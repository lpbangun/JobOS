import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { one, all, run, audit, save } from '../db.js';
import { id, now, parseJson, slug } from '../utils.js';
import { writeMd, writeYaml } from '../workspace.js';
import {
  canonicalUrl,
  emailDomain,
  extractEmailContexts,
  extractEmails,
  hostForUrl,
  isGenericInbox,
  nameFromEmailLocal,
} from './sources.js';
import { resolvePerson } from './people.js';
import { projectContactConfidenceV2 as buildContactConfidence } from '../contact-confidence.js';

const disposableDomains = new Set([
  '10minutemail.com', 'guerrillamail.com', 'mailinator.com', 'tempmail.com', 'yopmail.com'
]);
export const TIER_RANK = Object.freeze({A: 6, B: 5, U: 4, C: 3, E: 2, D: 1});


const smtpProbeLastByDomain = new Map();
export { CONTACT_CONFIDENCE_MODEL, CONTACT_CONFIDENCE_SCHEMA } from '../contact-confidence.js';

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
    personId: row.person_id || null,
    researchRunId: row.research_run_id || null,
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
    rawEvidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    checks: parseJson(row.checks_json, {}),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    originResearchRunId: row.origin_research_run_id || null
  } : null;
}

function rowToPattern(row) {
  return row ? {
    id: row.id,
    companyId: row.company_id || null,
    domain: row.domain,
    pattern: row.pattern,
    supportCount: row.support_count,
    supportSources: parseJson(row.support_sources_json, []),
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}
export function projectContactConfidenceV2(s, contact, options = {}) {
  return buildContactConfidence(s, contact, options);
}

function projectedContact(s, contact, options = {}) {
  if (!contact) return null;
  const contactConfidence = buildContactConfidence(s, contact, options);
  return {
    ...contact,
    rawEvidenceTier: contact.evidenceTier,
    evidenceTier: contactConfidence.evidenceTier,
    tierReason: contactConfidence.tierReason,
    contactConfidence,
    usable: contactConfidence.usable,
    usabilityReason: contactConfidence.usabilityReason,
    warnings: contactConfidence.warnings
  };
}

export function listPersonCandidates(s, { jobId = null, companyId = null } = {}) {
  if (jobId) return all(s, 'SELECT * FROM person_candidates WHERE job_id=? ORDER BY updated_at DESC, name', [jobId]).map(rowToCandidate);
  if (companyId) return all(s, 'SELECT * FROM person_candidates WHERE company_id=? ORDER BY updated_at DESC, name', [companyId]).map(rowToCandidate);
  return all(s, 'SELECT * FROM person_candidates ORDER BY updated_at DESC, name').map(rowToCandidate);
}

export function listContactPoints(s, { jobId = null, stakeholderId = null, companyId = null, nowDate = new Date() } = {}) {
  const confidenceOrder = { high: 3, medium: 2, low: 1 };
  let contacts;
  if (stakeholderId) {
    contacts = all(s, 'SELECT * FROM contact_points WHERE stakeholder_id=?', [stakeholderId]).map(rowToContact);
  } else if (companyId) {
    contacts = all(s, 'SELECT * FROM contact_points WHERE company_id=?', [companyId]).map(rowToContact);
  } else if (jobId) {
    const job = one(s, 'SELECT company_id FROM jobs WHERE id=?', [jobId]);
    if (!job?.company_id) return [];
    contacts = all(s, 'SELECT * FROM contact_points WHERE company_id=?', [job.company_id]).map(rowToContact);
  } else {
    contacts = all(s, 'SELECT * FROM contact_points ORDER BY updated_at DESC').map(rowToContact);
  }
  return contacts.map(contact => projectedContact(s, contact, { nowDate })).sort((a, b) =>
    (TIER_RANK[b.evidenceTier] || 0) - (TIER_RANK[a.evidenceTier] || 0)
    || (confidenceOrder[b.confidence] || 0) - (confidenceOrder[a.confidence] || 0)
    || b.updatedAt.localeCompare(a.updatedAt)
  );
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
  const personId = person.personId || null;
  const researchRunId = person.researchRunId || null;
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
    at,
    personId,
    researchRunId
  ];
  if (existing) {
    run(s, `UPDATE person_candidates SET job_id=?,company_id=?,name=?,role=?,function=?,seniority=?,relevance=?,confidence=?,source_observation_ids_json=?,status=?,suppression_reason=?,created_at=?,updated_at=?,person_id=?,research_run_id=? WHERE id=?`, [...params.slice(1, 16), cid]);
  } else {
    run(s, `INSERT INTO person_candidates (id,job_id,company_id,name,role,function,seniority,relevance,confidence,source_observation_ids_json,status,suppression_reason,created_at,updated_at,person_id,research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params);
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

export function upsertContactPoint(s, {
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
  doNotUse = false,
  originResearchRunId = null
}, at = now()) {
  const normalized = normalizeContactValue(type, value);
  if (!normalized) return null;
  const seededId = contactId(companyId, type, normalized, personId || '', stakeholderId || '');
  const existing = personId
    ? one(s, 'SELECT * FROM contact_points WHERE person_id=? AND type=? AND normalized_value=? ORDER BY created_at LIMIT 1', [personId, type, normalized])
    : one(s, 'SELECT * FROM contact_points WHERE id=?', [seededId]);
  const cid = existing?.id || seededId;
  const sourceIds = [...new Set([...(parseJson(existing?.source_observation_ids_json, []) || []), ...sourceObservationIds])];
  const mergedChecks = { ...(parseJson(existing?.checks_json, {}) || {}), ...(checks || {}) };
  const approved = existing?.human_approved ? 1 : (humanApproved ? 1 : 0);
  const blocked = existing?.do_not_use ? 1 : (doNotUse ? 1 : 0);
  const resolvedTier = (TIER_RANK[existing?.evidence_tier] || 0) > (TIER_RANK[evidenceTier] || 0)
    ? existing.evidence_tier
    : evidenceTier;
  const resolvedVerification = resolvedTier === existing?.evidence_tier
    ? existing.verification_status
    : verificationStatus;
  const confidenceRank = { blocked: 0, low: 1, medium: 2, high: 3 };
  const resolvedConfidence = (confidenceRank[existing?.confidence] || 0) > (confidenceRank[confidence] || 0)
    ? existing.confidence
    : normalizeConfidence(confidence, 'low');
  const orrId = originResearchRunId || existing?.origin_research_run_id || '';
  const params = [
    cid,
    personId || existing?.person_id || null,
    stakeholderId || existing?.stakeholder_id || null,
    companyId || existing?.company_id || null,
    type,
    value,
    normalized,
    resolvedTier,
    resolvedVerification,
    resolvedConfidence,
    JSON.stringify(sourceIds),
    JSON.stringify(mergedChecks),
    approved,
    blocked,
    existing?.created_at || at,
    at,
    orrId
  ];
  if (existing) {
    run(s, `UPDATE contact_points SET person_id=?,stakeholder_id=?,company_id=?,type=?,value=?,normalized_value=?,evidence_tier=?,verification_status=?,confidence=?,source_observation_ids_json=?,checks_json=?,human_approved=?,do_not_use=?,created_at=?,updated_at=?,origin_research_run_id=? WHERE id=?`, [...params.slice(1, 17), cid]);
  } else {
    run(s, `INSERT INTO contact_points (id,person_id,stakeholder_id,company_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at,origin_research_run_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, params);
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


function companyDomains(job, company) {
  const domains = new Set();
  const declared = String(company?.domain || '').trim().toLowerCase();
  if (declared && declared.includes('.')) domains.add(declared);
  const websiteHost = hostForUrl(company?.website);
  if (websiteHost) domains.add(websiteHost);
  return [...domains].sort();
}

function tierForEmailObservation(email, observation, domains, companyId, nowAt, { generic = false, hasIndependentAssociation = false } = {}) {
  const domain = emailDomain(email);
  const host = hostForUrl(observation.url);
  const companyDomainMatch = domains.some(expected => domain === expected || domain.endsWith(`.${expected}`));
  const companyControlled = observation.companyId === companyId
    && domains.some(expected => host === expected || host.endsWith(`.${expected}`));
  const fetched = Date.parse(observation.fetchedAt || '');
  const current = Date.parse(nowAt || '');
  const nonStale = Number.isFinite(fetched) && Number.isFinite(current) && current - fetched <= 90 * 86_400_000;
  if (!companyDomainMatch || observation.companyId !== companyId || !nonStale) return 'D';
  if (companyControlled && observation.sourceType === 'page_fetch' && !generic) return 'A';
  if ((observation.sourceType === 'web_search' || observation.sourceType === 'profile_search') && hasIndependentAssociation) return 'B';
  return 'D';
}

function hasIndependentCompanyAssociation(s, personId, stakeholderId, companyId, excludeSourceId, additionalExcludes = []) {
  const exclude = new Set([excludeSourceId, ...additionalExcludes].filter(Boolean));
  if (stakeholderId) {
    const stakeholder = one(s, 'SELECT company_id,links_json FROM stakeholders WHERE id=?', [stakeholderId]);
    if (stakeholder?.company_id === companyId) {
      const links = parseJson(stakeholder.links_json, []);
      if (links.length) {
        const linkPlaceholders = links.map(() => '?').join(',');
        const independentIds = all(s, `SELECT id FROM source_observations WHERE company_id=? AND url IN (${linkPlaceholders})`, [companyId, ...links])
          .map(row => row.id)
          .filter(id => !exclude.has(id));
        if (independentIds.length) return true;
      }
    }
  }
  if (personId && companyId) {
    const candidates = all(s, 'SELECT source_observation_ids_json FROM person_candidates WHERE person_id=? AND company_id=?', [personId, companyId]);
    const candidateIds = [...new Set(candidates.flatMap(c => parseJson(c.source_observation_ids_json, [])))]
      .filter(sid => sid && !exclude.has(sid));
    if (candidateIds.length) {
      const placeholders = candidateIds.map(() => '?').join(',');
      const real = all(s, `SELECT id FROM source_observations WHERE company_id=? AND id IN (${placeholders})`, [companyId, ...candidateIds]);
      if (real.length) return true;
    }
  }
  return false;
}

function confidenceForTier(tier, generic = false) {
  if (generic) return 'medium';
  if (tier === 'A') return 'high';
  if (tier === 'B' || tier === 'C' || tier === 'U') return 'medium';
  return 'low';
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
function catchAllCheck(email, { env = process.env } = {}) {
  if (!env.JOBOS_CATCH_ALL_FIXTURE_JSON) return { status: 'unknown', method: null, evidence: null };
  try {
    const fixture = JSON.parse(env.JOBOS_CATCH_ALL_FIXTURE_JSON);
    const raw = fixture[email] ?? fixture[emailDomain(email)];
    const value = typeof raw === 'string' ? { status: raw } : (raw || {});
    const status = ['detected', 'not_detected'].includes(value.status) ? value.status : 'unknown';
    return {
      status,
      method: 'fixture',
      evidence: value.evidence || null,
      fixture: true
    };
  } catch {
    return { status: 'unknown', method: 'fixture', evidence: 'invalid_fixture_json', fixture: true };
  }
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


function stakeholderCandidates(s, jobId) {
  return all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [jobId]).map(row => ({
    id: row.id,
    personId: row.person_id || null,
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


function syncContacts(s, jobId) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) return {};
  const contacts = listContactPoints(s, { jobId });
  const candidates = listPersonCandidates(s, { jobId });
  const patterns = job.company_id ? listEmailPatterns(s, { companyId: job.company_id }) : [];
  const relYaml = path.join('jobs', jobId, 'research', 'contacts.yaml');
  writeYaml(path.join(s.p.ws, relYaml), {
    version: 2,
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
    const projection = contact.contactConfidence;
    const approval = contact.humanApproved ? 'approved' : 'needs human review';
    const warnings = projection.warnings.length ? projection.warnings.map(warning => `  - Warning: ${warning}`).join('\n') : '  - Warnings: none';
    return `- **${contact.value}** (${contact.type})\n  - Tier: ${projection.evidenceTier} (derived; raw historical tier: ${projection.rawEvidenceTier || 'unknown'})\n  - Tier reason: ${projection.tierReason}\n  - Public observation: ${projection.signals.publicObservation.state}\n  - Company-domain alignment: ${projection.signals.companyDomain.matchState}\n  - Pattern support: ${projection.signals.pattern.supportState}\n  - DNS: MX ${projection.signals.dns.mx}; NS ${projection.signals.dns.ns}; SPF ${projection.signals.dns.spf}; DMARC ${projection.signals.dns.dmarc}\n  - SMTP: ${projection.signals.smtp.state} (not identity proof)\n  - Catch-all: ${projection.signals.catchAll.state}\n  - Freshness: ${projection.signals.freshness.state}${projection.signals.freshness.ageDays == null ? '' : ` (${projection.signals.freshness.ageDays} days)`}\n  - Approval: ${approval}; suppression: ${projection.doNotUse ? 'do not use' : 'not suppressed'}\n  - Usable: ${projection.usable ? 'yes' : 'no'} — ${projection.usabilityReason}\n${warnings}\n${renderSources(contact.sourceObservationIds)}`;
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
- A: exact named or role inbox observed on a company-controlled same-domain page, with company-domain match and non-stale evidence.
- B: exact public contact on a credible third-party source, with independently supported person-company association, company-domain match, and non-stale evidence.
- U: user-imported contact from network CSV import (unverified).
- C: generated candidate on a matching company domain, backed by at least two distinct non-stale exact public examples from at least two real qualifying source observations.
- D: weak pattern/domain hypothesis, usually DNS-only or single-example support.
- E: profile URL or role relevance without an email.

## Human gate
- JobOS created a local contact worksheet only.
- It did not send email, LinkedIn messages, connection requests, applications, or follow-ups.
- Guessed emails are hypotheses until a human approves them.
`;
}

function observationRowsById(s, observationIds) {
  const ids = [...new Set((observationIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return all(s, `SELECT * FROM source_observations WHERE id IN (${placeholders})`, ids).map(row => ({
    id: row.id,
    companyId: row.company_id || null,
    jobId: row.job_id || null,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    snippet: row.snippet,
    sourceType: row.source_type,
    provider: row.provider,
    query: row.query,
    trust: row.trust,
    fetchedAt: row.fetched_at,
    contentHash: row.content_hash,
    metadata: parseJson(row.metadata_json, {})
  }));
}

export async function verifyObservationContacts(s, {
  runId,
  jobId = null,
  companyId = null,
  observationIds = [],
  resolver = null,
  env = process.env
} = {}) {
  if (!runId) throw Error('verifyObservationContacts requires runId');
  const job = jobId ? one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]) : null;
  if (jobId && !job) throw Error(`Unknown job: ${jobId}`);
  const resolvedCompanyId = companyId || job?.company_id || null;
  const company = resolvedCompanyId ? one(s, 'SELECT * FROM companies WHERE id=?', [resolvedCompanyId]) : null;
  const observations = observationRowsById(s, observationIds);
  const domainJob = job || { id: runId, company_id: resolvedCompanyId, url: '' };
  const domains = companyDomains(domainJob, company);
  const at = now();
  const contactIds = [];
  const exactEmails = new Set();
  const domainChecks = new Map();
  const stakeholderRows = job ? all(s, 'SELECT id,person_id FROM stakeholders WHERE job_id=?', [job.id]) : [];

  const domainCheckFor = async email => {
    const domain = emailDomain(email);
    if (!domainChecks.has(domain)) domainChecks.set(domain, await verifyEmailDomain(domain, { resolver, env }));
    return domainChecks.get(domain);
  };

  for (const observation of observations) {
    for (const ctx of observationEmailContexts(observation)) {
      if (!ctx.email) continue;
      exactEmails.add(ctx.email);
      const generic = ctx.generic || isGenericInbox(ctx.email);
      let person = null;
      if (!generic && ctx.name) {
        person = resolvePerson(s, {
          email: ctx.email,
          name: ctx.name,
          sourceRecordId: observation.id
        })?.person || null;
        if (job && person) {
          upsertPersonCandidate(s, job, {
            id: id('candidate', `${runId}:${person.id}`),
            personId: person.id,
            researchRunId: runId,
            name: person.name || ctx.name,
            role: 'Public contact',
            confidence: 'medium'
          }, [observation.id], at);
        }
      }
      const linkedStakeholder = person
        ? stakeholderRows.find(row => row.person_id === person.id)
        : null;
      let existingSourceIds = [];
      if (person) {
        const contactType = generic ? 'generic_inbox' : 'email';
        const normalizedContactValue = normalizeContactValue(contactType, ctx.email);
        const existingContact = one(s, 'SELECT source_observation_ids_json FROM contact_points WHERE person_id=? AND type=? AND normalized_value=? ORDER BY created_at LIMIT 1', [person.id, contactType, normalizedContactValue]);
        existingSourceIds = parseJson(existingContact?.source_observation_ids_json, []);
      }
      const hasIndependentAssociation = person
        ? hasIndependentCompanyAssociation(s, person.id, linkedStakeholder?.id || null, resolvedCompanyId, observation.id, existingSourceIds)
        : false;
      const tier = tierForEmailObservation(ctx.email, observation, domains, resolvedCompanyId, at, { generic, hasIndependentAssociation });
      const domainCheck = await domainCheckFor(ctx.email);
      const smtp = await smtpProbe(ctx.email, domainCheck.checks, { env });
      const catchAll = catchAllCheck(ctx.email, { env });
      const contact = upsertContactPoint(s, {
        companyId: resolvedCompanyId,
        personId: person?.id || null,
        stakeholderId: linkedStakeholder?.id || null,
        type: generic ? 'generic_inbox' : 'email',
        value: ctx.email,
        evidenceTier: tier,
        verificationStatus: tier === 'A' || tier === 'B' ? 'exact_public' : domainCheck.status,
        confidence: confidenceForTier(tier, generic),
        sourceObservationIds: [observation.id],
        checks: { exactPublic: true, sourceUrl: observation.url, dns: domainCheck, smtp, catchAll },
        originResearchRunId: runId
      }, at);
      if (contact?.id) contactIds.push(contact.id);
    }
  }

  if (job && resolvedCompanyId) {
    const patternSupport = new Map();
    for (const observation of observations) {
      if (observation.companyId !== resolvedCompanyId) continue;
      const fetched = Date.parse(observation.fetchedAt || '');
      if (!Number.isFinite(fetched) || Date.parse(at) - fetched > 90 * 86_400_000) continue;
      if (!['page_fetch', 'web_search', 'profile_search', 'x_search'].includes(observation.sourceType)
        || !/public|source|company|search/i.test(observation.trust || '')) continue;
      for (const ctx of observationEmailContexts(observation)) {
        if (!ctx.name || ctx.generic || isGenericInbox(ctx.email)) continue;
        const pattern = patternForNameEmail(ctx.name, ctx.email);
        if (!pattern) continue;
        const domain = emailDomain(ctx.email);
        if (!domains.includes(domain)) continue;
        const key = `${domain}:${pattern}`;
        if (!patternSupport.has(key)) patternSupport.set(key, { domain, pattern, sourceIds: new Set(), examples: new Set() });
        patternSupport.get(key).sourceIds.add(observation.id);
        patternSupport.get(key).examples.add(ctx.email);
      }
    }
    const patterns = [];
    for (const support of patternSupport.values()) {
      patterns.push(upsertPattern(s, {
        companyId: resolvedCompanyId,
        domain: support.domain,
        pattern: support.pattern,
        supportSources: [...support.sourceIds],
        supportCount: support.examples.size,
        confidence: support.examples.size >= 2 ? 'high' : 'low'
      }, at));
    }
    const existingEmailValues = new Set(listContactPoints(s, { companyId: resolvedCompanyId })
      .filter(contact => ['email', 'generic_inbox'].includes(contact.type))
      .map(contact => contact.normalizedValue));
    for (const pattern of patterns) {
      const dnsCheck = domainChecks.get(pattern.domain) || await verifyEmailDomain(pattern.domain, { resolver, env });
      const catchAll = catchAllCheck(`fixture@${pattern.domain}`, { env });
      for (const candidate of candidateRowsForGeneration(s, job.id)) {
        const guessed = generateFromPattern(candidate.name, pattern.domain, pattern.pattern);
        if (!guessed || existingEmailValues.has(guessed)) continue;
        const tier = pattern.supportCount >= 2 && pattern.supportSources.length >= 2 ? 'C' : 'D';
        const sourceIds = [...new Set([...(candidate.sourceObservationIds || []), ...pattern.supportSources])];
        const contact = upsertContactPoint(s, {
          companyId: resolvedCompanyId,
          personId: candidate.personId || null,
          stakeholderId: candidate.stakeholderId || null,
          type: 'email',
          value: guessed,
          evidenceTier: tier,
          verificationStatus: tier === 'C' ? 'pattern_candidate' : dnsCheck.status,
          confidence: tier === 'C' && dnsCheck.checks.mxPresent ? 'medium' : 'low',
          sourceObservationIds: sourceIds,
          checks: { pattern: pattern.pattern, supportCount: pattern.supportCount, dns: dnsCheck, catchAll, generated: true },
          originResearchRunId: runId
        }, at);
        if (contact?.id) contactIds.push(contact.id);
        existingEmailValues.add(guessed);
      }
    }
    syncContacts(s, job.id);
  }
  return { contactIds: [...new Set(contactIds)], exactEmailCount: exactEmails.size };
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
  return { ...projectedContact(s, rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId]))), note: 'Contact approved for human-reviewed use; JobOS did not send outreach.' };
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
  return { ...projectedContact(s, rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId]))), note: 'Contact suppressed locally; no external action was taken.' };
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
  run(s, `INSERT OR REPLACE INTO stakeholders (id,job_id,company_id,name,role,links_json,summary,outreach_status,created_at,updated_at,person_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [stakeholderId, job.id, job.company_id, candidate.name, candidate.role || 'Relevant stakeholder', JSON.stringify(links), summary, 'not_contacted', at, at, candidate.person_id || null]);
  run(s, 'UPDATE person_candidates SET status=?, updated_at=? WHERE id=?', ['promoted', at, cid]);
  run(s, 'UPDATE contact_points SET stakeholder_id=?, updated_at=? WHERE person_id=? AND (stakeholder_id IS NULL OR stakeholder_id="")', [stakeholderId, at, candidate.person_id || cid]);
  syncContacts(s, job.id);
  audit(s, 'research.stakeholder.promoted', 'stakeholder', stakeholderId, { jobId: job.id, candidateId: cid, sourceObservationIds: sourceIds });
  save(s);
  return { id: stakeholderId, candidateId: cid, jobId: job.id, name: candidate.name, role: candidate.role || '', sourceUrls: links, note: 'Candidate promoted to local stakeholder; no outreach was sent.' };
}

export function contactSummaryForPlan(contact) {
  if (!contact) return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['No contact point selected.'] };
  const projectionWarnings = contact.contactConfidence?.warnings || contact.warnings || [];
  if (contact.doNotUse) return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['Selected contact is suppressed.', ...projectionWarnings] };
  if (!contact.usable && contact.contactConfidence) {
    return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: [contact.usabilityReason, ...projectionWarnings] };
  }
  if (contact.type === 'profile_url') return { channel: 'linkedin_manual', pathStrength: contact.evidenceTier === 'E' ? 'medium' : 'low', warnings: ['Manual profile outreach only. JobOS will not fetch or send LinkedIn messages.', ...projectionWarnings] };
  if (contact.type === 'generic_inbox') return { channel: 'generic_inbox', pathStrength: contact.humanApproved ? 'medium' : 'low', warnings: [...(contact.humanApproved ? [] : ['Generic inbox requires human review before use.']), ...projectionWarnings] };
  if (contact.type === 'email') {
    const guessed = ['C', 'D'].includes(contact.evidenceTier);
    const warnings = [...projectionWarnings];
    if (!contact.humanApproved) warnings.push('Email contact is not human-approved yet.');
    if (guessed) warnings.push('Email is a pattern candidate, not a verified mailbox.');
    const strength = contact.humanApproved && contact.evidenceTier === 'A' ? 'high' : contact.humanApproved && contact.evidenceTier !== 'D' ? 'medium' : 'low';
    return { channel: 'email', pathStrength: strength, warnings: [...new Set(warnings)] };
  }
  return { channel: 'no_safe_path', pathStrength: 'blocked', warnings: ['Unsupported contact type.', ...projectionWarnings] };
}

export function createOutreachPlan(s, { jobId, profileId, stakeholderId = null, goal = 'informational' }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Object.assign(new Error(`Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`), { code: 'profile_job_mismatch', type: 'validation' });

  const contacts = stakeholderId ? listContactPoints(s, { stakeholderId }) : listContactPoints(s, { jobId });
  const sorted = contacts.sort((a, b) => {
    const tierScore = tier => TIER_RANK[tier] || 0;
    return Number(b.humanApproved) - Number(a.humanApproved) || tierScore(b.evidenceTier) - tierScore(a.evidenceTier);
  });
  const approved = sorted.filter(c => c.humanApproved && !c.doNotUse && c.usable);
  const selected = approved[0] || null;
  const stakeholderRows = all(s, 'SELECT id,name,person_id FROM stakeholders WHERE job_id=?', [jobId]);
  const candidates = listPersonCandidates(s, { jobId });
  const targetIds = new Set([
    job.company_id,
    job.company,
    ...stakeholderRows.flatMap(row => [row.id, row.person_id]),
    ...candidates.flatMap(candidate => [candidate.id, candidate.personId])
  ].filter(Boolean).map(value => String(value).toLowerCase()));
  const edgeScore = type => type === 'direct_connection' ? 6
    : ['shared_employer', 'shared_school', 'shared_open_source', 'shared_event'].includes(type) ? 5
      : ['shared_investor', 'shared_customer_domain'].includes(type) ? 4 : 3;
  const warmEdges = all(s, 'SELECT * FROM relationship_edges ORDER BY created_at DESC')
    .filter(edge => targetIds.has(String(edge.to_id || '').toLowerCase()))
    .filter(edge => !stakeholderId
      || edge.to_id === stakeholderId
      || stakeholderRows.some(row => row.id === stakeholderId && row.person_id === edge.to_id)
      || String(edge.to_id || '').toLowerCase() === String(job.company || '').toLowerCase())
    .sort((a, b) => edgeScore(b.edge_type) - edgeScore(a.edge_type));
  const selectedEdge = warmEdges[0] || null;
  const summary = contactSummaryForPlan(selected);
  const edgeStrength = selectedEdge ? edgeScore(selectedEdge.edge_type) : 0;
  const contactStrength = selected ? (TIER_RANK[selected.evidenceTier] || 1) : 0;
  const preferWarmPath = edgeStrength >= contactStrength && Boolean(selectedEdge);
  const channel = preferWarmPath ? (selectedEdge.edge_type === 'direct_connection' ? 'intro_request' : 'warm_context') : summary.channel;
  const pathStrength = preferWarmPath
    ? (edgeStrength >= 6 ? 'direct' : edgeStrength >= 5 ? 'strong' : 'moderate')
    : summary.pathStrength;
  const recommended = Boolean(selected || selectedEdge);
  const at = now();
  const pid = id('plan', `${jobId}:${profileId}:${stakeholderId || ''}:${selected?.id || ''}:${selectedEdge?.id || ''}:${goal}:${at}`);
  const reasoning = {
    selectedContact: selected,
    selectedNetworkEdge: selectedEdge ? {
      id: selectedEdge.id,
      fromType: selectedEdge.from_type,
      fromId: selectedEdge.from_id,
      toType: selectedEdge.to_type,
      toId: selectedEdge.to_id,
      edgeType: selectedEdge.edge_type,
      confidence: selectedEdge.confidence,
      evidence: parseJson(selectedEdge.evidence_json, [])
    } : null,
    reason: preferWarmPath
      ? `Selected ${selectedEdge.edge_type.replace(/_/g, ' ')} as the strongest introduction path.`
      : selected
        ? `Selected ${selected.evidenceTier} ${selected.type} contact path for review.`
        : 'No source-backed contact or user-owned network path is available.',
    execution: 'local_draft_or_user_configured_action'
  };
  const edgeStakeholder = selectedEdge
    ? stakeholderRows.find(row => row.id === selectedEdge.to_id || row.person_id === selectedEdge.to_id)
    : null;
  const contactStakeholder = selected?.personId
    ? stakeholderRows.find(row => row.person_id === selected.personId)
    : null;
  const resolvedStakeholderId = stakeholderId || selected?.stakeholderId || contactStakeholder?.id || edgeStakeholder?.id || null;
  const warnings = preferWarmPath ? [] : summary.warnings;
  run(s, 'INSERT INTO outreach_plans VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [pid, jobId, profileId, resolvedStakeholderId, selected?.id || null, slug(goal || 'informational'), channel, pathStrength, recommended ? 1 : 0, JSON.stringify(reasoning), JSON.stringify(warnings), at]);
  audit(s, 'outreach.plan.created', 'outreach_plan', pid, { jobId, profileId, stakeholderId: resolvedStakeholderId, contactPointId: selected?.id || null, relationshipEdgeId: selectedEdge?.id || null, channel, warnings: warnings.length });
  save(s);
  return {
    id: pid,
    jobId,
    profileId,
    stakeholderId: resolvedStakeholderId,
    contactPointId: selected?.id || null,
    relationshipEdgeId: selectedEdge?.id || null,
    goal: slug(goal || 'informational'),
    channel,
    pathStrength,
    recommended,
    reasoning,
    warnings,
    note: 'Outreach plan created locally; JobOS did not send a message.'
  };
}

export async function discoverContacts(s, { jobId = null, stakeholderId = null } = {}) {
  const { createResearchRun, executeResearchRun } = await import('./runs.js');
  const job = jobId ? one(s, 'SELECT profile_id FROM jobs WHERE id=?', [jobId]) : null;
  if (!job) throw Error(`Unknown job: ${jobId || ''}`);
  const runId = createResearchRun(s, { profileId: job.profile_id, scope: 'job', jobId, depth: 'standard' });
  return executeResearchRun(s, runId);
}
