const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DEPARTMENTS, INITIAL_AGENTS, HIREABLE_TEMPLATES, THREE_D_ROOMS } = require('./agents');
const { extractCodeBlock, extractJsonBlock } = require('./llm');
const { OfficeDatabase } = require('./db');
const { AIModelRouter } = require('./aiRouter');
const { GoogleDriveIntegration } = require('./drive');
const gen = require('./generators');
const { scanGeneratedCodeSafety } = require('./security');
const storage = require('./storage');
const templates = require('./templates');

const TASK_STATUS_LABELS = {
  new: 'جديدة',
  analyzing: 'قيد التحليل',
  queued: 'في قائمة الانتظار',
  in_progress: 'قيد التنفيذ',
  waiting_dependency: 'تنتظر موظفًا آخر',
  testing: 'قيد الاختبار',
  needs_fix: 'تحتاج إلى إصلاح',
  awaiting_owner_approval: 'تنتظر موافقة المالك',
  completed: 'مكتملة',
  paused: 'متوقفة',
  failed: 'فشلت',
};

const DEFAULT_STATE = {
  officeName: 'شركة الذكاء الاصطناعي المستقلة 24/7',
  autopilotEnabled: true,
  autoInventProjects: false,
  tickIntervalMs: 4000,
  maxConcurrency: 3,
  cycleCount: 0,
  llmConfig: {
    provider: process.env.AI_PROVIDER || 'builtin',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    baseUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    backupProvider: process.env.AI_BACKUP_PROVIDER || 'none',
    backupApiKey: process.env.AI_BACKUP_API_KEY || '',
    backupModel: process.env.AI_BACKUP_MODEL || '',
    hfApiKey: process.env.HF_API_KEY || '',
  },
  agents: INITIAL_AGENTS,
  tasks: [],
  deliverables: [],
  logs: [],
  meetings: [],
  customQueue: [],
  stats: {
    totalAppsBuilt: 0,
    totalAutoFixes: 0,
    totalVideosProduced: 0,
    totalMontageEdits: 0,
    totalGamesBuilt: 0,
    totalBookletsBuilt: 0,
    totalHires: 0,
  },
};

class VirtualOfficeOrchestrator {
  constructor() {
    this.db = new OfficeDatabase();
    this.aiRouter = null;
    this.drive = null;
    this.state = storage.loadState(DEFAULT_STATE);
    this.applyEnvOverrides();
    this.mergeExpandedAgents();
    for (const a of this.state.agents) {
      if (a.status !== 'idle') a.status = 'idle';
    }
    this.clients = new Set();
    this.isTicking = false;
    this.timer = null;
    this.startedAt = new Date().toISOString();
    this.initialized = false;

    if (this.state.logs.length === 0) {
      this.addLog('system', 'النظام', '🚀 تم تشغيل شركة الذكاء الاصطناعي المستقلة 24/7 — بانتظار أوامرك أو رفع درس متكامل.');
    }
  }

  applyEnvOverrides() {
    if (process.env.AI_PROVIDER && process.env.AI_API_KEY && (this.state.llmConfig?.provider === 'builtin' || !this.state.llmConfig?.apiKey)) {
      this.state.llmConfig = {
        ...this.state.llmConfig,
        provider: process.env.AI_PROVIDER,
        apiKey: process.env.AI_API_KEY,
        model: process.env.AI_MODEL || this.state.llmConfig?.model || '',
      };
    }
    if (process.env.AI_BACKUP_PROVIDER && process.env.AI_BACKUP_API_KEY && (this.state.llmConfig?.backupProvider === 'none' || !this.state.llmConfig?.backupApiKey)) {
      this.state.llmConfig = {
        ...this.state.llmConfig,
        backupProvider: process.env.AI_BACKUP_PROVIDER,
        backupApiKey: process.env.AI_BACKUP_API_KEY,
        backupModel: process.env.AI_BACKUP_MODEL || this.state.llmConfig?.backupModel || '',
      };
    }
    if (process.env.ARENA_API_KEY && process.env.AI_PROVIDER === 'arena' && !this.state.llmConfig?.apiKey) {
      this.state.llmConfig = {
        ...this.state.llmConfig,
        provider: 'arena',
        apiKey: process.env.ARENA_API_KEY,
      };
    }
  }

  mergeExpandedAgents() {
    const byId = new Map((this.state.agents || []).map((a) => [a.id, a]));
    for (const def of INITIAL_AGENTS) {
      if (!byId.has(def.id)) {
        byId.set(def.id, structuredClone(def));
      } else {
        const cur = byId.get(def.id);
        byId.set(def.id, {
          ...def,
          tasksCompleted: cur.tasksCompleted || 0,
          qualityScore: cur.qualityScore || def.qualityScore,
        });
      }
    }
    this.state.agents = Array.from(byId.values());
  }

  async init() {
    if (this.initialized) return this;
    await this.db.init();
    this.aiRouter = new AIModelRouter(this.db);
    this.drive = new GoogleDriveIntegration(this.db);

    // Recover any interrupted in-progress tasks after server crash/restart
    const stale = this.db.all("SELECT id, title, project_id FROM tasks WHERE status IN ('in_progress', 'testing')");
    if (stale.length > 0) {
      this.db.run("UPDATE tasks SET status = 'queued', updated_at = ? WHERE status IN ('in_progress', 'testing')", [
        new Date().toISOString(),
      ]);
      this.db.run("UPDATE job_queue SET status = 'pending', locked_by = '', locked_at = '' WHERE status = 'running'", []);
      this.addLog('devops_sec', 'م. بلال (DevOps)', `♻️ تمت استعادة ${stale.length} مهام متوقفة تلقائياً من آخر Checkpoint بعد إعادة التشغيل.`);
    }
    this.initialized = true;
    return this;
  }

  start() {
    this.scheduleNextTick();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  scheduleNextTick() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.state.autopilotEnabled) return;
    const delay = Math.max(2000, Math.min(300000, Number(this.state.tickIntervalMs) || 4000));
    this.timer = setTimeout(async () => {
      await this.runTick();
      this.scheduleNextTick();
    }, delay);
  }

  subscribe(res) {
    this.clients.add(res);
    res.write(`data: ${JSON.stringify({ type: 'state', state: this.getPublicState() })}\n\n`);
    return () => this.clients.delete(res);
  }

  broadcast(eventName = 'state') {
    const payload = `data: ${JSON.stringify({ type: eventName, state: this.getPublicState() })}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(payload);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  getDbOverview() {
    if (!this.db || !this.db.ready) {
      return {
        projects: [],
        dbTasks: [],
        bugReports: [],
        meetingsDetailed: [],
        assets: [],
        auditLogs: [],
        queueStats: { pending: 0, running: 0, done: 0, failed: 0 },
      };
    }
    const projects = this.db.all('SELECT * FROM projects ORDER BY created_at DESC LIMIT 25').map((p) => ({
      ...p,
      curriculumMeta: safeJson(p.curriculum_meta_json, {}),
      acceptanceCriteria: safeJson(p.acceptance_criteria_json, []),
    }));
    const dbTasks = this.db.all('SELECT * FROM tasks ORDER BY priority ASC, created_at ASC LIMIT 120').map((t) => ({
      ...t,
      statusLabel: TASK_STATUS_LABELS[t.status] || t.status,
      dependsOn: safeJson(t.depends_on_json, []),
      participants: safeJson(t.participants_json, []),
      outputFiles: safeJson(t.output_files_json, []),
      issues: safeJson(t.issues_json, []),
      checkpoint: safeJson(t.checkpoint_json, {}),
      executionLog: safeJson(t.execution_log_json, []),
    }));
    const bugReports = this.db.all('SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT 40');
    const meetingsDetailed = this.db.all('SELECT * FROM meetings ORDER BY created_at DESC LIMIT 25').map((m) => ({
      ...m,
      participants: safeJson(m.participants_json, []),
      agenda: safeJson(m.agenda_json, []),
      transcript: safeJson(m.transcript_json, []),
      decisions: safeJson(m.decisions_json, []),
    }));
    const assets = this.db.all('SELECT * FROM assets_registry ORDER BY created_at DESC LIMIT 60').map((a) => ({
      ...a,
      inspection: safeJson(a.inspection_json, {}),
    }));
    const auditLogs = this.db.all('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 40');
    const qRows = this.db.all('SELECT status, COUNT(*) as c FROM job_queue GROUP BY status');
    const queueStats = { pending: 0, running: 0, done: 0, failed: 0 };
    for (const r of qRows) queueStats[r.status] = r.c;

    return { projects, dbTasks, bugReports, meetingsDetailed, assets, auditLogs, queueStats };
  }

  getPublicState() {
    const safeLlm = {
      ...this.state.llmConfig,
      apiKey: this.state.llmConfig.apiKey ? '••••••••' + this.state.llmConfig.apiKey.slice(-4) : '',
      backupApiKey: this.state.llmConfig.backupApiKey ? '••••••••' + this.state.llmConfig.backupApiKey.slice(-4) : '',
      hfApiKey: this.state.llmConfig.hfApiKey ? '••••••••' + this.state.llmConfig.hfApiKey.slice(-4) : '',
      hasApiKey: Boolean(this.state.llmConfig.apiKey),
      hasBackupApiKey: Boolean(this.state.llmConfig.backupApiKey),
      hasHfApiKey: Boolean(this.state.llmConfig.hfApiKey),
    };
    const dbOverview = this.getDbOverview();
    const routerDashboard = this.aiRouter ? this.aiRouter.getDashboard(this.state.llmConfig) : null;
    return {
      ...this.state,
      departments: DEPARTMENTS,
      rooms3D: THREE_D_ROOMS,
      statusLabels: TASK_STATUS_LABELS,
      llmConfig: safeLlm,
      routerDashboard,
      ...dbOverview,
      monitoring: {
        startedAt: this.startedAt,
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
        workerActive: this.isTicking,
        autopilotEnabled: this.state.autopilotEnabled,
        queueStats: dbOverview.queueStats,
        sqliteReady: Boolean(this.db?.ready),
        hostingNote: 'الاستمرارية 24/7 تتطلب تشغيل Worker على خادم لا ينام (VPS / Docker / Render المدفوع)؛ الخطة المجانية قد تنام عند الخمول.',
      },
    };
  }

  persistAndBroadcast() {
    storage.saveState(this.state);
    this.broadcast();
  }

  setAgentState(agentId, status, currentTask, bubble = '') {
    const agent = this.state.agents.find((a) => a.id === agentId);
    if (!agent) return;
    agent.status = status;
    agent.currentTask = currentTask;
    agent.bubble = bubble || currentTask;
    agent.lastActiveAt = new Date().toISOString();
  }

  addLog(agentId, actorName, message, level = 'info') {
    const entry = {
      id: crypto.randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      agentId,
      actorName,
      message,
      level,
    };
    this.state.logs.unshift(entry);
    if (this.state.logs.length > 100) this.state.logs = this.state.logs.slice(0, 100);
  }

  addMeetingMessage(speaker, role, text) {
    this.state.meetings.unshift({
      id: crypto.randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      speaker,
      role,
      text,
    });
    if (this.state.meetings.length > 50) this.state.meetings = this.state.meetings.slice(0, 50);
  }

  async generateWithAgentAI(agent, userPrompt, fallbackFn) {
    if (!this.aiRouter) {
      return { text: null, usedProvider: 'builtin', fallback: fallbackFn(), tokensEst: 0 };
    }
    const memories = this.db.ready
      ? this.db
          .all('SELECT content FROM agent_memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3', [agent.id])
          .map((m) => m.content)
          .join(' | ')
      : '';
    const sys = memories ? `${agent.systemPrompt}\nذاكرة سابقة من خبرتك: ${memories}` : agent.systemPrompt;

    const res = await this.aiRouter.complete({
      config: this.state.llmConfig,
      systemPrompt: sys,
      userPrompt,
      modelClass: agent.preferredModelClass || 'reasoning',
      agentId: agent.id,
      roleType: agent.role,
      fallbackFn,
    });
    if (res.error) {
      this.addLog('devops_sec', 'AI Router', `⚠️ تعذر المزود الأساسي (${res.error}) — تم التحويل تلقائياً للاحتياطي.`, 'warn');
    }
    return res;
  }

  /**
   * Tariq creates a full Multi-Track Project (Video + Game + Booklet + Curriculum Pack) from a Lesson or Goal
   */
  createMultiTrackProject({ title, description = '', sourceType = 'lesson', sourceFile = '', lessonText = '', curriculumMeta = {} }) {
    const now = new Date().toISOString();
    const projectId = 'proj-' + Date.now().toString(36);
    const fullText = lessonText || description || title;

    this.setAgentState('ceo', 'thinking', `تحليل المشروع: ${title}`, 'أقسم المشروع لـ 4 مسارات متوازية... 👔');

    const acceptanceCriteria = [
      'إنتاج ملف فيديو MP4 حقيقي + ملف ترجمة SRT + مراجعة Video QA',
      'إنتاج لعبة تعليمية قابلة للعب على الهاتف والحاسوب + اجتياز Game QA',
      'إنتاج ملزمة حقيقية بصيغتي PDF و DOCX + مراجعة لغوية وعلمية',
      'بناء حزمة المنهج (أهداف + خريطة ذهنية + بنك أسئلة موثق المصادر)',
    ];

    this.db.run(
      `INSERT INTO projects (id, title, description, source_type, source_file, curriculum_meta_json, status, created_by, budget_tokens, used_tokens, acceptance_criteria_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'in_progress', 'owner', 150000, 0, ?, ?, ?)`,
      [projectId, title, description || fullText.slice(0, 400), sourceType, sourceFile, JSON.stringify(curriculumMeta), JSON.stringify(acceptanceCriteria), now, now]
    );

    const makeTask = ({ id, track, taskTitle, desc, department, assigneeId, participants = [], priority = 5, dependsOn = [], jobType }) => {
      const taskId = `${projectId}-${id}`;
      const depIds = dependsOn.map((d) => `${projectId}-${d}`);
      const initialStatus = depIds.length > 0 ? 'waiting_dependency' : 'queued';
      this.db.run(
        `INSERT INTO tasks (id, project_id, track, title, description, department, assignee_id, participants_json, priority, depends_on_json, status, progress_pct, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 3, ?, ?)`,
        [taskId, projectId, track, taskTitle, desc, department, assigneeId, JSON.stringify(participants), priority, JSON.stringify(depIds), initialStatus, now, now]
      );
      this.db.run(
        `INSERT INTO job_queue (id, task_id, project_id, job_type, payload_json, priority, status, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 3, ?, ?)`,
        ['job-' + crypto.randomUUID().slice(0, 8), taskId, projectId, jobType, JSON.stringify({ lessonText: fullText, curriculumMeta }), priority, now, now]
      );
      return taskId;
    };

    // Track 1: Curriculum & Research (Runs immediately in parallel)
    makeTask({
      id: 'curr-1',
      track: 'curriculum',
      taskTitle: `تحليل المنهج وبنك الأسئلة والخريطة الذهنية: ${title}`,
      desc: fullText,
      department: 'curriculum',
      assigneeId: 'curriculum_lead',
      participants: ['curriculum_lead'],
      priority: 1,
      jobType: 'produce_curriculum_pack',
    });

    // Track 2: Video & Montage (Runs in parallel)
    makeTask({
      id: 'vid-1',
      track: 'video',
      taskTitle: `بحث وكتابة سيناريو ومشاهد الفيديو: ${title}`,
      desc: fullText,
      department: 'video',
      assigneeId: 'video_scriptwriter',
      participants: ['video_researcher', 'video_scriptwriter', 'video_storyboarder'],
      priority: 2,
      jobType: 'produce_video_script',
    });
    makeTask({
      id: 'vid-2',
      track: 'video',
      taskTitle: `توليد الفيديو والصوت والمونتاج بـ FFmpeg: ${title}`,
      desc: fullText,
      department: 'video',
      assigneeId: 'video_editor',
      participants: ['video_creator', 'video_voice', 'video_fx', 'video_editor'],
      priority: 2,
      dependsOn: ['vid-1'],
      jobType: 'render_real_video',
    });
    makeTask({
      id: 'vid-qa',
      track: 'video',
      taskTitle: `اختبار جودة الفيديو المستقل (Video QA): ${title}`,
      desc: fullText,
      department: 'qa',
      assigneeId: 'video_qa',
      priority: 2,
      dependsOn: ['vid-2'],
      jobType: 'qa_verify_video',
    });

    // Track 3: Educational Game (Runs in parallel)
    makeTask({
      id: 'game-1',
      track: 'game',
      taskTitle: `تصميم وبرمجة اللعبة التعليمية: ${title}`,
      desc: fullText,
      department: 'games',
      assigneeId: 'game_dev',
      participants: ['game_designer', 'game_dev', 'game_ui', 'game_audio'],
      priority: 3,
      jobType: 'build_educational_game',
    });
    makeTask({
      id: 'game-qa',
      track: 'game',
      taskTitle: `اختبار اللعبة المستقل ومراجعة المنهج: ${title}`,
      desc: fullText,
      department: 'qa',
      assigneeId: 'game_tester',
      participants: ['game_tester', 'game_edu_qa'],
      priority: 3,
      dependsOn: ['game-1'],
      jobType: 'qa_verify_game',
    });

    // Track 4: Printable Arabic Booklet PDF & DOCX (Runs in parallel)
    makeTask({
      id: 'bkl-1',
      track: 'booklet',
      taskTitle: `إعداد وتصميم وإخراج الملزمة (PDF + DOCX): ${title}`,
      desc: fullText,
      department: 'booklets',
      assigneeId: 'booklet_pdf',
      participants: ['booklet_curriculum', 'booklet_editor', 'booklet_designer', 'booklet_pdf'],
      priority: 3,
      jobType: 'build_booklet_files',
    });
    makeTask({
      id: 'bkl-qa',
      track: 'booklet',
      taskTitle: `مراجعة صحة الملزمة والملفات (Booklet QA): ${title}`,
      desc: fullText,
      department: 'qa',
      assigneeId: 'booklet_qa',
      priority: 3,
      dependsOn: ['bkl-1'],
      jobType: 'qa_verify_booklet',
    });

    // Final Aggregation & CEO Delivery Report (Waits for all 4 tracks!)
    makeTask({
      id: 'ceo-final',
      track: 'executive',
      taskTitle: `تجميع المخرجات وتقرير التسليم الموحد: ${title}`,
      desc: fullText,
      department: 'executive',
      assigneeId: 'ceo',
      priority: 9,
      dependsOn: ['curr-1', 'vid-qa', 'game-qa', 'bkl-qa'],
      jobType: 'ceo_finalize_project',
    });

    this.db.logAudit('ceo', 'create_multi_track_project', projectId, { title, sourceType });
    this.addLog('ceo', 'طارق (CEO)', `👔 أطلقت مشروعاً متكاملاً "${title}" بـ 4 مسارات متوازية (فيديو + لعبة + ملزمة + حزمة منهج).`);
    this.addMeetingMessage('طارق (CEO)', 'CEO', `بدء المشروع "${title}". كل المسارات المستقلة تعمل بالتوازي الآن وسأستلم تقارير الـ QA المستقلة قبل التسليم النهائي.`);
    this.setAgentState('ceo', 'idle', `يتابع تقدم مشروع: ${title}`, 'تم توزيع المهام على الأقسام 🚀');
    this.persistAndBroadcast();
    return projectId;
  }

  /**
   * Executes up to maxConcurrency ready DAG tasks in parallel!
   */
  async processReadyQueueJobs() {
    if (!this.db?.ready) return 0;
    const now = new Date().toISOString();

    // Unlock waiting_dependency tasks whose dependencies are all completed
    const waiting = this.db.all("SELECT id, depends_on_json FROM tasks WHERE status = 'waiting_dependency'");
    for (const wt of waiting) {
      const deps = safeJson(wt.depends_on_json, []);
      if (deps.length === 0) {
        this.db.run("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?", [now, wt.id]);
        continue;
      }
      const placeholders = deps.map(() => '?').join(',');
      const unfinished = this.db.get(
        `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status != 'completed'`,
        deps
      );
      if (!unfinished || unfinished.c === 0) {
        this.db.run("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ?", [now, wt.id]);
      }
    }

    // Claim up to maxConcurrency ready queued tasks
    const limit = Math.max(1, Math.min(4, Number(this.state.maxConcurrency) || 3));
    const readyJobs = this.db.all(
      `SELECT jq.*, t.title as task_title, t.description as task_desc, t.assignee_id, t.department, t.track, t.checkpoint_json, t.fix_attempts, t.max_attempts, p.title as project_title, p.budget_tokens, p.used_tokens
       FROM job_queue jq
       JOIN tasks t ON jq.task_id = t.id
       JOIN projects p ON jq.project_id = p.id
       WHERE jq.status = 'pending' AND t.status IN ('queued', 'needs_fix')
       ORDER BY jq.priority ASC, jq.created_at ASC
       LIMIT ?`,
      [limit]
    );

    if (readyJobs.length === 0) return 0;

    await Promise.all(readyJobs.map((job) => this.executeSingleQueueJob(job)));
    return readyJobs.length;
  }

  async executeSingleQueueJob(job) {
    const now = new Date().toISOString();
    const agent = this.state.agents.find((a) => a.id === job.assignee_id) || this.state.agents[0];
    const payload = safeJson(job.payload_json, {});
    const checkpoint = safeJson(job.checkpoint_json, {});

    if (job.used_tokens >= job.budget_tokens) {
      this.db.run("UPDATE tasks SET status = 'paused', stop_reason = 'تجاوز ميزانية التوكنز المحددة للمشروع', updated_at = ? WHERE id = ?", [now, job.task_id]);
      this.db.run("UPDATE job_queue SET status = 'failed', last_error = 'Budget exceeded', updated_at = ? WHERE id = ?", [now, job.id]);
      this.addLog('ceo', 'طارق (CEO)', `⛔ تم إيقاف المهمة "${job.task_title}" لتجاوز ميزانية المشروع.`, 'warn');
      return;
    }

    this.db.run("UPDATE job_queue SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?", [
      agent.id,
      now,
      now,
      job.id,
    ]);
    this.db.run("UPDATE tasks SET status = 'in_progress', progress_pct = 35, updated_at = ? WHERE id = ?", [now, job.task_id]);
    this.setAgentState(agent.id, 'working', job.task_title, `أنفّذ: ${job.task_title.slice(0, 34)}...`);
    this.persistAndBroadcast();

    const projectDir = path.join(storage.DELIVERABLES_DIR, 'projects', job.project_id);
    fs.mkdirSync(projectDir, { recursive: true });

    try {
      let outputs = [];
      let tokensUsed = 0;
      let modelUsed = 'builtin:deterministic-v2';

      if (job.job_type === 'produce_curriculum_pack') {
        const res = await this.generateWithAgentAI(
          agent,
          `حلل الدرس التالي وأرجع JSON فقط فيه: {"objectives":["..."],"summary":"...","mindMapNodes":["..."],"questions":[{"question":"...","options":["..."],"answer":"...","answerIndex":0}],"sourceNotes":[{"verified":true,"text":"..."}]}.\nالنص:\n${String(payload.lessonText || '').slice(0, 3500)}`,
          () => null
        );
        const parsed = res.text ? extractJsonBlock(res.text) : null;
        modelUsed = res.usedProvider;
        tokensUsed = res.tokensEst || 0;
        const packData = {
          title: job.project_title,
          curriculumMeta: payload.curriculumMeta || {},
          objectives: parsed?.objectives?.length ? parsed.objectives : [`فهم المفهوم الأساسي في: ${job.project_title}`, 'تطبيق القواعد عملياً عبر الأسئلة'],
          summary: parsed?.summary || String(payload.lessonText || job.project_title).slice(0, 600),
          mindMapNodes: parsed?.mindMapNodes?.length ? parsed.mindMapNodes : ['المفهوم الرئيسي', 'القواعد الأساسية', 'الأمثلة', 'التقويم'],
          questions: parsed?.questions?.length
            ? parsed.questions
            : [
                { question: `ما المحور الأساسي في "${job.project_title}"؟`, options: ['الفهم المنظم للمفهوم وتطبيقه', 'الحفظ دون فهم', 'إهمال المصدر'], answer: 'الفهم المنظم للمفهوم وتطبيقه', answerIndex: 0 },
                { question: 'كيف نتأكد من دقة المعلومة المنهجية؟', options: ['الرجوع لنص الدرس والمصدر الموثق', 'التخمين', 'معلومات عشوائية'], answer: 'الرجوع لنص الدرس والمصدر الموثق', answerIndex: 0 },
                { question: 'ما الهدف من التدريبات العملية؟', options: ['تثبيت الفهم وقياس الإتقان', 'إضاعة الوقت', 'تعقيد الدرس'], answer: 'تثبيت الفهم وقياس الإتقان', answerIndex: 0 },
              ],
          sourceNotes: parsed?.sourceNotes?.length
            ? parsed.sourceNotes
            : [{ verified: true, text: 'محتوى مستخلص ومطابق لنص الدرس المرفق.' }],
        };
        const outDir = path.join(projectDir, 'curriculum');
        gen.generateCurriculumPack({ ...packData, outputDir: outDir });
        this.db.setKV(`project_pack:${job.project_id}`, packData);
        outputs.push(`/deliverables/projects/${job.project_id}/curriculum/curriculum-pack.html`);
        this.registerAsset(job.project_id, job.task_id, 'curriculum-pack.html', 'curriculum', path.join(outDir, 'curriculum-pack.html'));
      } else if (job.job_type === 'produce_video_script') {
        const res = await this.generateWithAgentAI(
          agent,
          `اكتب سيناريو فيديو تعليمي من 4 مشاهد للدرس "${job.project_title}" بصيغة JSON فقط: {"scenes":[{"id":1,"durationSec":4,"heading":"...","subtitle":"...","voiceover":"...","accent":"#38bdf8","bgStart":"#0f172a","bgEnd":"#312e81"}]}\nالمحتوى:\n${String(payload.lessonText || '').slice(0, 2500)}`,
          () => null
        );
        const parsed = res.text ? extractJsonBlock(res.text) : null;
        modelUsed = res.usedProvider;
        tokensUsed = res.tokensEst || 0;
        const scenes = parsed?.scenes?.length
          ? parsed.scenes
          : templates.buildBuiltinVideoV1({ title: job.project_title, topic: payload.lessonText || job.project_title }).scenes;
        this.db.setKV(`project_video_scenes:${job.project_id}`, scenes);
        outputs.push(`checkpoint:scenes(${scenes.length})`);
      } else if (job.job_type === 'render_real_video') {
        const scenes = this.db.getKV(`project_video_scenes:${job.project_id}`) || templates.buildBuiltinVideoV1({ title: job.project_title }).scenes;
        const outDir = path.join(projectDir, 'video');
        const vid = gen.generateRealVideo({ title: job.project_title, topic: payload.lessonText || job.project_title, scenes, outputDir: outDir });
        outputs.push(`/deliverables/projects/${job.project_id}/video/video.mp4`, `/deliverables/projects/${job.project_id}/video/subtitles.srt`);
        this.registerAsset(job.project_id, job.task_id, 'video.mp4', 'video', vid.mp4Path);
        this.state.stats.totalVideosProduced += 1;
        this.state.stats.totalMontageEdits += 1;
        this.state.deliverables.unshift({
          id: `vid-${job.project_id}`,
          type: 'video',
          title: `${job.project_title} (MP4 حقيقي)`,
          version: 2,
          url: `/deliverables/projects/${job.project_id}/video/storyboard.json`,
          mp4Url: `/deliverables/projects/${job.project_id}/video/video.mp4`,
          srtUrl: `/deliverables/projects/${job.project_id}/video/subtitles.srt`,
          createdAt: now,
          provider: modelUsed,
        });
      } else if (job.job_type === 'build_educational_game') {
        const pack = this.db.getKV(`project_pack:${job.project_id}`);
        const questions = pack?.questions || [];
        const outDir = path.join(projectDir, 'game');
        const gm = gen.generateEducationalGame({ title: job.project_title, questions, outputDir: outDir });
        outputs.push(`/deliverables/projects/${job.project_id}/game/game.html`);
        this.registerAsset(job.project_id, job.task_id, 'game.html', 'game', gm.gamePath);
        this.state.stats.totalGamesBuilt += 1;
        this.state.deliverables.unshift({
          id: `game-${job.project_id}`,
          type: 'game',
          title: `لعبة: ${job.project_title}`,
          version: 1,
          url: `/deliverables/projects/${job.project_id}/game/game.html`,
          createdAt: now,
          provider: modelUsed,
        });
      } else if (job.job_type === 'build_booklet_files') {
        const pack = this.db.getKV(`project_pack:${job.project_id}`) || {
          objectives: [`فهم درس ${job.project_title}`],
          summary: String(payload.lessonText || job.project_title).slice(0, 600),
          questions: [{ question: `اشرح الفكرة الرئيسية في ${job.project_title}`, answer: 'ملخص المفهوم الأساسي من الدرس.' }],
          sourceNotes: [{ verified: true, text: 'نص الدرس الأساسي' }],
        };
        const outDir = path.join(projectDir, 'booklet');
        await gen.generateBookletFiles({
          title: `ملزمة: ${job.project_title}`,
          curriculumMeta: payload.curriculumMeta || {},
          objectives: pack.objectives || [],
          summary: pack.summary || '',
          sections: [{ heading: 'الشرح والتطبيق', body: pack.summary || '' }],
          questions: pack.questions || [],
          sourceNotes: pack.sourceNotes || [],
          outputDir: outDir,
        });
        outputs.push(`/deliverables/projects/${job.project_id}/booklet/booklet.pdf`, `/deliverables/projects/${job.project_id}/booklet/booklet.docx`);
        this.registerAsset(job.project_id, job.task_id, 'booklet.pdf', 'pdf', path.join(outDir, 'booklet.pdf'));
        this.registerAsset(job.project_id, job.task_id, 'booklet.docx', 'docx', path.join(outDir, 'booklet.docx'));
        this.state.stats.totalBookletsBuilt += 1;
        this.state.deliverables.unshift({
          id: `bkl-${job.project_id}`,
          type: 'booklet',
          title: `ملزمة PDF/DOCX: ${job.project_title}`,
          version: 1,
          url: `/deliverables/projects/${job.project_id}/booklet/booklet.pdf`,
          docxUrl: `/deliverables/projects/${job.project_id}/booklet/booklet.docx`,
          createdAt: now,
          provider: modelUsed,
        });
      } else if (job.job_type.startsWith('qa_verify_')) {
        const qaType = job.job_type.replace('qa_verify_', '');
        const folderMap = { video: 'video', game: 'game', booklet: 'booklet' };
        const qaRes = gen.runIndependentQA({
          type: qaType,
          outputDir: path.join(projectDir, folderMap[qaType] || qaType),
          title: job.project_title,
        });
        if (!qaRes.passed) {
          for (const b of qaRes.bugs) {
            this.db.run(
              `INSERT INTO bug_reports (id, task_id, project_id, reporter_id, assignee_id, severity, title, repro_steps, expected, actual, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
              ['bug-' + crypto.randomUUID().slice(0, 8), job.task_id, job.project_id, agent.id, job.assignee_id, b.severity, b.title, 'فحص QA مستقل للمخرج', b.expected, b.actual, now]
            );
          }
          throw new Error(`فشل فحص الجودة (${qaRes.bugs.map((x) => x.title).join('؛ ')})`);
        }
        outputs.push(`qa_passed:${qaType}`);
      } else if (job.job_type === 'ceo_finalize_project') {
        const allAssets = this.db.all('SELECT file_name, asset_type, local_path FROM assets_registry WHERE project_id = ?', [job.project_id]);
        const summaryReport = `تم إنجاز المشروع "${job.project_title}" بالكامل عبر 4 مسارات متوازية واجتاز جميع اختبارات الجودة المستقلة (${allAssets.length} ملفات مخرجة جاهزة للمعاينة والتحميل).`;
        this.db.run("UPDATE projects SET status = 'completed', summary_report = ?, updated_at = ? WHERE id = ?", [summaryReport, now, job.project_id]);
        this.addLog('ceo', 'طارق (CEO)', `🎉 ${summaryReport}`);
        this.addMeetingMessage('طارق (CEO)', 'CEO', summaryReport);
        outputs.push('project_delivery_ready');
      }

      // Save agent learning memory
      this.db.run(
        'INSERT INTO agent_memories (id, agent_id, memory_type, project_id, content, quality_score, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ['mem-' + crypto.randomUUID().slice(0, 8), agent.id, 'task_success', job.project_id, `أنجز بنجاح: ${job.task_title}`, agent.qualityScore || 96, now]
      );

      this.db.run(
        `UPDATE tasks SET status = 'completed', progress_pct = 100, output_files_json = ?, checkpoint_json = ?, model_used = ?, tokens_used = tokens_used + ?, updated_at = ? WHERE id = ?`,
        [JSON.stringify(outputs), JSON.stringify({ ...checkpoint, completedAt: now }), modelUsed, tokensUsed, now, job.task_id]
      );
      this.db.run("UPDATE job_queue SET status = 'done', updated_at = ? WHERE id = ?", [now, job.id]);
      this.db.run('UPDATE projects SET used_tokens = used_tokens + ?, updated_at = ? WHERE id = ?', [tokensUsed, now, job.project_id]);

      agent.tasksCompleted += 1;
      this.addLog(agent.id, agent.shortName, `✅ أنجز: ${job.task_title}`);
    } catch (err) {
      const nextAttempts = (job.fix_attempts || 0) + 1;
      if (nextAttempts >= (job.max_attempts || 3)) {
        this.db.run("UPDATE tasks SET status = 'failed', fix_attempts = ?, stop_reason = ?, updated_at = ? WHERE id = ?", [nextAttempts, err.message, now, job.task_id]);
        this.db.run("UPDATE job_queue SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?", [err.message, now, job.id]);
        this.addLog('ceo', 'طارق (CEO)', `❌ فشلت المهمة "${job.task_title}" بعد ${nextAttempts} محاولات: ${err.message}`, 'error');
      } else {
        this.db.run("UPDATE tasks SET status = 'needs_fix', fix_attempts = ?, stop_reason = ?, updated_at = ? WHERE id = ?", [nextAttempts, err.message, now, job.task_id]);
        this.db.run("UPDATE job_queue SET status = 'pending', last_error = ?, updated_at = ? WHERE id = ?", [err.message, now, job.id]);
        this.addLog(agent.id, agent.shortName, `🔧 تحتاج إصلاح (${nextAttempts}/${job.max_attempts || 3}): ${err.message}`, 'warn');
      }
    } finally {
      this.setAgentState(agent.id, 'idle', 'جاهز للمهمة التالية', 'تم التنفيذ بنجاح ✅');
      this.persistAndBroadcast();
    }
  }

  registerAsset(projectId, taskId, fileName, assetType, localPath, extra = {}) {
    if (!this.db?.ready) return;
    const id = 'ast-' + crypto.randomUUID().slice(0, 8);
    this.db.run(
      `INSERT INTO assets_registry (id, project_id, task_id, file_name, asset_type, local_path, source, license, inspection_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        projectId,
        taskId,
        fileName,
        assetType,
        localPath,
        extra.source || 'generated_in_house',
        extra.license || 'Proprietary - AI Virtual Office',
        JSON.stringify(extra.inspection || {}),
        new Date().toISOString(),
      ]
    );
  }

  async runTick(force = false) {
    if (this.isTicking) return;
    if (!this.state.autopilotEnabled && !force) return;

    this.isTicking = true;
    try {
      // 1. Run ready parallel DAG jobs from SQLite job_queue first
      const workedQueue = await this.processReadyQueueJobs();

      // 2. Also keep backward-compatible single-app / single-video customQueue pipeline working
      const activeTask = this.state.tasks.find((t) => t.status !== 'completed');
      const hasQueued = this.state.customQueue.length > 0;

      if (workedQueue > 0 || activeTask || hasQueued || this.state.autoInventProjects || force) {
        this.state.cycleCount += 1;
        if (this.state.cycleCount % 6 === 0) {
          await this.runHRCheck();
        }
        if (activeTask) {
          await this.advanceTask(activeTask);
        } else if (hasQueued || this.state.autoInventProjects) {
          await this.ceoCreateNextProject();
        }
        this.persistAndBroadcast();
      }
    } catch (err) {
      this.addLog('system', 'النظام', `❌ خطأ في دورة العمل: ${err.message}`, 'error');
      this.persistAndBroadcast();
    } finally {
      this.isTicking = false;
    }
  }

  async runHRCheck() {
    const hr = this.state.agents.find((a) => a.id === 'hr');
    if (!hr) return;
    this.setAgentState('hr', 'working', 'مراجعة مؤشرات الأداء وجودة الأقسام', 'أراجع أداء الفريق 📊');
    this.addLog('hr', hr.shortName, `📊 تقرير دوري: ${this.state.agents.length} موظفاً نشطاً في 12 قسماً.`);
    hr.tasksCompleted += 1;
    this.setAgentState('hr', 'idle', 'متابعة كفاءة الفريق وتوازن الأحمال', 'الطاقم متوازن 👍');
  }

  async ceoCreateNextProject() {
    const ceo = this.state.agents.find((a) => a.id === 'ceo');
    if (!ceo) return;

    if (this.state.customQueue.length > 0) {
      const directive = this.state.customQueue.shift();
      const idPrefix = directive.type === 'video' ? 'video' : 'app';
      const newTask = {
        id: `${idPrefix}-${Date.now().toString(36)}`,
        type: directive.type || 'app',
        ideaKey: directive.ideaKey || 'custom',
        title: directive.title,
        description: directive.description || directive.title,
        status: directive.type === 'video' ? 'filming' : 'developing',
        stageLabel: directive.type === 'video' ? 'تصوير وإنتاج المشاهد' : 'تطوير النسخة الأولى',
        assigneeId: directive.type === 'video' ? 'video_creator' : 'app_dev',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliverableUrl: null,
        issues: [],
      };
      this.state.tasks.unshift(newTask);
      this.addLog('ceo', ceo.shortName, `👔 أطلقت مهمة: "${newTask.title}".`);
      return;
    }

    if (this.state.autoInventProjects) {
      const idea = templates.pickNextIdea(this.state.cycleCount);
      const idPrefix = idea.type === 'video' ? 'video' : 'app';
      const newTask = {
        id: `${idPrefix}-${Date.now().toString(36)}`,
        type: idea.type,
        ideaKey: idea.key,
        title: idea.title,
        description: idea.description,
        status: idea.type === 'video' ? 'filming' : 'developing',
        stageLabel: idea.type === 'video' ? 'تصوير وإنتاج المشاهد' : 'تطوير النسخة الأولى',
        assigneeId: idea.type === 'video' ? 'video_creator' : 'app_dev',
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deliverableUrl: null,
        issues: [],
      };
      this.state.tasks.unshift(newTask);
      this.addLog('ceo', ceo.shortName, `👔 ابتكر مشروعاً ذاتياً: "${newTask.title}".`);
    }
  }

  async advanceTask(task) {
    if (task.type === 'app') {
      if (task.status === 'developing') await this.stepBuildApp(task);
      else if (task.status === 'qa_review') await this.stepQAReviewAndFix(task);
      else if (task.status === 'ceo_approval') await this.stepCEOApprove(task);
    } else {
      if (task.status === 'filming') await this.stepCreateVideo(task);
      else if (task.status === 'montage') await this.stepMontageVideo(task);
      else if (task.status === 'ceo_approval') await this.stepCEOApprove(task);
    }
  }

  async stepBuildApp(task) {
    const dev = this.state.agents.find((a) => a.id === 'app_dev');
    this.setAgentState('app_dev', 'coding', `برمجة: ${task.title}`, 'أكتب الكود الآن... 💻');
    this.persistAndBroadcast();

    const prompt = `ابنِ تطبيق ويب كامل ومستقل في ملف HTML واحد فقط (متضمن CSS و JS بدون مكتبات خارجية) باللغة العربية (lang="ar" dir="rtl"):\nالعنوان: ${task.title}\nالوصف: ${task.description}\nأعد كود HTML داخل \`\`\`html ... \`\`\`.`;
    const result = await this.generateWithAgentAI(dev, prompt, () => templates.buildBuiltinAppV1({ key: task.ideaKey, title: task.title }));

    let html = result.fallback;
    if (result.text) {
      const extracted = extractCodeBlock(result.text, 'html');
      if (extracted && extracted.includes('<html')) html = extracted;
      else html = templates.buildBuiltinAppV1({ key: task.ideaKey, title: task.title });
    }

    const safety = scanGeneratedCodeSafety(html);
    if (!safety.safe) {
      this.addLog('devops_sec', 'بلال (الأمن)', `🛡️ تم حظر أنماط غير آمنة في "${task.title}" واستبدالها بنسخة آمنة.`);
      html = templates.buildBuiltinAppV1({ key: task.ideaKey, title: task.title });
    }

    const url = storage.saveAppDeliverable(task.id, html, { title: task.title, version: 1, provider: result.usedProvider });
    task.version = 1;
    task.deliverableUrl = url;
    task.providerUsed = result.usedProvider;
    task.status = 'qa_review';
    task.stageLabel = 'قيد المراجعة والاختبار المستقل';
    task.assigneeId = 'qa_fixer';
    task.updatedAt = new Date().toISOString();
    dev.tasksCompleted += 1;
    this.setAgentState('app_dev', 'idle', 'بانتظار المشروع التالي', 'تم تسليم v1 ✅');
  }

  async stepQAReviewAndFix(task) {
    const qa = this.state.agents.find((a) => a.id === 'qa_fixer');
    this.setAgentState('qa_fixer', 'reviewing', `فحص وتعديل: ${task.title}`, 'أختبر الكود وأصلحه... 🔍');
    this.persistAndBroadcast();

    const currentHtml = storage.readAppDeliverable(task.id) || '';
    let audit = templates.runStaticQAAndAutoFix(currentHtml, task.title);

    if (this.state.llmConfig.provider !== 'builtin' && currentHtml.length < 24000) {
      const prompt = `راجع كود HTML التالي لتطبيق "${task.title}" وأصلح أي مشكلة برمجية أو استجابة، وأعد الكود المحسن داخل \`\`\`html ... \`\`\`:\n${currentHtml}`;
      const res = await this.generateWithAgentAI(qa, prompt, () => null);
      if (res.text) {
        const improved = extractCodeBlock(res.text, 'html');
        if (improved && improved.includes('<html')) {
          audit = templates.runStaticQAAndAutoFix(improved, task.title);
          audit.summary = `تمت المراجعة الذكية عبر (${res.usedProvider}) والتحسين إلى v2.`;
        }
      }
    }

    storage.saveAppDeliverable(task.id, audit.fixedHtml, { title: task.title, version: 2, issuesFixed: audit.issuesFound });
    task.version = 2;
    task.issues = audit.issuesFound;
    task.qaSummary = audit.summary;
    task.status = 'ceo_approval';
    task.stageLabel = 'بانتظار الاعتماد النهائي';
    task.assigneeId = 'ceo';
    task.updatedAt = new Date().toISOString();
    qa.tasksCompleted += 1;
    this.state.stats.totalAutoFixes += 1;
    this.addLog('qa_fixer', qa.shortName, `🔍 ${audit.summary}`);
    this.setAgentState('qa_fixer', 'idle', 'جاهزة للاختبار القادم', 'تم الاعتماد v2 🛠️');
  }

  async stepCreateVideo(task) {
    const creator = this.state.agents.find((a) => a.id === 'video_creator');
    this.setAgentState('video_creator', 'creating', `إنتاج مشاهد: ${task.title}`, 'أجهز المشاهد... 🎬');
    this.persistAndBroadcast();

    const prompt = `اكتب سيناريو فيديو من 4 مشاهد حول "${task.title}" بصيغة JSON فقط: {"title":"...","topic":"...","scenes":[{"id":1,"durationSec":4,"heading":"...","subtitle":"...","bgStart":"#0f172a","bgEnd":"#312e81","accent":"#38bdf8","voiceover":"..."}]}`;
    const res = await this.generateWithAgentAI(creator, prompt, () => templates.buildBuiltinVideoV1({ title: task.title }));
    let videoData = res.fallback;
    if (res.text) {
      const parsed = extractJsonBlock(res.text);
      if (parsed?.scenes?.length) videoData = { ...templates.buildBuiltinVideoV1({ title: task.title }), ...parsed };
    }
    const url = storage.saveVideoDeliverable(task.id, videoData);
    task.deliverableUrl = url;
    task.providerUsed = res.usedProvider;
    task.status = 'montage';
    task.stageLabel = 'في غرفة المونتاج FFmpeg';
    task.assigneeId = 'video_editor';
    task.updatedAt = new Date().toISOString();
    creator.tasksCompleted += 1;
    this.setAgentState('video_creator', 'idle', 'جاهز للفيديو القادم', 'المشاهد جاهزة 🎥');
  }

  async stepMontageVideo(task) {
    const editor = this.state.agents.find((a) => a.id === 'video_editor');
    this.setAgentState('video_editor', 'editing', `مونتاج FFmpeg: ${task.title}`, 'أنتج MP4 حقيقي... ✂️');
    this.persistAndBroadcast();

    const rawVideo = storage.readVideoDeliverable(task.id) || templates.buildBuiltinVideoV1({ title: task.title });
    const outDir = path.join(storage.VIDEOS_DIR, task.id);
    const vid = gen.generateRealVideo({
      title: task.title,
      topic: rawVideo.topic || task.title,
      scenes: rawVideo.scenes,
      outputDir: outDir,
    });
    task.mp4Url = `/deliverables/videos/${task.id}/video.mp4`;
    task.srtUrl = `/deliverables/videos/${task.id}/subtitles.srt`;
    task.version = 2;
    task.status = 'ceo_approval';
    task.stageLabel = 'بانتظار الاعتماد النهائي';
    task.assigneeId = 'ceo';
    task.updatedAt = new Date().toISOString();
    editor.tasksCompleted += 1;
    this.state.stats.totalMontageEdits += 1;
    this.addLog('video_editor', editor.shortName, `✂️ تم مونتاج وإخراج ملف MP4 حقيقي (${Math.round(vid.mp4Size / 1024)} KB) لـ "${task.title}".`);
    this.setAgentState('video_editor', 'idle', 'جاهزة للمونتاج القادم', 'تم إخراج MP4 🎞️');
  }

  async stepCEOApprove(task) {
    const ceo = this.state.agents.find((a) => a.id === 'ceo');
    task.status = 'completed';
    task.stageLabel = 'مكتمل ومعتمد';
    task.updatedAt = new Date().toISOString();
    ceo.tasksCompleted += 1;
    if (task.type === 'app') this.state.stats.totalAppsBuilt += 1;
    else this.state.stats.totalVideosProduced += 1;

    this.state.deliverables.unshift({
      id: task.id,
      type: task.type,
      title: task.title,
      version: task.version,
      url: task.deliverableUrl,
      mp4Url: task.mp4Url || null,
      srtUrl: task.srtUrl || null,
      qaSummary: task.qaSummary || '',
      provider: task.providerUsed || 'builtin',
      createdAt: task.updatedAt,
    });
    if (this.state.deliverables.length > 60) this.state.deliverables = this.state.deliverables.slice(0, 60);
    this.addLog('ceo', ceo.shortName, `🎉 اعتمد تسليم "${task.title}" (v${task.version}).`);
  }

  enqueueDirective({ type = 'app', title, description = '', multiTrack = false, lessonText = '', curriculumMeta = {} }) {
    if (multiTrack || lessonText) {
      return { projectId: this.createMultiTrackProject({ title, description, lessonText, curriculumMeta }) };
    }
    this.state.customQueue.push({ type, title, description: description || title, ideaKey: 'custom' });
    this.addLog('system', 'أنت (المالك)', `📌 طلب مباشر: "${title}"`);
    this.persistAndBroadcast();
    return { queued: true };
  }

  async conveneMeeting({ title, projectId = '', participantIds = ['ceo', 'hr', 'qa_fixer', 'video_creator', 'game_dev'], agenda = [] }) {
    const participants = participantIds
      .map((id) => this.state.agents.find((a) => a.id === id))
      .filter(Boolean);
    const ceo = this.state.agents.find((a) => a.id === 'ceo');
    const transcript = [];
    const decisions = [];

    for (const p of participants.slice(0, 5)) {
      const reply = await this.generateWithAgentAI(
        p,
        `أنت في اجتماع تنسيقي بعنوان "${title}". جدول الأعمال: ${agenda.join('، ')}. أعطِ مداخلة عملية في سطرين فقط.`,
        () => `جاهز من قسم ${p.departmentLabel} لتنفيذ المطلوب وفق معايير الجودة.`
      );
      const text = reply.text ? reply.text.trim() : reply.fallback;
      transcript.push({ speaker: p.shortName, role: p.role, text, timestamp: new Date().toISOString() });
      this.addMeetingMessage(p.shortName, p.role, text);
    }

    const summary = `ملخص اجتماع "${title}": تم الاتفاق على التنفيذ المتوازي ومراجعة الجودة المستقلة.`;
    decisions.push({ decision: `تنفيذ مخرجات "${title}"`, owner: ceo?.shortName || 'طارق', followUp: 'خلال الدورة القادمة' });

    if (this.db?.ready) {
      this.db.run(
        `INSERT INTO meetings (id, title, project_id, participants_json, agenda_json, transcript_json, summary, decisions_json, follow_up_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'mtg-' + crypto.randomUUID().slice(0, 8),
          title,
          projectId,
          JSON.stringify(participants.map((p) => p.id)),
          JSON.stringify(agenda),
          JSON.stringify(transcript),
          summary,
          JSON.stringify(decisions),
          new Date(Date.now() + 86400000).toISOString(),
          new Date().toISOString(),
        ]
      );
    }
    this.addLog('ceo', 'طارق (CEO)', `🤝 انعقد اجتماع: "${title}" بحضور ${participants.length} قيادات.`);
    this.persistAndBroadcast();
    return { title, summary, transcript, decisions };
  }

  async runInnovationReport() {
    const innovator = this.state.agents.find((a) => a.id === 'ai_innovator');
    if (!innovator) throw new Error('AI Innovator not found');
    this.setAgentState(innovator.id, 'working', 'إعداد تقرير التطوير والابتكار في AI', 'أبحث في أحدث النماذج والأدوات... 🧪');
    this.persistAndBroadcast();

    const res = await this.generateWithAgentAI(
      innovator,
      `أعد تقريراً مختصراً ومنظماً لـ أ. طارق والمالك يوضح:
1) ما الجديد في نماذج AI والفيديو والصوت والـ3D؟
2) ما الذي يضيفه للمكتب؟
3) هل توجد نسخة مجانية وحدودها والتكلفة المحتملة؟
4) مخاطر الخصوصية والأمان وخطة التجربة الآمنة (بدون تنفيذ تلقائي).`,
      () =>
        'توصية ابتكار: تجربة نماذج Groq السريعة (openai/gpt-oss-120b) مع Gemini Flash Lite وFFmpeg المحلي، كلهم ضمن الحدود المجانية دون تكلفة أو تغيير تلقائي على الإنتاج.'
    );
    const report = res.text ? res.text.trim() : res.fallback;
    this.addLog(innovator.id, innovator.shortName, `🧪 رفع تقرير ابتكار لـ أ. طارق (بانتظار موافقة المالك قبل أي تغيير).`);
    this.addMeetingMessage(innovator.shortName, 'AI_INNOVATOR', report);
    this.setAgentState(innovator.id, 'idle', 'رصد تطورات نماذج AI وأدوات الإنتاج', 'تقرير الابتكار مرفوع ✅');
    this.persistAndBroadcast();
    return { report, requiresOwnerApproval: true };
  }

  async chatWithAgent(agentId, message) {
    const agent = this.state.agents.find((a) => a.id === agentId) || this.state.agents[0];
    if (!agent) throw new Error('Agent not found');

    this.setAgentState(agent.id, 'thinking', `ينفذ طلب المالك: ${message.slice(0, 40)}`, 'أنفّذ طلبك الآن... ⚡');
    this.persistAndBroadcast();

    const lower = message.toLowerCase();
    const now = new Date().toISOString();
    const cleanTitle = message.slice(0, 70).trim();
    const files = [];
    let reply = '';
    let usedProvider = 'system';
    let triggeredProjectId = null;

    const wantsPptx =
      lower.includes('باوربوينت') ||
      lower.includes('بوربوينت') ||
      lower.includes('باور بوينت') ||
      lower.includes('بور بوينت') ||
      lower.includes('powerpoint') ||
      lower.includes('pptx') ||
      lower.includes('عرض تقديمي') ||
      lower.includes('شرائح');

    const wantsBooklet =
      lower.includes('ملزمة') ||
      lower.includes('بوكليت') ||
      lower.includes('pdf') ||
      lower.includes('docx') ||
      lower.includes('وورد');

    const wantsImage =
      lower.includes('صورة') ||
      lower.includes('صوره') ||
      lower.includes('صور') ||
      lower.includes('ارسم') ||
      lower.includes('توليد صورة');

    const wantsVideo = lower.includes('فيديو') || lower.includes('مونتاج') || lower.includes('mp4');
    const wantsGame = lower.includes('لعبة') || lower.includes('لعبه');
    const wantsApp =
      lower.includes('تطبيق') || lower.includes('برنامج') || lower.includes('موقع') || lower.includes('صفحة') || lower.includes('أداة');
    const wantsMultiTrack = lower.includes('درس متكامل') || lower.includes('كل الأقسام') || (lower.includes('درس') && (wantsVideo || wantsBooklet || wantsGame));

    if (wantsMultiTrack) {
      triggeredProjectId = this.createMultiTrackProject({ title: cleanTitle, description: message, lessonText: message });
      reply = `تم استلام الدرس وإطلاق المشروع (${triggeredProjectId}) فوراً بـ 4 مسارات متوازية (فيديو MP4 + لعبة + ملزمة PDF/DOCX + حزمة المنهج). تابع التقدم والمخرجات في تبويب "المشاريع" الآن.`;
    } else if (wantsPptx) {
      const id = 'pptx-' + Date.now().toString(36);
      const outDir = path.join(storage.DELIVERABLES_DIR, 'pptx', id);
      const aiRes = await this.generateWithAgentAI(
        agent,
        `أنشئ محتوى عرض PowerPoint احترافي بالعربية عن: "${message}". أرجع JSON فقط بهذا الشكل:
{"title":"عنوان العرض","subtitle":"وصف مختصر","slides":[{"heading":"عنوان الشريحة","bullets":["نقطة 1","نقطة 2","نقطة 3"]}]}`,
        () => null
      );
      usedProvider = aiRes.usedProvider;
      const parsed = aiRes.text ? extractJsonBlock(aiRes.text) : null;
      const pptxData = await gen.generatePowerPointPptx({
        title: parsed?.title || cleanTitle,
        subtitle: parsed?.subtitle || 'عرض تقديمي احترافي — شركة الذكاء الاصطناعي',
        slides: parsed?.slides || [],
        outputDir: outDir,
      });
      const url = `/deliverables/pptx/${id}/presentation.pptx`;
      this.registerAsset(id, id, 'presentation.pptx', 'pptx', pptxData.pptxPath);
      this.state.deliverables.unshift({
        id,
        type: 'pptx',
        title: parsed?.title || cleanTitle,
        version: 1,
        url,
        createdAt: now,
        provider: usedProvider,
      });
      files.push({ name: 'presentation.pptx', url, type: 'pptx', size: pptxData.size });
      reply = `تم إنشاء ملف الـ PowerPoint الفعلي الآن (${pptxData.slideCount} شرائح، حجم ${(pptxData.size / 1024).toFixed(1)} KB) عبر (${usedProvider}). تقدر تحمله وتفتحه فوراً من الزر بالأسفل:`;
    } else if (wantsImage) {
      const id = 'img-' + Date.now().toString(36);
      const outDir = path.join(storage.DELIVERABLES_DIR, 'images', id);
      const imgRes = await gen.generateImageDeliverable({
        prompt: message,
        title: cleanTitle,
        hfApiKey: this.state.llmConfig?.hfApiKey || process.env.HF_API_KEY || '',
        outputDir: outDir,
      });
      if (imgRes.ok) {
        const url = `/deliverables/images/${id}/image.png`;
        this.registerAsset(id, id, 'image.png', 'image', imgRes.imgPath);
        this.state.deliverables.unshift({ id, type: 'image', title: cleanTitle, version: 1, url, createdAt: now, provider: imgRes.mode });
        files.push({ name: 'image.png', url, type: 'image', size: imgRes.size });
        reply = `تم توليد الصورة الحقيقية الآن (${(imgRes.size / 1024).toFixed(1)} KB). اضغط لفتحها أو تحميلها:`;
      } else {
        reply = `بصراحة وبدون وعود وهمية: ${imgRes.reason} أضف مفتاح Hugging Face مجاني (hf_...) من تبويب الإعدادات وسأولّد لك أي صورة بالذكاء الاصطناعي في ثوانٍ، أو اطلب مني الآن فوراً عرض PowerPoint أو ملزمة PDF/DOCX أو فيديو MP4 أو تطبيق ويب!`;
      }
    } else if (wantsBooklet) {
      const id = 'bkl-' + Date.now().toString(36);
      const outDir = path.join(storage.DELIVERABLES_DIR, 'booklets', id);
      const aiRes = await this.generateWithAgentAI(
        agent,
        `أنشئ محتوى ملزمة PDF/DOCX عن: "${message}". أرجع JSON فقط: {"title":"...","objectives":["..."],"summary":"...","questions":[{"question":"...","options":["..."],"answer":"..."}]}`,
        () => null
      );
      usedProvider = aiRes.usedProvider;
      const parsed = aiRes.text ? extractJsonBlock(aiRes.text) : null;
      const bkl = await gen.generateBookletFiles({
        title: parsed?.title || cleanTitle,
        objectives: parsed?.objectives || [`فهم موضوع: ${cleanTitle}`],
        summary: parsed?.summary || message,
        sections: [{ heading: 'الشرح والتفصيل', body: parsed?.summary || message }],
        questions: parsed?.questions || [{ question: `ما أهم فكرة في ${cleanTitle}؟`, answer: 'مراجعة الملخص الأساسي.' }],
        sourceNotes: [{ verified: true, text: 'تم إعداده مباشرة بناءً على طلب المالك' }],
        outputDir: outDir,
      });
      const pdfUrl = `/deliverables/booklets/${id}/booklet.pdf`;
      const docxUrl = `/deliverables/booklets/${id}/booklet.docx`;
      this.state.stats.totalBookletsBuilt += 1;
      this.state.deliverables.unshift({ id, type: 'booklet', title: parsed?.title || cleanTitle, version: 1, url: pdfUrl, docxUrl, createdAt: now, provider: usedProvider });
      files.push({ name: 'booklet.pdf', url: pdfUrl, type: 'pdf', size: bkl.pdfSize });
      files.push({ name: 'booklet.docx', url: docxUrl, type: 'docx', size: bkl.docxSize });
      reply = `تم إنشاء الملزمة الفعلية بصيغتي PDF و Word (.docx) الآن! يمكنك تحميلها فوراً من الأزرار التالية:`;
    } else if (wantsVideo) {
      const id = 'vid-' + Date.now().toString(36);
      const outDir = path.join(storage.VIDEOS_DIR, id);
      const aiRes = await this.generateWithAgentAI(
        agent,
        `اكتب سيناريو فيديو قصير من 3 مشاهد عن "${message}" بصيغة JSON فقط: {"title":"...","scenes":[{"id":1,"durationSec":4,"heading":"...","subtitle":"...","voiceover":"...","accent":"#38bdf8","bgStart":"#0f172a","bgEnd":"#312e81"}]}`,
        () => null
      );
      usedProvider = aiRes.usedProvider;
      const parsed = aiRes.text ? extractJsonBlock(aiRes.text) : null;
      const vid = gen.generateRealVideo({
        title: parsed?.title || cleanTitle,
        topic: message,
        scenes: parsed?.scenes || [],
        outputDir: outDir,
      });
      const mp4Url = `/deliverables/videos/${id}/video.mp4`;
      const srtUrl = `/deliverables/videos/${id}/subtitles.srt`;
      this.state.stats.totalVideosProduced += 1;
      this.state.deliverables.unshift({ id, type: 'video', title: parsed?.title || cleanTitle, version: 2, url: `/deliverables/videos/${id}/storyboard.json`, mp4Url, srtUrl, createdAt: now, provider: usedProvider });
      files.push({ name: 'video.mp4', url: mp4Url, type: 'video', size: vid.mp4Size });
      files.push({ name: 'subtitles.srt', url: srtUrl, type: 'srt' });
      reply = `تم إخراج الفيديو الفعلي MP4 (${vid.durationSec} ثانية، ${(vid.mp4Size / 1024).toFixed(1)} KB) مع ملف الترجمة SRT الآن! اضغط لمشاهدته أو تحميله:`;
    } else if (wantsGame) {
      const id = 'game-' + Date.now().toString(36);
      const outDir = path.join(storage.DELIVERABLES_DIR, 'games', id);
      const gm = gen.generateEducationalGame({ title: cleanTitle, outputDir: outDir });
      const url = `/deliverables/games/${id}/game.html`;
      this.state.stats.totalGamesBuilt += 1;
      this.state.deliverables.unshift({ id, type: 'game', title: cleanTitle, version: 1, url, createdAt: now, provider: 'system' });
      files.push({ name: 'game.html', url, type: 'game', size: gm.size });
      reply = `تم بناء اللعبة التفاعلية الآن ويمكنك تشغيلها مباشرة من الزر بالأسفل:`;
    } else if (wantsApp) {
      const id = 'app-' + Date.now().toString(36);
      const aiRes = await this.generateWithAgentAI(
        agent,
        `ابنِ تطبيق ويب كامل ومستقل في ملف HTML واحد فقط بالعربية (dir="rtl") لتنفيذ: "${message}". أعد كود HTML داخل \`\`\`html ... \`\`\`.`,
        () => templates.buildBuiltinAppV1({ key: 'custom', title: cleanTitle })
      );
      usedProvider = aiRes.usedProvider;
      let html = aiRes.fallback;
      if (aiRes.text) {
        const ext = extractCodeBlock(aiRes.text, 'html');
        if (ext && ext.includes('<html')) html = ext;
      }
      const audit = templates.runStaticQAAndAutoFix(html, cleanTitle);
      const url = storage.saveAppDeliverable(id, audit.fixedHtml, { title: cleanTitle, version: 2, provider: usedProvider });
      this.state.stats.totalAppsBuilt += 1;
      this.state.deliverables.unshift({ id, type: 'app', title: cleanTitle, version: 2, url, createdAt: now, provider: usedProvider });
      files.push({ name: 'index.html', url, type: 'app' });
      reply = `تم بناء التطبيق ومراجعته تلقائياً (v2) الآن عبر (${usedProvider}). افتحه مباشرة من الزر بالأسفل:`;
    } else {
      const dbOverview = this.getDbOverview();
      const contextSummary = `حالة الشركة: مشاريع=${dbOverview.projects.length}، تطبيقات=${this.state.stats.totalAppsBuilt}، فيديوهات=${this.state.stats.totalVideosProduced}، ألعاب=${this.state.stats.totalGamesBuilt}، ملازم=${this.state.stats.totalBookletsBuilt}.`;
      const strictRules = `قواعد صارمة جداً يجب الالتزام بها في ردك:
1. ممنوع منعاً باتاً إعطاء أي مواعيد أو وعود زمنية وهمية مثل "خلال ساعتين" أو "خلال 3 أيام" أو "أسبوعين" أو "هرسله لك لاحقاً".
2. إذا سأل المالك عن ربط Arena.ai، وضح بصدق أن المكتب يدعم الآن بوابة Arena API الرسمية (https://api.arena.ai/v1) ضمن قائمة المزودات، ولكن لا يوجد مفتاح عام مجاني مشترك — يحتاج المالك فقط إلى إنشاء مفتاحه الشخصي من https://platform.arena.ai/dashboard/keys ولصقه في تبويب الإعدادات.
3. ما تستطيع تنفيذه فوراً هنا خلال ثوانٍ هو: عروض PowerPoint (.pptx)، ملازم PDF و Word (.docx)، فيديوهات MP4، تطبيقات ويب HTML، وألعاب تعليمية؛ أما الصور الفوتوغرافية بالذكاء الاصطناعي فتتطلب إضافة مفتاح HuggingFace مجاني (HF_API_KEY) في الإعدادات.
4. أجب باللهجة المصرية الاحترافية المباشرة في 3 أسطر كحد أقصى.`;

      const res = await this.generateWithAgentAI(
        agent,
        `${strictRules}\n${contextSummary}\nرسالة المالك: "${message}"`,
        () => `أهلاً بك يا فندم! أنا ${agent.name}. اطلب مني فوراً (باوربوينت / ملزمة PDF وWord / فيديو MP4 / تطبيق ويب) وسأنفذه وأسلمه لك هنا خلال ثوانٍ.`
      );
      usedProvider = res.usedProvider;
      reply = res.text ? res.text.trim() : res.fallback;
    }

    this.addMeetingMessage('أنت (المالك)', 'Owner', `@${agent.shortName}: ${message}`);
    this.addMeetingMessage(agent.shortName, agent.role, reply);
    this.addLog(agent.id, agent.shortName, `⚡ ${files.length ? `أنجز وأرفق ${files.length} ملف` : 'رد على المالك'} (${usedProvider})`);
    this.setAgentState(agent.id, 'idle', 'جاهز لطلبك القادم', reply.slice(0, 70));
    this.persistAndBroadcast();
    return { agent, reply, usedProvider, triggeredProjectId, files };
  }

  toggleAutopilot(enabled) {
    this.state.autopilotEnabled = typeof enabled === 'boolean' ? enabled : !this.state.autopilotEnabled;
    if (this.state.autopilotEnabled) this.scheduleNextTick();
    else this.stop();
    this.addLog('system', 'النظام', this.state.autopilotEnabled ? '▶️ تم استئناف التشغيل التلقائي 24/7.' : '⏸️ تم إيقاف التشغيل التلقائي مؤقتاً.');
    this.persistAndBroadcast();
  }

  updateSettings(settings = {}) {
    if (settings.tickIntervalMs) {
      this.state.tickIntervalMs = Math.max(2000, Math.min(300000, Number(settings.tickIntervalMs)));
    }
    if (settings.maxConcurrency) {
      this.state.maxConcurrency = Math.max(1, Math.min(4, Number(settings.maxConcurrency)));
    }
    if (typeof settings.autoInventProjects === 'boolean') {
      this.state.autoInventProjects = settings.autoInventProjects;
    }
    if (settings.llmConfig) {
      const next = { ...this.state.llmConfig, ...settings.llmConfig };
      if (settings.llmConfig.apiKey === '' || String(settings.llmConfig.apiKey || '').startsWith('••••')) {
        next.apiKey = this.state.llmConfig.apiKey;
      }
      if (settings.llmConfig.backupApiKey === '' || String(settings.llmConfig.backupApiKey || '').startsWith('••••')) {
        next.backupApiKey = this.state.llmConfig.backupApiKey;
      }
      if (settings.llmConfig.hfApiKey === '' || String(settings.llmConfig.hfApiKey || '').startsWith('••••')) {
        next.hfApiKey = this.state.llmConfig.hfApiKey;
      }
      this.state.llmConfig = next;
    }
    this.scheduleNextTick();
    this.addLog('devops_sec', 'بلال (DevOps)', '⚙️ تم تحديث إعدادات الشركة والموديلات وحمايتها على الخادم.');
    this.persistAndBroadcast();
  }

  hireCustomEmployee({ name, role, room, avatar, color, systemPrompt }) {
    const id = `emp-${Date.now().toString(36)}`;
    const agent = {
      id,
      name,
      shortName: name.split('—')[0].trim(),
      role: role || 'SPECIALIST',
      department: 'custom',
      departmentLabel: 'تخصص إضافي',
      room: room || 'مكتب العمليات',
      roomId: 'reception',
      avatar: avatar || '🤖',
      color: color || '#0ea5e9',
      desk: { x: 75, y: 18 },
      preferredModelClass: 'reasoning',
      permissions: ['execute_assigned'],
      guardrails: 'يعمل ضمن المهام المسندة له فقط.',
      jobDescription: systemPrompt || 'متخصص إضافي في المكتب.',
      status: 'idle',
      currentTask: 'جاهز للمهام',
      tasksCompleted: 0,
      qualityScore: 95,
      systemPrompt: systemPrompt || `أنت ${name} وتعمل بمسؤولية عالية في المكتب الافتراضي.`,
    };
    this.state.agents.push(agent);
    this.state.stats.totalHires += 1;
    this.addLog('hr', 'سارة (HR)', `✨ تم تعيين موظف جديد: "${name}".`);
    this.persistAndBroadcast();
    return agent;
  }

  resetOffice() {
    this.state.cycleCount = 0;
    this.state.tasks = [];
    this.state.deliverables = [];
    this.state.customQueue = [];
    this.state.meetings = [];
    this.state.stats = {
      totalAppsBuilt: 0,
      totalAutoFixes: 0,
      totalVideosProduced: 0,
      totalMontageEdits: 0,
      totalGamesBuilt: 0,
      totalBookletsBuilt: 0,
      totalHires: 0,
    };
    this.state.agents = structuredClone(INITIAL_AGENTS);
    this.state.logs = [];
    if (this.db?.ready) this.db.resetOperationalData();
    this.addLog('system', 'النظام', '🧹 تم تصفير الشركة والبدء من الصفر (0) — بانتظار أول أمر أو درس منك.');
    this.persistAndBroadcast();
  }

  exportFullBackup() {
    const deliverablesFiles = {};
    if (fs.existsSync(storage.APPS_DIR)) {
      for (const dir of fs.readdirSync(storage.APPS_DIR)) {
        const html = storage.readAppDeliverable(dir);
        if (html) deliverablesFiles[dir] = html;
      }
    }
    return {
      exportedAt: new Date().toISOString(),
      version: 2,
      state: this.getPublicState(),
      appsHtml: deliverablesFiles,
    };
  }

  restoreBackup(backup) {
    if (!backup || !backup.state) throw new Error('ملف النسخة الاحتياطية غير صالح');
    const savedKey = this.state.llmConfig.apiKey;
    const savedBackupKey = this.state.llmConfig.backupApiKey;
    this.state = { ...structuredClone(DEFAULT_STATE), ...backup.state };
    this.state.llmConfig.apiKey = savedKey;
    this.state.llmConfig.backupApiKey = savedBackupKey;
    if (backup.appsHtml) {
      for (const [id, html] of Object.entries(backup.appsHtml)) {
        storage.saveAppDeliverable(id, html, { restored: true });
      }
    }
    this.persistAndBroadcast();
  }
}

function safeJson(raw, fallback) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

module.exports = { VirtualOfficeOrchestrator, TASK_STATUS_LABELS };
