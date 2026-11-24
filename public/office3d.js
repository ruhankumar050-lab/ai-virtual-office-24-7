import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

class VirtualOffice3D {
  constructor() {
    this.container = null;
    this.scene = null;
    this.camera = null;
    this.renderer = null;
    this.controls = null;
    this.enabled = true;
    this.animId = null;
    this.agentMeshes = new Map();
    this.roomMap = new Map();
    this.speakingAgentId = null;
    this.onSelectAgent = null;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.clock = new THREE.Clock();
  }

  init(container, onSelectAgent) {
    this.container = container;
    this.onSelectAgent = onSelectAgent;
    if (!container) return;

    const w = Math.max(320, container.clientWidth || 800);
    const h = Math.max(340, container.clientHeight || 460);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#070b17');
    this.scene.fog = new THREE.Fog('#070b17', 42, 110);

    this.camera = new THREE.PerspectiveCamera(48, w / h, 0.5, 220);
    this.camera.position.set(0, 32, 42);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false;
    container.innerHTML = '';
    container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.minDistance = 8;
    this.controls.maxDistance = 78;

    // Lighting
    const hemi = new THREE.HemisphereLight('#93c5fd', '#0f172a', 1.15);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight('#ffffff', 1.25);
    dir.position.set(18, 34, 22);
    this.scene.add(dir);

    // Base floor + subtle grid
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(90, 70),
      new THREE.MeshStandardMaterial({ color: '#0b1222', roughness: 0.9 })
    );
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(90, 45, '#1e293b', '#131d33');
    grid.position.y = 0.02;
    this.scene.add(grid);

    window.addEventListener('resize', () => this.handleResize());
    this.renderer.domElement.addEventListener('pointerdown', (e) => this.handleClick(e));
    this.animate();
  }

  handleResize() {
    if (!this.container || !this.renderer || !this.camera) return;
    const w = Math.max(320, this.container.clientWidth);
    const h = Math.max(340, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  makeLabelSprite(text, bg = '#0f172a', border = '#38bdf8') {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 112;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg;
    ctx.strokeStyle = border;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(8, 8, 496, 96, 22);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f8fafc';
    ctx.font = 'bold 30px Tahoma, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text || '').slice(0, 28), 256, 56);
    const tex = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(5.4, 1.2, 1);
    return spr;
  }

  buildRooms(rooms) {
    if (!this.scene || this.roomMap.size > 0) return;
    for (const r of rooms || []) {
      const group = new THREE.Group();
      group.position.set(r.x, 0, r.z);

      // Room pad
      const pad = new THREE.Mesh(
        new THREE.BoxGeometry(r.w, 0.16, r.d),
        new THREE.MeshStandardMaterial({ color: '#111c33', roughness: 0.85 })
      );
      pad.position.y = 0.08;
      group.add(pad);

      // Neon border
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(r.w, 0.22, r.d));
      const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: r.color || '#38bdf8' }));
      line.position.y = 0.14;
      group.add(line);

      // Room label floating
      const lbl = this.makeLabelSprite(r.label, 'rgba(15,23,42,0.9)', r.color || '#38bdf8');
      lbl.position.set(0, 4.2, -r.d / 2 + 0.8);
      group.add(lbl);

      // Special Server Rack visual in server_ops
      if (r.id === 'server_ops') {
        for (let i = -1; i <= 1; i++) {
          const rack = new THREE.Mesh(
            new THREE.BoxGeometry(1.1, 2.6, 1.1),
            new THREE.MeshStandardMaterial({ color: '#1e293b', emissive: '#1d4ed8', emissiveIntensity: 0.35 })
          );
          rack.position.set(i * 1.8, 1.35, -2.2);
          group.add(rack);
        }
      }

      // Meeting table in meeting_room
      if (r.id === 'meeting_room') {
        const tbl = new THREE.Mesh(
          new THREE.CylinderGeometry(2.6, 2.6, 0.25, 24),
          new THREE.MeshStandardMaterial({ color: '#312e81', roughness: 0.5 })
        );
        tbl.position.set(0, 0.9, 0);
        group.add(tbl);
      }

      this.scene.add(group);
      this.roomMap.set(r.id, r);
    }
  }

  createCharacterMesh(agent, indexInRoom) {
    const root = new THREE.Group();
    root.userData.agentId = agent.id;

    // Desk & monitor
    const desk = new THREE.Mesh(
      new THREE.BoxGeometry(2.1, 0.15, 1.1),
      new THREE.MeshStandardMaterial({ color: '#1e293b' })
    );
    desk.position.set(0, 0.78, 0.95);
    root.add(desk);

    const monitor = new THREE.Mesh(
      new THREE.BoxGeometry(1.1, 0.65, 0.08),
      new THREE.MeshStandardMaterial({ color: '#020617', emissive: agent.color || '#38bdf8', emissiveIntensity: 0.45 })
    );
    monitor.position.set(0, 1.22, 1.05);
    root.add(monitor);

    // Character body (articulated humanoid rig)
    const bodyMat = new THREE.MeshStandardMaterial({ color: agent.color || '#6366f1', roughness: 0.55 });
    const skinMat = new THREE.MeshStandardMaterial({ color: '#f1c27d', roughness: 0.6 });

    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.38, 0.95, 12), bodyMat);
    torso.position.y = 1.05;
    root.add(torso);

    const headGroup = new THREE.Group();
    headGroup.position.y = 1.78;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 16), skinMat);
    headGroup.add(head);

    // Eyes
    const eyeMat = new THREE.MeshBasicMaterial({ color: '#0f172a' });
    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), eyeMat);
    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), eyeMat);
    eyeL.position.set(-0.09, 0.05, 0.24);
    eyeR.position.set(0.09, 0.05, 0.24);
    headGroup.add(eyeL, eyeR);

    // Animated Mouth (Viseme / Lip Sync mesh)
    const mouth = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.04, 0.05),
      new THREE.MeshBasicMaterial({ color: '#be123c' })
    );
    mouth.position.set(0, -0.09, 0.25);
    headGroup.add(mouth);
    root.add(headGroup);

    // Arms (typing/gesturing)
    const armGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.65, 8);
    const armL = new THREE.Mesh(armGeo, bodyMat);
    const armR = new THREE.Mesh(armGeo, bodyMat);
    armL.position.set(-0.42, 1.1, 0.25);
    armR.position.set(0.42, 1.1, 0.25);
    armL.rotation.x = -0.9;
    armR.rotation.x = -0.9;
    root.add(armL, armR);

    // Status floor ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.65, 0.85, 24),
      new THREE.MeshBasicMaterial({ color: '#22c55e', side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.2;
    root.add(ring);

    // Name sprite
    const tag = this.makeLabelSprite(agent.shortName || agent.name, 'rgba(2,6,23,0.85)', agent.color || '#38bdf8');
    tag.position.set(0, 2.65, 0);
    tag.scale.set(3.4, 0.78, 1);
    root.add(tag);

    // Position inside assigned room
    const room = this.roomMap.get(agent.roomId) || { x: 0, z: 0, w: 12, d: 10 };
    const cols = Math.max(2, Math.floor((room.w - 2) / 3.2));
    const col = indexInRoom % cols;
    const row = Math.floor(indexInRoom / cols);
    const px = room.x - room.w / 2 + 2.4 + col * 3.1;
    const pz = room.z - room.d / 2 + 2.8 + row * 3.4;
    root.position.set(px, 0, pz);

    this.scene.add(root);
    return { root, headGroup, mouth, armL, armR, ring, monitor, status: agent.status, homePos: new THREE.Vector3(px, 0, pz) };
  }

  syncState(state) {
    if (!this.scene) return;
    if (state.rooms3D) this.buildRooms(state.rooms3D);

    const perRoomCounts = new Map();
    for (const agent of state.agents || []) {
      const idx = perRoomCounts.get(agent.roomId) || 0;
      perRoomCounts.set(agent.roomId, idx + 1);

      let entry = this.agentMeshes.get(agent.id);
      if (!entry) {
        entry = this.createCharacterMesh(agent, idx);
        this.agentMeshes.set(agent.id, entry);
      }
      entry.status = agent.status;
      const statusColor =
        agent.status === 'idle' ? '#22c55e' : agent.status === 'thinking' ? '#6366f1' : '#f59e0b';
      entry.ring.material.color.set(statusColor);
    }
  }

  setSpeakingAgent(agentId, speaking) {
    this.speakingAgentId = speaking ? agentId : null;
  }

  focusRoom(roomId) {
    const r = this.roomMap.get(roomId);
    if (!r || !this.camera || !this.controls) return;
    this.controls.target.set(r.x, 1.2, r.z);
    this.camera.position.set(r.x, 13, r.z + 15);
  }

  focusAgent(agentId) {
    const entry = this.agentMeshes.get(agentId);
    if (!entry || !this.camera || !this.controls) return;
    const p = entry.root.position;
    this.controls.target.set(p.x, 1.5, p.z);
    this.camera.position.set(p.x + 2.5, 5.2, p.z + 6.8);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    if (this.enabled && !this.animId) {
      this.animate();
    }
  }

  handleClick(event) {
    if (!this.renderer || !this.camera || !this.onSelectAgent) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    for (const h of hits) {
      let obj = h.object;
      while (obj) {
        if (obj.userData?.agentId) {
          this.onSelectAgent(obj.userData.agentId);
          return;
        }
        obj = obj.parent;
      }
    }
  }

  animate() {
    if (!this.enabled) {
      this.animId = null;
      return;
    }
    this.animId = requestAnimationFrame(() => this.animate());
    const t = this.clock.getElapsedTime();

    for (const [id, entry] of this.agentMeshes.entries()) {
      const isWorking = entry.status !== 'idle';
      const isSpeaking = this.speakingAgentId === id;

      // Subtle breathing & head motion
      entry.headGroup.rotation.y = Math.sin(t * 1.4 + entry.homePos.x) * (isSpeaking ? 0.22 : 0.08);
      entry.headGroup.rotation.x = isSpeaking ? Math.sin(t * 5) * 0.08 : 0;

      // Lip-sync viseme animation when speaking
      if (isSpeaking) {
        const open = 0.8 + Math.abs(Math.sin(t * 18)) * 3.2;
        entry.mouth.scale.set(1.2, open, 1);
      } else {
        entry.mouth.scale.set(1, 1, 1);
      }

      // Typing / gesturing animation
      if (isWorking || isSpeaking) {
        entry.armL.rotation.x = -0.9 + Math.sin(t * 12) * 0.25;
        entry.armR.rotation.x = -0.9 + Math.cos(t * 12) * 0.25;
      } else {
        entry.armL.rotation.x = -0.7;
        entry.armR.rotation.x = -0.7;
      }
    }

    if (this.controls) this.controls.update();
    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

window.Office3D = new VirtualOffice3D();
