function cleanBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('LLM returned empty content');
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) return JSON.parse(fenced);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
  throw new Error('LLM response did not contain JSON');
}

export function llmConfig(env = process.env) {
  const provider = env.JOBOS_LLM_PROVIDER || '';
  const model = env.JOBOS_LLM_MODEL || '';
  const apiKey = env.JOBOS_LLM_API_KEY || (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : provider === 'ollama-cloud' ? env.OLLAMA_API_KEY : env.OPENAI_API_KEY) || '';
  const baseUrl = env.JOBOS_LLM_BASE_URL || (provider === 'anthropic' ? 'https://api.anthropic.com/v1' : provider === 'ollama-cloud' ? 'https://ollama.com/v1' : 'https://api.openai.com/v1');
  const timeoutMs = Math.max(1000, Number(env.JOBOS_LLM_TIMEOUT_MS || 30000));
  const configured = Boolean(provider && model && apiKey);
  return {
    provider,
    model,
    baseUrl,
    timeoutMs,
    configured,
    degradedMode: !configured,
    warning: configured ? null : 'JOBOS LLM is not configured; using deterministic degraded mode. Set JOBOS_LLM_PROVIDER, JOBOS_LLM_MODEL, and JOBOS_LLM_API_KEY to enable provider-backed scoring and tailoring.'
  };
}

async function postOpenAiCompatible(cfg, messages, temperature, maxTokens, schemaName) {
  const response = await fetch(`${cleanBaseUrl(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: {
      authorization: `Bearer ${cfg.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      response_format: { type: 'json_object' },
      metadata: schemaName ? { schemaName } : undefined
    })
  });
  if (!response.ok) throw new Error(`LLM provider HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  return extractJson(content);
}

async function postAnthropic(cfg, messages, temperature, maxTokens) {
  const system = messages.find(m => m.role === 'system')?.content || '';
  const user = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }));
  const response = await fetch(`${cleanBaseUrl(cfg.baseUrl)}/messages`, {
    method: 'POST',
    signal: AbortSignal.timeout(cfg.timeoutMs),
    headers: {
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: cfg.model, system, messages: user, temperature, max_tokens: maxTokens })
  });
  if (!response.ok) throw new Error(`LLM provider HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const content = data.content?.map(part => part.text || '').join('\n');
  return extractJson(content);
}

export async function generateJson({ system = '', user = '', schemaName = 'jobos_json', temperature = 0.2, maxTokens = 2200, env = process.env } = {}) {
  const cfg = llmConfig(env);
  if (!cfg.configured) {
    return { ok: false, config: cfg, reason: cfg.warning };
  }
  const runtimeCfg = { ...cfg, apiKey: env.JOBOS_LLM_API_KEY || (cfg.provider === 'anthropic' ? env.ANTHROPIC_API_KEY : cfg.provider === 'ollama-cloud' ? env.OLLAMA_API_KEY : env.OPENAI_API_KEY) };
  const messages = [
    { role: 'system', content: `${system}\n\nReturn valid JSON only. Do not include markdown fences or prose outside JSON.`.trim() },
    { role: 'user', content: user }
  ];
  const json = runtimeCfg.provider === 'anthropic'
    ? await postAnthropic(runtimeCfg, messages, temperature, maxTokens)
    : await postOpenAiCompatible(runtimeCfg, messages, temperature, maxTokens, schemaName);
  return { ok: true, json, config: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl, timeoutMs: cfg.timeoutMs, configured: true, degradedMode: false } };
}
