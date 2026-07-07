import path from 'node:path';
import { all, one, run, save, audit } from './db.js';
import { id, now, parseJson, slug, splitCsv } from './utils.js';
import { writeYaml, writeMd } from './workspace.js';
import { importNormalized, syncJob } from './jobs.js';
import { score } from './scoring.js';
import { getAdapter } from './discovery/adapters.js';

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  return JSON.parse(String(value));
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

${outputs.errors?.length ? `## Errors\n${outputs.errors.map(e => `- ${e}`).join('\n')}\n` : ''}
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
  run(s, 'INSERT OR REPLACE INTO saved_searches (id,name,profile_id,adapter,config_json,min_fit,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [sid, name, profileId, adapter, JSON.stringify(parseConfig(config)), Number(minFit || 70), one(s, 'SELECT last_run_at FROM saved_searches WHERE id=?', [sid])?.last_run_at || null, one(s, 'SELECT created_at FROM saved_searches WHERE id=?', [sid])?.created_at || at, at]);
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

function recordAutomationRun(s, outputs, opts = {}) {
  const trigger = opts.trigger || 'manual';
  const actionId = opts.actionId || 'discover.run';
  const inputs = { searchId: outputs.searchId, searchName: outputs.searchName, adapter: outputs.adapter, profileId: outputs.profileId, config: outputs.config, trigger };
  const error = outputs.errors?.length ? outputs.errors.join('; ') : null;
  run(s, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,action_id,trigger_type,started_at,finished_at,duration_ms,error,counts_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [outputs.runId, 'discover.run', JSON.stringify(inputs), JSON.stringify(outputs), outputs.status, 'none', outputs.createdAt, actionId, trigger, outputs.createdAt, now(), 0, error, JSON.stringify(outputs.counts || {})]);
  audit(s, outputs.status === 'succeeded' ? 'discovery.run.completed' : 'discovery.run.failed', 'automation_run', outputs.runId, { profileId: outputs.profileId, searchId: outputs.searchId, counts: outputs.counts, errors: outputs.errors });
  syncDiscoveryRun(s, outputs);
  save(s);
}

export async function runSavedSearch(s, searchRef, opts = {}) {
  const row = getSearch(s, searchRef);
  if (!row) throw Error(`Unknown saved search: ${searchRef}`);
  const cfg = parseJson(row.config_json, {});
  const runId = id('run', `discover:${row.id}:${now()}`), createdAt = now();
  const outputs = { runId, searchId: row.id, searchName: row.name, profileId: row.profile_id, adapter: row.adapter, config: cfg, status: 'succeeded', counts: { fetched: 0, imported: 0, deduped: 0, highFit: 0 }, jobs: [], errors: [], createdAt };
  try {
    const adapter = getAdapter(row.adapter);
    const jobs = await adapter.fetchJobs(cfg, opts);
    outputs.counts.fetched = jobs.length;
    for (const job of jobs) {
      const imported = importNormalized(s, { profileId: row.profile_id, job, source: job.source || row.adapter, status: 'new', runId });
      if (imported.created) outputs.counts.imported += 1;
      else outputs.counts.deduped += 1;
      const sc = await score(s, imported.job.id, row.profile_id);
      const highFit = Number(sc.overall || 0) >= Number(row.min_fit || 70);
      run(s, 'UPDATE jobs SET high_fit=?, updated_at=? WHERE id=?', [highFit ? 1 : 0, now(), imported.job.id]);
      syncJob(s, imported.job.id);
      outputs.counts.highFit += highFit ? 1 : 0;
      outputs.jobs.push({ id: imported.job.id, title: imported.job.title, company: imported.job.company, created: imported.created, deduped: !imported.created, score: sc.overall, highFit });
    }
    run(s, 'UPDATE saved_searches SET last_run_at=?, updated_at=? WHERE id=?', [createdAt, now(), row.id]);
    syncSearch(s, one(s, 'SELECT * FROM saved_searches WHERE id=?', [row.id]));
  } catch (e) {
    outputs.status = 'failed';
    outputs.errors.push(e.message);
    run(s, 'UPDATE saved_searches SET last_run_at=?, updated_at=? WHERE id=?', [createdAt, now(), row.id]);
    syncSearch(s, one(s, 'SELECT * FROM saved_searches WHERE id=?', [row.id]));
  }
  recordAutomationRun(s, outputs, opts);
  return outputs;
}

export async function runAllSearches(s, opts = {}) {
  const rows = listSearches(s).filter(search => !opts.profileId || search.profileId === opts.profileId);
  const runs = [];
  for (const search of rows) runs.push(await runSavedSearch(s, search.id, opts));
  return { count: runs.length, runs };
}

export function discoveryRuns(s) {
  return all(s, "SELECT * FROM automation_runs WHERE trigger_name='discover.run' ORDER BY created_at DESC").map(r => ({ id: r.id, trigger: r.trigger_name, status: r.status, inputs: parseJson(r.inputs_json, {}), outputs: parseJson(r.outputs_json, {}), externalSideEffects: r.external_side_effects, createdAt: r.created_at }));
}

export function reviewQueue(s) {
  return all(s, "SELECT * FROM jobs WHERE status='new' ORDER BY high_fit DESC, fit_score DESC, created_at DESC").map(j => ({ ...j, score: parseJson(j.score_json, null), sourceHistory: parseJson(j.source_history_json, []) }));
}

export function configFromFlags(flags = {}) {
  const cfg = flags.config ? parseConfig(flags.config) : {};
  for (const [flag, key] of [['board-token','boardToken'], ['board_token','boardToken'], ['company','company'], ['handle','handle'], ['fixture','fixture'], ['location','location']]) {
    if (flags[flag]) cfg[key] = String(flags[flag]);
  }
  if (flags.keywords) cfg.keywords = splitCsv(flags.keywords);
  if (flags.notes) cfg.notes = String(flags.notes);
  return cfg;
}

export function searchNameFromArg(arg) {
  return arg || `search-${slug(now())}`;
}
