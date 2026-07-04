import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';
import { id, now, paths, workspaceRoot } from './utils.js';
import { mkdirs } from './workspace.js';
import { seedDefaultAutomations } from './scheduler/store.js';

const require = createRequire(import.meta.url);
let SQL;

const schema = `PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, name TEXT NOT NULL, preferences_json TEXT NOT NULL, resume_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS proof_points (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, summary TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', skills_json TEXT NOT NULL DEFAULT '[]', metrics_json TEXT NOT NULL DEFAULT '[]', source TEXT NOT NULL DEFAULT 'manual', metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS companies (id TEXT PRIMARY KEY, name TEXT NOT NULL, website TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', facts_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, company_id TEXT, title TEXT NOT NULL, company TEXT NOT NULL, location TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual', description TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', compensation TEXT NOT NULL DEFAULT '', work_model TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'imported', fit_score INTEGER, score_json TEXT, high_fit INTEGER NOT NULL DEFAULT 0, posted_date TEXT NOT NULL DEFAULT '', dedupe_key TEXT NOT NULL DEFAULT '', source_history_json TEXT NOT NULL DEFAULT '[]', first_seen_at TEXT, last_seen_at TEXT, reposted INTEGER NOT NULL DEFAULT 0, discovery_run_id TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id,url), FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS saved_searches (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, profile_id TEXT NOT NULL, adapter TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', min_fit INTEGER NOT NULL DEFAULT 70, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(profile_id) REFERENCES profiles(id));
CREATE TABLE IF NOT EXISTS company_watchlist (id TEXT PRIMARY KEY, company TEXT NOT NULL, adapter TEXT NOT NULL, handle TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(company,adapter,handle));
CREATE TABLE IF NOT EXISTS stakeholders (id TEXT PRIMARY KEY, job_id TEXT, company_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', links_json TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '', outreach_status TEXT NOT NULL DEFAULT 'not_contacted', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS applications (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, status TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', confirmation_url TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(job_id,profile_id));
CREATE TABLE IF NOT EXISTS status_changes (id TEXT PRIMARY KEY, application_id TEXT NOT NULL, job_id TEXT NOT NULL, profile_id TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', warnings_json TEXT NOT NULL DEFAULT '[]', approval_status TEXT NOT NULL DEFAULT 'draft_needs_human_review', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, job_id TEXT, application_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'review', due_at TEXT, priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'open', created_by TEXT NOT NULL DEFAULT 'system', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, action_id TEXT NOT NULL, schedule TEXT NOT NULL, profile_id TEXT, enabled INTEGER NOT NULL DEFAULT 0, config_json TEXT NOT NULL DEFAULT '{}', last_run_at TEXT, last_status TEXT NOT NULL DEFAULT 'never_run', consecutive_failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS automation_runs (id TEXT PRIMARY KEY, trigger_name TEXT NOT NULL, inputs_json TEXT NOT NULL DEFAULT '{}', outputs_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL, external_side_effects TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL, automation_id TEXT, action_id TEXT, trigger_type TEXT NOT NULL DEFAULT 'manual', started_at TEXT, finished_at TEXT, duration_ms INTEGER NOT NULL DEFAULT 0, error TEXT, counts_json TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS audit_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', external_side_effect TEXT NOT NULL DEFAULT 'none', created_at TEXT NOT NULL);`;

function migrate(db){
  for (const sql of [
    "ALTER TABLE proof_points ADD COLUMN metrics_json TEXT NOT NULL DEFAULT '[]'",
    "ALTER TABLE proof_points ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'",
    "ALTER TABLE companies ADD COLUMN facts_json TEXT NOT NULL DEFAULT '[]'",
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
    "ALTER TABLE automation_runs ADD COLUMN counts_json TEXT NOT NULL DEFAULT '{}'"
  ]) { try { db.run(sql); } catch {} }
}

export async function openStore(flags={}){
  const r=workspaceRoot(flags), p=paths(r); mkdirs(p);
  if(!SQL) SQL=await initSqlJs({ locateFile: f => path.join(path.dirname(require.resolve('sql.js')), f) });
  const db=fs.existsSync(p.db) ? new SQL.Database(fs.readFileSync(p.db)) : new SQL.Database();
  db.run(schema); migrate(db); db.run('INSERT OR REPLACE INTO meta VALUES (?,?)',['schema_version','3']);
  const store={db,p,root:r}; seedDefaultAutomations(store); save(store); return store;
}
export function reload(s){ if(!fs.existsSync(s.p.db)) return s; try { s.db.close(); } catch {} s.db = new SQL.Database(fs.readFileSync(s.p.db)); s.db.run(schema); migrate(s.db); seedDefaultAutomations(s); return s; }
export function save(s){ fs.writeFileSync(s.p.db, Buffer.from(s.db.export())); }
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
