import { parseJson } from '../../utils.js';
import { sourceObservationFromSearch, isHttpUrl } from '../sources.js';

const DEFAULT_MODEL = 'grok-4.5';
const BASE_URL = 'https://api.x.ai';
const XAI_KEY_ENV = 'XAI_API_KEY';

function pricingFor(env, model) {
  const pricing = parseJson(env.JOBOS_MODEL_PRICING_JSON, {});
  const rate = pricing?.models?.[model] || pricing?.xai?.[model] || pricing?.[model];
  if (!rate || typeof rate !== 'object') return null;
  const number = (...keys) => {
    for (const key of keys) {
      const value = Number(rate[key]);
      if (Number.isFinite(value) && value >= 0) return value;
    }
    return 0;
  };
  return {
    inputPerMillionUsd: number('inputPerMillionUsd', 'inputPer1MTokensUsd', 'inputPerMillion', 'input'),
    outputPerMillionUsd: number('outputPerMillionUsd', 'outputPer1MTokensUsd', 'outputPerMillion', 'output'),
    xSearchCallUsd: number('xSearchCallUsd', 'toolCallUsd', 'xSearchCall', 'tool')
  };
}

/**
 * Build a research prompt from context + plan queries.
 */
function buildPrompt(context, plan) {
  const lines = [
    'You are a people research assistant. Search for professionals matching the following criteria and return structured JSON only.',
    '',
    '## Research Context'
  ];

  if (context.companyName) lines.push(`- Target company: ${context.companyName}`);
  if (context.role) lines.push(`- Target role: ${context.role}`);
  if (context.person?.name) lines.push(`- Person to find: ${context.person.name}`);
  if (context.person?.profileUrl) lines.push(`- Known profile: ${context.person.profileUrl}`);

  if (context.confirmedAffiliations?.length) {
    lines.push('');
    lines.push('## Confirmed affiliations (use for matching)');
    for (const aff of context.confirmedAffiliations) {
      lines.push(`- ${aff.type}: ${aff.organization}${aff.roleOrProgram ? ` (${aff.roleOrProgram})` : ''}`);
    }
  }

  const queries = plan?.queries?.length ? plan.queries : [];
  if (queries.length) {
    lines.push('');
    lines.push('## Search queries to explore');
    for (const q of queries) {
      lines.push(`- ${q}`);
    }
  }

  lines.push('');
  lines.push('## Output format');
  lines.push('Return a JSON object with a single key "candidates" containing an array of candidate objects.');
  lines.push('Each candidate object MUST have these fields:');
  lines.push('- name: string (full name of the person)');
  lines.push('- profileUrl: string (x.com profile URL if found, otherwise empty string)');
  lines.push('- evidenceUrls: array of strings (URLs from X/Twitter that evidence this candidate)');
  lines.push('- relevance: string (one-sentence explanation of relevance to the research context)');
  lines.push('- affiliations: array of { type: "employer"|"school"|"community", organization: string, role?: string }');
  lines.push('');
  lines.push('Only include candidates with real evidence from X/Twitter. The evidenceUrls must be actual X/Twitter post URLs.');
  lines.push('Return valid JSON only. No markdown fences, no prose outside the JSON object.');

  return lines.join('\n');
}

/**
 * xAI / X Search adapter for people research.
 *
 * Triple preflight gate:
 *  1. JOBOS_XAI_ENABLED=1
 *  2. networkIntent.allowedSources.xai === true
 *  3. XAI_API_KEY is set
 *
 * Uses `fetchImpl` for injectable HTTP (testing).
 * Never exposes the API key in results or error messages.
 */
export const xaiAdapter = {
  name: 'xai',

  async run({ context, plan, budget, signal, env = process.env, fetchImpl = fetch }) {
    const warnings = [];
    const observations = [];
    const personHints = [];
    const usage = { queries: 0, sourceChars: 0, modelCalls: 0, inputTokens: 0, outputTokens: 0, paidToolCalls: 0, estimatedUsd: null };

    // --- Preflight gates ---

    const enabled = String(env.JOBOS_XAI_ENABLED || '').trim() === '1';
    if (!enabled) {
      return { observations, personHints, usage, warnings: [...warnings, 'xAI preflight: JOBOS_XAI_ENABLED is not set to 1'] };
    }

    const networkIntent = context?.networkIntent || {};
    const allowedSources = networkIntent.allowedSources || {};
    if (allowedSources.xai !== true) {
      return { observations, personHints, usage, warnings: [...warnings, 'xAI preflight: networkIntent.allowedSources.xai is not enabled'] };
    }

    const apiKey = String(env[XAI_KEY_ENV] || '').trim();
    if (!apiKey) {
      return { observations, personHints, usage, warnings: [...warnings, 'xAI preflight: XAI_API_KEY is not configured'] };
    }

    // --- Build request ---
    const model = String(env.JOBOS_XAI_MODEL || DEFAULT_MODEL).trim();
    usage.queries = 1;
    usage.modelCalls = 1;
    const input = buildPrompt(context, plan);

    const body = JSON.stringify({
      model,
      input,
      tools: [{ type: 'x_search' }],
      include: ['no_inline_citations']
    });

    // --- Make request ---
    const controller = new AbortController();
    const timeout = Math.max(1000, Number(env.JOBOS_XAI_TIMEOUT_MS || 30000));
    const timer = setTimeout(() => controller.abort(), timeout);
    timer.unref?.();

    let response;
    try {
      response = await fetchImpl(`${BASE_URL}/v1/responses`, {
        method: 'POST',
        signal: signal ? anySignal(signal, controller.signal) : controller.signal,
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json'
        },
        body
      });
    } catch (err) {
      clearTimeout(timer);
      return {
        observations,
        personHints,
        usage,
        warnings: [...warnings, `xAI request failed: ${err.message}`]
      };
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      return {
        observations,
        personHints,
        usage,
        warnings: [...warnings, `xAI HTTP ${response.status}`]
      };
    }

    // --- Parse response ---
    let data;
    try {
      data = await response.json();
    } catch (err) {
      return {
        observations,
        personHints,
        usage,
        warnings: [...warnings, `xAI response parse failed: ${err.message}`]
      };
    }

    // --- Extract usage ---
    const hasUsage = data.usage && typeof data.usage === 'object';
    if (hasUsage) {
      usage.inputTokens = Number.isFinite(data.usage.input_tokens) ? data.usage.input_tokens : 0;
      usage.outputTokens = Number.isFinite(data.usage.output_tokens) ? data.usage.output_tokens : 0;
    } else {
      warnings.push('xAI response contained no usage metadata');
    }
    if (Array.isArray(data.output)) {
      usage.paidToolCalls = data.output.filter(item => item?.type === 'x_search_call').length;
    }
    const pricing = pricingFor(env, model);
    if (pricing && hasUsage) {
      usage.estimatedUsd =
        (usage.inputTokens / 1_000_000) * pricing.inputPerMillionUsd
        + (usage.outputTokens / 1_000_000) * pricing.outputPerMillionUsd
        + usage.paidToolCalls * pricing.xSearchCallUsd;
      if (budget.maxCostUsd != null && usage.estimatedUsd > budget.maxCostUsd) {
        warnings.push(`budget_exhausted: xAI estimated cost exceeded maxCostUsd`);
      }
    }

    // --- Parse citations ---
    const citations = Array.isArray(data.citations) ? data.citations : [];
    if (!citations.length) {
      return {
        observations,
        personHints,
        usage,
        warnings: [...warnings, 'xAI response contained no citations; no evidence recorded.']
      };
    }

    // Build a set of citation URLs (lowercased for matching)
    const citationUrls = new Set();
    for (const citation of citations) {
      const url = String(typeof citation === 'string' ? citation : citation?.url || '').trim();
      if (url && isHttpUrl(url)) citationUrls.add(url.toLowerCase());
    }

    // --- Extract model output text ---
    const outputMessages = Array.isArray(data.output) ? data.output : [];
    const messageOutput = outputMessages.find(o => o?.type === 'message');
    const contentBlocks = messageOutput?.content || [];
    const outputText = contentBlocks
      .filter(c => c?.type === 'output_text')
      .map(c => c.text)
      .join('\n');

    if (!outputText.trim()) {
      return {
        observations,
        personHints,
        usage,
        warnings: [...warnings, 'xAI response contained no output text; no candidates to process.']
      };
    }

    // --- Parse JSON from output ---
    let parsed;
    try {
      parsed = parseJson(outputText);
    } catch {
      // Try extracting JSON from the text
      const match = outputText.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch {
          return { observations, personHints, usage, warnings: [...warnings, 'xAI output did not contain valid JSON; no candidates processed.'] };
        }
      } else {
        return { observations, personHints, usage, warnings: [...warnings, 'xAI output did not contain valid JSON; no candidates processed.'] };
      }
    }

    const candidates = Array.isArray(parsed?.candidates) ? parsed.candidates : [];
    if (!candidates.length) {
      return { observations, personHints, usage, warnings: [...warnings, 'xAI returned no candidates in JSON output.'] };
    }

    // --- Process candidates ---
    const queryString = plan?.queries?.join('; ') || context.companyName || 'xai research';
    let citedCount = 0;
    let uncitedCount = 0;

    for (const candidate of candidates) {
      const name = String(candidate?.name || '').trim();
      if (!name) continue;

      const evidenceUrls = Array.isArray(candidate.evidenceUrls) ? candidate.evidenceUrls : [];
      if (!evidenceUrls.length) {
        uncitedCount++;
        continue;
      }

      // Filter evidenceUrls to only those present in citations
      const citedUrls = evidenceUrls.filter(u => {
        const cu = String(u || '').trim().toLowerCase();
        return cu && citationUrls.has(cu);
      });

      if (!citedUrls.length) {
        uncitedCount++;
        warnings.push(`xAI candidate "${name}" has no cited evidence URLs; dropping uncited claims.`);
        continue;
      }

      citedCount++;

      // Create one source observation per cited URL
      const obsIds = [];
      for (const url of citedUrls) {
        const profileUrl = String(candidate.profileUrl || '').trim();
        const obs = sourceObservationFromSearch(context, {
          url,
          title: `xAI: ${name}${profileUrl ? ` (${profileUrl})` : ''}`,
          snippet: candidate.relevance || '',
          provider: 'xai',
          query: queryString
        }, { sourceType: 'x_search' });

        obsIds.push(obs.id);
        observations.push(obs);
      }

      // Build person hint
      const hint = {
        name,
        source: 'xai',
        profileUrl: String(candidate.profileUrl || '').trim() || undefined,
        relevance: String(candidate.relevance || '').trim() || undefined,
        affiliations: Array.isArray(candidate.affiliations) ? candidate.affiliations : [],
        evidenceObservationIds: obsIds
      };
      personHints.push(hint);
    }

    if (uncitedCount > 0 && citedCount === 0) {
      warnings.push(`xAI: all ${uncitedCount} candidate(s) had no cited evidence; no observations created.`);
    }

    return { observations, personHints, usage, warnings };
  }
};

/**
 * Combine an AbortSignal from the caller with the internal timeout controller.
 */
function anySignal(...signals) {
  const controller = new AbortController();
  const cleanup = () => {
    for (const sig of signals) {
      if (sig) {
        try { sig.removeEventListener?.('abort', onAbort); } catch {}
      }
    }
  };
  function onAbort() {
    cleanup();
    controller.abort();
  }
  for (const sig of signals) {
    if (sig) {
      if (sig.aborted) { onAbort(); return controller.signal; }
      sig.addEventListener?.('abort', onAbort, { once: true });
    }
  }
  return controller.signal;
}
