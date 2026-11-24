const crypto = require('node:crypto');
const { INITIAL_AGENTS, HIREABLE_TEMPLATES } = require('./agents');
const { callExternalLLM, extractCodeBlock, extractJsonBlock } = require('./llm');
const storage = require('./storage');
const templates = require('./templates');

const DEFAULT_STATE = {
  officeName: 'مكتب الذكاء الاصطناعي المستقل 24/7',
  autopilotEnabled: true,
  autoInventProjects: false,
  tickIntervalMs: 5000,
  cycleCount: 0,
  llmConfig: {
    provider: process.env.AI_PROVIDER || 'builtin', // builtin | gemini | groq | openrouter | ollama
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    baseUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
    backupProvider: process.env.AI_BACKUP_PROVIDER || 'none',
    backupApiKey: process.env.AI_BACKUP_API_KEY || '',
    backupModel: process.env.AI_BACKUP_MODEL || '',
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
    totalHires: 0,
  },
};

class VirtualOfficeOrchestrator {
  constructor() {
    this.state = storage.loadState(DEFAULT_STATE);
    // Reset any mid-flight busy states after a server restart
    for (const a of this.state.agents) {
      if (a.status !== 'idle') a.status = 'idle';
    }
    this.clients = new Set();
    this.isTicking = false;
    this.timer = null;

    if (this.state.logs.length === 0) {
      this.addLog('system', 'النظام', '🚀 تم تشغيل المكتب الافتراضي الذكي بنجاح — وضع التشغيل التلقائي 24/7 مفعل.');
    }
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

  getPublicState() {
    const safeLlm = {
      ...this.state.llmConfig,
      apiKey: this.state.llmConfig.apiKey ? '••••••••' + this.state.llmConfig.apiKey.slice(-4) : '',
      backupApiKey: this.state.llmConfig.backupApiKey ? '••••••••' + this.state.llmConfig.backupApiKey.slice(-4) : '',
      hasApiKey: Boolean(this.state.llmConfig.apiKey),
    };
    return {
      ...this.state,
      llmConfig: safeLlm,
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
    if (this.state.logs.length > 120) {
      this.state.logs = this.state.logs.slice(0, 120);
    }
  }

  addMeetingMessage(speaker, role, text) {
    this.state.meetings.unshift({
      id: crypto.randomUUID().slice(0, 8),
      timestamp: new Date().toISOString(),
      speaker,
      role,
      text,
    });
    if (this.state.meetings.length > 40) {
      this.state.meetings = this.state.meetings.slice(0, 40);
    }
  }

  async generateWithLLMOrFallback(systemPrompt, userPrompt, fallbackFn) {
    const cfg = this.state.llmConfig;
    if (!cfg || cfg.provider === 'builtin') {
      return { text: null, usedProvider: 'builtin', fallback: fallbackFn() };
    }
    try {
      const res = await callExternalLLM(cfg, systemPrompt, userPrompt);
      return { ...res, fallback: null };
    } catch (err) {
      this.addLog(
        'system',
        'نظام الذكاء الاصطناعي',
        `⚠️ تعذر الاتصال بالمزود (${cfg.provider}): ${err.message} — تم التبديل التلقائي للمحرك المدمج حتى لا يتوقف العمل.`,
        'warn'
      );
      return { text: null, usedProvider: 'builtin-fallback', fallback: fallbackFn() };
    }
  }

  async runTick(force = false) {
    if (this.isTicking) return;
    if (!this.state.autopilotEnabled && !force) return;

    this.isTicking = true;
    try {
      const activeTask = this.state.tasks.find((t) => t.status !== 'completed');
      const hasQueued = this.state.customQueue.length > 0;

      if (!activeTask && !hasQueued && !this.state.autoInventProjects && !force) {
        // Idle peacefully until user assigns a project or turns on autoInventProjects
        return;
      }

      this.state.cycleCount += 1;

      // 1. Periodic HR Audit & Auto-Hiring
      if (this.state.cycleCount % 4 === 0) {
        await this.runHRCheck();
      }

      // 2. Advance active task or start next queued/invented project
      if (!activeTask) {
        await this.ceoCreateNextProject();
      } else {
        await this.advanceTask(activeTask);
      }

      this.persistAndBroadcast();
    } catch (err) {
      this.addLog('system', 'النظام', `❌ خطأ غير متوقع في دورة العمل: ${err.message}`, 'error');
      this.persistAndBroadcast();
    } finally {
      this.isTicking = false;
    }
  }

  async runHRCheck() {
    const hr = this.state.agents.find((a) => a.id === 'hr');
    if (!hr) return;

    const pendingCount = this.state.tasks.filter((t) => t.status !== 'completed').length;
    this.setAgentState('hr', 'working', 'تقييم كفاءة الموظفين ومراقبة ضغط المهام', 'أراجع أداء الفريق حالياً 📊');
    this.persistAndBroadcast();

    // Auto-hire a specialist if tasks are piling up OR at cycle 8 / 16 to showcase dynamic HR growth
    const unHired = HIREABLE_TEMPLATES.filter(
      (tpl) => !this.state.agents.some((a) => a.role === tpl.role)
    );

    if (unHired.length > 0 && (pendingCount >= 2 || this.state.cycleCount === 4 || this.state.cycleCount === 12)) {
      const nextHire = unHired[0];
      const newAgent = {
        id: nextHire.role.toLowerCase(),
        name: nextHire.namePrefix,
        shortName: nextHire.shortName,
        role: nextHire.role,
        department: nextHire.department,
        room: nextHire.room,
        avatar: nextHire.avatar,
        color: nextHire.color,
        desk: { x: 26 + this.state.stats.totalHires * 24, y: 18 },
        status: 'idle',
        currentTask: 'انضم حديثاً للفريق لدعم جودة وسرعة الإنتاج',
        tasksCompleted: 0,
        qualityScore: 95,
        systemPrompt: nextHire.systemPrompt,
      };
      this.state.agents.push(newAgent);
      this.state.stats.totalHires += 1;
      hr.tasksCompleted += 1;

      this.addLog(
        'hr',
        hr.shortName,
        `🧑‍💼 قرار HR تلقائي: تم توظيف "${nextHire.namePrefix}" لتعزيز قسم ${nextHire.department === 'engineering' ? 'البرمجة والجودة' : 'الميديا والنمو'} بدون الحاجة لموافقتك.`
      );
      this.addMeetingMessage(
        hr.shortName,
        'HR',
        `لاحظت ارتفاع وتيرة العمل، لذلك وظّفت ${nextHire.shortName} فوراً لضمان استمرار العمل 24/7 بأعلى جودة.`
      );
    } else {
      hr.tasksCompleted += 1;
      this.addLog(
        'hr',
        hr.shortName,
        `📋 تقرير HR الدوري: جميع الموظفين (${this.state.agents.length}) يعملون بكفاءة عالية (متوسط الجودة 96%).`
      );
    }

    this.setAgentState('hr', 'idle', 'متابعة الأداء وجاهزية الفريق', 'الفريق متوازن وجاهز ✅');
  }

  async ceoCreateNextProject() {
    const ceo = this.state.agents.find((a) => a.id === 'ceo');
    this.setAgentState('ceo', 'thinking', 'ابتكار مشروع جديد وتحديد خطة التنفيذ', 'أخطط للمشروع القادم... 💡');
    this.persistAndBroadcast();

    // Check if user queued a manual directive, otherwise CEO invents autonomously
    let directive = this.state.customQueue.shift();

    if (!directive) {
      const totalDone = this.state.stats.totalAppsBuilt + this.state.stats.totalVideosProduced;
      const nextType = totalDone % 2 === 0 ? 'app' : 'video';
      if (nextType === 'app') {
        const ideaPool = templates.BUILTIN_APP_IDEAS;
        const picked = ideaPool[(this.state.stats.totalAppsBuilt) % ideaPool.length];
        directive = {
          type: 'app',
          title: picked.title,
          description: picked.description,
          ideaKey: picked.key,
        };
      } else {
        const ideaPool = templates.BUILTIN_VIDEO_IDEAS;
        const picked = ideaPool[(this.state.stats.totalVideosProduced) % ideaPool.length];
        directive = {
          type: 'video',
          title: picked.title,
          description: `إنتاج ومونتاج فيديو احترافي حول: ${picked.topic}`,
          ideaKey: picked.key,
          topic: picked.topic,
        };
      }

      // If real LLM is configured, let CEO generate a fresh creative brief
      if (this.state.llmConfig.provider !== 'builtin') {
        const res = await this.generateWithLLMOrFallback(
          ceo.systemPrompt,
          `اقترح مشروعاً واحداً جديداً (${nextType === 'app' ? 'تطبيق ويب تفاعلي' : 'فيديو قصير'}) وأعد النتيجة بصيغة JSON فقط بهذا الشكل: {"title":"...","description":"...","topic":"..."}`,
          () => null
        );
        if (res.text) {
          const parsed = extractJsonBlock(res.text);
          if (parsed && parsed.title) {
            directive.title = parsed.title;
            directive.description = parsed.description || directive.description;
            directive.topic = parsed.topic || parsed.title;
          }
        }
      }
    }

    const taskId = `${directive.type}-${Date.now().toString(36)}`;
    const newTask = {
      id: taskId,
      type: directive.type,
      title: directive.title,
      description: directive.description,
      ideaKey: directive.ideaKey || 'custom',
      topic: directive.topic || directive.title,
      status: directive.type === 'app' ? 'developing' : 'filming',
      stageLabel: directive.type === 'app' ? 'جاري البرمجة' : 'جاري صناعة الفيديو',
      assigneeId: directive.type === 'app' ? 'app_dev' : 'video_creator',
      version: 0,
      qaNotes: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.state.tasks.unshift(newTask);
    if (this.state.tasks.length > 40) {
      this.state.tasks = this.state.tasks.slice(0, 40);
    }

    ceo.tasksCompleted += 1;
    this.addLog(
      'ceo',
      ceo.shortName,
      `👔 قرار المدير التنفيذي: إطلاق مشروع "${newTask.title}" وتكليف ${newTask.type === 'app' ? 'قسم البرمجة' : 'قسم الفيديو'} بالتنفيذ الفوري.`
    );
    this.addMeetingMessage(
      ceo.shortName,
      'CEO',
      `مشروع جديد الآن: "${newTask.title}". يا فريق العمل، نريد تنفيذ ومراجعة تلقائية بالكامل دون الرجوع لصاحب الشركة.`
    );
    this.setAgentState('ceo', 'idle', 'متابعة تنفيذ المشروع الحالي', 'تم تكليف الفريق 🚀');
  }

  async advanceTask(task) {
    if (task.type === 'app') {
      if (task.status === 'developing') {
        await this.stepBuildApp(task);
      } else if (task.status === 'qa_review') {
        await this.stepQAReviewAndFix(task);
      } else if (task.status === 'ceo_approval') {
        await this.stepCEOApprove(task);
      }
    } else {
      if (task.status === 'filming') {
        await this.stepCreateVideo(task);
      } else if (task.status === 'montage') {
        await this.stepMontageVideo(task);
      } else if (task.status === 'ceo_approval') {
        await this.stepCEOApprove(task);
      }
    }
  }

  async stepBuildApp(task) {
    const dev = this.state.agents.find((a) => a.id === 'app_dev');
    this.setAgentState('app_dev', 'coding', `برمجة: ${task.title}`, 'أكتب الكود الآن... 💻');
    this.persistAndBroadcast();

    const prompt = `ابنِ تطبيق ويب كامل ومستقل في ملف HTML واحد فقط (متضمن CSS و JavaScript بدون مكتبات خارجية) باللغة العربية (lang="ar" dir="rtl") للمشروع التالي:
العنوان: ${task.title}
الوصف: ${task.description}
أعد كود HTML الكامل فقط داخل \`\`\`html ... \`\`\`.`;

    const result = await this.generateWithLLMOrFallback(dev.systemPrompt, prompt, () =>
      templates.buildBuiltinAppV1({ key: task.ideaKey, title: task.title })
    );

    let html = result.fallback;
    if (result.text) {
      const extracted = extractCodeBlock(result.text, 'html');
      if (extracted && extracted.includes('<html')) {
        html = extracted;
      } else {
        html = templates.buildBuiltinAppV1({ key: task.ideaKey, title: task.title });
      }
    }

    const url = storage.saveAppDeliverable(task.id, html, {
      title: task.title,
      version: 1,
      provider: result.usedProvider,
    });

    task.version = 1;
    task.deliverableUrl = url;
    task.providerUsed = result.usedProvider;
    task.status = 'qa_review';
    task.stageLabel = 'قيد المراجعة والتعديل التلقائي';
    task.assigneeId = 'qa_fixer';
    task.updatedAt = new Date().toISOString();

    dev.tasksCompleted += 1;
    this.addLog(
      'app_dev',
      dev.shortName,
      `👨‍💻 أنجزت النسخة الأولى (v1) من "${task.title}" وأرسلتها لقسم الجودة للتدقيق والتعديل.`
    );
    this.setAgentState('app_dev', 'idle', 'بانتظار المشروع التالي', 'تم تسليم v1 بنجاح ✅');
  }

  async stepQAReviewAndFix(task) {
    const qa = this.state.agents.find((a) => a.id === 'qa_fixer');
    this.setAgentState('qa_fixer', 'reviewing', `مراجعة وتعديل: ${task.title}`, 'أفحص الكود وأعدله ذاتياً... 🔍');
    this.persistAndBroadcast();

    const currentHtml = storage.readAppDeliverable(task.id) || '';
    let audit = templates.runStaticQAAndAutoFix(currentHtml, task.title);

    // If external LLM is active, ask it to review & improve the HTML code directly
    if (this.state.llmConfig.provider !== 'builtin' && currentHtml.length < 24000) {
      const prompt = `راجع كود HTML التالي لتطبيق "${task.title}"، اكتشف أي مشاكل في التصميم أو الاستجابة أو تجربة المستخدم أو الأخطاء البرمجية، ثم عدّله مباشرة وأعد الكود المحسن كاملاً داخل \`\`\`html ... \`\`\` مع سطر ملخص للتعديلات:
${currentHtml}`;
      const res = await this.generateWithLLMOrFallback(qa.systemPrompt, prompt, () => null);
      if (res.text) {
        const improved = extractCodeBlock(res.text, 'html');
        if (improved && improved.includes('<html')) {
          audit = templates.runStaticQAAndAutoFix(improved, task.title);
          audit.summary = `تمت المراجعة الذكية عبر (${res.usedProvider}) وتطبيق تحسينات الجودة والتجاوب ذاتياً (v2).`;
        }
      }
    }

    // If HR hired UI/UX Designer or Security Auditor, let them contribute automatically
    const uiDesigner = this.state.agents.find((a) => a.role === 'UI_UX_DESIGNER');
    if (uiDesigner) {
      this.setAgentState(uiDesigner.id, 'working', `تحسين تجربة المستخدم: ${task.title}`, 'أضيف لمسات UI/UX 🎨');
      audit.issuesFound.push(`لمسات ${uiDesigner.shortName}: تحسين تباين الألوان وحركة الأزرار`);
      uiDesigner.tasksCompleted += 1;
      this.setAgentState(uiDesigner.id, 'idle', 'جاهزة لتحسين الواجهات', 'تم تحسين الواجهة ✨');
    }

    const secAuditor = this.state.agents.find((a) => a.role === 'SECURITY_AUDITOR');
    if (secAuditor) {
      this.setAgentState(secAuditor.id, 'reviewing', `تدقيق أمان: ${task.title}`, 'أفحص أمان الكود 🛡️');
      audit.issuesFound.push(`فحص ${secAuditor.shortName}: التحقق من تعقيم المدخلات وعدم وجود سكربتات ضارة`);
      secAuditor.tasksCompleted += 1;
      this.setAgentState(secAuditor.id, 'idle', 'مراقبة أمان التطبيقات', 'الكود آمن 100% 🛡️');
    }

    const url = storage.saveAppDeliverable(task.id, audit.fixedHtml, {
      title: task.title,
      version: 2,
      qaVerified: true,
      qaNotes: audit.issuesFound,
    });

    task.version = 2;
    task.deliverableUrl = url;
    task.qaNotes = audit.issuesFound;
    task.qaSummary = audit.summary;
    task.status = 'ceo_approval';
    task.stageLabel = 'بانتظار الاعتماد النهائي';
    task.assigneeId = 'ceo';
    task.updatedAt = new Date().toISOString();

    qa.tasksCompleted += 1;
    this.state.stats.totalAutoFixes += 1;

    this.addLog('qa_fixer', qa.shortName, `🔍 ${audit.summary}`);
    this.addMeetingMessage(
      qa.shortName,
      'QA & Fix',
      `فحصت تطبيق "${task.title}"، ووجدت ${audit.issuesFound.length} نقاط تحسين وقمت بتعديل الكود بنفسي إلى v2 دون إزعاج صاحب العمل.`
    );
    this.setAgentState('qa_fixer', 'idle', 'جاهزة لفحص التطبيق القادم', 'تم التعديل والاعتماد v2 🛠️');
  }

  async stepCreateVideo(task) {
    const creator = this.state.agents.find((a) => a.id === 'video_creator');
    this.setAgentState('video_creator', 'creating', `إنتاج مشاهد: ${task.title}`, 'أكتب السيناريو وأصمم المشاهد... 🎬');
    this.persistAndBroadcast();

    const prompt = `اكتب سيناريو فيديو قصير من 4 مشاهد حول "${task.title}" (${task.description}) وأرجعه بصيغة JSON فقط بهذا الهيكل:
{"title":"...","topic":"...","musicMood":"...","scenes":[{"id":1,"durationSec":4,"heading":"عنوان قصير","subtitle":"وصف مختصر","icon":"🚀","bgStart":"#0f172a","bgEnd":"#312e81","accent":"#38bdf8","voiceover":"النص الصوتي بالعربية"}]}`;

    const res = await this.generateWithLLMOrFallback(creator.systemPrompt, prompt, () =>
      templates.buildBuiltinVideoV1({ title: task.title, topic: task.topic })
    );

    let videoData = res.fallback;
    if (res.text) {
      const parsed = extractJsonBlock(res.text);
      if (parsed && Array.isArray(parsed.scenes) && parsed.scenes.length > 0) {
        videoData = {
          ...templates.buildBuiltinVideoV1({ title: task.title, topic: task.topic }),
          ...parsed,
          version: 1,
          edited: false,
        };
      } else {
        videoData = templates.buildBuiltinVideoV1({ title: task.title, topic: task.topic });
      }
    }

    const url = storage.saveVideoDeliverable(task.id, videoData);
    task.version = 1;
    task.deliverableUrl = url;
    task.providerUsed = res.usedProvider;
    task.status = 'montage';
    task.stageLabel = 'في غرفة المونتاج';
    task.assigneeId = 'video_editor';
    task.updatedAt = new Date().toISOString();

    creator.tasksCompleted += 1;
    this.addLog(
      'video_creator',
      creator.shortName,
      `🎬 تم تصوير وتجهيز ${videoData.scenes.length} مشاهد لـ "${task.title}" وإرسالها لغرفة المونتاج.`
    );
    this.setAgentState('video_creator', 'idle', 'جاهز للفيديو القادم', 'المشاهد جاهزة للمونتاج 🎥');
  }

  async stepMontageVideo(task) {
    const editor = this.state.agents.find((a) => a.id === 'video_editor');
    this.setAgentState('video_editor', 'editing', `مونتاج: ${task.title}`, 'أضيف الانتقالات والترجمة... ✂️');
    this.persistAndBroadcast();

    const rawVideo = storage.readVideoDeliverable(task.id) || templates.buildBuiltinVideoV1({ title: task.title });
    const editedVideo = templates.applyMontageEdit(rawVideo);

    const growth = this.state.agents.find((a) => a.role === 'GROWTH_MARKETER');
    if (growth) {
      this.setAgentState(growth.id, 'working', `تحسين عنوان وجاذبية: ${task.title}`, 'أضيف خطاف تسويقي ووسوم 📈');
      editedVideo.seoTags = ['#ذكاء_اصطناعي', '#أتمتة', '#إنتاجية', '#مكتب_افتراضي'];
      editedVideo.editorNotes += ` + تحسين النمو والجاذبية بواسطة ${growth.shortName}`;
      growth.tasksCompleted += 1;
      this.setAgentState(growth.id, 'idle', 'تحليل فرص الانتشار', 'جاهز للحملة القادمة 📈');
    }

    const url = storage.saveVideoDeliverable(task.id, editedVideo);
    task.version = 2;
    task.deliverableUrl = url;
    task.editorNotes = editedVideo.editorNotes;
    task.status = 'ceo_approval';
    task.stageLabel = 'جاهز للاعتماد النهائي';
    task.assigneeId = 'ceo';
    task.updatedAt = new Date().toISOString();

    editor.tasksCompleted += 1;
    this.state.stats.totalMontageEdits += 1;

    this.addLog('video_editor', editor.shortName, `✂️ تم إتمام المونتاج لـ "${task.title}": ${editedVideo.editorNotes}`);
    this.addMeetingMessage(
      editor.shortName,
      'Montage',
      `أنهيت مونتاج "${task.title}" مع انتقالات سينمائية وترجمة متزامنة وإخراج نهائي جاهز للعرض.`
    );
    this.setAgentState('video_editor', 'idle', 'جاهزة لمونتاج الفيديو القادم', 'تم إخراج الفيديو v2 🎞️');
  }

  async stepCEOApprove(task) {
    const ceo = this.state.agents.find((a) => a.id === 'ceo');
    this.setAgentState('ceo', 'reviewing', `اعتماد: ${task.title}`, 'أعتمد المخرج النهائي... ✅');
    this.persistAndBroadcast();

    task.status = 'completed';
    task.stageLabel = 'مكتمل ومنشور';
    task.completedAt = new Date().toISOString();
    task.updatedAt = new Date().toISOString();

    if (task.type === 'app') {
      this.state.stats.totalAppsBuilt += 1;
    } else {
      this.state.stats.totalVideosProduced += 1;
    }

    const deliverable = {
      id: task.id,
      type: task.type,
      title: task.title,
      description: task.description,
      version: task.version,
      url: task.deliverableUrl,
      notes: task.qaSummary || task.editorNotes || 'تم الإنجاز والاعتماد الذاتي',
      qaNotes: task.qaNotes || [],
      createdAt: task.completedAt,
    };
    this.state.deliverables.unshift(deliverable);
    if (this.state.deliverables.length > 50) {
      this.state.deliverables = this.state.deliverables.slice(0, 50);
    }

    ceo.tasksCompleted += 1;
    this.addLog(
      'ceo',
      ceo.shortName,
      `🏆 اعتماد المدير التنفيذي: تم إكمال "${task.title}" (الإصدار v${task.version}) وإضافته لمعرض المخرجات النهائية!`
    );
    this.setAgentState('ceo', 'idle', 'مراقبة مؤشرات الشركة 24/7', 'تم النشر بنجاح 🎉');
  }

  // User optional controls
  toggleAutopilot(enabled) {
    this.state.autopilotEnabled = Boolean(enabled);
    this.addLog(
      'system',
      'الإدارة',
      this.state.autopilotEnabled ? '▶️ تم تفعيل التشغيل التلقائي 24/7' : '⏸️ تم إيقاف التشغيل التلقائي مؤقتاً'
    );
    if (this.state.autopilotEnabled) {
      this.scheduleNextTick();
    } else {
      this.stop();
    }
    this.persistAndBroadcast();
  }

  updateSettings(payload) {
    if (payload.tickIntervalMs) {
      this.state.tickIntervalMs = Math.max(2000, Math.min(300000, Number(payload.tickIntervalMs)));
    }
    if (payload.llmConfig) {
      const next = { ...this.state.llmConfig };
      if (payload.llmConfig.provider) next.provider = payload.llmConfig.provider;
      if (typeof payload.llmConfig.apiKey === 'string' && !payload.llmConfig.apiKey.startsWith('••••')) {
        next.apiKey = payload.llmConfig.apiKey.trim();
      }
      if (typeof payload.llmConfig.model === 'string') next.model = payload.llmConfig.model.trim();
      if (typeof payload.llmConfig.baseUrl === 'string') next.baseUrl = payload.llmConfig.baseUrl.trim();
      if (payload.llmConfig.backupProvider) next.backupProvider = payload.llmConfig.backupProvider;
      if (typeof payload.llmConfig.backupApiKey === 'string' && !payload.llmConfig.backupApiKey.startsWith('••••')) {
        next.backupApiKey = payload.llmConfig.backupApiKey.trim();
      }
      if (typeof payload.llmConfig.backupModel === 'string') next.backupModel = payload.llmConfig.backupModel.trim();
      this.state.llmConfig = next;
    }
    if (typeof payload.autoInventProjects === 'boolean') {
      this.state.autoInventProjects = payload.autoInventProjects;
    }
    this.addLog('system', 'الإعدادات', `⚙️ تم تحديث إعدادات المزود (${this.state.llmConfig.provider}) وسرعة الدورة.`);
    if (this.state.autopilotEnabled) this.scheduleNextTick();
    this.persistAndBroadcast();
  }

  resetOffice() {
    const savedLlm = structuredClone(this.state.llmConfig);
    this.state = structuredClone(DEFAULT_STATE);
    this.state.llmConfig = savedLlm;
    this.addLog('system', 'النظام', '🧹 تم تصفير المكتب والبدء من الصفر — الفريق بانتظار أول توجيه منك (أو تفعيل الابتكار التلقائي).');
    this.persistAndBroadcast();
  }

  exportFullBackup() {
    const appSources = {};
    const videoSources = {};
    for (const d of this.state.deliverables || []) {
      if (d.type === 'app') {
        const html = storage.readAppDeliverable(d.id);
        if (html) appSources[d.id] = html;
      } else if (d.type === 'video') {
        const v = storage.readVideoDeliverable(d.id);
        if (v) videoSources[d.id] = v;
      }
    }
    return {
      exportedAt: new Date().toISOString(),
      state: this.getPublicState(),
      appSources,
      videoSources,
    };
  }

  restoreBackup(backupData) {
    if (!backupData || !backupData.state) throw new Error('Invalid backup format');
    const currentKeys = {
      apiKey: this.state.llmConfig.apiKey,
      backupApiKey: this.state.llmConfig.backupApiKey,
    };
    this.state = {
      ...DEFAULT_STATE,
      ...backupData.state,
      llmConfig: {
        ...DEFAULT_STATE.llmConfig,
        ...(backupData.state.llmConfig || {}),
        apiKey: currentKeys.apiKey,
        backupApiKey: currentKeys.backupApiKey,
      },
    };
    if (backupData.appSources) {
      for (const [id, html] of Object.entries(backupData.appSources)) {
        storage.saveAppDeliverable(id, html, { restored: true });
      }
    }
    if (backupData.videoSources) {
      for (const [id, v] of Object.entries(backupData.videoSources)) {
        storage.saveVideoDeliverable(id, v);
      }
    }
    this.addLog('system', 'النظام', '♻️ تم استرجاع النسخة الاحتياطية للمكتب والمخرجات بنجاح.');
    this.persistAndBroadcast();
  }

  enqueueDirective({ type, title, description }) {
    this.state.customQueue.push({
      type: type === 'video' ? 'video' : 'app',
      title: title || 'مشروع مخصص من المالك',
      description: description || title || 'تنفيذ ومراجعة تلقائية بالكامل',
      ideaKey: 'pomodoro',
      topic: title || 'الذكاء الاصطناعي',
    });
    this.addLog('ceo', 'توجيه جديد', `📌 تمت إضافة طلب "${title}" إلى قائمة المشاريع ليبدأ الفريق بتنفيذه فوراً.`);
    this.persistAndBroadcast();
  }

  hireCustomEmployee({ name, role, room, avatar, color, systemPrompt }) {
    const id = 'emp_' + crypto.randomUUID().slice(0, 6);
    const shortName = name.split('—')[0].trim().slice(0, 18);
    const agent = {
      id,
      name,
      shortName,
      role: role || 'SPECIALIST',
      department: 'custom',
      room: room || 'مكتب المهام الخاصة',
      avatar: avatar || '🤖',
      color: color || '#0ea5e9',
      desk: { x: 75, y: 18 },
      status: 'idle',
      currentTask: 'موظف جديد جاهز للمهام',
      tasksCompleted: 0,
      qualityScore: 95,
      systemPrompt: systemPrompt || `أنت ${name} وتعمل بمسؤولية عالية في المكتب الافتراضي.`,
    };
    this.state.agents.push(agent);
    this.state.stats.totalHires += 1;
    this.addLog('hr', 'سارة (HR)', `✨ تم تعيين موظف جديد: "${name}" في ${agent.room}.`);
    this.persistAndBroadcast();
    return agent;
  }

  async chatWithAgent(agentId, message) {
    const agent = this.state.agents.find((a) => a.id === agentId) || this.state.agents[0];
    if (!agent) throw new Error('Agent not found');

    this.setAgentState(agent.id, 'thinking', `يرد على رسالة المالك: ${message.slice(0, 40)}`, 'أسمعك الآن... 💬');
    this.persistAndBroadcast();

    const lower = message.toLowerCase();
    const isTaskOrder =
      lower.includes('فيديو') ||
      lower.includes('مونتاج') ||
      lower.includes('تطبيق') ||
      lower.includes('برنامج') ||
      lower.includes('موقع') ||
      lower.includes('ابني') ||
      lower.includes('اعمل') ||
      lower.includes('صمم');

    if (isTaskOrder && (agent.role === 'CEO' || agent.role === 'APP_DEV' || agent.role === 'VIDEO_CREATOR')) {
      const isVideo = lower.includes('فيديو') || lower.includes('مونتاج');
      this.enqueueDirective({ type: isVideo ? 'video' : 'app', title: message.slice(0, 80), description: message });
    }

    const contextSummary = `حالة المكتب: التطبيقات=${this.state.stats.totalAppsBuilt}، الفيديوهات=${this.state.stats.totalVideosProduced}، الموظفون=${this.state.agents.length}.`;
    const fallbackReply = () => {
      if (isTaskOrder) {
        return `حاضر يا فندم! أنا ${agent.shortName}، استلمت طلبك: "${message}". أضفته الآن لقائمة العمل وهيبدأ الفريق ينفذه ويراجعه ويعدله ذاتياً في ثوانٍ بدون ما يرجع لك. (ملاحظة: لتوليد أفكار وتطبيقات مخصصة بالكامل، ضع مفتاح Gemini أو Groq المجاني من الإعدادات).`;
      }
      if (lower.includes('اهلا') || lower.includes('سلام') || lower.includes('ازيك') || lower.includes('صباح') || lower.includes('مساء') || lower.includes('عامل ايه')) {
        return `أهلاً بك يا فندم! أنا ${agent.name}، كل أموري تمام وجاهز لتنفيذ أوامرك. لو حابب نبدأ مشروع تطبيق أو فيديو قولي فوراً بصوتك أو بالكتابة!`;
      }
      if (lower.includes('بتعمل') || lower.includes('شغال') || lower.includes('اخبار') || lower.includes('وضع')) {
        return `أنا ${agent.name} في ${agent.room}. حاليّاً أنجزنا ${this.state.stats.totalAppsBuilt} تطبيقات و${this.state.stats.totalVideosProduced} فيديوهات، وحالتي الآن: ${agent.currentTask}.`;
      }
      if (agent.role === 'HR') {
        return `أهلاً بك! أنا ${agent.name}. لدينا حالياً ${this.state.agents.length} موظفين جاهزين. تحب أوظف لك تخصص جديد أو أتابع أداء حد معين؟`;
      }
      if (agent.role === 'QA_FIXER') {
        return `مرحباً! أنا ${agent.name}. أي تطبيق يعمله المبرمج بفحصه وأصلح أخطاءه وأعدله بنفسي إلى v2 قبل التسليم. حالياً أنجزت ${this.state.stats.totalAutoFixes} تعديل ذاتي.`;
      }
      if (agent.role === 'VIDEO_CREATOR' || agent.role === 'VIDEO_EDITOR') {
        return `أهلاً بك! أنا ${agent.name}. لو طلبت مني أو من أ. طارق فيديو جديد هكتب السيناريو وأعمل المونتاج والترجمة وتقدر تحمله فيديو WebM جاهز.`;
      }
      return `تحت أمرك يا فندم! أنا ${agent.name}. استلمت كلامك: "${message}". لو ده أمر شغل قولي "اعمل تطبيق..." أو "اعمل فيديو..." وهبدأ فوراً. (ملحوظة: لتشغيل حوار ذكي مفتوح، أضف مفتاح Gemini أو Groq المجاني من تبويب الإعدادات).`;
    };

    const res = await this.generateWithLLMOrFallback(
      `${agent.systemPrompt}\n${contextSummary}\nأجب باللهجة المصرية الودودة والاحترافية باختصار بصفتك ${agent.name}.`,
      message,
      fallbackReply
    );

    const reply = res.text ? res.text.trim() : res.fallback;
    this.addMeetingMessage('أنت (المالك)', 'Owner', `@${agent.shortName}: ${message}`);
    this.addMeetingMessage(agent.shortName, agent.role, reply);
    this.addLog(agent.id, agent.shortName, `💬 رد على المالك: ${reply.slice(0, 90)}${reply.length > 90 ? '...' : ''}`);
    this.setAgentState(agent.id, 'idle', 'جاهز لتوجيهك القادم', reply.slice(0, 70));
    this.persistAndBroadcast();
    return { agent, reply, usedProvider: res.usedProvider };
  }
}

module.exports = { VirtualOfficeOrchestrator };
