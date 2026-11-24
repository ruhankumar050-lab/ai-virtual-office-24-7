/**
 * Free Multi-Provider LLM Client with Automatic Backup Rotation
 * Supports:
 * 1. "builtin" (0-cost built-in smart generator — works immediately without API keys)
 * 2. "gemini" (Google AI Studio Free Tier)
 * 3. "groq" (Groq Cloud Free Tier)
 * 4. "openrouter" (OpenRouter :free models)
 * 5. "arena" (Arena API Gateway — https://api.arena.ai/v1)
 * 6. "ollama" (Local unlimited free models)
 */

async function callSingleProvider(providerConfig, systemPrompt, userPrompt, options = {}) {
  const { provider, apiKey, model, baseUrl } = providerConfig;
  const temperature = options.temperature ?? 0.7;
  const maxTokens = options.maxTokens ?? 4096;

  if (provider === 'gemini') {
    if (!apiKey) throw new Error('Gemini API key missing');
    const chosenModel = model || 'gemini-flash-lite-latest';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: maxTokens,
        },
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    if (!text) throw new Error('Empty Gemini response');
    return { text, usedProvider: `gemini:${chosenModel}` };
  }

  if (provider === 'groq') {
    if (!apiKey) throw new Error('Groq API key missing');
    const chosenModel = model || 'openai/gpt-oss-120b';
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: chosenModel,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Groq HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Empty Groq response');
    return { text, usedProvider: `groq:${chosenModel}` };
  }

  if (provider === 'openrouter') {
    if (!apiKey) throw new Error('OpenRouter API key missing');
    const chosenModel = model || 'meta-llama/llama-3.3-70b-instruct:free';
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/ai-virtual-office',
        'X-Title': 'AI Virtual Office 24/7',
      },
      body: JSON.stringify({
        model: chosenModel,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenRouter HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Empty OpenRouter response');
    return { text, usedProvider: `openrouter:${chosenModel}` };
  }

  if (provider === 'arena') {
    if (!apiKey) throw new Error('Arena API key missing');
    const chosenModel = model || 'coding-router-preview';
    const endpoint = (baseUrl && baseUrl.includes('arena.ai') ? baseUrl : 'https://api.arena.ai/v1').replace(/\/$/, '');
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: chosenModel,
        temperature,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Arena HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content || '';
    if (!text) throw new Error('Empty Arena response');
    return { text, usedProvider: `arena:${chosenModel}` };
  }

  if (provider === 'ollama') {
    const endpoint = (baseUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const chosenModel = model || 'qwen2.5-coder:7b';
    const res = await fetch(`${endpoint}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: chosenModel,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama HTTP ${res.status}: ${errText.slice(0, 180)}`);
    }
    const data = await res.json();
    const text = data?.message?.content || '';
    if (!text) throw new Error('Empty Ollama response');
    return { text, usedProvider: `ollama:${chosenModel}` };
  }

  throw new Error(`Unknown provider: ${provider}`);
}

async function callExternalLLM(providerConfig, systemPrompt, userPrompt, options = {}) {
  const hasBackup =
    providerConfig.backupProvider &&
    providerConfig.backupProvider !== 'none' &&
    providerConfig.backupProvider !== 'builtin' &&
    providerConfig.backupApiKey;

  const primaryCfg = {
    provider: providerConfig.provider,
    apiKey: providerConfig.apiKey,
    model: providerConfig.model,
    baseUrl: providerConfig.baseUrl,
  };
  const backupCfg = {
    provider: providerConfig.backupProvider,
    apiKey: providerConfig.backupApiKey,
    model: providerConfig.backupModel,
    baseUrl: providerConfig.baseUrl,
  };

  const firstCfg = options.preferBackup && hasBackup ? backupCfg : primaryCfg;
  const secondCfg = options.preferBackup && hasBackup ? primaryCfg : backupCfg;

  try {
    return await callSingleProvider(firstCfg, systemPrompt, userPrompt, options);
  } catch (firstErr) {
    if (hasBackup) {
      return await callSingleProvider(secondCfg, systemPrompt, userPrompt, options);
    }
    throw firstErr;
  }
}

function extractCodeBlock(text, lang = 'html') {
  const regex = new RegExp('```(?:' + lang + ')?\\s*([\\s\\S]*?)```', 'i');
  const match = text.match(regex);
  if (match && match[1]) return match[1].trim();
  if (text.includes('<!DOCTYPE html') || text.includes('<html')) {
    const idx = text.indexOf('<!DOCTYPE html') !== -1 ? text.indexOf('<!DOCTYPE html') : text.indexOf('<html');
    return text.slice(idx).trim();
  }
  return null;
}

function extractJsonBlock(text) {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = match ? match[1].trim() : text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

module.exports = {
  callExternalLLM,
  extractCodeBlock,
  extractJsonBlock,
};
