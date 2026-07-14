import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { id, now, paths, workspaceRoot } from './utils.js';
import { mkdirs } from './workspace.js';
import { seedDefaultAutomations } from './scheduler/store.js';

const require = createRequire(import.meta.url);
let SQL;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));

const schema = `PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, preferences_json TEXT NOT NULL, resume_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proof_points (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', skills_json TEXT NOT NULL DEFAULT '[]', metrics_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '[]', domain TEXT NOT NULL DEFAULT '', aliases_json TEXT NOT NULL DEFAULT '[]', source_confidence TEXT NOT NULL DEFAULT 'low', identity_sources_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, company_id TEXT, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', description TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', compensation TEXT NOT NULL DEFAULT '', work_model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'imported', fit_score INTEGER, score_json TEXT, high_fit INTEGER NOT NULL DEFAULT 0, posted_date TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL DEFAULT '', source_history_json TEXT NOT NULL DEFAULT '[]', first_seen_at TEXT, last_seen_at TEXT, reposted INTEGER NOT NULL DEFAULT 0, discovery_run_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,url), FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL, adapter TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', min_fit INTEGER NOT NULL DEFAULT 70, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS company_watchlist (id TEXT PRIMARY KEY, company TEXT NOT NULL, adapter TEXT NOT NULL, handle TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company,adapter,handle));
CREATE TABLE IF NOT EXISTS stakeholders (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', links_json TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', outreach_status TEXT NOT NULL DEFAULT 'not_contacted', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', confirmation_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(job_id,profile_id));
CREATE TABLE IF NOT EXISTS status_changes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', approval_status TEXT NOT NULL DEFAULT 'draft_needs_human_review', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_threads (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, goal TEXT NOT NULL DEFAULT 'informational', channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'drafted', sent_at TEXT, next_followup_at TEXT, followup_task_id TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS source_observations (id TEXT PRIMARY KEY, company_id TEXT, job_id TEXT, url TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT, snippet TEXT, source_type TEXT NOT NULL, provider TEXT NOT NULL, query TEXT, trust TEXT NOT NULL, fetched_at TEXT NOT NULL, content_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS person_candidates (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT, function TEXT, seniority TEXT, relevance TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'candidate', suppression_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_points (id TEXT PRIMARY KEY, person_id TEXT, stakeholder_id TEXT, company_id TEXT, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, evidence_tier TEXT NOT NULL, verification_status TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '{}', human_approved INTEGER NOT NULL DEFAULT 0, do_not_use INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_patterns (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, domain TEXT NOT NULL, pattern TEXT NOT NULL, support_count INTEGER NOT NULL, support_sources_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relationship_edges (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outreach_plans (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, contact_point_id TEXT, goal TEXT NOT NULL, channel TEXT NOT NULL, path_strength TEXT NOT NULL, recommended INTEGER NOT NULL DEFAULT 0, reasoning_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL, question_fingerprint TEXT NOT NULL, question_text TEXT NOT NULL, answer_text TEXT NOT NULL, sensitivity TEXT NOT NULL, reuse_scope TEXT NOT NULL, verification_status TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', employer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,question_fingerprint,employer), FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, job_id TEXT, application_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'review', due_at TEXT, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL, schedule TEXT NOT NULL, profile_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, last_status TEXT NOT NULL DEFAULT 'never_run', consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, trigger_name TEXT NOT NULL, inputs_json TEXT NOT NULL DEFAULT '{}', outputs_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, external_side_effects TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, automation_id TEXT, action_id TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual', started_at TEXT, finished_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT, counts_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', external_side_effect TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL);`;

function migrate(db){
  for (const sql of [
    "ALTER TABLE proof_points ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE proof_points ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE companies ADD COLUMN facts_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE companies ADD COLUMN domain TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE companies ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE companies ADD COLUMN source_confidence TEXT NOT NULL DEFAULT 'low'",
    "ALTER TABLE companies ADD COLUMN identity_sources_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jobs ADD COLUMN high_fit INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN posted_date TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN dedupe_key TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE jobs ADD COLUMN source_history_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE jobs ADD COLUMN first_seen_at TEXT",
    "ALTER TABLE jobs ADD COLUMN last_seen_at TEXT",
    "ALTER TABLE jobs ADD COLUMN reposted INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE jobs ADD COLUMN discovery_run_id TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE automation_runs ADD COLUMN automation_id TEXT",
    "ALTER TABLE automation_runs ADD COLUMN action_id TEXT",
    "ALTER TABLE automation_runs ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'manual'",
    "ALTER TABLE automation_runs ADD COLUMN started_at TEXT",
    "ALTER TABLE automation_runs ADD COLUMN finished_at TEXT",
    "ALTER TABLE automation_runs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE automation_runs ADD COLUMN error TEXT",
    "ALTER TABLE automation_runs ADD COLUMN counts_json TEXT NOT NULL DEFAULT '{}'",
    "CREATE TABLE IF NOT EXISTS outreach_threads (id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, goal TEXT NOT NULL DEFAULT 'informational', channel TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'drafted', sent_at TEXT, next_followup_at TEXT, followup_task_id TEXT, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS source_observations (id TEXT PRIMARY KEY, company_id TEXT, job_id TEXT, url TEXT NOT NULL, canonical_url TEXT NOT NULL, title TEXT, snippet TEXT, source_type TEXT NOT NULL, provider TEXT NOT NULL, query TEXT, trust TEXT NOT NULL, fetched_at TEXT NOT NULL, content_hash TEXT, metadata_json TEXT NOT NULL DEFAULT '{}')",
    "CREATE TABLE IF NOT EXISTS person_candidates (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT, function TEXT, seniority TEXT, relevance TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'candidate', suppression_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS contact_points (id TEXT PRIMARY KEY, person_id TEXT, stakeholder_id TEXT, company_id TEXT, type TEXT NOT NULL, value TEXT NOT NULL, normalized_value TEXT NOT NULL, evidence_tier TEXT NOT NULL, verification_status TEXT NOT NULL, confidence TEXT NOT NULL, source_observation_ids_json TEXT NOT NULL DEFAULT '[]', checks_json TEXT NOT NULL DEFAULT '{}', human_approved INTEGER NOT NULL DEFAULT 0, do_not_use INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS email_patterns (id TEXT PRIMARY KEY, company_id TEXT NOT NULL, domain TEXT NOT NULL, pattern TEXT NOT NULL, support_count INTEGER NOT NULL, support_sources_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS relationship_edges (id TEXT PRIMARY KEY, from_type TEXT NOT NULL, from_id TEXT NOT NULL, to_type TEXT NOT NULL, to_id TEXT NOT NULL, edge_type TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', confidence TEXT NOT NULL, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS outreach_plans (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, stakeholder_id TEXT, contact_point_id TEXT, goal TEXT NOT NULL, channel TEXT NOT NULL, path_strength TEXT NOT NULL, recommended INTEGER NOT NULL DEFAULT 0, reasoning_json TEXT NOT NULL DEFAULT '{}', warnings_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS answers (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL, question_fingerprint TEXT NOT NULL, question_text TEXT NOT NULL, answer_text TEXT NOT NULL, sensitivity TEXT NOT NULL, reuse_scope TEXT NOT NULL, verification_status TEXT NOT NULL, source_ref TEXT NOT NULL DEFAULT '', employer TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,question_fingerprint,employer), FOREIGN KEY(profile_id) REFERENCES profiles(id))"
  ]) {
    try { db.run(sql); } catch (e) {
      const message = String(e?.message || e);
      if (!/duplicate column name/i.test(message) && !/already exists/i.test(message)) throw e;
    }
  }
}

function revisionOf(db) {
  try {
    const rows = db.exec("SELECT value FROM meta WHERE key='store_revision'");
    return Number(rows[0]?.values?.[0]?.[0] || 0);
  } catch {
    return 0;
  }
}

function diskRevision(file) {
  if (!fs.existsSync(file)) return 0;
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    return revisionOf(db);
  } finally {
    db.close();
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function concurrencyError(code, message) {
  return Object.assign(new Error(message), { code, type: 'concurrency', retryable: true });
}

export function acquireWriteLock(s, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  fs.mkdirSync(s.p.state, { recursive: true });
  const file = path.join(s.p.state, 'jobos.lock');
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      return () => {
        try {
          const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (Number(lock.pid) === process.pid) fs.unlinkSync(file);
        } catch {}
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(file);
        const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
        stale = Date.now() - stat.mtimeMs > staleMs && !processAlive(Number(lock.pid));
      } catch {
        try { stale = Date.now() - fs.statSync(file).mtimeMs > staleMs; } catch {}
      }
      if (stale) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw concurrencyError('lock_timeout', `Workspace is busy; retry after the writer holding ${file} finishes`);
      Atomics.wait(lockSleep, 0, 0, 25);
    }
  }
}

function migratePolicyPreferences(db) {
  const rows = [];
  const statement = db.prepare('SELECT id,preferences_json FROM profiles');
  try {
    while (statement.step()) rows.push(statement.getAsObject());
  } finally {
    statement.free();
  }
  for (const row of rows) {
    let prefs;
    try { prefs = JSON.parse(row.preferences_json || '{}'); } catch { continue; }
    const policy = prefs.automationPolicy || {};
    let changed = false;
    for (const key of ['externalApply', 'externalSend']) {
      if (policy[key] === 'human_approval_required') {
        policy[key] = 'user_configured';
        changed = true;
      }
    }
    if (changed) {
      prefs.automationPolicy = policy;
      db.run('UPDATE profiles SET preferences_json=?,updated_at=? WHERE id=?', [JSON.stringify(prefs), now(), row.id]);
    }
  }
}

export async function openStore(flags={}){
  const r=workspaceRoot(flags), p=paths(r); mkdirs(p);
  if(!SQL) SQL=await initSqlJs({ locateFile: f => path.join(path.dirname(require.resolve('sql.js')), f) });
  const existed = fs.existsSync(p.db);
  const db=existed ? new SQL.Database(fs.readFileSync(p.db)) : new SQL.Database();
  const baseRevision = revisionOf(db);
  let previousSchemaVersion = '0';
  try { previousSchemaVersion = String(db.exec("SELECT value FROM meta WHERE key='schema_version'")[0]?.values?.[0]?.[0] || '0'); } catch {}
  db.run(schema); migrate(db); migratePolicyPreferences(db); db.run('INSERT OR REPLACE INTO meta VALUES (?,?)',['schema_version','6']);
  const store={db,p,root:r,baseRevision}; seedDefaultAutomations(store);
  if (!existed || previousSchemaVersion !== '6') save(store);
  return store;
}
export function reload(s){
  if(!fs.existsSync(s.p.db)) return s;
  try { s.db.close(); } catch {}
  s.db = new SQL.Database(fs.readFileSync(s.p.db));
  s.db.run(schema); migrate(s.db); migratePolicyPreferences(s.db); seedDefaultAutomations(s);
  s.baseRevision = revisionOf(s.db);
  return s;
}
export function save(s){
  const release = acquireWriteLock(s);
  let temp = null;
  try {
    const current = diskRevision(s.p.db);
    if (current !== Number(s.baseRevision || 0)) {
      throw concurrencyError('stale_snapshot', `Workspace changed from revision ${s.baseRevision || 0} to ${current}; reopen it and retry the command`);
    }
    const next = current + 1;
    s.db.run('INSERT OR REPLACE INTO meta VALUES (?,?)', ['store_revision', String(next)]);
    const bytes = Buffer.from(s.db.export());
    temp = `${s.p.db}.tmp-${process.pid}-${Date.now()}`;
    const fd = fs.openSync(temp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, s.p.db);
    temp = null;
    try {
      const directory = fs.openSync(path.dirname(s.p.db), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } catch {}
    s.baseRevision = next;
  } finally {
    if (temp) try { fs.unlinkSync(temp); } catch {}
    release();
  }
}
export function all(s, sql, params=[]){ const st=s.db.prepare(sql,params), rows=[]; try { while(st.step()) rows.push(st.getAsObject()); } finally { st.free(); } return rows; }
export function one(s, sql, params=[]){ return all(s,sql,params)[0] || null; }
export function run(s, sql, params=[]){ s.db.run(sql,params); }
export function audit(s, action, type, eid, payload={}, side='none'){
  const at=now(), aid=id('audit',`${action}:${type}:${eid}:${at}:${JSON.stringify(payload)}`);
  run(s,'INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)',[aid,action,type,eid,JSON.stringify(payload),side,at]);
  const evt={id:aid,action,entityType:type,entityId:eid,payload,externalSideEffect:side,createdAt:at};
  fs.appendFileSync(path.join(s.p.ws,'audit.log.jsonl'),JSON.stringify(evt)+'\n');
  const jid=payload.jobId || (type==='job'?eid:null); if(jid){const d=path.join(s.p.jobs,jid); fs.mkdirSync(d,{recursive:true}); fs.appendFileSync(path.join(d,'audit.log.jsonl'),JSON.stringify(evt)+'\n');}
}
