import { safeGet, createDiscoveryBudget } from './http.js';

const FRESH_WINDOW_MS = 86_400_000;
const STANDALONE_MAX_REQUESTS = 8;
const STANDALONE_TOTAL_TIMEOUT_MS = 30_000;

const AMBIGUOUS_HTTP_STATUS = new Set([401, 403, 429, 503]);
const EXPIRED_HTTP_STATUS = new Set([404, 410]);

const CLOSURE_PATTERNS = [
  /no longer accepting applications/i,
  /position has been filled/i,
  /this role has been filled/i,
  /this position has been filled/i,
  /this job has been filled/i,
  /requisition has been filled/i,
  /role has been closed/i,
  /position has been closed/i,
  /no longer open/i,
  /job has expired/i,
  /posting has expired/i,
  /this role is no longer/i,
  /this position is no longer/i,
  /application is now closed/i,
  /applications are now closed/i,
  /applications are closed/i,
  /has been filled/i,
  /has been closed/i,
  /closed and is no longer/i,
];

const ANTI_BOT_PATTERNS = [
  /captcha/i,
  /verify you are human/i,
  /verify that you are human/i,
  /are you a robot/i,
  /are you human/i,
  /automated challenge/i,
  /challenge page/i,
  /access denied/i,
  /blocked by our anti-bot/i,
  /anti-bot system/i,
  /anti-bot/i,
  /bot protection/i,
  /protected by.*automated/i,
  /cloudflare/i,
  /just a moment/i,
  /checking your browser/i,
  /enable javascript and cookies/i,
  /perimeterx/i,
  /px-captcha/i,
  /datadome/i,
  /kasada/i,
  /akamai bot/i
];

const APPLY_CONTROL_PATTERNS = [
  /<a[^>]*\bapply\b[^>]*>/i,
  /<button[^>]*\bapply\b[^>]*>/i,
  /<form[^>]*\bapply\b[^>]*>/i,
  /<a[^>]*\bhref\b[^>]*apply[^>]*>/i,
  /<input[^>]*type=["']?submit[^>]*\bapply\b[^>]*>/i,
  /apply now/i,
  /apply for this job/i,
  /apply for this role/i,
  /apply for this position/i
];

function evidence(kind, value) {
  return { kind, value: String(value ?? '') };
}

function isoFromMs(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return null;
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n).toISOString();
}

function parseIsoMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Date.parse(String(value));
  return Number.isNaN(n) ? null : n;
}

function freshUntilFrom(checkedAtMs) {
  if (checkedAtMs == null || !Number.isFinite(Number(checkedAtMs))) return null;
  return new Date(Number(checkedAtMs) + FRESH_WINDOW_MS).toISOString();
}

function detectClosureText(body) {
  const text = String(body ?? '');
  for (const pattern of CLOSURE_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function detectAntiBot(body, status) {
  if (AMBIGUOUS_HTTP_STATUS.has(Number(status))) return null;
  const text = String(body ?? '');
  for (const pattern of ANTI_BOT_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function detectApplyControl(body) {
  const text = String(body ?? '');
  for (const pattern of APPLY_CONTROL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function isGenericListingRedirect(requestedUrl, finalUrl, redirects) {
  if (!redirects || !redirects.length) return false;
  if (!finalUrl || finalUrl === requestedUrl) return false;
  try {
    const from = new URL(requestedUrl);
    const to = new URL(finalUrl);
    // Same host redirect away from a specific posting path to a generic listing/home.
    if (from.hostname.toLowerCase() !== to.hostname.toLowerCase()) return false;
    const fromPath = from.pathname.replace(/\/+$/, '');
    const toPath = to.pathname.replace(/\/+$/, '');
    if (!fromPath || !toPath) return false;
    // The final path must be shorter or equal (generic parent) and not contain the
    // original trailing posting identity segment.
    const fromSegments = fromPath.split('/').filter(Boolean);
    const toSegments = toPath.split('/').filter(Boolean);
    if (toSegments.length > fromSegments.length) return false;
    // Drop the last segment of the posting URL (its id) and compare the prefix.
    const fromPrefix = fromSegments.slice(0, -1).join('/');
    const toPrefix = toSegments.join('/');
    if (fromPrefix === toPrefix && toSegments.length < fromSegments.length) return true;
    // Generic listing/home keywords in the final path.
    if (/\/(jobs|careers|openings|roles|opportunities|listings?)$/i.test(toPath)) return true;
    if (toPath === '' || toPath === '/' ) return true;
    return false;
  } catch {
    return false;
  }
}

function classifyManualImport(job, reasonCodes, ev) {
  return {
    version: 1,
    jobId: String(job.jobId ?? ''),
    status: 'uncertain',
    checkedAt: null,
    requestedUrl: String(job.url ?? ''),
    finalUrl: '',
    httpStatus: null,
    reasonCodes,
    evidence: ev,
    source: String(job.source ?? ''),
    freshUntil: null
  };
}

async function classifyFromListingHint(job, hint, nowMs) {
  const reasonCodes = [];
  const ev = [];
  const observedAtMs = parseIsoMs(hint.observedAt);
  const checkedAtMs = observedAtMs != null ? observedAtMs : nowMs;
  const checkedAt = checkedAtMs != null ? isoFromMs(checkedAtMs) : null;
  ev.push(evidence('ats_listing', `${hint.kind}:${hint.request ? hint.request.httpStatus : ''}`));
  reasonCodes.push('listed_in_current_listing');
  return {
    version: 1,
    jobId: String(job.jobId ?? ''),
    status: 'active',
    checkedAt,
    requestedUrl: String(hint.request?.requestedUrl ?? job.url ?? ''),
    finalUrl: String(hint.request?.finalUrl ?? hint.request?.requestedUrl ?? job.url ?? ''),
    httpStatus: hint.request ? Number(hint.request.httpStatus) : null,
    reasonCodes,
    evidence: ev,
    source: String(job.source ?? ''),
    freshUntil: freshUntilFrom(checkedAtMs)
  };
}

async function classifyFromFetch(job, opts) {
  const url = String(job.url ?? '');
  const budget = opts.budget || createDiscoveryBudget({
    maxRequests: STANDALONE_MAX_REQUESTS,
    totalTimeoutMs: STANDALONE_TOTAL_TIMEOUT_MS,
    now: opts.now
  });
  let result = null;
  let transportError = null;
  try {
    result = await safeGet(url, {}, {
      fetch: opts.fetch,
      lookup: opts.lookup,
      sleep: opts.sleep,
      now: opts.now,
      budget,
      delayMs: opts.delayMs ?? 0,
      requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
      allowHttpErrors: true
    });
  } catch (error) {
    transportError = error;
  }

  const checkedAtMs = parseIsoMs(opts.now());
  const checkedAt = checkedAtMs == null ? null : isoFromMs(checkedAtMs);
  const reasonCodes = [];
  const ev = [];
  const requestedUrl = url;
  const finalUrl = transportError ? url : String(result?.finalUrl ?? requestedUrl);
  const httpStatus = transportError ? null : (result ? Number(result.status) : null);

  if (transportError) {
    ev.push(evidence('transport_error', transportError.code || transportError.message || 'transport_error'));
    reasonCodes.push('transport_error');
    return {
      version: 1,
      jobId: String(job.jobId ?? ''),
      status: 'uncertain',
      checkedAt,
      requestedUrl,
      finalUrl,
      httpStatus,
      reasonCodes,
      evidence: ev,
      source: String(job.source ?? ''),
      freshUntil: freshUntilFrom(checkedAtMs)
    };
  }

  const status = Number(result.status);

  // Ambiguity stop: 401/403/429/503.
  if (AMBIGUOUS_HTTP_STATUS.has(status)) {
    ev.push(evidence('http_status', String(status)));
    reasonCodes.push('ambiguous_http_status');
    return buildResult(job, 'uncertain', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }

  // Definitive expiration: 404/410.
  if (EXPIRED_HTTP_STATUS.has(status)) {
    ev.push(evidence('http_status', String(status)));
    reasonCodes.push('not_found');
    return buildResult(job, 'expired', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }

  // For 2xx (and any other OK status), inspect the body.
  let body = '';
  try {
    body = result.response ? await result.response.text() : '';
  } catch {
    body = '';
  }

  // Anti-bot / challenge / access-denied overrides everything (including closure language).
  const antiBot = detectAntiBot(body, status);
  if (antiBot) {
    ev.push(evidence('anti_bot', antiBot));
    reasonCodes.push('anti_bot');
    return buildResult(job, 'uncertain', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }

  // Redirect away from a direct posting to a generic listing/home → expired.
  if (isGenericListingRedirect(requestedUrl, finalUrl, result.redirects)) {
    const hop = result.redirects[result.redirects.length - 1];
    ev.push(evidence('redirect', `${hop?.status || 302}:${requestedUrl}->${finalUrl}`));
    reasonCodes.push('redirect_away_from_posting');
    return buildResult(job, 'expired', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }

  const closure = detectClosureText(body);
  const apply = detectApplyControl(body);
  if (closure && apply) {
    ev.push(evidence('closure_text', closure));
    ev.push(evidence('apply_control', apply));
    reasonCodes.push('conflicting_evidence');
    return buildResult(job, 'uncertain', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }
  if (closure) {
    ev.push(evidence('closure_text', closure));
    reasonCodes.push('closure_text');
    return buildResult(job, 'expired', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }
  if (apply) {
    ev.push(evidence('apply_control', apply));
    reasonCodes.push('apply_control_present');
    return buildResult(job, 'active', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
  }

  // Bare 200 / ambiguous page → uncertain. HTTP 200 alone is not proof of an active posting.
  ev.push(evidence('http_status', String(status)));
  reasonCodes.push('no_positive_evidence');
  return buildResult(job, 'uncertain', checkedAt, checkedAtMs, requestedUrl, finalUrl, status, reasonCodes, ev);
}

function buildResult(job, status, checkedAt, checkedAtMs, requestedUrl, finalUrl, httpStatus, reasonCodes, ev) {
  return {
    version: 1,
    jobId: String(job.jobId ?? ''),
    status,
    checkedAt,
    requestedUrl,
    finalUrl,
    httpStatus,
    reasonCodes,
    evidence: ev,
    source: String(job.source ?? ''),
    freshUntil: freshUntilFrom(checkedAtMs)
  };
}

export function legacyLiveness(row = {}) {
  return {
    version: 1,
    jobId: String(row.id ?? row.jobId ?? ''),
    status: 'uncertain',
    checkedAt: null,
    requestedUrl: '',
    finalUrl: '',
    httpStatus: null,
    reasonCodes: ['legacy_unchecked'],
    evidence: [],
    source: String(row.source ?? ''),
    freshUntil: null
  };
}

export function normalizeLiveness(value, row = {}) {
  if (!value || Number(value.version) !== 1 || !['active', 'expired', 'uncertain'].includes(value.status)) {
    return legacyLiveness(row);
  }
  const checkedAtMs = parseIsoMs(value.checkedAt);
  const freshUntilMs = parseIsoMs(value.freshUntil);
  const httpStatus = value.httpStatus == null ? null : Number(value.httpStatus);
  return {
    version: 1,
    jobId: String(row.id ?? value.jobId ?? ''),
    status: value.status,
    checkedAt: checkedAtMs == null ? null : isoFromMs(checkedAtMs),
    requestedUrl: String(value.requestedUrl ?? ''),
    finalUrl: String(value.finalUrl ?? ''),
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
    reasonCodes: Array.isArray(value.reasonCodes) ? value.reasonCodes.map(String) : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence
        .filter(item => item && typeof item === 'object')
        .map(item => ({ kind: String(item.kind ?? ''), value: String(item.value ?? '') }))
      : [],
    source: String(value.source ?? row.source ?? ''),
    freshUntil: freshUntilMs == null ? null : isoFromMs(freshUntilMs)
  };
}

export function deserializeLiveness(row = {}) {
  if (Number(row.version) === 1) return normalizeLiveness(row, row);
  let value = row.livenessJson ?? row.liveness;
  if (value === undefined) value = row.liveness_json;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return legacyLiveness(row);
    }
  }
  return normalizeLiveness(value, row);
}

export function isLivenessFresh(value, nowValue = Date.now()) {
  const liveness = Number(value?.version) === 1 ? normalizeLiveness(value) : deserializeLiveness(value);
  const checkedAtMs = parseIsoMs(liveness.checkedAt);
  const nowMs = parseIsoMs(nowValue);
  if (checkedAtMs == null || nowMs == null) return false;
  const ageMs = nowMs - checkedAtMs;
  return ageMs >= 0 && ageMs < FRESH_WINDOW_MS;
}

export function postingLivenessHandoff(value, row = {}) {
  const liveness = Number(value?.version) === 1
    ? normalizeLiveness(value, row)
    : deserializeLiveness(value);
  return {
    contract: 'jobos.posting-liveness.v1',
    jobId: liveness.jobId,
    status: liveness.status,
    checkedAt: liveness.checkedAt,
    reasonCodes: liveness.reasonCodes,
    source: liveness.source
  };
}

export function livenessGate(value, row = {}) {
  const liveness = Number(value?.version) === 1
    ? normalizeLiveness(value, row)
    : deserializeLiveness(value);
  if (liveness.status === 'expired') {
    return { outcome: 'blocked', liveness, warning: null };
  }
  if (liveness.status === 'uncertain') {
    return {
      outcome: 'warning',
      liveness,
      warning: {
        code: 'liveness_uncertain',
        message: 'Posting liveness is uncertain; human review is required before relying on this posting.',
        reasonCodes: liveness.reasonCodes
      }
    };
  }
  return { outcome: 'allowed', liveness, warning: null };
}

export async function classifyLiveness(job, opts = {}) {
  const input = job || {};
  const nowFn = opts.now || (() => Date.now());
  const nowMs = parseIsoMs(nowFn());
  const reasonCodes = [];
  const ev = [];
  const url = String(input.url ?? '');

  // No public URL / manual text import → uncertain, no network.
  if (!url || !/^https?:\/\//i.test(url)) {
    ev.push(evidence('manual_import', 'no_public_url'));
    reasonCodes.push('manual_import');
    return classifyManualImport(input, reasonCodes, ev);
  }

  const hint = input.livenessHint;
  const hasCurrentListingHint = hint &&
    (hint.kind === 'listed_in_public_ats' || hint.kind === 'listed_on_career_page') &&
    input.listingPresent !== false &&
    (!hint.request || Number(hint.request.httpStatus) === 200);

  if (hasCurrentListingHint) {
    return classifyFromListingHint(input, hint, nowMs);
  }

  return classifyFromFetch(input, { ...opts, now: nowFn });
}