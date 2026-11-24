const crypto = require('node:crypto');
const { callExternalLLM } = require('./llm');
const { redactSecrets } = require('./security');

const PROVIDER_CATALOG = [
  {
    id: 'groq',
    name: 'Groq Cloud',
    tier: 'مجاني بحدود استخدام (Free Tier — بدون بطاقة)',
    models: [
      { id: 'openai/gpt-oss-120b', roleFit: ['reasoning', 'coding', 'qa', 'executive'], limits: 'حدود مجانية (RPM/RPD حسب الموديل)' },
      { id: 'qwen/qwen3.8-27b', roleFit: ['fast', 'coding', 'arabic'], limits: 'حدود مجانية سريعة جداً' },
    ],
    officialDocs: 'https://console.groq.com/docs/rate-limits',
    note: 'مناسب للقيادة التنفيذية والبرمجة والمراجعة السريعة. يخضع لحدود RPM/TPM/RPD.',
  },
  {
    id: 'gemini',
    name: 'Google Gemini (AI Studio)',
    tier: 'مجاني بحدود حصة (Free Tier — بدون بطاقة)',
    models: [
      { id: 'gemini-flash-lite-latest', roleFit: ['creative', 'research', 'video', 'curriculum'], limits: 'مستقر ضمن الحصة المجانية، بعض موديلات Pro/4 تتطلب Billing' },
      { id: 'gemini-3.5-flash-lite', roleFit: ['creative', 'fast'], limits: 'حصة مجانية محدودة (قد يحدث ضغط 503 أحياناً)' },
    ],
    officialDocs: 'https://ai.google.dev/gemini-api/docs/rate-limits',
    note: 'ممتاز للإبداع والسيناريوهات والبحث التعليمي. يُستخدم مع احتياطي تلقائي لتجنب 429/503.',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter (:free)',
    tier: 'مجاني لنماذج :free بحدود يومية',
    models: [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', roleFit: ['reasoning', 'creative'], limits: 'حدود يومية للنماذج المجانية' },
    ],
    officialDocs: 'https://openrouter.ai/docs/limits',
    note: 'بديل احتياطي مرن يجمع نماذج مفتوحة مجانية.',
  },
  {
    id: 'arena',
    name: 'Arena API (api.arena.ai)',
    tier: 'حسب رصيد مساحة العمل في platform.arena.ai',
    models: [
      { id: 'coding-router-preview', roleFit: ['coding', 'reasoning'], limits: 'مضبوط لأدوات البرمجة؛ وللمهام العامة اختر نموذجاً من /v1/models' },
    ],
    officialDocs: 'https://platform.arena.ai/docs/api',
    note: 'يتطلب مفتاح API من platform.arena.ai/dashboard/keys ورصيداً مفعلاً في مساحة العمل.',
  },
  {
    id: 'ollama',
    name: 'Ollama (محلي / خادم خاص)',
    tier: 'مجاني غير محدود على جهازك أو VPS قوي',
    models: [
      { id: 'qwen2.5-coder:7b', roleFit: ['coding', 'reasoning'], limits: 'محدود بمواصفات CPU/GPU للخادم فقط' },
    ],
    officialDocs: 'https://ollama.com/library',
    note: 'يعمل بلا إنترنت أو حدود سحابية عند توفر خادم مناسب.',
  },
  {
    id: 'builtin',
    name: 'المحرك الهندسي المدمج (Fallback)',
    tier: 'مدمج 100% مجاني للأبد',
    models: [
      { id: 'deterministic-template-engine-v2', roleFit: ['fallback'], limits: 'بلا حدود — استمرارية مضمونة عند تعطل كل المزودات' },
    ],
    officialDocs: '',
    note: 'ضمان عدم ضياع المهام عند انقطاع المزودات السحابية.',
  },
];

class AIModelRouter {
  constructor(db) {
    this.db = db;
  }

  selectRoute(config, modelClass = 'reasoning') {
    const hasPrimary = Boolean(config?.provider && config.provider !== 'builtin' && (config.apiKey || config.provider === 'ollama'));
    const hasBackup = Boolean(
      config?.backupProvider &&
        config.backupProvider !== 'none' &&
        config.backupProvider !== 'builtin' &&
        (config.backupApiKey || config.backupProvider === 'ollama')
    );

    const preferCreativeBackup = (modelClass === 'creative' || modelClass === 'research') && hasBackup;

    let selectedModel = config?.model || '';
    if (modelClass === 'fast' && config?.provider === 'groq' && !preferCreativeBackup) {
      selectedModel = 'qwen/qwen3.8-27b';
    }

    return {
      hasPrimary,
      hasBackup,
      preferBackup: preferCreativeBackup,
      activeConfig: {
        ...config,
        model: selectedModel,
      },
    };
  }

  logUsage({ provider, model, taskId = '', agentId = '', roleType = '', latencyMs = 0, tokensEst = 0, status = 'ok', errorMessage = '' }) {
    if (!this.db) return;
    try {
      this.db.run(
        `INSERT INTO ai_usage_logs (id, provider, model, task_id, agent_id, role_type, latency_ms, tokens_est, status, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'ai-' + crypto.randomUUID().slice(0, 8),
          provider,
          model,
          taskId,
          agentId,
          roleType,
          Math.round(latencyMs),
          Math.round(tokensEst),
          status,
          redactSecrets(errorMessage).slice(0, 300),
          new Date().toISOString(),
        ]
      );
    } catch {
      // Non-fatal logging failure
    }
  }

  async complete({ config, systemPrompt, userPrompt, modelClass = 'reasoning', taskId = '', agentId = '', roleType = '', fallbackFn }) {
    if (!config || config.provider === 'builtin') {
      const fb = fallbackFn ? fallbackFn() : null;
      this.logUsage({
        provider: 'builtin',
        model: 'deterministic-template-engine-v2',
        taskId,
        agentId,
        roleType,
        latencyMs: 1,
        tokensEst: 0,
        status: 'ok',
      });
      return { text: null, usedProvider: 'builtin:deterministic-v2', fallback: fb, tokensEst: 0 };
    }

    const route = this.selectRoute(config, modelClass);
    const t0 = Date.now();
    try {
      const res = await callExternalLLM(route.activeConfig, systemPrompt, userPrompt, {
        preferBackup: route.preferBackup,
      });
      const latencyMs = Date.now() - t0;
      const [prov, ...rest] = String(res.usedProvider || config.provider).split(':');
      const model = rest.join(':') || config.model || 'default';
      const tokensEst = Math.ceil((String(systemPrompt).length + String(userPrompt).length + String(res.text).length) / 4);
      this.logUsage({
        provider: prov,
        model,
        taskId,
        agentId,
        roleType,
        latencyMs,
        tokensEst,
        status: 'ok',
      });
      return { ...res, fallback: null, tokensEst };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      this.logUsage({
        provider: config.provider,
        model: config.model || 'default',
        taskId,
        agentId,
        roleType,
        latencyMs,
        tokensEst: 0,
        status: 'error',
        errorMessage: err.message,
      });
      const fb = fallbackFn ? fallbackFn() : null;
      return {
        text: null,
        usedProvider: 'builtin-fallback',
        fallback: fb,
        error: redactSecrets(err.message),
        tokensEst: 0,
      };
    }
  }

  getDashboard(config) {
    const usageRows = this.db
      ? this.db.all(
          `SELECT provider, model,
            COUNT(*) as requests,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
            SUM(tokens_est) as tokens_est,
            AVG(latency_ms) as avg_latency_ms
           FROM ai_usage_logs
           GROUP BY provider, model`
        )
      : [];

    const recentErrors = this.db
      ? this.db.all(
          `SELECT provider, model, error_message, created_at FROM ai_usage_logs WHERE status = 'error' ORDER BY created_at DESC LIMIT 8`
        )
      : [];

    return {
      activePrimary: {
        provider: config?.provider || 'builtin',
        model: config?.model || (config?.provider === 'groq' ? 'openai/gpt-oss-120b' : 'auto'),
        connected: config?.provider === 'builtin' || Boolean(config?.apiKey) || config?.provider === 'ollama',
      },
      activeBackup: {
        provider: config?.backupProvider || 'none',
        model: config?.backupModel || (config?.backupProvider === 'gemini' ? 'gemini-flash-lite-latest' : 'auto'),
        connected: Boolean(config?.backupProvider && config.backupProvider !== 'none' && config?.backupApiKey),
      },
      catalog: PROVIDER_CATALOG,
      usageByModel: usageRows,
      recentErrors,
    };
  }
}

module.exports = { AIModelRouter, PROVIDER_CATALOG };
