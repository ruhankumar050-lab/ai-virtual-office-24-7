const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { VirtualOfficeOrchestrator } = require('./engine/orchestrator');
const { ROOT_DIR, DELIVERABLES_DIR, ensureDirs, readAppDeliverable } = require('./engine/storage');
const { parseLessonBuffer } = require('./engine/lessonParser');
const { inspectGlbOrGltf } = require('./engine/generators');
const security = require('./engine/security');

ensureDirs();

const PORT = Number(process.env.SERVER_PORT || process.env.PORT) || 3000;
const HOST = process.env.HOST || process.env.IP || '0.0.0.0';
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const THREE_DIR = path.join(ROOT_DIR, 'node_modules', 'three');

const orchestrator = new VirtualOfficeOrchestrator();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.wav': 'audio/wav',
  '.srt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function readBody(req, maxBytes = 18e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (chunk) => {
      len += chunk.length;
      if (len > maxBytes) {
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(JSON.stringify(data));
}

function serveStaticFile(res, baseDir, reqPath) {
  const safeRel = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, '');
  const fullPath = path.join(baseDir, safeRel);
  if (!fullPath.startsWith(baseDir) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(fullPath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(fullPath).pipe(res);
}

function requireOwner(req, res) {
  if (!security.isAuthenticatedOwner(req, orchestrator.db)) {
    sendJson(res, 401, { error: 'يتطلب هذا الإجراء تسجيل دخول المالك أولاً.' });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseOrigin = `${proto}://${req.headers.host || 'localhost:' + PORT}`;
  const url = new URL(req.url, baseOrigin);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Owner-Token, X-Platform-Key',
    });
    res.end();
    return;
  }

  // Healthcheck
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, {
      ok: true,
      autopilot: orchestrator.state.autopilotEnabled,
      cycle: orchestrator.state.cycleCount,
      sqliteReady: Boolean(orchestrator.db?.ready),
      uptimeSec: Math.round(process.uptime()),
    });
  }

  // Auth Endpoints
  if (pathname === '/api/auth/status' && req.method === 'GET') {
    return sendJson(res, 200, {
      authEnabled: security.isOwnerAuthEnabled(orchestrator.db),
      authenticated: security.isAuthenticatedOwner(req, orchestrator.db),
    });
  }

  if (pathname === '/api/auth/setup' && req.method === 'POST') {
    if (security.isOwnerAuthEnabled(orchestrator.db) && !security.isAuthenticatedOwner(req, orchestrator.db)) {
      return sendJson(res, 401, { error: 'كلمة المرور مضبوطة بالفعل — سجل الدخول أولاً لتغييرها.' });
    }
    const body = await readBody(req).catch(() => ({}));
    try {
      security.setOwnerPassword(orchestrator.db, body.password);
      const token = security.createSessionToken(orchestrator.db, 'owner');
      return sendJson(
        res,
        200,
        { ok: true, authenticated: true },
        { 'Set-Cookie': `avo_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800` }
      );
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!security.checkOwnerPassword(orchestrator.db, body.password)) {
      return sendJson(res, 401, { error: 'كلمة المرور غير صحيحة' });
    }
    const token = security.createSessionToken(orchestrator.db, 'owner');
    return sendJson(
      res,
      200,
      { ok: true, authenticated: true },
      { 'Set-Cookie': `avo_session=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800` }
    );
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'avo_session=; HttpOnly; Path=/; Max-Age=0' });
  }

  // State & SSE
  if (pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, orchestrator.getPublicState());
  }

  if (pathname === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    const unsubscribe = orchestrator.subscribe(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return;
  }

  // Orchestration Controls
  if (pathname === '/api/tick' && req.method === 'POST') {
    await orchestrator.runTick(true);
    return sendJson(res, 200, { ok: true, state: orchestrator.getPublicState() });
  }

  if (pathname === '/api/autopilot' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    orchestrator.toggleAutopilot(body.enabled);
    return sendJson(res, 200, { ok: true, autopilotEnabled: orchestrator.state.autopilotEnabled });
  }

  if (pathname === '/api/settings' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    const body = await readBody(req).catch(() => ({}));
    orchestrator.updateSettings(body);
    return sendJson(res, 200, { ok: true, state: orchestrator.getPublicState() });
  }

  if (pathname === '/api/directive' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.title) return sendJson(res, 400, { error: 'Title is required' });
    const out = orchestrator.enqueueDirective(body);
    return sendJson(res, 200, { ok: true, ...out });
  }

  // Multi-Track Lesson Project (supports TXT, MD, DOCX, PDF, PPTX via base64 or plain text)
  if (pathname === '/api/projects/lesson' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body || (!body.title && !body.fileBase64)) {
      return sendJson(res, 400, { error: 'يجب إدخال عنوان الدرس أو إرفاق ملف (PDF/DOCX/PPTX/TXT).' });
    }
    try {
      let parsedText = body.lessonText || '';
      let sourceFile = body.fileName || '';
      if (body.fileBase64 && body.fileName) {
        const buf = Buffer.from(body.fileBase64, 'base64');
        const parsed = await parseLessonBuffer(buf, body.fileName);
        parsedText = parsed.text || parsedText;
      }
      const title = (body.title || sourceFile || 'مشروع درس تعليمي').replace(/\.[^.]+$/, '');
      const projectId = orchestrator.createMultiTrackProject({
        title,
        description: body.description || parsedText.slice(0, 300),
        sourceType: sourceFile ? 'file_upload' : 'lesson_text',
        sourceFile,
        lessonText: parsedText || title,
        curriculumMeta: body.curriculumMeta || {},
      });
      return sendJson(res, 200, { ok: true, projectId, extractedChars: parsedText.length });
    } catch (err) {
      return sendJson(res, 400, { error: `تعذر تحليل ملف الدرس: ${err.message}` });
    }
  }

  const projMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projMatch && req.method === 'GET') {
    const pid = projMatch[1].replace(/[^a-zA-Z0-9_-]/g, '');
    const proj = orchestrator.db.get('SELECT * FROM projects WHERE id = ?', [pid]);
    if (!proj) return sendJson(res, 404, { error: 'Project not found' });
    const tasks = orchestrator.db.all('SELECT * FROM tasks WHERE project_id = ? ORDER BY priority ASC, created_at ASC', [pid]);
    const bugs = orchestrator.db.all('SELECT * FROM bug_reports WHERE project_id = ? ORDER BY created_at DESC', [pid]);
    const assets = orchestrator.db.all('SELECT * FROM assets_registry WHERE project_id = ? ORDER BY created_at DESC', [pid]);
    return sendJson(res, 200, { project: proj, tasks, bugs, assets });
  }

  // Meetings & AI Innovation
  if (pathname === '/api/meetings/convene' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const out = await orchestrator.conveneMeeting({
      title: body.title || 'اجتماع تنسيقي عام',
      projectId: body.projectId || '',
      participantIds: body.participantIds || ['ceo', 'hr', 'qa_fixer', 'video_creator', 'game_dev'],
      agenda: Array.isArray(body.agenda) ? body.agenda : ['متابعة التقدم', 'حل الاختناقات'],
    });
    return sendJson(res, 200, { ok: true, meeting: out });
  }

  if (pathname === '/api/innovation/scan' && req.method === 'POST') {
    const out = await orchestrator.runInnovationReport();
    return sendJson(res, 200, { ok: true, ...out });
  }

  // 3D GLB/GLTF Asset Inspector
  if (pathname === '/api/assets/inspect-3d' && req.method === 'POST') {
    const body = await readBody(req).catch(() => null);
    if (!body || !body.fileBase64 || !body.fileName) {
      return sendJson(res, 400, { error: 'يجب إرفاق ملف .glb أو .gltf للفحص.' });
    }
    const safeName = path.basename(body.fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const tmpDir = path.join(DELIVERABLES_DIR, '3d-assets');
    fs.mkdirSync(tmpDir, { recursive: true });
    const outPath = path.join(tmpDir, `${Date.now()}-${safeName}`);
    fs.writeFileSync(outPath, Buffer.from(body.fileBase64, 'base64'));
    const report = inspectGlbOrGltf(outPath, { source: body.source || '', license: body.license || '' });
    if (report.valid) {
      orchestrator.registerAsset(body.projectId || '', '', safeName, '3d_model', outPath, {
        source: body.source || 'user_upload',
        license: body.license,
        inspection: report,
      });
    } else {
      fs.unlinkSync(outPath);
    }
    return sendJson(res, 200, { ok: report.valid, report });
  }

  // HR & Chat
  if (pathname === '/api/hr/hire' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.name) return sendJson(res, 400, { error: 'Employee name is required' });
    const agent = orchestrator.hireCustomEmployee(body);
    return sendJson(res, 200, { ok: true, agent });
  }

  if (pathname === '/api/chat' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    if (!body.message) return sendJson(res, 400, { error: 'Message is required' });
    const result = await orchestrator.chatWithAgent(body.agentId || 'ceo', body.message);
    return sendJson(res, 200, {
      ok: true,
      reply: result.reply,
      agentName: result.agent.name,
      usedProvider: result.usedProvider,
      triggeredProjectId: result.triggeredProjectId,
    });
  }

  if (pathname === '/api/reset' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    orchestrator.resetOffice();
    return sendJson(res, 200, { ok: true, state: orchestrator.getPublicState() });
  }

  if (pathname === '/api/backup' && req.method === 'GET') {
    const backup = orchestrator.exportFullBackup();
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="virtual-office-backup.json"',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify(backup, null, 2));
    return;
  }

  if (pathname === '/api/restore' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    const body = await readBody(req).catch(() => null);
    if (!body) return sendJson(res, 400, { error: 'Invalid backup JSON' });
    try {
      orchestrator.restoreBackup(body);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  // Google Drive OAuth 2.0 Routes
  if (pathname === '/api/drive/status' && req.method === 'GET') {
    const status = await orchestrator.drive.getStatus();
    return sendJson(res, 200, status);
  }

  if (pathname === '/api/drive/credentials' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    const body = await readBody(req).catch(() => ({}));
    orchestrator.drive.saveOAuthAppCredentials(body);
    return sendJson(res, 200, { ok: true, status: await orchestrator.drive.getStatus() });
  }

  if (pathname === '/api/drive/auth-url' && req.method === 'GET') {
    try {
      const authUrl = orchestrator.drive.getAuthUrl(`${baseOrigin}/api/drive/oauth/callback`);
      return sendJson(res, 200, { ok: true, authUrl });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/drive/oauth/callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h2>❌ لم يصل رمز التفويض من Google.</h2>');
      return;
    }
    try {
      await orchestrator.drive.handleOAuthCallback(code, `${baseOrigin}/api/drive/oauth/callback`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html dir="rtl"><body><h2>✅ تم ربط Google Drive بنجاح!</h2><p>يمكنك إغلاق هذه الصفحة والعودة للمكتب.</p><script>setTimeout(()=>location.href="/",1500)</script></body></html>');
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html dir="rtl"><body><h2>❌ فشل ربط Drive: ${err.message}</h2></body></html>`);
    }
    return;
  }

  if (pathname === '/api/drive/files' && req.method === 'GET') {
    try {
      const list = await orchestrator.drive.listFiles(url.searchParams.get('q') || '');
      return sendJson(res, 200, list);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/drive/upload-asset' && req.method === 'POST') {
    const body = await readBody(req).catch(() => ({}));
    const asset = orchestrator.db.get('SELECT * FROM assets_registry WHERE id = ?', [body.assetId || '']);
    if (!asset) return sendJson(res, 404, { error: 'Asset not found' });
    try {
      const proj = orchestrator.db.get('SELECT title FROM projects WHERE id = ?', [asset.project_id]);
      const folders = await orchestrator.drive.ensureProjectSubfolders(proj?.title || 'General', asset.asset_type);
      const uploaded = await orchestrator.drive.uploadFile({
        localPath: asset.local_path,
        fileName: asset.file_name,
        folderId: folders.deptFolderId,
      });
      orchestrator.db.run('UPDATE assets_registry SET drive_file_id = ?, drive_link = ? WHERE id = ?', [
        uploaded.id,
        uploaded.webViewLink,
        asset.id,
      ]);
      return sendJson(res, 200, { ok: true, uploaded });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/drive/disconnect' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    orchestrator.drive.disconnect();
    return sendJson(res, 200, { ok: true });
  }

  // Educational Platform Unified Integration API (Section 12)
  if (pathname === '/api/platform/config' && req.method === 'GET') {
    const cfg = orchestrator.db.getKV('platform_integration', { enabled: false, baseUrl: '', hasApiKey: false });
    return sendJson(res, 200, {
      enabled: Boolean(cfg.enabled),
      baseUrl: cfg.baseUrl || '',
      hasApiKey: Boolean(cfg.apiKey),
    });
  }

  if (pathname === '/api/platform/config' && req.method === 'POST') {
    if (!requireOwner(req, res)) return;
    const body = await readBody(req).catch(() => ({}));
    const prev = orchestrator.db.getKV('platform_integration', {}) || {};
    orchestrator.db.setKV('platform_integration', {
      enabled: Boolean(body.enabled),
      baseUrl: body.baseUrl || prev.baseUrl || '',
      apiKey: body.apiKey && !String(body.apiKey).startsWith('••') ? body.apiKey : prev.apiKey || '',
    });
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/platform/lessons' && req.method === 'POST') {
    const cfg = orchestrator.db.getKV('platform_integration', {}) || {};
    if (cfg.apiKey && req.headers['x-platform-key'] !== cfg.apiKey) {
      return sendJson(res, 401, { error: 'Invalid X-Platform-Key' });
    }
    const body = await readBody(req).catch(() => ({}));
    if (!body.title || !body.lessonId) {
      return sendJson(res, 400, { error: 'lessonId and title are required' });
    }
    const projectId = orchestrator.createMultiTrackProject({
      title: body.title,
      description: body.content || body.title,
      sourceType: 'educational_platform',
      lessonText: body.content || body.title,
      curriculumMeta: {
        lessonId: body.lessonId,
        unitId: body.unitId || '',
        grade: body.grade || '',
        term: body.term || '',
      },
    });
    return sendJson(res, 200, { ok: true, projectId, lessonId: body.lessonId });
  }

  const platLessonMatch = pathname.match(/^\/api\/platform\/lessons\/([^/]+)\/deliverables$/);
  if (platLessonMatch && req.method === 'GET') {
    const lid = platLessonMatch[1];
    const projects = orchestrator.db.all('SELECT * FROM projects ORDER BY created_at DESC LIMIT 50');
    const matched = projects.find((p) => {
      try {
        return JSON.parse(p.curriculum_meta_json || '{}').lessonId === lid;
      } catch {
        return false;
      }
    });
    if (!matched) return sendJson(res, 404, { error: 'No project found for this lessonId' });
    const assets = orchestrator.db.all('SELECT * FROM assets_registry WHERE project_id = ?', [matched.id]);
    return sendJson(res, 200, { project: matched, assets });
  }

  // Deliverables & App Source
  const appSourceMatch = pathname.match(/^\/api\/deliverables\/app\/([^/]+)\/source$/);
  if (appSourceMatch && req.method === 'GET') {
    const id = appSourceMatch[1].replace(/[^a-zA-Z0-9_-]/g, '');
    const html = readAppDeliverable(id);
    if (!html) return sendJson(res, 404, { error: 'App not found' });
    return sendJson(res, 200, { id, html });
  }

  if (pathname.startsWith('/deliverables/')) {
    const rel = pathname.slice('/deliverables/'.length);
    return serveStaticFile(res, DELIVERABLES_DIR, rel);
  }

  // Local Three.js Vendor Static Serve (works offline/sandboxed too)
  if (pathname.startsWith('/vendor/three/')) {
    const rel = pathname.slice('/vendor/three/'.length);
    return serveStaticFile(res, THREE_DIR, rel);
  }

  if (pathname === '/' || pathname === '/index.html') {
    return serveStaticFile(res, PUBLIC_DIR, 'index.html');
  }

  return serveStaticFile(res, PUBLIC_DIR, pathname.slice(1));
});

orchestrator
  .init()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`🚀 AI Virtual Office Enterprise listening at http://${HOST}:${PORT}`);
      orchestrator.start();
    });
  })
  .catch((err) => {
    console.error('Failed to start AI Virtual Office:', err);
    process.exit(1);
  });
