import {
  canonicalUrl,
  fetchPublicPage,
  hostForUrl,
  sourceObservationFromPage
} from '../sources.js';
import { id, now, hash } from '../../utils.js';

export const name = 'wayback';

async function fetchJsonUrl(url, { env = {}, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timeout = Math.max(1000, Number(env.JOBOS_RESEARCH_FETCH_TIMEOUT_MS || 12000));
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json,*/*;q=0.8', 'user-agent': 'JobOS local research (+wayback adapter)', ...headers },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json();
}

function companyDomains(context, plan) {
  const domains = new Set();
  if (context.companyName) {
    const slug = String(context.companyName).toLowerCase().replace(/[^a-z0-9.-]+/g, '');
    if (slug) domains.add(`${slug}.com`);
  }
  if (plan?.domains?.length) {
    for (const d of plan.domains) domains.add(d);
  }
  return [...domains];
}

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  let apiCalls = 0;
  let sourceChars = 0;
  const maxQueries = budget.maxQueries ?? 8;
  const maxSourceChars = budget.maxSourceChars ?? 250000;
  const domains = companyDomains(context, plan).slice(0, 2);
  for (const domain of domains) {
    if (signal?.aborted) break;
    if (apiCalls >= maxQueries) {
      warnings.push(`wayback: maxQueries (${maxQueries}) reached`);
      break;
    }
    try {
      const base = env.JOBOS_WAYBACK_CDX_URL || 'https://web.archive.org/cdx/search/cdx';
      const url = new URL(base);
      url.searchParams.set('url', `${domain}/team*`);
      url.searchParams.set('output', 'json');
      url.searchParams.set('filter', 'statuscode:200');
      url.searchParams.set('collapse', 'digest');
      url.searchParams.set('limit', String(Math.max(1, Number(env.JOBOS_WAYBACK_LIMIT || 3))));
      const data = await fetchJsonUrl(url.href, { env, fetchImpl });
      apiCalls++;
      const rows = Array.isArray(data) ? data.slice(1) : [];
      for (const row of rows.slice(0, 3)) {
        if (signal?.aborted) break;
        const [urlkey, timestamp, original] = row;
        if (!timestamp || !original) continue;
        const archiveUrl = `https://web.archive.org/web/${timestamp}/${original}`;
        const archiveKey = `wayback:${domain}/team*`;
        try {
          if (sourceChars >= maxSourceChars) {
            warnings.push(`wayback: maxSourceChars (${maxSourceChars}) reached`);
            break;
          }
          const page = await fetchPublicPage(archiveUrl, { fetchImpl, lookupImpl: null, env });
          if (!page.ok) continue;
          const obs = sourceObservationFromPage(context, page, { provider: 'wayback', query: archiveKey });
          obs.sourceType = 'archived_page';
          obs.trust = 'public_archive_potentially_stale';
          obs.metadata = { ...(obs.metadata || {}), archiveTimestamp: timestamp, originalUrl: original, urlkey };
          observations.push(obs);
          sourceChars += (obs.snippet || '').length + (obs.title || '').length;
        } catch (e) {
          warnings.push(`wayback snapshot fetch failed for ${archiveUrl}: ${e.message}`);
        }
      }
    } catch (e) {
      warnings.push(`wayback adapter failed for ${domain}: ${e.message}`);
    }
  }
  return {
    observations,
    personHints,
    usage: { queries: apiCalls, sourceChars },
    warnings
  };
}
