import { canonicalUrl } from '../sources.js';
import { id, now, hash } from '../../utils.js';

export const name = 'github';

async function fetchJsonUrl(url, { env = {}, headers = {}, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timeout = Math.max(1000, Number(env.JOBOS_RESEARCH_FETCH_TIMEOUT_MS || 12000));
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json,*/*;q=0.8', 'user-agent': 'JobOS local research (+github adapter)', ...headers },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json();
}

function githubHandles(context, plan) {
  const handles = new Set();
  if (plan?.handles?.length) {
    for (const h of plan.handles) handles.add(h);
  }
  if (context.companyName) {
    // Derive a likely org handle from the company name
    const slug = String(context.companyName).toLowerCase().trim().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
    if (slug) handles.add(slug);
  }
  if (context.confirmedAffiliations?.length) {
    for (const aff of context.confirmedAffiliations) {
      const slug = String(aff.organization).toLowerCase().trim().replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');
      if (slug) handles.add(slug);
    }
  }
  return [...handles].slice(0, 3);
}

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  let apiCalls = 0;
  const maxQueries = budget.maxQueries ?? 8;
  const handles = githubHandles(context, plan);
  for (const handle of handles) {
    if (signal?.aborted) break;
    if (apiCalls >= maxQueries) {
      warnings.push(`github: maxQueries (${maxQueries}) reached`);
      break;
    }
    try {
      const base = String(env.JOBOS_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
      const authHeaders = env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {};
      const members = await fetchJsonUrl(`${base}/orgs/${encodeURIComponent(handle)}/members`, { env, headers: authHeaders, fetchImpl });
      apiCalls++;
      for (const member of (Array.isArray(members) ? members : []).slice(0, 20)) {
        const memberUrl = member.html_url || `https://github.com/${member.login}`;
        const obs = {
          id: id('src', `${context.runId}:github:${canonicalUrl(memberUrl)}:${member.login}:${handle}`),
          companyId: context.companyId,
          jobId: context.jobId,
          url: memberUrl,
          canonicalUrl: canonicalUrl(memberUrl),
          title: `${member.login} - public GitHub member of ${handle}`,
          snippet: `Public GitHub org member for ${handle}.`,
          sourceType: 'github_public_member',
          provider: 'github',
          query: `${handle}/members`,
          trust: 'public_api',
          fetchedAt: now(),
          contentHash: hash(`${member.login}:${handle}`),
          metadata: { githubOrg: handle, login: member.login, avatarUrl: member.avatar_url || '' }
        };
        observations.push(obs);
        personHints.push({
          name: member.name || member.login || '',
          profileUrl: memberUrl,
          sourceObservationId: obs.id,
          confidence: 'low',
          source: 'github_public_member'
        });
      }
    } catch (e) {
      warnings.push(`github adapter failed for ${handle}: ${e.message}`);
    }
  }
  return {
    observations,
    personHints,
    usage: { queries: apiCalls, sourceChars: 0 },
    warnings
  };
}
