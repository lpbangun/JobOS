import path from 'node:path';
import * as cheerio from 'cheerio';
import { one, all, run } from '../db.js';
import { hash, id, now, parseJson } from '../utils.js';
import { writeYaml } from '../workspace.js';

export const blockedProfileHosts = ['facebook.com', 'instagram.com', 'x.com', 'twitter.com'];

const genericInboxNames = new Set([
  'admin', 'careers', 'career', 'contact', 'hello', 'help', 'hr', 'info', 'jobs', 'press',
  'recruiting', 'recruitment', 'sales', 'support', 'talent', 'team'
]);

export function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) url.port = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(raw || '').replace(/\/$/, '');
  }
}

export function hostForUrl(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

export function isHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isLinkedInProfileUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'linkedin.com' && /^\/in\/[^/]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function isFetchablePublicPage(raw) {
  if (!isHttpUrl(raw)) return false;
  if (isLinkedInProfileUrl(raw)) return false;
  const host = hostForUrl(raw);
  return !blockedProfileHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function sourceAllowedForRecording(raw) {
  if (!isHttpUrl(raw)) return false;
  if (isLinkedInProfileUrl(raw)) return true;
  const host = hostForUrl(raw);
  return !blockedProfileHosts.some(domain => host === domain || host.endsWith(`.${domain}`));
}

export function normalizeEmail(raw) {
  return String(raw || '').trim().replace(/^mailto:/i, '').split('?')[0].toLowerCase();
}

export function emailDomain(email) {
  return normalizeEmail(email).split('@')[1] || '';
}

export function emailLocal(email) {
  return normalizeEmail(email).split('@')[0] || '';
}

export function isGenericInbox(email) {
  const local = emailLocal(email).replace(/[^a-z0-9]+/g, '');
  return genericInboxNames.has(local);
}

export function extractEmails(text) {
  const found = new Set();
  const re = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
  for (const match of String(text || '').matchAll(re)) {
    const email = normalizeEmail(match[0]);
    if (email && !email.includes('..')) found.add(email);
  }
  return [...found].sort();
}

function titleCase(value) {
  return String(value || '').split(/[\s._-]+/).filter(Boolean).map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()).join(' ');
}

export function nameFromEmailLocal(email) {
  const local = emailLocal(email);
  if (!local || isGenericInbox(email)) return '';
  if (/^[a-z]+[._-][a-z]+/.test(local)) return titleCase(local.replace(/[._-]+/g, ' '));
  return '';
}

function looksLikePersonName(value) {
  const words = String(value || '').trim().split(/\s+/).filter(Boolean);
  return words.length >= 2 && words.length <= 4 && words.every(w => /^[A-Z][A-Za-z'.-]+$/.test(w));
}

function roleLikeName(value) {
  return /\b(head|lead|manager|director|recruit|talent|people|hiring|founder|product|engineering|design|operations|advisor|partner|public|contact)\b/i.test(value);
}

function roleSignal(value) {
  return /\b(head|lead|manager|director|recruit|talent|people|hiring|founder|ceo|cto|vp|product|engineering|design|operations|advisor|partner)\b/i.test(value);
}

function inferNameFromLine(line, email) {
  const before = String(line || '').split(email)[0] || String(line || '');
  const matches = [];
  for (const sequence of before.match(/\b[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,5}\b/g) || []) {
    const words = sequence.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length - 1; i++) {
      const pair = `${words[i]} ${words[i + 1]}`;
      if (looksLikePersonName(pair)) matches.push(pair);
    }
    for (let i = 0; i < words.length - 2; i++) {
      const triple = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (looksLikePersonName(triple)) matches.push(triple);
    }
  }
  const explicit = matches.find(value => !roleLikeName(value)) || matches[0] || '';
  if (explicit) return explicit;
  return nameFromEmailLocal(email);
}

export function extractEmailContexts(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    for (const email of extractEmails(line)) {
      rows.push({ email, name: inferNameFromLine(line, email), context: line.slice(0, 300), generic: isGenericInbox(email) });
    }
  }
  const seen = new Set();
  return rows.filter(row => {
    const key = `${row.email}:${row.name}:${row.context}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nearestHeadingName($, el) {
  let prev = $(el).prev();
  for (let i = 0; i < 4 && prev.length; i++) {
    const text = prev.text().replace(/\s+/g, ' ').trim();
    if (looksLikePersonName(text) && !roleLikeName(text)) return text;
    prev = prev.prev();
  }
  const heading = $(el).parent().find('h1,h2,h3,h4,strong,b').first().text().replace(/\s+/g, ' ').trim();
  return looksLikePersonName(heading) && !roleLikeName(heading) ? heading : '';
}

function extractEmailContextsFromDom($) {
  const rows = [];
  $('p,li').each((_, el) => {
    const text = $(el).clone().children('h1,h2,h3,h4').remove().end().text().replace(/\s+/g, ' ').trim();
    const emails = extractEmails(text);
    if (!emails.length) return;
    const headingName = nearestHeadingName($, el);
    for (const email of emails) {
      rows.push({
        email,
        name: headingName || inferNameFromLine(text, email),
        context: text.slice(0, 300),
        generic: isGenericInbox(email)
      });
    }
  });
  const seen = new Set();
  return rows.filter(row => {
    const key = `${row.email}:${row.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function cleanRole(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/^[\-–—|,:\s]+/, '').trim().slice(0, 120);
}

export function extractPersonCandidatesFromText(text) {
  const people = [];
  const seen = new Set();
  const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/\b([A-Z][A-Za-z'.-]+\s+[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+)?)\b\s*(?:[-–—|,]| is |,? at )\s*([^@\n]{3,120})/);
    if (!match) continue;
    const name = match[1].trim();
    const role = cleanRole(match[2]);
    if (!looksLikePersonName(name) || !roleSignal(role)) continue;
    const key = `${name}:${role}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({ name, role, sourceType: 'page_text', confidence: 'medium', summary: line.slice(0, 300) });
  }
  return people.slice(0, 25);
}

function extractPeopleFromHtml($, bodyText) {
  const people = extractPersonCandidatesFromText(bodyText);
  const seen = new Set(people.map(p => `${p.name}:${p.role}`.toLowerCase()));
  $('h1,h2,h3,h4,strong,b').each((_, el) => {
    const name = $(el).text().replace(/\s+/g, ' ').trim();
    if (!looksLikePersonName(name)) return;
    const nextText = $(el).next().text().replace(/\s+/g, ' ').trim();
    const parentText = $(el).parent().text().replace(/\s+/g, ' ').trim();
    const after = nextText || parentText.replace(name, '').trim();
    if (!roleSignal(after)) return;
    const role = cleanRole(after);
    const key = `${name}:${role}`.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    people.push({ name, role, sourceType: 'page_dom', confidence: 'medium', summary: (nextText || parentText).slice(0, 300) });
  });
  return people.slice(0, 25);
}

export async function fetchPublicPage(rawUrl, { fetchImpl = fetch, env = process.env } = {}) {
  if (!isFetchablePublicPage(rawUrl)) return { ok: false, url: rawUrl, skipped: true, reason: 'not_fetchable_public_page' };
  const timeout = Math.max(1000, Number(env.JOBOS_RESEARCH_FETCH_TIMEOUT_MS || 12000));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  let response;
  try {
    response = await fetchImpl(rawUrl, {
      headers: { 'accept': 'text/html,text/plain;q=0.9,*/*;q=0.5', 'user-agent': 'JobOS local research (+human-initiated public page fetch)' },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  const type = response.headers?.get?.('content-type') || '';
  const $ = cheerio.load(html);
  const mailtoEmails = $('a[href^="mailto:"]').map((_, el) => normalizeEmail($(el).attr('href'))).get().filter(Boolean);
  $('script,style,noscript,svg').remove();
  $('br,p,div,section,article,li,h1,h2,h3,h4,h5,header,footer').each((_, el) => { $(el).append('\n'); });
  const title = ($('title').first().text() || $('h1').first().text() || rawUrl).replace(/\s+/g, ' ').trim();
  const bodyText = $('body').text().replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const emails = [...new Set([...mailtoEmails, ...extractEmails(bodyText)])].sort();
  const emailContexts = [...extractEmailContextsFromDom($), ...extractEmailContexts(bodyText)]
    .filter((row, index, arr) => arr.findIndex(other => other.email === row.email && other.name === row.name) === index);
  const personCandidates = extractPeopleFromHtml($, bodyText);
  return {
    ok: true,
    url: response.url || rawUrl,
    title,
    snippet: bodyText.slice(0, 500),
    rawText: bodyText.slice(0, 20000),
    contentHash: hash(`${title}\n${bodyText}`),
    metadata: {
      contentType: type,
      mailtoEmails: [...new Set(mailtoEmails)].sort(),
      emails,
      emailContexts,
      personCandidates
    }
  };
}

export function sourceObservationFromSearch(job, result, { sourceType = null } = {}) {
  const url = String(result.url || '').trim();
  const canonical = canonicalUrl(url);
  const type = sourceType || (isLinkedInProfileUrl(url) ? 'profile_search' : 'web_search');
  return {
    id: id('src', `${job.id}:${canonical}:${result.provider || 'search'}:${result.query || ''}:${result.rank || ''}`),
    companyId: job.company_id || null,
    jobId: job.id,
    url,
    canonicalUrl: canonical,
    title: String(result.title || url),
    snippet: String(result.snippet || ''),
    sourceType: type,
    provider: result.provider || 'search',
    query: result.query || '',
    trust: type === 'profile_search' ? 'public_search_profile_url' : 'public_search',
    fetchedAt: result.fetchedAt || now(),
    contentHash: hash(`${result.title || ''}\n${result.snippet || ''}`),
    metadata: { rank: result.rank || null, profileUrlOnly: isLinkedInProfileUrl(url) }
  };
}

export function sourceObservationFromPage(job, page, { provider = 'page_fetch', query = '' } = {}) {
  const canonical = canonicalUrl(page.url);
  return {
    id: id('src', `${job.id}:${canonical}:${page.contentHash || hash(page.rawText || page.snippet || '')}`),
    companyId: job.company_id || null,
    jobId: job.id,
    url: page.url,
    canonicalUrl: canonical,
    title: page.title || page.url,
    snippet: page.snippet || '',
    sourceType: 'page_fetch',
    provider,
    query,
    trust: 'public_company_or_web_page',
    fetchedAt: now(),
    contentHash: page.contentHash || hash(page.rawText || page.snippet || ''),
    metadata: { ...(page.metadata || {}), rawText: page.rawText || '' }
  };
}

export function saveSourceObservation(s, observation) {
  const existing = one(s, 'SELECT id FROM source_observations WHERE id=?', [observation.id]);
  const params = [
    observation.id,
    observation.companyId || null,
    observation.jobId || null,
    observation.url,
    observation.canonicalUrl || canonicalUrl(observation.url),
    observation.title || '',
    observation.snippet || '',
    observation.sourceType || 'web_search',
    observation.provider || 'unknown',
    observation.query || '',
    observation.trust || 'public',
    observation.fetchedAt || now(),
    observation.contentHash || '',
    JSON.stringify(observation.metadata || {})
  ];
  if (existing) {
    run(s, `UPDATE source_observations SET company_id=?,job_id=?,url=?,canonical_url=?,title=?,snippet=?,source_type=?,provider=?,query=?,trust=?,fetched_at=?,content_hash=?,metadata_json=? WHERE id=?`, [...params.slice(1), observation.id]);
  } else {
    run(s, 'INSERT INTO source_observations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', params);
  }
  return observation.id;
}

export function observationRow(row) {
  return row ? {
    id: row.id,
    companyId: row.company_id || null,
    jobId: row.job_id || null,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title || '',
    snippet: row.snippet || '',
    sourceType: row.source_type,
    provider: row.provider,
    query: row.query || '',
    trust: row.trust,
    fetchedAt: row.fetched_at,
    contentHash: row.content_hash || '',
    metadata: parseJson(row.metadata_json, {})
  } : null;
}

export function listSourceObservations(s, { jobId = null, companyId = null } = {}) {
  if (jobId) return all(s, 'SELECT * FROM source_observations WHERE job_id=? ORDER BY fetched_at DESC, title', [jobId]).map(observationRow);
  if (companyId) return all(s, 'SELECT * FROM source_observations WHERE company_id=? ORDER BY fetched_at DESC, title', [companyId]).map(observationRow);
  return all(s, 'SELECT * FROM source_observations ORDER BY fetched_at DESC, title').map(observationRow);
}

export function syncSourceObservations(s, jobId) {
  if (!jobId) return '';
  const rel = path.join('jobs', jobId, 'research', 'source-observations.yaml');
  writeYaml(path.join(s.p.ws, rel), {
    version: 1,
    policy: {
      externalSideEffects: 'none',
      note: 'Source observations are local research evidence. Private accounts are not fetched.'
    },
    observations: listSourceObservations(s, { jobId })
  });
  return rel;
}

function addUnique(items, value) {
  if (value && !items.includes(value)) items.push(value);
}

export function pageTargetsFromSeeds({ company = null, job = null, seedUrls = [], limit = 20 } = {}) {
  const targets = [];
  const add = url => {
    if (isFetchablePublicPage(url)) addUnique(targets, canonicalUrl(url));
  };
  const roots = [];
  for (const raw of [company?.website, job?.url, ...seedUrls]) {
    if (!isFetchablePublicPage(raw)) continue;
    try {
      const url = new URL(raw);
      add(raw);
      const root = `${url.protocol}//${url.host}`;
      addUnique(roots, root);
    } catch {}
  }
  for (const root of roots) {
    for (const suffix of ['', '/team', '/about', '/people', '/leadership', '/press', '/contact', '/careers']) add(`${root}${suffix}`);
  }
  return targets.slice(0, limit);
}
