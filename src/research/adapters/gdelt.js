import { canonicalUrl } from '../sources.js';
import { id, now, hash } from '../../utils.js';

export const name = 'gdelt';

async function fetchJsonUrl(url, { env = {}, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timeout = Math.max(1000, Number(env.JOBOS_RESEARCH_FETCH_TIMEOUT_MS || 12000));
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json,*/*;q=0.8', 'user-agent': 'JobOS local research (+gdelt adapter)', ...headers },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json();
}

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  let apiCalls = 0;
  const maxQueries = budget.maxQueries ?? 8;
  const company = context.companyName || '';
  if (!company) {
    return { observations, personHints, usage: { queries: 0, sourceChars: 0 }, warnings: ['gdelt: no company name in context'] };
  }
  if (apiCalls >= maxQueries) {
    warnings.push(`gdelt: maxQueries (${maxQueries}) reached`);
    return { observations, personHints, usage: { queries: apiCalls, sourceChars: 0 }, warnings };
  }
  try {
    const base = env.JOBOS_GDELT_DOC_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';
    const url = new URL(base);
    url.searchParams.set('query', `"${company}"`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('maxrecords', String(Math.max(1, Number(env.JOBOS_GDELT_LIMIT || 12))));
    const data = await fetchJsonUrl(url.href, { env, fetchImpl });
    apiCalls++;
    for (const article of (data.articles || []).slice(0, budget.maxQueries > 1 ? 10 : 5)) {
      if (signal?.aborted) break;
      const obs = {
        id: id('src', `${context.runId}:gdelt:${canonicalUrl(article.url)}`),
        companyId: context.companyId,
        jobId: context.jobId,
        url: article.url,
        canonicalUrl: canonicalUrl(article.url),
        title: article.title || `${company} news`,
        snippet: article.seendate ? `${article.seendate}: ${article.domain || ''}` : (article.domain || ''),
        sourceType: 'news',
        provider: 'gdelt',
        query: `"${company}"`,
        trust: 'public_news_index',
        fetchedAt: now(),
        contentHash: hash(article.title || article.url || ''),
        metadata: { domain: article.domain || '', language: article.language || '', sourceCountry: article.sourcecountry || '' }
      };
      observations.push(obs);
    }
  } catch (e) {
    warnings.push(`gdelt adapter failed: ${e.message}`);
  }
  return {
    observations,
    personHints,
    usage: { queries: apiCalls, sourceChars: 0 },
    warnings
  };
}
