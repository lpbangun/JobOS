import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { one, all, run, audit, save } from '../db.js';
import { id, now, parseJson, slug } from '../utils.js';
import { writeMd, writeYaml } from '../workspace.js';
import { searchWebDetailed } from '../search.js';
import {
  canonicalUrl,
  emailDomain,
  extractEmailContexts,
  extractEmails,
  fetchPublicPage,
  hostForUrl,
  isFetchablePublicPage,
  isGenericInbox,
  isLinkedInProfileUrl,
  nameFromEmailLocal,
  pageTargetsFromSeeds,
  saveSourceObservation,
  sourceAllowedForRecording,
  sourceObservationFromPage,
  sourceObservationFromSearch,
  syncSourceObservations,
  listSourceObservations
} from './sources.js';

const disposableDomains = new Set([
  '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.com', 'yopmail.com'
]);

const smtpProbeLastByDomain = new Map();

function normalizeConfidence(value, fallback = 'medium') {
  const v = String(value || '').toLowerCase();
  return ['low', 'medium', 'high', 'blocked'].includes(v) ? v : fallback;
}

function normalizeFunction(role) {
  const r = String(role || '').toLowerCase();
  if (/recruit|talent|people|hr/.test(r)) return 'recruiting/talent/people ops';
  if (/product|engineering|design|data|operations|marketing|sales|customer/.test(r)) return 'likely hiring manager or functional peer';
  if (/founder|ceo|cto|cpo|vp|chief/.test(r)) return 'founder/executive';
  if (/investor|advisor|partner/.test(r)) return 'investor/advisor';
  return 'public expert';
}

function seniorityFromRole(role) {
  const r = String(role || '').toLowerCase();
  if (/founder|chief|ceo|cto|cpo|vp|vice president/.test(r)) return 'executive';
  if (/head|director|lead|manager/.test(r)) return 'leadership';
  if (/senior|principal|staff/.test(r)) return 'senior';
  return 'unknown';
}

function relevanceFromRole(role) {
  const r = String(role || '').toLowerCase();
  if (/recruit|talent|people|hiring/.test(r)) return 'recruiter';
  if (/head|lead|manager|director|product|engineering|design|operations/.test(r)) return 'likely_hiring_manager_or_peer';
  if (/founder|ceo|cto|vp/.test(r)) return 'executive';
  if (/investor|advisor|partner/.test(r)) return 'investor_or_advisor';
  return 'public_expert';
}

function candidateId(job, person) {
  return id('candidate', `${job.id}:${person.name}:${person.role || ''}`);
}

function rowToCandidate(row) {
  return row ? {
    id: row.id,
    jobId: row.job_id || null,
    companyId: row.company_id || null,
    name: row.name,
    role: row.role || '',
    function: row.function || '',
    seniority: row.seniority || '',
    relevance: row.relevance,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    status: row.status,
    suppressionReason: row.suppression_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowToContact(row) {
  return row ? {
    id: row.id,
    personId: row.person_id || null,
    stakeholderId: row.stakeholder_id || null,
    companyId: row.company_id || null,
    type: row.type,
    value: row.value,
    normalizedValue: row.normalized_value,
    evidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    checks: parseJson(row.checks_json, {}),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

function rowToPattern(row) {
  return row ? {
    id: row.id,
    companyId: row.company_id,
    domain: row.domain,
    pattern: row.pattern,
    supportCount: Number(row.support_count || 0),
    supportSources: parseJson(row.support_sources_json, []),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export function listPersonCandidates(s, { jobId = null, companyId = null } = {}) {
  if (jobId) return all(s, 'SELECT * FROM person_candidates WHERE job_id=? ORDER BY updated_at DESC, name', [jobId]).map(rowToCandidate);
  if (companyId) return all(s, 'SELECT * FROM person_candidates WHERE company_id=? ORDER BY updated_at DESC, name', [companyId]).map(rowToCandidate);
  return all(s, 'SELECT * FROM person_candidates ORDER BY updated_at DESC, name').map(rowToCandidate);
}

export function listContactPoints(s, { jobId = null, stakeholderId = null, companyId = null } = {}) {
  if (stakeholderId) return all(s, 'SELECT * FROM contact_points WHERE stakeholder_id=? ORDER BY evidence_tier, confidence DESC, updated_at DESC', [stakeholderId]).map(rowToContact);
  if (companyId) return all(s, 'SELECT * FROM contact_points WHERE company_id=? ORDER BY evidence_tier, confidence DESC, updated_at DESC', [companyId]).map(rowToContact);
  if (jobId) {
    const job = one(s, 'SELECT company_id FROM jobs WHERE id=?', [jobId]);
    if (!job?.company_id) return [];
    return all(s, 'SELECT * FROM contact_points WHERE company_id=? ORDER BY evidence_tier, confidence DESC, updated_at DESC', [job.company_id]).map(rowToContact);
  }
  return all(s, 'SELECT * FROM contact_points ORDER BY updated_at DESC').map(rowToContact);
}

export function listEmailPatterns(s, { companyId }) {
  return all(s, 'SELECT * FROM email_patterns WHERE company_id=? ORDER BY confidence DESC, support_count DESC, pattern', [companyId]).map(rowToPattern);
}

function upsertPersonCandidate(s, job, person, sourceIds, at = now()) {
  const name = String(person.name || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  const role = String(person.role || 'Relevant stakeholder').replace(/\s+/g, ' ').trim();
  const cid = person.id || candidateId(job, { name, role });
  const existing = one(s, 'SELECT * FROM person_candidates WHERE id=?', [cid]);
  const status = existing?.status || 'candidate';
  const sourceObservationIds = [...new Set([...(parseJson(existing?.source_observation_ids_json, []) || []), ...sourceIds])];
  const params = [
    cid,
    job.id,
    job.company_id || null,
    name,
    role,
    person.function || normalizeFunction(role),
    person.seniority || seniorityFromRole(role),
    person.relevance || relevanceFromRole(role),
    normalizeConfidence(person.confidence, 'medium'),
    JSON.stringify(sourceObservationIds),
    status,
    existing?.suppression_reason || '',
    existing?.created_at || at,
    at
  ];
  if (existing) {
    run(s, `UPDATE person_candidates SET job_id=?,company_id=?,name=?,role=?,function=?,seniority=?,relevance=?,confidence=?,source_observation_ids_json=?,status=?,suppression_reason=?,updated_at=? WHERE id=?`, [...params.slice(1, 12), params[13], cid]);
  } else {
    run(s, 'INSERT INTO person_candidates VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params);
  }
  return rowToCandidate(one(s, 'SELECT * FROM person_candidates WHERE id=?', [cid]));
}

function contactId(companyId, type, normalizedValue, personId = '', stakeholderId = '') {
  return id('contact', `${companyId || ''}:${personId || ''}:${stakeholderId || ''}:${type}:${normalizedValue}`);
}

function normalizeContactValue(type, value) {
  if (type === 'email' || type === 'generic_inbox') return String(value || '').trim().toLowerCase();
  if (type === 'profile_url' || type === 'website') return canonicalUrl(value);
  return String(value || '').trim();
}

function upsertContactPoint(s, {
  companyId,
  personId = null,
  stakeholderId = null,
  type,
  value,
  evidenceTier,
  verificationStatus,
  confidence,
  sourceObservationIds = [],
  checks = {},
  humanApproved = false,
  doNotUse = false
}, at = now()) {
  const normalized = normalizeContactValue(type, value);
  if (!normalized) return null;
  const cid = contactId(companyId, type, normalized, personId || '', stakeholderId || '');
  const existing = one(s, 'SELECT * FROM contact_points WHERE id=?', [cid]);
  const sourceIds = [...new Set([...(parseJson(existing?.source_observation_ids_json, []) || []), ...sourceObservationIds])];
  const mergedChecks = { ...(parseJson(existing?.checks_json, {}) || {}), ...(checks || {}) };
  const approved = existing?.human_approved ? 1 : (humanApproved ? 1 : 0);
  const blocked = existing?.do_not_use ? 1 : (doNotUse ? 1 : 0);
  const params = [
    cid,
    personId || null,
    stakeholderId || null,
    companyId || null,
    type,
    value,
    normalized,
    evidenceTier,
    verificationStatus,
    normalizeConfidence(confidence, 'low'),
    JSON.stringify(sourceIds),
    JSON.stringify(mergedChecks),
    approved,
    blocked,
    existing?.created_at || at,
    at
  ];
  if (existing) {
    run(s, `UPDATE contact_points SET person_id=?,stakeholder_id=?,company_id=?,type=?,value=?,normalized_value=?,evidence_tier=?,verification_status=?,confidence=?,source_observation_ids_json=?,checks_json=?,human_approved=?,do_not_use=?,updated_at=? WHERE id=?`, [...params.slice(1, 14), at, cid]);
  } else {
    run(s, 'INSERT INTO contact_points VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params);
  }
  return rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [cid]));
}

function upsertPattern(s, { companyId, domain, pattern, supportSources, supportCount = null, confidence }, at = now()) {
  const pid = id('pattern', `${companyId}:${domain}:${pattern}`);
  const existing = one(s, 'SELECT * FROM email_patterns WHERE id=?', [pid]);
  const sources = [...new Set([...(parseJson(existing?.support_sources_json, []) || []), ...supportSources])];
  const count = Math.max(existing?.support_count || 0, Number(supportCount || sources.length));
  const params = [pid, companyId, domain, pattern, count, JSON.stringify(sources), confidence, existing?.created_at || at, at];
  if (existing) {
    run(s, 'UPDATE email_patterns SET support_count=?,support_sources_json=?,confidence=?,updated_at=? WHERE id=?', [count, JSON.stringify(sources), confidence, at, pid]);
  } else {
    run(s, 'INSERT INTO email_patterns VALUES (?,?,?,?,?,?,?,?,?)', params);
  }
  return rowToPattern(one(s, 'SELECT * FROM email_patterns WHERE id=?', [pid]));
}

function namesFromTitle(title) {
  const name = String(title || '').replace(/\s+/g, ' ').trim().split(/\s+[—|-]\s+/)[0]?.trim() || '';
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z][A-Za-z'.-]+$/.test(w)) ? name : '';
}

function roleFromTitle(title, snippet = '') {
  const text = `${title} ${snippet}`.replace(/\s+/g, ' ');
  const exact = text.match(/\b(Head of [A-Z][A-Za-z ]+|Director of [A-Z][A-Za-z ]+|VP [A-Z][A-Za-z ]+|Vice President [A-Z][A-Za-z ]+|Recruiting Lead|Talent Lead|People Operations Manager|Product Manager|Product Leader|Engineering Manager|Design Lead|Hiring Manager|Founder|Recruiter)\b/);
  if (exact) return exact[1].trim();
  if (/recruit/i.test(text)) return 'Recruiter';
  if (/talent/i.test(text)) return 'Talent Lead';
  if (/people/i.test(text)) return 'People Operations';
  if (/product/i.test(text)) return 'Product Leader';
  if (/engineer/i.test(text)) return 'Engineering Leader';
  if (/founder/i.test(text)) return 'Founder';
  return 'Relevant stakeholder';
}

function companyDomains(job, company, observations = []) {
  const domains = new Set();
  for (const raw of [company?.website, job?.url]) {
    const host = hostForUrl(raw);
    if (host) domains.add(host);
  }
  for (const obs of observations) {
    const meta = obs.metadata || {};
    for (const email of meta.emails || []) {
      const domain = emailDomain(email);
      const host = hostForUrl(obs.url);
      if (domain && host && (host === domain || host.endsWith(`.${domain}`))) domains.add(domain);
    }
  }
  return [...domains];
}

function tierForEmailObservation(email, observation, domains) {
  const domain = emailDomain(email);
  const host = hostForUrl(observation.url);
  const sameDomain = domains.includes(domain) || host === domain || host.endsWith(`.${domain}`);
  if (sameDomain && observation.sourceType === 'page_fetch') return 'A';
  if (sameDomain && observation.sourceType === 'web_search') return 'B';
  return 'B';
}

function confidenceForTier(tier, generic = false) {
  if (generic) return 'medium';
  if (tier === 'A') return 'high';
  if (tier === 'B' || tier === 'C') return 'medium';
  return 'low';
}

function contactQueries(job, domains) {
  const domain = domains[0] || '';
  const roleFamily = String(job.title || '').replace(/[,()]/g, ' ');
  const queries = [
    `"${job.company}" "@${domain || job.company}"`,
    `"${job.company}" "Head of People" OR recruiter OR "Talent Acquisition"`,
    `"${job.company}" "${roleFamily}" "hiring manager"`,
    `site:linkedin.com/in "${job.company}" "Talent Acquisition"`,
    `site:linkedin.com/in "${job.company}" "${roleFamily.split(/\s+/).slice(0, 3).join(' ')}"`
  ];
  if (domain) {
    queries.unshift(`site:${domain} "@${domain}"`);
    queries.unshift(`site:${domain} "mailto:"`);
  }
  return [...new Set(queries.filter(q => q.replace(/["\s]/g, '').length > 0))].slice(0, 8);
}

function adapterNames(env) {
  return String(env.JOBOS_RESEARCH_ADAPTERS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

async function fetchJsonUrl(url, { env = process.env, headers = {} } = {}) {
  const controller = new AbortController();
  const timeout = Math.max(1000, Number(env.JOBOS_RESEARCH_FETCH_TIMEOUT_MS || 12000));
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  let response;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json,*/*;q=0.8', 'user-agent': 'JobOS local research (+configured public adapter)', ...headers },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return await response.json();
}

function observationFromAdapter(job, { url, title, snippet, sourceType, provider, metadata = {}, trust = 'public_adapter' }) {
  return {
    id: id('src', `${job.id}:${provider}:${canonicalUrl(url)}:${title}:${snippet}`),
    companyId: job.company_id || null,
    jobId: job.id,
    url,
    canonicalUrl: canonicalUrl(url),
    title: title || url,
    snippet: snippet || '',
    sourceType,
    provider,
    query: '',
    trust,
    fetchedAt: now(),
    contentHash: id('hash', `${title || ''}:${snippet || ''}`).replace(/^hash_/, ''),
    metadata
  };
}

function githubOrgHandles(observations, company) {
  const handles = new Set();
  const companyText = String(company || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const obs of observations) {
    try {
      const url = new URL(obs.url);
      const host = url.hostname.replace(/^www\./, '').toLowerCase();
      if (host !== 'github.com') continue;
      const handle = url.pathname.split('/').filter(Boolean)[0];
      if (!handle || ['features', 'marketplace', 'topics', 'collections', 'login', 'orgs'].includes(handle.toLowerCase())) continue;
      const text = `${obs.title || ''} ${obs.snippet || ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      if (!companyText || text.includes(companyText.split(' ')[0]) || obs.query?.includes('github')) handles.add(handle);
    } catch {}
  }
  return [...handles].slice(0, 3);
}

async function collectGithubObservations(s, job, searchObservations, { env = process.env } = {}) {
  const observations = [];
  const warnings = [];
  for (const handle of githubOrgHandles(searchObservations, job.company)) {
    try {
      const base = String(env.JOBOS_GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
      const members = await fetchJsonUrl(`${base}/orgs/${encodeURIComponent(handle)}/members`, { env, headers: env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {} });
      for (const member of (Array.isArray(members) ? members : []).slice(0, 20)) {
        const observation = observationFromAdapter(job, {
          url: member.html_url || `https://github.com/${member.login}`,
          title: `${member.login} - public GitHub member of ${handle}`,
          snippet: `Public GitHub org member for ${handle}.`,
          sourceType: 'github_public_member',
          provider: 'github',
          trust: 'public_api',
          metadata: { githubOrg: handle, login: member.login, avatarUrl: member.avatar_url || '' }
        });
        saveSourceObservation(s, observation);
        observations.push(observation);
      }
    } catch (e) {
      warnings.push(`GitHub adapter failed for ${handle}: ${e.message}`);
    }
  }
  return { observations, warnings };
}

async function collectGdeltObservations(s, job, { env = process.env } = {}) {
  const observations = [];
  const warnings = [];
  try {
    const base = env.JOBOS_GDELT_DOC_URL || 'https://api.gdeltproject.org/api/v2/doc/doc';
    const url = new URL(base);
    url.searchParams.set('query', `"${job.company}"`);
    url.searchParams.set('format', 'json');
    url.searchParams.set('maxrecords', String(Math.max(1, Number(env.JOBOS_GDELT_LIMIT || 10))));
    const data = await fetchJsonUrl(url.href, { env });
    for (const article of (data.articles || []).slice(0, 10)) {
      const observation = observationFromAdapter(job, {
        url: article.url,
        title: article.title || `${job.company} news`,
        snippet: article.seendate ? `${article.seendate}: ${article.domain || ''}` : (article.domain || ''),
        sourceType: 'news',
        provider: 'gdelt',
        trust: 'public_news_index',
        metadata: { domain: article.domain || '', language: article.language || '', sourceCountry: article.sourcecountry || '' }
      });
      saveSourceObservation(s, observation);
      observations.push(observation);
    }
  } catch (e) {
    warnings.push(`GDELT adapter failed: ${e.message}`);
  }
  return { observations, warnings };
}

async function collectWaybackObservations(s, job, domains, { fetchImpl = fetch, lookupImpl = null, env = process.env } = {}) {
  const observations = [];
  const warnings = [];
  for (const domain of domains.slice(0, 2)) {
    try {
      const base = env.JOBOS_WAYBACK_CDX_URL || 'https://web.archive.org/cdx/search/cdx';
      const url = new URL(base);
      url.searchParams.set('url', `${domain}/team*`);
      url.searchParams.set('output', 'json');
      url.searchParams.set('filter', 'statuscode:200');
      url.searchParams.set('collapse', 'digest');
      url.searchParams.set('limit', String(Math.max(1, Number(env.JOBOS_WAYBACK_LIMIT || 3))));
      const data = await fetchJsonUrl(url.href, { env });
      const rows = Array.isArray(data) ? data.slice(1) : [];
      for (const row of rows.slice(0, 3)) {
        const [urlkey, timestamp, original] = row;
        if (!timestamp || !original) continue;
        const archiveUrl = `https://web.archive.org/web/${timestamp}/${original}`;
        try {
          const page = await fetchPublicPage(archiveUrl, { fetchImpl, env });
          if (!page.ok) continue;
          const observation = sourceObservationFromPage(job, page, { provider: 'wayback', query: `wayback:${domain}/team*` });
          observation.sourceType = 'archived_page';
          observation.trust = 'public_archive_potentially_stale';
          observation.metadata = { ...(observation.metadata || {}), archiveTimestamp: timestamp, originalUrl: original, urlkey };
          saveSourceObservation(s, observation);
          observations.push(observation);
        } catch (e) {
          warnings.push(`Wayback snapshot fetch failed for ${archiveUrl}: ${e.message}`);
        }
      }
    } catch (e) {
      warnings.push(`Wayback adapter failed for ${domain}: ${e.message}`);
    }
  }
  return { observations, warnings };
}

async function collectConfiguredAdapterObservations(s, job, domains, searchObservations, { fetchImpl = fetch, lookupImpl = null, env = process.env } = {}) {
  const names = adapterNames(env);
  const observations = [];
  const warnings = [];
  if (names.includes('github')) {
    const result = await collectGithubObservations(s, job, searchObservations, { env });
    observations.push(...result.observations);
    warnings.push(...result.warnings);
  }
  if (names.includes('gdelt')) {
    const result = await collectGdeltObservations(s, job, { env });
    observations.push(...result.observations);
    warnings.push(...result.warnings);
  }
  if (names.includes('wayback')) {
    const result = await collectWaybackObservations(s, job, domains, { fetchImpl, lookupImpl, env });
    observations.push(...result.observations);
    warnings.push(...result.warnings);
  }
  return { observations, warnings };
}

async function safeSearch(query, { limit = 6, env = process.env } = {}) {
  try {
    const detailed = await searchWebDetailed(query, { limit, env });
    return { results: detailed.results, warnings: detailed.warnings || [], error: null };
  } catch (e) {
    return { results: [], warnings: [{ provider: 'search', message: e.message }], error: e.message };
  }
}

async function collectSearchObservations(s, job, company, { env = process.env } = {}) {
  const domains = companyDomains(job, company);
  const queries = contactQueries(job, domains);
  const observations = [];
  const warnings = [];
  for (const query of queries) {
    const searched = await safeSearch(query, { env, limit: 8 });
    if (searched.error) warnings.push(`${query}: ${searched.error}`);
    for (const warning of searched.warnings) warnings.push(`${query}: ${warning.provider} ${warning.message}`);
    for (const result of searched.results) {
      if (!sourceAllowedForRecording(result.url)) continue;
      const observation = sourceObservationFromSearch(job, result);
      saveSourceObservation(s, observation);
      observations.push(observation);
    }
  }
  return { queries, observations, warnings };
}

async function fetchPageObservations(s, job, company, searchObservations, { fetchImpl = fetch, lookupImpl = null, env = process.env } = {}) {
  const seedUrls = searchObservations.map(obs => obs.url).filter(isFetchablePublicPage);
  const targets = pageTargetsFromSeeds({ company, job, seedUrls, limit: Math.max(1, Number(env.JOBOS_RESEARCH_PAGE_LIMIT || 16)) });
  const observations = [];
  const warnings = [];
  for (const target of targets) {
    try {
      const page = await fetchPublicPage(target, { fetchImpl, lookupImpl, env });
      if (!page.ok) continue;
      const observation = sourceObservationFromPage(job, page, { query: 'contact-page-crawl' });
      saveSourceObservation(s, observation);
      observations.push(observation);
    } catch (e) {
      warnings.push(`Could not fetch ${target}: ${e.message}`);
    }
  }
  return { targets, observations, warnings };
}

function namesForPattern(name) {
  const parts = String(name || '').toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { first: parts[0].replace(/[^a-z]/g, ''), last: parts[parts.length - 1].replace(/[^a-z]/g, '') };
}

function patternForNameEmail(name, email) {
  const parts = namesForPattern(name);
  if (!parts) return '';
  const local = String(email || '').split('@')[0]?.toLowerCase();
  if (!local) return '';
  const { first, last } = parts;
  const patterns = [
    ['first', first],
    ['first.last', `${first}.${last}`],
    ['flast', `${first.charAt(0)}${last}`],
    ['firstl', `${first}${last.charAt(0)}`],
    ['first_last', `${first}_${last}`],
    ['firstlast', `${first}${last}`]
  ];
  return patterns.find(([, value]) => value === local)?.[0] || '';
}

function generateFromPattern(name, domain, pattern) {
  const parts = namesForPattern(name);
  if (!parts || !domain) return '';
  const { first, last } = parts;
  const local = {
    first,
    'first.last': `${first}.${last}`,
    flast: `${first.charAt(0)}${last}`,
    firstl: `${first}${last.charAt(0)}`,
    first_last: `${first}_${last}`,
    firstlast: `${first}${last}`
  }[pattern];
  return local ? `${local}@${domain}` : '';
}

function dnsResolverFromEnv(env) {
  if (!env.JOBOS_DNS_FIXTURE_JSON) return null;
  try {
    const fixture = JSON.parse(env.JOBOS_DNS_FIXTURE_JSON);
    return {
      async resolveMx(domain) {
        const row = fixture[domain] || {};
        if (row.mxError) throw new Error(row.mxError);
        if (!row.mx?.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
        return row.mx;
      },
      async resolveTxt(domain) {
        const row = fixture[domain.replace(/^_dmarc\./, '')] || {};
        const key = domain.startsWith('_dmarc.') ? 'dmarc' : 'txt';
        if (!row[key]?.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
        return row[key];
      },
      async resolveNs(domain) {
        const row = fixture[domain] || {};
        if (!row.ns?.length) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
        return row.ns;
      }
    };
  } catch {
    return null;
  }
}

export async function verifyEmailDomain(domain, { resolver = null, env = process.env } = {}) {
  const safeDomain = String(domain || '').toLowerCase().replace(/[^a-z0-9.-]/g, '');
  const activeResolver = resolver || dnsResolverFromEnv(env) || dns;
  const checks = { domain: safeDomain, syntax: /^[a-z0-9.-]+\.[a-z]{2,}$/.test(safeDomain), disposable: disposableDomains.has(safeDomain) };
  if (!checks.syntax) return { status: 'invalid_domain', confidence: 'low', checks };
  try {
    checks.mx = await activeResolver.resolveMx(safeDomain);
    checks.mxPresent = Array.isArray(checks.mx) && checks.mx.length > 0;
  } catch (e) {
    checks.mx = [];
    checks.mxPresent = false;
    checks.mxError = e.code || e.message;
  }
  try {
    checks.txt = await activeResolver.resolveTxt(safeDomain);
    checks.spfPresent = JSON.stringify(checks.txt).toLowerCase().includes('v=spf1');
  } catch (e) {
    checks.txt = [];
    checks.txtError = e.code || e.message;
    checks.spfPresent = false;
  }
  try {
    checks.dmarc = await activeResolver.resolveTxt(`_dmarc.${safeDomain}`);
    checks.dmarcPresent = JSON.stringify(checks.dmarc).toLowerCase().includes('v=dmarc1');
  } catch (e) {
    checks.dmarc = [];
    checks.dmarcError = e.code || e.message;
    checks.dmarcPresent = false;
  }
  try {
    checks.ns = await activeResolver.resolveNs(safeDomain);
    checks.nsPresent = Array.isArray(checks.ns) && checks.ns.length > 0;
  } catch (e) {
    checks.ns = [];
    checks.nsError = e.code || e.message;
    checks.nsPresent = false;
  }
  const status = checks.disposable ? 'disposable_domain'
    : checks.mxPresent ? 'mx_present'
      : checks.nsPresent ? 'dns_valid_domain_no_mx'
        : 'dns_not_confirmed';
  return { status, confidence: checks.mxPresent ? 'medium' : 'low', checks };
}

async function smtpProbe(email, domainChecks, { env = process.env, timeoutMs = 8000 } = {}) {
  if (env.JOBOS_SMTP_PROBE !== 'true') return { status: 'smtp_not_enabled' };
  if (env.JOBOS_SMTP_FIXTURE_JSON) {
    try {
      const fixture = JSON.parse(env.JOBOS_SMTP_FIXTURE_JSON);
      const status = fixture[email] || fixture[emailDomain(email)] || 'smtp_inconclusive';
      return { status, fixture: true };
    } catch {
      return { status: 'smtp_inconclusive', fixtureError: 'invalid_fixture_json' };
    }
  }
  const domain = emailDomain(email);
  const last = smtpProbeLastByDomain.get(domain) || 0;
  const elapsed = Date.now() - last;
  if (elapsed < 30000) return { status: 'smtp_rate_limited', waitMs: 30000 - elapsed };
  const mx = [...(domainChecks.mx || [])].sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0))[0];
  if (!mx?.exchange) return { status: 'smtp_inconclusive', reason: 'no_mx_host' };
  smtpProbeLastByDomain.set(domain, Date.now());
  return await new Promise(resolve => {
    const socket = net.connect(25, mx.exchange);
    socket.setTimeout(timeoutMs);
    let buffer = '';
    let step = 0;
    const finish = status => {
      try { socket.write('QUIT\r\n'); } catch {}
      try { socket.end(); } catch {}
      resolve({ status });
    };
    socket.on('connect', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      const line = buffer.split(/\r?\n/).filter(Boolean).at(-1) || '';
      if (step === 0 && /^220/.test(line)) {
        step = 1;
        socket.write('HELO jobos.local\r\n');
      } else if (step === 1 && /^250/.test(line)) {
        step = 2;
        socket.write('MAIL FROM:<test@jobos.local>\r\n');
      } else if (step === 2 && /^250/.test(line)) {
        step = 3;
        socket.write(`RCPT TO:<${email}>\r\n`);
      } else if (step === 3) {
        if (/^250/.test(line)) finish('smtp_accepts_rcpt');
        else if (/^(550|551|553)/.test(line)) finish('smtp_rejects_rcpt');
        else finish('smtp_inconclusive');
      }
    });
    socket.on('error', () => resolve({ status: 'smtp_inconclusive' }));
    socket.on('timeout', () => { try { socket.end(); } catch {} resolve({ status: 'smtp_inconclusive' }); });
  });
}

async function dnsForEmails(emails, options) {
  const out = new Map();
  for (const email of emails) {
    const domain = emailDomain(email);
    if (!domain || out.has(domain)) continue;
    out.set(domain, await verifyEmailDomain(domain, options));
  }
  return out;
}

function observationEmailContexts(observation) {
  const meta = observation.metadata || {};
  const rows = Array.isArray(meta.emailContexts) ? meta.emailContexts : [];
  const fromRows = rows.map(row => ({
    email: String(row.email || '').toLowerCase(),
    name: String(row.name || '').trim(),
    context: String(row.context || '').trim(),
    generic: Boolean(row.generic)
  })).filter(row => row.email);
  const seen = new Set(fromRows.map(row => row.email));
  const extra = [...(Array.isArray(meta.emails) ? meta.emails : []), ...extractEmails(observation.snippet || ''), ...extractEmails(meta.rawText || '')]
    .filter(email => !seen.has(email))
    .map(email => ({ email, name: nameFromEmailLocal(email), context: observation.snippet || observation.title, generic: isGenericInbox(email) }));
  const textContexts = meta.rawText ? extractEmailContexts(meta.rawText).filter(row => !seen.has(row.email)) : [];
  return [...fromRows, ...extra, ...textContexts].filter((row, index, arr) => arr.findIndex(other => other.email === row.email && other.name === row.name) === index);
}

function personCandidatesFromObservation(observation) {
  const meta = observation.metadata || {};
  const people = Array.isArray(meta.personCandidates) ? meta.personCandidates : [];
  const fromEmails = observationEmailContexts(observation).filter(row => row.name && !row.generic).map(row => ({
    name: row.name,
    role: 'Public contact',
    confidence: 'medium',
    summary: row.context,
    sourceType: 'email_context'
  }));
  const fromLinkedIn = isLinkedInProfileUrl(observation.url) ? [{
    name: namesFromTitle(observation.title),
    role: roleFromTitle(observation.title, observation.snippet),
    confidence: 'medium',
    summary: observation.snippet || observation.title,
    sourceType: 'public_profile_url'
  }].filter(p => p.name) : [];
  return [...people, ...fromEmails, ...fromLinkedIn].filter(p => p.name);
}

function stakeholderCandidates(s, jobId) {
  return all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [jobId]).map(row => ({
    id: row.id,
    name: row.name,
    role: row.role || '',
    sourceObservationIds: [],
    stakeholderId: row.id,
    type: 'stakeholder'
  }));
}

function candidateRowsForGeneration(s, jobId) {
  return [
    ...listPersonCandidates(s, { jobId }).filter(candidate => candidate.status !== 'suppressed'),
    ...stakeholderCandidates(s, jobId)
  ];
}

function samePerson(a, b) {
  return String(a || '').toLowerCase().replace(/[^a-z]/g, '') === String(b || '').toLowerCase().replace(/[^a-z]/g, '');
}

function syncContacts(s, jobId) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) return {};
  const contacts = listContactPoints(s, { jobId });
  const candidates = listPersonCandidates(s, { jobId });
  const patterns = job.company_id ? listEmailPatterns(s, { companyId: job.company_id }) : [];
  const relYaml = path.join('jobs', jobId, 'research', 'contacts.yaml');
  writeYaml(path.join(s.p.ws, relYaml), {
    version: 1,
    policy: {
      autoSend: 'disabled',
      approvalRequired: 'human_approval_required',
      note: 'Exact public and candidate contacts are stored for review only. JobOS never sends outreach.'
    },
    contacts,
    personCandidates: candidates,
    emailPatterns: patterns
  });
  const relMd = path.join('jobs', jobId, 'research', 'contacts.md');
  writeMd(path.join(s.p.ws, relMd), renderContactWorksheet({ job, contacts, candidates, patterns, generatedAt: now() }));
  return { yamlPath: relYaml, path: relMd };
}

function renderSources(ids) {
  return ids.length ? ids.map(sourceId => `  - Source observation: ${sourceId}`).join('\n') : '  - Source observation: none recorded';
}

function renderContactWorksheet({ job, contacts, candidates, patterns, generatedAt }) {
  const contactRows = contacts.length ? contacts.map(contact => {
    const approval = contact.humanApproved ? 'approved' : 'needs human review';
    return `- **${contact.value}** (${contact.type})\n  - Tier: ${contact.evidenceTier}\n  - Verification: ${contact.verificationStatus}\n  - Confidence: ${contact.confidence}\n  - Approval: ${approval}\n${renderSources(contact.sourceObservationIds)}`;
  }).join('\n') : '- No contacts discovered yet.';
  const candidateRows = candidates.length ? candidates.map(candidate => `- **${candidate.name}** — ${candidate.role || 'role unknown'}\n  - Relevance: ${candidate.relevance}\n  - Confidence: ${candidate.confidence}\n  - Status: ${candidate.status}\n${renderSources(candidate.sourceObservationIds)}`).join('\n') : '- No person candidates staged yet.';
  const patternRows = patterns.length ? patterns.map(pattern => `- ${pattern.domain}: \`${pattern.pattern}\` (${pattern.supportCount} source-backed example(s), ${pattern.confidence})`).join('\n') : '- No source-backed email patterns inferred.';
  return `# Contact research - ${job.company}

Generated: ${generatedAt}

**Related job:** ${job.title} (${job.id})

## Contact points
${contactRows}

## Email patterns
${patternRows}

## Person candidates
${candidateRows}

## Evidence tiers
- A: exact public email on a company-controlled page.
- B: exact public email on a credible third-party or search-indexed public source.
- C: source-backed person plus company email pattern with multiple public examples.
- D: weak pattern/domain hypothesis, usually DNS-only or single-example support.
- E: profile URL or role relevance without an email.

## Human gate
- JobOS created a local contact worksheet only.
- It did not send email, LinkedIn messages, connection requests, applications, or follow-ups.
- Guessed emails are hypotheses until a human approves them.
`;
}

export async function discoverContacts(s, { jobId = null, stakeholderId = null, fetchImpl = fetch, lookupImpl = null, resolver = null, env = process.env } = {}) {
  let job = jobId ? one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]) : null;
  let stakeholder = null;
  if (stakeholderId) {
    stakeholder = one(s, 'SELECT * FROM stakeholders WHERE id=?', [stakeholderId]);
    if (!stakeholder) throw Error(`Unknown stakeholder: ${stakeholderId}`);
    job = one(s, 'SELECT * FROM jobs WHERE id=?', [stakeholder.job_id]);
  }
  if (!job) throw Error(`Unknown job: ${jobId || ''}`);
  const company = job.company_id ? one(s, 'SELECT * FROM companies WHERE id=?', [job.company_id]) : null;
  const at = now();
  const search = await collectSearchObservations(s, job, company, { env });
  const initialObservations = [
    ...listSourceObservations(s, { jobId: job.id }),
    ...search.observations
  ].filter((obs, index, arr) => arr.findIndex(other => other.id === obs.id) === index);
  const initialDomains = companyDomains(job, company, initialObservations);
  const adapters = await collectConfiguredAdapterObservations(s, job, initialDomains, search.observations, { fetchImpl, lookupImpl, env });
  const pages = await fetchPageObservations(s, job, company, [...search.observations, ...adapters.observations], { fetchImpl, lookupImpl, env });
  const observations = [
    ...initialObservations,
    ...adapters.observations,
    ...pages.observations
  ].filter((obs, index, arr) => arr.findIndex(other => other.id === obs.id) === index);
  const domains = companyDomains(job, company, observations);
  const exactEmails = new Set();
  const candidateByName = new Map();
  for (const observation of observations) {
    const people = personCandidatesFromObservation(observation);
    for (const person of people) {
      const candidate = upsertPersonCandidate(s, job, person, [observation.id], at);
      if (candidate) candidateByName.set(candidate.name.toLowerCase(), candidate);
    }
  }
  for (const observation of observations) {
    for (const ctx of observationEmailContexts(observation)) {
      if (!ctx.email) continue;
      exactEmails.add(ctx.email);
      const tier = tierForEmailObservation(ctx.email, observation, domains);
      const generic = ctx.generic || isGenericInbox(ctx.email);
      let personId = null;
      let linkedStakeholderId = null;
      if (!generic && ctx.name) {
        const candidate = candidateByName.get(ctx.name.toLowerCase()) || upsertPersonCandidate(s, job, { name: ctx.name, role: 'Public contact', confidence: 'medium' }, [observation.id], at);
        personId = candidate?.id || null;
        const stakeholderMatch = all(s, 'SELECT id,name FROM stakeholders WHERE job_id=?', [job.id]).find(row => samePerson(row.name, ctx.name));
        linkedStakeholderId = stakeholderMatch?.id || null;
      }
      const domainCheck = await verifyEmailDomain(emailDomain(ctx.email), { resolver, env });
      const smtp = await smtpProbe(ctx.email, domainCheck.checks, { env });
      const status = tier === 'A' || tier === 'B' ? 'exact_public' : domainCheck.status;
      upsertContactPoint(s, {
        companyId: job.company_id,
        personId,
        stakeholderId: linkedStakeholderId,
        type: generic ? 'generic_inbox' : 'email',
        value: ctx.email,
        evidenceTier: tier,
        verificationStatus: status,
        confidence: confidenceForTier(tier, generic),
        sourceObservationIds: [observation.id],
        checks: { exactPublic: true, sourceUrl: observation.url, dns: domainCheck, smtp }
      }, at);
    }
  }
  for (const observation of observations.filter(obs => isLinkedInProfileUrl(obs.url))) {
    const name = namesFromTitle(observation.title);
    const candidate = name ? upsertPersonCandidate(s, job, { name, role: roleFromTitle(observation.title, observation.snippet), confidence: 'medium', sourceType: 'public_profile_url' }, [observation.id], at) : null;
    upsertContactPoint(s, {
      companyId: job.company_id,
      personId: candidate?.id || null,
      type: 'profile_url',
      value: observation.url,
      evidenceTier: 'E',
      verificationStatus: 'profile_url_only',
      confidence: 'medium',
      sourceObservationIds: [observation.id],
      checks: { profileUrlOnly: true, fetched: false }
    }, at);
  }
  const patternSupport = new Map();
  for (const observation of observations) {
    for (const ctx of observationEmailContexts(observation)) {
      if (!ctx.name || ctx.generic || isGenericInbox(ctx.email)) continue;
      const pattern = patternForNameEmail(ctx.name, ctx.email);
      if (!pattern) continue;
      const domain = emailDomain(ctx.email);
      const key = `${domain}:${pattern}`;
      if (!patternSupport.has(key)) patternSupport.set(key, { domain, pattern, sourceIds: new Set(), examples: new Set() });
      patternSupport.get(key).sourceIds.add(observation.id);
      patternSupport.get(key).examples.add(ctx.email);
    }
  }
  const patterns = [];
  for (const support of patternSupport.values()) {
    const count = support.examples.size;
    patterns.push(upsertPattern(s, {
      companyId: job.company_id,
      domain: support.domain,
      pattern: support.pattern,
      supportSources: [...support.sourceIds],
      supportCount: count,
      confidence: count >= 2 ? 'high' : 'low'
    }, at));
  }
  const existingEmailValues = new Set(listContactPoints(s, { jobId: job.id }).filter(c => ['email', 'generic_inbox'].includes(c.type)).map(c => c.normalizedValue));
  const domainChecks = await dnsForEmails([...exactEmails, ...patterns.map(p => `pattern@${p.domain}`)], { resolver, env });
  for (const pattern of patterns) {
    const dnsCheck = domainChecks.get(pattern.domain) || await verifyEmailDomain(pattern.domain, { resolver, env });
    for (const candidate of candidateRowsForGeneration(s, job.id)) {
      const guessed = generateFromPattern(candidate.name, pattern.domain, pattern.pattern);
      if (!guessed || existingEmailValues.has(guessed)) continue;
      const tier = pattern.supportCount >= 2 ? 'C' : 'D';
      const sourceIds = [...new Set([...(candidate.sourceObservationIds || []), ...pattern.supportSources])];
      upsertContactPoint(s, {
        companyId: job.company_id,
        personId: candidate.type === 'stakeholder' ? null : candidate.id,
        stakeholderId: candidate.stakeholderId || null,
        type: 'email',
        value: guessed,
        evidenceTier: tier,
        verificationStatus: tier === 'C' ? 'pattern_candidate' : dnsCheck.status,
        confidence: tier === 'C' && dnsCheck.checks.mxPresent ? 'medium' : 'low',
        sourceObservationIds: sourceIds,
        checks: { pattern: pattern.pattern, supportCount: pattern.supportCount, dns: dnsCheck, generated: true }
      }, at);
      existingEmailValues.add(guessed);
    }
  }
  const paths = syncContacts(s, job.id);
  syncSourceObservations(s, job.id);
  audit(s, 'research.contacts.created', 'job', job.id, {
    jobId: job.id,
    stakeholderId: stakeholder?.id || null,
    path: paths.path,
    queryCount: search.queries.length,
    fetchedPageCount: pages.observations.length,
    contactCount: listContactPoints(s, { jobId: job.id }).length,
    patternCount: listEmailPatterns(s, { companyId: job.company_id }).length,
    warnings: search.warnings.length + adapters.warnings.length + pages.warnings.length
  });
  save(s);
  const contacts = listContactPoints(s, stakeholderId ? { stakeholderId } : { jobId: job.id });
  return {
    jobId: job.id,
    stakeholderId: stakeholder?.id || null,
    path: paths.path,
    yamlPath: paths.yamlPath,
    sourceObservationPath: path.join('jobs', job.id, 'research', 'source-observations.yaml'),
    queryCount: search.queries.length,
    fetchedPageCount: pages.observations.length,
    contactCount: contacts.length,
    candidateCount: listPersonCandidates(s, { jobId: job.id }).length,
    patternCount: listEmailPatterns(s, { companyId: job.company_id }).length,
    contacts,
    personCandidates: listPersonCandidates(s, { jobId: job.id }),
    emailPatterns: listEmailPatterns(s, { companyId: job.company_id }),
    warnings: [...search.warnings, ...adapters.warnings, ...pages.warnings],
    note: 'Contact research created local evidence and review records only; no outreach was sent.'
  };
}

export function approveContact(s, { contactId }) {
  const row = one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId]);
  if (!row) throw Error(`Unknown contact: ${contactId}`);
  const at = now();
  run(s, 'UPDATE contact_points SET human_approved=1, updated_at=? WHERE id=?', [at, contactId]);
  audit(s, 'research.contact.approved', 'contact_point', contactId, { companyId: row.company_id, stakeholderId: row.stakeholder_id || null, type: row.type, evidenceTier: row.evidence_tier, humanApproved: true });
  const job = row.company_id ? one(s, 'SELECT id FROM jobs WHERE company_id=? ORDER BY updated_at DESC LIMIT 1', [row.company_id]) : null;
  if (job) syncContacts(s, job.id);
  save(s);
  return { ...rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId])), note: 'Contact approved for human-reviewed use; JobOS did not send outreach.' };
}

export function suppressContact(s, { contactId, reason = '' }) {
  const row = one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId]);
  if (!row) throw Error(`Unknown contact: ${contactId}`);
  const at = now();
  run(s, 'UPDATE contact_points SET do_not_use=1, updated_at=? WHERE id=?', [at, contactId]);
  audit(s, 'research.contact.suppressed', 'contact_point', contactId, { companyId: row.company_id, reason: reason || 'user_suppressed' });
  const job = row.company_id ? one(s, 'SELECT id FROM jobs WHERE company_id=? ORDER BY updated_at DESC LIMIT 1', [row.company_id]) : null;
  if (job) syncContacts(s, job.id);
  save(s);
  return { ...rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId])), note: 'Contact suppressed locally; no external action was taken.' };
}

export function promoteStakeholder(s, { candidateId: cid }) {
  const candidate = one(s, 'SELECT * FROM person_candidates WHERE id=?', [cid]);
  if (!candidate) throw Error(`Unknown candidate: ${cid}`);
  if (candidate.status === 'suppressed') throw Error(`Candidate ${cid} is suppressed`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [candidate.job_id]);
  if (!job) throw Error(`Unknown job for candidate: ${cid}`);
  const at = now();
  const stakeholderId = id('stakeholder', `${job.id}:${candidate.name}:${candidate.role}:${cid}`);
  const sourceIds = parseJson(candidate.source_observation_ids_json, []);
  const links = sourceIds.map(sourceId => one(s, 'SELECT url FROM source_observations WHERE id=?', [sourceId])?.url).filter(Boolean);
  const summary = `Confidence: ${candidate.confidence}. Source type: person_candidate. ${candidate.name} is staged as ${candidate.role || 'a relevant stakeholder'} for ${job.company}.`;
  run(s, 'INSERT OR REPLACE INTO stakeholders VALUES (?,?,?,?,?,?,?,?,?,?)', [stakeholderId, job.id, job.company_id, candidate.name, candidate.role || 'Relevant stakeholder', JSON.stringify(links), summary, 'not_contacted', at, at]);
  run(s, 'UPDATE person_candidates SET status=?, updated_at=? WHERE id=?', ['promoted', at, cid]);
  run(s, 'UPDATE contact_points SET stakeholder_id=?, updated_at=? WHERE person_id=? AND (stakeholder_id IS NULL OR stakeholder_id="")', [stakeholderId, at, cid]);
  syncContacts(s, job.id);
  audit(s, 'research.stakeholder.promoted', 'stakeholder', stakeholderId, { jobId: job.id, candidateId: cid, sourceObservationIds: sourceIds });
  save(s);
  return { id: stakeholderId, candidateId: cid, jobId: job.id, name: candidate.name, role: candidate.role || '', sourceUrls: links, note: 'Candidate promoted to local stakeholder; no outreach was sent.' };
}

export function contactSummaryForPlan(contact) {
  if (!contact) return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['No contact point selected.'] };
  if (contact.doNotUse) return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['Selected contact is suppressed.'] };
  if (contact.type === 'profile_url') return { channel: 'linkedin_manual', pathStrength: contact.evidenceTier === 'E' ? 'medium' : 'low', warnings: ['Manual profile outreach only. JobOS will not fetch or send LinkedIn messages.'] };
  if (contact.type === 'generic_inbox') return { channel: 'generic_inbox', pathStrength: contact.humanApproved ? 'medium' : 'low', warnings: contact.humanApproved ? [] : ['Generic inbox requires human review before use.'] };
  if (contact.type === 'email') {
    const guessed = ['C', 'D'].includes(contact.evidenceTier);
    const warnings = [];
    if (!contact.humanApproved) warnings.push('Email contact is not human-approved yet.');
    if (guessed) warnings.push('Email is a pattern candidate, not a verified mailbox.');
    const strength = contact.humanApproved && contact.evidenceTier === 'A' ? 'high' : contact.humanApproved ? 'medium' : 'low';
    return { channel: 'email', pathStrength: strength, warnings };
  }
  return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['Unsupported contact type.'] };
}

export function createOutreachPlan(s, { jobId, profileId, stakeholderId = null, goal = 'informational' }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  const contacts = stakeholderId ? listContactPoints(s, { stakeholderId }) : listContactPoints(s, { jobId });
  const sorted = contacts.sort((a, b) => {
    const tierScore = tier => ({ A: 5, B: 4, C: 3, E: 2, D: 1 }[tier] || 0);
    return Number(b.humanApproved) - Number(a.humanApproved) || tierScore(b.evidenceTier) - tierScore(a.evidenceTier);
  });
  const selected = sorted[0] || null;
  const summary = contactSummaryForPlan(selected);
  const at = now();
  const pid = id('plan', `${jobId}:${profileId}:${stakeholderId || ''}:${selected?.id || ''}:${goal}:${at}`);
  const reasoning = {
    selectedContact: selected,
    reason: selected ? `Selected ${selected.evidenceTier} ${selected.type} path for review.` : 'No contact path is available.',
    humanGate: 'draft_or_copy_only'
  };
  run(s, 'INSERT INTO outreach_plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [pid, jobId, profileId, stakeholderId || selected?.stakeholderId || null, selected?.id || null, slug(goal || 'informational'), summary.channel, summary.pathStrength, selected ? 1 : 0, JSON.stringify(reasoning), JSON.stringify(summary.warnings), at]);
  audit(s, 'outreach.plan.created', 'outreach_plan', pid, { jobId, profileId, stakeholderId, contactPointId: selected?.id || null, channel: summary.channel, warnings: summary.warnings.length });
  save(s);
  return {
    id: pid,
    jobId,
    profileId,
    stakeholderId: stakeholderId || selected?.stakeholderId || null,
    contactPointId: selected?.id || null,
    goal: slug(goal || 'informational'),
    channel: summary.channel,
    pathStrength: summary.pathStrength,
    recommended: Boolean(selected),
    reasoning,
    warnings: summary.warnings,
    note: 'Outreach plan is local and human-gated; JobOS did not send outreach.'
  };
}
