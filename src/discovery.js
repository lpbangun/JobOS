import path from 'node:path';
import { all, one, run, save, audit } from './db.js';
import { id, now, parseJson, slug, splitCsv } from './utils.js';
import { writeYaml, writeMd } from './workspace.js';
import { importNormalized, syncJob } from './jobs.js';
import { compareFitDecisions, deserializeFitScore, qualifiesForHighFit, score } from './scoring.js';
import { getAdapter } from './discovery/adapters.js';
import { classifyLiveness, deserializeLiveness, normalizeLiveness, postingLivenessHandoff } from './discovery/liveness.js';
import { createDiscoveryBudget } from './discovery/http.js';

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
}

const COMPANY_WATCH_PRESET = 'company-watch';

function normalizedAdapter(value) {
  return String(value || '').trim().toLowerCase();
}

function compactText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
}

/**
 * Convert the historical ways of spelling an ATS company target into the
 * config shape written by the canonical company-watch preset.
 */
function normalizeCompanySearchConfig(adapter, value = {}) {
  const kind = normalizedAdapter(adapter);
  const input = { ...parseConfig(value) };
  const explicitHandle = input.handle ?? input.boardToken ?? input.board_token;
  const company = compactText(input.company);
  const companyLabel = compactText(input.companyLabel || (explicitHandle ? company : '') || company);
  const handle = compactText(explicitHandle || company);
  const notes = String(input.notes ?? '');

  for (const key of ['preset', 'handle', 'boardToken', 'board_token', 'company', 'companyLabel', 'notes']) delete input[key];
  const config = { ...input, preset: COMPANY_WATCH_PRESET };
  if (kind === 'greenhouse') config.boardToken = handle;
  else if (kind === 'career-page' || kind === 'portfolio') config.url = compactText(input.url || handle);
  else config.handle = handle;
  if (companyLabel) config.companyLabel = companyLabel;
  config.notes = notes;
  return sortValue(config);
}

function companySearchIdentity(adapter, config) {
  const kind = normalizedAdapter(adapter);
  const normalized = normalizeCompanySearchConfig(kind, config);
  // ATS board handles and display labels are case-insensitive identifiers for
  // dedupe purposes. Other config (for example fixture paths) remains exact.
  for (const key of ['boardToken', 'handle', 'companyLabel']) {
    if (typeof normalized[key] === 'string') normalized[key] = normalized[key].toLowerCase();
  }
  normalized.notes = compactText(normalized.notes);
  return `${kind}:${JSON.stringify(sortValue(normalized))}`;
}

function equivalentCompanySearch(s, { profileId, adapter, config }) {
  const wanted = companySearchIdentity(adapter, config);
  return all(s, 'SELECT * FROM saved_searches WHERE profile_id=?', [profileId]).find(row => {
    try {
      return companySearchIdentity(row.adapter, parseJson(row.config_json, {})) === wanted;
    } catch {
      return false;
    }
  }) || null;
}

function availableCompanySearchName(s, preferred, adapter) {
  const names = new Set(all(s, 'SELECT name FROM saved_searches').map(row => compactText(row.name).toLowerCase()));
  const base = compactText(preferred) || 'Company jobs';
  if (!names.has(base.toLowerCase())) return base;
  const kind = normalizedAdapter(adapter);
  const withAdapter = `${base} (${kind})`;
  if (!names.has(withAdapter.toLowerCase())) return withAdapter;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} (${kind} ${suffix})`;
    if (!names.has(candidate.toLowerCase())) return candidate;
  }
}

function serializeSearch(row) {
  return row ? { id: row.id, name: row.name, profileId: row.profile_id, adapter: row.adapter, config: parseJson(row.config_json, {}), minFit: row.min_fit, lastRunAt: row.last_run_at, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function serializeWatch(row) {
  return row ? { id: row.id, company: row.company, adapter: row.adapter, handle: row.handle, notes: row.notes, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function syncSearch(s, row) {
  const item = serializeSearch(row);
  writeYaml(path.join(s.p.searches, `${item.id}.yaml`), item);
  writeYaml(path.join(s.p.searches, 'index.yaml'), listSearches(s));
}

function syncWatchlist(s, row) {
  const item = serializeWatch(row);
  writeYaml(path.join(s.p.watchlist, `${item.id}.yaml`), item);
  writeYaml(path.join(s.p.watchlist, 'index.yaml'), listWatchlist(s));
}

function discoveryErrorMessage(error) {
  if (typeof error === 'string') return error;
  return [error?.source, error?.url, error?.message].filter(Boolean).join(' — ') || String(error);
}

function runSummary(outputs) {
  return `# Discovery run ${outputs.runId}

Status: ${outputs.status}
Search: ${outputs.searchName || outputs.searchId}
Adapter: ${outputs.adapter}
Profile: ${outputs.profileId}
Created: ${outputs.createdAt}

## Counts
- Fetched: ${outputs.counts?.fetched ?? 0}
- Imported: ${outputs.counts?.imported ?? 0}
- Deduped: ${outputs.counts?.deduped ?? 0}
- High fit: ${outputs.counts?.highFit ?? 0}

## Human gate
Discovered jobs were queued for review only. JobOS did not apply, submit forms, send outreach, or touch external accounts.

${outputs.errors?.length ? `## Errors\n${outputs.errors.map(e => `- ${discoveryErrorMessage(e)}`).join('\n')}\n` : ''}
`;
}

function syncDiscoveryRun(s, outputs) {
  const relBase = path.join('runs', `${outputs.runId}`);
  writeYaml(path.join(s.p.discovery, `${relBase}.yaml`), outputs);
  writeMd(path.join(s.p.discovery, `${relBase}.md`), runSummary(outputs));
}

export function createSearch(s, { name, profileId, adapter, config = {}, minFit = 70 }) {
  if (!name) throw Error('Missing search name');
  if (!profileId) throw Error('Missing profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  getAdapter(adapter);
  const at = now(), sid = id('search', name);
  run(s, 'INSERT OR REPLACE INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [sid, name, profileId, adapter, JSON.stringify(parseConfig(config)), Number.isFinite(minFit) ? minFit : 70, one(s, 'SELECT last_run_at FROM saved_searches WHERE id=?', [sid])?.last_run_at || null, one(s, 'SELECT created_at FROM saved_searches WHERE id=?', [sid])?.created_at || at, at]);
  const row = one(s, 'SELECT * FROM saved_searches WHERE id=?', [sid]);
  audit(s, 'search.saved', 'saved_search', sid, { profileId, adapter, name });
  syncSearch(s, row); save(s);
  return serializeSearch(row);
}

export function listSearches(s) {
  return all(s, 'SELECT * FROM saved_searches ORDER BY name').map(serializeSearch);
}

export function getSearch(s, search) {
  return one(s, 'SELECT * FROM saved_searches WHERE id=? OR name=?', [search, search]);
}

/**
 * Create the saved-search representation of a watched company. Unlike the
 * legacy watchlist API, this preset is executable by discovery run-all.
 */
export function createCompanySearch(s, { company, profileId, adapter, handle, notes = '', minFit = 70, name = '' }) {
  const label = compactText(company);
  if (!label) throw Error('Missing company');
  if (!profileId) throw Error('Missing profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const kind = normalizedAdapter(adapter);
  getAdapter(kind);
  const boardHandle = compactText(handle);
  if (!boardHandle) throw Error('Missing board token/handle');
  const config = normalizeCompanySearchConfig(kind, { companyLabel: label, handle: boardHandle, notes });
  const existing = equivalentCompanySearch(s, { profileId, adapter: kind, config });
  if (existing) return { ...serializeSearch(existing), created: false, deduped: true };

  const preferredName = compactText(name) || `${label} jobs`;
  const safeName = availableCompanySearchName(s, preferredName, kind);
  const search = createSearch(s, {
    name: safeName,
    profileId,
    adapter: kind,
    config,
    minFit: Number.isFinite(Number(minFit)) ? Number(minFit) : 70
  });
  return { ...search, created: true, deduped: false };
}

/**
 * Explicitly migrate legacy, profile-less watchlist rows into executable
 * saved searches for one chosen profile. Legacy rows remain readable so old
 * workspaces and exports retain their history.
 */
export function migrateLegacyWatchlist(s, { profileId, minFit = 70 } = {}) {
  if (!profileId) throw Error('Missing profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const legacyRows = all(s, 'SELECT * FROM company_watchlist ORDER BY company,adapter,handle');
  const items = [];
  let created = 0, deduped = 0, failed = 0;
  for (const row of legacyRows) {
    try {
      const search = createCompanySearch(s, {
        company: row.company,
        profileId,
        adapter: row.adapter,
        handle: row.handle,
        notes: row.notes,
        minFit
      });
      if (search.created) created += 1;
      else deduped += 1;
      items.push({ watchlistId: row.id, status: search.created ? 'created' : 'deduped', search });
    } catch (error) {
      failed += 1;
      items.push({ watchlistId: row.id, status: 'failed', error: error?.message || String(error) });
    }
  }
  return { profileId, total: legacyRows.length, created, deduped, failed, items };
}

export function addWatchlist(s, { company, adapter, handle, notes = '' }) {
  if (!company) throw Error('Missing company');
  if (!handle) throw Error('Missing board token/handle');
  getAdapter(adapter);
  const at = now(), wid = id('watch', `${company}:${adapter}:${handle}`);
  run(s, 'INSERT OR REPLACE INTO company_watchlist (id,company,adapter,handle,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?)', [wid, company, adapter, handle, notes, one(s, 'SELECT created_at FROM company_watchlist WHERE id=?', [wid])?.created_at || at, at]);
  const row = one(s, 'SELECT * FROM company_watchlist WHERE id=?', [wid]);
  audit(s, 'watchlist.saved', 'company_watchlist', wid, { company, adapter, handle });
  syncWatchlist(s, row); save(s);
  return serializeWatch(row);
}

export function listWatchlist(s) {
  return all(s, 'SELECT * FROM company_watchlist ORDER BY company,adapter,handle').map(serializeWatch);
}

function structuredDiscoveryError(error, context = {}) {
  return {
    stage: context.stage || error?.stage || 'discovery',
    message: error?.message || String(error),
    code: error?.code || error?.name || 'discovery_error',
    retryable: Boolean(error?.retryable ?? false),
    source: context.source || error?.source || null,
    url: String(context.url || error?.url || ''),
    jobKey: context.jobKey || error?.jobKey || null,
    details: error?.details || null
  };
}

export function deriveDiscoveryStatus({ counts = {}, errors = [], metadata = null } = {}) {
  const durableProgress = Number(counts.imported || 0) + Number(counts.deduped || 0) + Number(counts.scored || 0) + Number(counts.expired || 0);
  const incomplete = errors.length > 0 || metadata?.truncated === true;
  if (incomplete && durableProgress > 0) return 'partial';
  if (incomplete) return 'failed';
  if (Number(counts.expired || 0) > 0 || Number(counts.uncertain || 0) > 0) return 'partial';
  return 'succeeded';
}

function recordAutomationRun(s, outputs, opts = {}) {
  const trigger = opts.trigger || 'manual';
  const actionId = opts.actionId || 'discover.run';
  const inputs = { searchId: outputs.searchId, searchName: outputs.searchName, adapter: outputs.adapter, profileId: outputs.profileId, config: outputs.config, trigger };
  const error = outputs.errors?.length ? outputs.errors.map(item => item.message || String(item)).join('; ') : null;
  run(s, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,action_id,trigger_type,started_at,finished_at,duration_ms,error,counts_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [outputs.runId, 'discover.run', JSON.stringify(inputs), JSON.stringify(outputs), outputs.status, 'none', outputs.createdAt, actionId, trigger, outputs.createdAt, outputs.finishedAt || now(), 0, error, JSON.stringify(outputs.counts || {})]);
  const auditAction = outputs.status === 'succeeded'
    ? 'discovery.run.completed'
    : outputs.status === 'partial'
      ? 'discovery.run.partial'
      : 'discovery.run.failed';
  audit(s, auditAction, 'automation_run', outputs.runId, { profileId: outputs.profileId, searchId: outputs.searchId, counts: outputs.counts, errors: outputs.errors });
  syncDiscoveryRun(s, outputs);
  save(s);
}

export async function runSavedSearch(s, searchRef, opts = {}) {
  const row = getSearch(s, searchRef);
  if (!row) throw Error(`Unknown saved search: ${searchRef}`);
  const cfg = parseJson(row.config_json, {});
  const budget = opts.budget || createDiscoveryBudget({
    maxRequests: cfg.maxRequests,
    totalTimeoutMs: cfg.totalTimeoutMs,
    now: opts.now
  });
  const runOptions = { ...opts, budget };
  const runId = id('run', `discover:${row.id}:${now()}`);
  const createdAt = now();
  const outputs = {
    version: 2,
    runId,
    searchId: row.id,
    searchName: row.name,
    profileId: row.profile_id,
    adapter: row.adapter,
    config: cfg,
    status: 'succeeded',
    counts: { fetched: 0, processed: 0, imported: 0, deduped: 0, scored: 0, highFit: 0, active: 0, expired: 0, uncertain: 0, failed: 0 },
    jobs: [],
    errors: [],
    metadata: {},
    createdAt,
    finishedAt: null
  };
  const adapter = opts.adapter || getAdapter(row.adapter);
  const importJob = opts.importJob || importNormalized;
  const scoreJob = opts.scoreJob || score;
  const checkLiveness = opts.checkLiveness || classifyLiveness;
  try {
    const result = await adapter.fetchJobs(cfg, runOptions);
    const jobs = Array.isArray(result) ? result : result?.jobs;
    if (!Array.isArray(jobs)) throw Error(`Discovery adapter ${row.adapter} returned an invalid result`);
    const metadata = Array.isArray(result) ? result.metadata : result?.metadata;
    if (metadata && typeof metadata === 'object') {
      outputs.metadata = { ...metadata };
      if (Array.isArray(metadata.errors)) {
        outputs.errors.push(...metadata.errors.map(error => structuredDiscoveryError(error, { stage: 'fetch', source: row.adapter, url: error?.url || '' })));
      }
    }
    outputs.counts.fetched = jobs.length;
    for (const [index, job] of jobs.entries()) {
      outputs.counts.processed += 1;
      const jobKey = String(job.sourceId || job.url || `${row.adapter}:${index}`);
      const sourceId = String(job.sourceId || jobKey);
      let stage = 'liveness';
      let importedId = null;
      let importedCreated = false;
      let classifiedLiveness = null;
      try {
        const liveness = await checkLiveness({
          ...job,
          jobId: jobKey,
          sourceId: job.sourceId || jobKey,
          source: job.source || row.adapter,
          livenessHint: job.livenessHint || null
        }, runOptions);
        classifiedLiveness = liveness;
        if (liveness.status === 'active') outputs.counts.active += 1;
        else if (liveness.status === 'uncertain') outputs.counts.uncertain += 1;
        stage = 'import';
        const imported = await importJob(s, {
          profileId: row.profile_id,
          job: { ...job, liveness },
          source: job.source || row.adapter,
          status: 'new',
          runId
        });
        importedId = imported.job.id;
        importedCreated = imported.created;
        if (imported.created) outputs.counts.imported += 1;
        else outputs.counts.deduped += 1;
        if (liveness.status === 'expired') {
          outputs.counts.expired += 1;
          outputs.jobs.push({
            id: imported.job.id,
            sourceId,
            title: imported.job.title,
            company: imported.job.company,
            outcome: 'expired',
            created: imported.created,
            deduped: !imported.created,
            score: null,
            highFit: false,
            liveness,
            fit: null,
            postingLiveness: postingLivenessHandoff(liveness),
            error: null
          });
          continue;
        }
        stage = 'score';
        const sc = await scoreJob(s, imported.job.id, row.profile_id, {
          ...runOptions,
          checkLiveness,
          now: runOptions.now
        });
        outputs.counts.scored += 1;
        const highFit = qualifiesForHighFit(sc, Number(row.min_fit || 70));
        run(s, 'UPDATE jobs SET high_fit=?, updated_at=? WHERE id=?', [highFit ? 1 : 0, now(), imported.job.id]);
        syncJob(s, imported.job.id);
        outputs.counts.highFit += highFit ? 1 : 0;
        outputs.jobs.push({
          id: imported.job.id,
          sourceId,
          title: imported.job.title,
          company: imported.job.company,
          outcome: 'scored',
          created: imported.created,
          deduped: !imported.created,
          score: sc.overall,
          highFit,
          liveness,
          fit: sc,
          postingLiveness: sc.postingLiveness || postingLivenessHandoff(liveness),
          error: null
        });
      } catch (error) {
        outputs.counts.failed += 1;
        const structured = structuredDiscoveryError(error, { stage, jobKey, source: job.source || row.adapter, url: job.url || error?.url || '' });
        outputs.errors.push(structured);
        const failedLiveness = classifiedLiveness || normalizeLiveness({
          version: 1,
          jobId: jobKey,
          status: 'uncertain',
          checkedAt: null,
          requestedUrl: String(job.url || ''),
          finalUrl: '',
          httpStatus: null,
          reasonCodes: ['liveness_check_failed'],
          evidence: [],
          source: String(job.source || row.adapter),
          freshUntil: null
        }, { id: importedId, source: String(job.source || row.adapter) });
        if (stage === 'score' && importedId) {
          outputs.jobs.push({
            id: importedId,
            sourceId,
            title: job.title || '',
            company: job.company || '',
            outcome: 'imported_unscored',
            created: importedCreated,
            deduped: !importedCreated,
            score: null,
            highFit: false,
            liveness: failedLiveness,
            fit: null,
            postingLiveness: postingLivenessHandoff(failedLiveness),
            error: structured
          });
        } else {
          outputs.jobs.push({
            id: importedId,
            sourceId,
            title: job.title || '',
            company: job.company || '',
            outcome: 'failed',
            created: importedCreated,
            deduped: !importedCreated,
            score: null,
            highFit: false,
            liveness: failedLiveness,
            fit: null,
            postingLiveness: postingLivenessHandoff(failedLiveness),
            error: structured
          });
        }
      }
    }
    run(s, 'UPDATE saved_searches SET last_run_at=?, updated_at=? WHERE id=?', [createdAt, now(), row.id]);
    syncSearch(s, one(s, 'SELECT * FROM saved_searches WHERE id=?', [row.id]));
  } catch (error) {
    outputs.counts.failed += 1;
    outputs.errors.push(structuredDiscoveryError(error, { stage: 'fetch', source: row.adapter, url: error?.url || '' }));
    run(s, 'UPDATE saved_searches SET last_run_at=?, updated_at=? WHERE id=?', [createdAt, now(), row.id]);
    syncSearch(s, one(s, 'SELECT * FROM saved_searches WHERE id=?', [row.id]));
  }
  const budgetSnapshot = budget.snapshot();
  outputs.metadata = { ...(outputs.metadata || {}), budget: budgetSnapshot };
  if (budgetSnapshot.truncated) {
    outputs.metadata.truncated = true;
    outputs.metadata.reason ||= budgetSnapshot.reason;
  }
  outputs.jobs.sort(compareFitDecisions);
  outputs.status = deriveDiscoveryStatus(outputs);
  outputs.finishedAt = now();
  recordAutomationRun(s, outputs, opts);
  return outputs;
}

export async function runAllSearches(s, opts = {}) {
  const rows = listSearches(s).filter(search => !opts.profileId || search.profileId === opts.profileId);
  const runs = [];
  for (const search of rows) runs.push(await runSavedSearch(s, search.id, opts));
  const counts = runs.reduce((total, item) => {
    for (const [key, value] of Object.entries(item.counts || {})) {
      total[key] = Number(total[key] || 0) + Number(value || 0);
    }
    return total;
  }, {});
  const failed = runs.filter(item => item.status === 'failed').length;
  const partial = runs.filter(item => item.status === 'partial').length;
  const status = failed === runs.length && runs.length
    ? 'failed'
    : (failed || partial)
      ? 'partial'
      : 'succeeded';
  return { count: runs.length, status, counts, runs };
}

export function discoveryRuns(s) {
  return all(s, "SELECT * FROM automation_runs WHERE trigger_name='discover.run' ORDER BY created_at DESC").map(r => ({ id: r.id, trigger: r.trigger_name, status: r.status, inputs: parseJson(r.inputs_json, {}), outputs: parseJson(r.outputs_json, {}), externalSideEffects: r.external_side_effects, createdAt: r.created_at }));
}

export function reviewQueue(s) {
  return all(s, "SELECT * FROM jobs WHERE status='new'").map(job => {
    const fit = deserializeFitScore(parseJson(job.score_json, null), { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id });
    return {
      ...job,
      score: fit,
      fit,
      postingLiveness: postingLivenessHandoff(deserializeLiveness(job)),
      sourceHistory: parseJson(job.source_history_json, []),
      liveness: deserializeLiveness(job)
    };
  }).sort(compareFitDecisions);
}

export function recommendResearchForJobs(s, { profileId, limit = 5 }) {
  const candidates = all(s, `SELECT jobs.*, applications.status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id AND applications.profile_id=? WHERE jobs.profile_id=? AND jobs.high_fit=1 AND COALESCE(jobs.liveness_status,'uncertain')<>'expired' AND (applications.id IS NULL OR applications.status IN ('researching','saved','materials-ready','applied')) ORDER BY jobs.fit_score DESC, jobs.id`, [profileId, profileId]);
  return candidates.map(job => ({
    jobId: job.id,
    job,
    fit: deserializeFitScore(parseJson(job.score_json, null), { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id }),
    postingLiveness: postingLivenessHandoff(deserializeLiveness(job))
  }))
    .filter(({ fit }) => qualifiesForHighFit(fit, 0))
    .sort(compareFitDecisions)
    .slice(0, limit)
    .map(({ job, fit }) => ({
      jobId: job.id,
      title: job.title,
      company: job.company,
      fitScore: fit.overall,
      nextAction: `jobos research people --scope job --job ${job.id} --profile ${profileId} --depth standard`,
      label: `High-fit job "${job.title}" at ${job.company} (${fit.overall}/100) has no fresh people-research run.`
    }));
}

export function configFromFlags(flags = {}) {
  const cfg = flags.config ? parseConfig(flags.config) : {};
  for (const [flag, key] of [
    ['board-token', 'boardToken'], ['board_token', 'boardToken'], ['boardToken', 'boardToken'],
    ['company', 'company'], ['company-label', 'companyLabel'], ['companyLabel', 'companyLabel'],
    ['handle', 'handle'], ['fixture', 'fixture'], ['location', 'location'], ['url', 'url']
  ]) {
    if (flags[flag] !== undefined && flags[flag] !== null && flags[flag] !== '') cfg[key] = String(flags[flag]);
  }
  for (const [flag, key, maximum] of [
    ['max-companies', 'maxCompanies', 30], ['maxCompanies', 'maxCompanies', 30],
    ['max-requests', 'maxRequests', 90], ['maxRequests', 'maxRequests', 90],
    ['request-timeout-ms', 'requestTimeoutMs', 10_000], ['requestTimeoutMs', 'requestTimeoutMs', 10_000],
    ['total-timeout-ms', 'totalTimeoutMs', 60_000], ['totalTimeoutMs', 'totalTimeoutMs', 60_000],
    ['posted-within-days', 'postedWithinDays', 3650], ['postedWithinDays', 'postedWithinDays', 3650]
  ]) {
    if (flags[flag] === undefined || flags[flag] === null || flags[flag] === '') continue;
    const value = Math.floor(Number(flags[flag]));
    if (!Number.isFinite(value) || value <= 0) throw Error(`Invalid --${flag}: expected a positive number`);
    cfg[key] = Math.min(value, maximum);
  }
  const remoteOnly = flags['remote-only'] ?? flags.remoteOnly;
  if (remoteOnly !== undefined) cfg.remoteOnly = remoteOnly === true || String(remoteOnly).toLowerCase() === 'true';
  const employmentTypes = flags['employment-types'] ?? flags.employmentTypes;
  if (employmentTypes) {
    const allowed = new Set(['full_time', 'part_time', 'contract', 'temporary', 'internship', 'volunteer', 'other']);
    const normalized = splitCsv(employmentTypes).map(value => value.trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const invalid = normalized.find(value => !allowed.has(value));
    if (invalid) throw Error(`Invalid employment type: ${invalid}`);
    cfg.employmentTypes = [...new Set(normalized)];
  }
  if (flags.keywords) cfg.keywords = splitCsv(flags.keywords);
  if (flags.notes) cfg.notes = String(flags.notes);
  return cfg;
}

export function searchNameFromArg(arg) {
  return arg || `search-${slug(now())}`;
}
