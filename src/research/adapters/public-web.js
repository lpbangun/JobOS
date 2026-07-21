import { searchWebDetailed } from '../../search.js';
import {
  canonicalUrl,
  fetchPublicPage,
  hostForUrl,
  isFetchablePublicPage,
  isLinkedInProfileUrl,
  pageTargetsFromSeeds,
  sourceAllowedForRecording,
  sourceObservationFromSearch,
  sourceObservationFromPage
} from '../sources.js';
import { id, now, hash } from '../../utils.js';

export const name = 'public-web';

function defaultQueries(context) {
  const company = context.companyName || '';
  const role = context.role || '';
  if (!company && !role) return [];
  const queries = [`"${company}" contact`];
  if (company) queries.push(`"${company}" "Head of People" OR recruiter OR "Talent Acquisition"`);
  if (company && role) {
    queries.push(`"${company}" "${role}" "hiring manager"`);
    queries.push(`site:linkedin.com/in "${company}" "Talent Acquisition"`);
    const roleWords = role.split(/\s+/).slice(0, 3).join(' ');
    if (roleWords) queries.push(`site:linkedin.com/in "${company}" "${roleWords}"`);
  }
  return queries;
}

function estimateChars(observations) {
  return observations.reduce((sum, o) => sum + (o.snippet || '').length + (o.title || '').length, 0);
}

function personHintFromResult(result, observation, context) {
  const title = String(result.title || '').trim();
  const snippet = String(result.snippet || '').trim();
  const text = `${title} ${snippet}`;
  const company = String(context.companyName || '').trim();
  if (company && !text.toLowerCase().includes(company.toLowerCase())) return null;
  if (!/\b(head|lead|director|vice president|vp|founder|recruiter|talent|manager)\b/i.test(text)) return null;
  const match = title.match(/^([\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,4})\s*(?:[-–—|]|$)/u);
  const linkedIn = isLinkedInProfileUrl(result.url);
  const personName = match?.[1]?.trim() || (linkedIn ? title.split(/\s+(?:[-–—|]|at)\s+/i)[0].trim() : '');
  if (!personName || personName.toLowerCase() === company.toLowerCase()) return null;
  const genericNameTokens = new Set(['team', 'page', 'leadership', 'people', 'careers', 'jobs', 'company', 'about']);
  if (personName.toLowerCase().split(/\s+/).some(token => genericNameTokens.has(token))) return null;
  let personSpecificUrl = linkedIn;
  if (!personSpecificUrl) {
    try {
      const pathname = decodeURIComponent(new URL(result.url).pathname).toLowerCase();
      const nameTokens = personName.toLowerCase().split(/\s+/).filter(token => token.length > 1);
      personSpecificUrl = nameTokens.length >= 2 && nameTokens.every(token => pathname.includes(token));
    } catch {
      personSpecificUrl = false;
    }
  }
  return {
    name: personName,
    company,
    role: title.replace(personName, '').replace(/^\s*[-–—|]\s*/, '').trim(),
    sourceObservationId: observation.id,
    profileUrl: personSpecificUrl ? result.url : '',
    confidence: linkedIn ? 'low' : 'medium',
    source: 'public_search'
  };
}

async function collectSearchQueries({ context, plan, budget, signal, env, fetchImpl }) {
  const observations = [];
  const personHints = [];
  const warnings = [];
  let queries = 0;
  const qlist = plan?.queries?.length ? plan.queries : defaultQueries(context);
  for (const query of qlist) {
    if (signal?.aborted) break;
    if (queries >= budget.maxQueries) {
      warnings.push(`public-web: maxQueries (${budget.maxQueries}) reached`);
      break;
    }
    try {
      const result = await searchWebDetailed(query, { limit: 8, env, providers: null, fetchImpl });
      queries++;
      for (const warning of result.warnings || []) {
        warnings.push(`public-web query "${query.slice(0, 60)}": ${warning.provider || ''} ${warning.message || warning}`);
      }
      for (const r of result.results || []) {
        if (!sourceAllowedForRecording(r.url)) continue;
        const obs = sourceObservationFromSearch(context, { ...r, query, provider: r.provider || 'search' });
        observations.push(obs);
        const personHint = personHintFromResult(r, obs, context);
        if (personHint) personHints.push(personHint);
        }
    } catch (e) {
      warnings.push(`public-web search failed for "${query.slice(0, 60)}": ${e.message}`);
    }
  }
  return { observations, personHints, queries, warnings };
}

async function collectPageFetches({ context, observations, plan, budget, signal, env, fetchImpl }) {
  const pages = [];
  const warnings = [];
  let totalChars = estimateChars(observations);
  const seedUrls = observations.map(o => o.url).filter(isFetchablePublicPage);
  const targets = pageTargetsFromSeeds({
    company: context.companyName,
    job: context.jobId ? { id: context.jobId, company: context.companyName, title: context.role } : null,
    seedUrls,
    limit: Math.max(1, Number(env.JOBOS_RESEARCH_PAGE_LIMIT || 16))
  });
  for (const target of targets) {
    if (signal?.aborted) break;
    if (totalChars >= budget.maxSourceChars) {
      warnings.push(`public-web: maxSourceChars (${budget.maxSourceChars}) reached`);
      break;
    }
    try {
      const page = await fetchPublicPage(target, { fetchImpl, lookupImpl: null, env });
      if (!page.ok) continue;
      const obs = sourceObservationFromPage(context, page, { query: 'contact-page-crawl' });
      pages.push(obs);
      totalChars += estimateChars([obs]);
    } catch (e) {
      warnings.push(`public-web: could not fetch ${target}: ${e.message}`);
    }
  }
  return { pages, warnings, totalChars };
}

export async function run({ context, plan, budget, signal, env, fetchImpl }) {
  const b = { maxQueries: budget.maxQueries ?? 8, maxSourceChars: budget.maxSourceChars ?? 250000 };
  const search = await collectSearchQueries({ context, plan, budget: b, signal, env, fetchImpl });
  const pageResult = await collectPageFetches({
    context, observations: search.observations, plan, budget: b, signal, env, fetchImpl
  });
  const observations = [...search.observations, ...pageResult.pages];
  const warnings = [...search.warnings, ...pageResult.warnings];
  return {
    observations,
    personHints: search.personHints,
    usage: { queries: search.queries, sourceChars: pageResult.totalChars },
    warnings
  };
}
