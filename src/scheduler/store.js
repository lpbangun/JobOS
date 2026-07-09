import fs from 'node:fs';
import path from 'node:path';
import { id, now, parseJson, slug } from '../utils.js';
import { writeYaml } from '../workspace.js';
import { nextRunAfter, parseCron } from './cron.js';

export const policy = {
  autoApply: 'user_configured',
  autoSend: 'user_configured',
  defaultExternalActions: 'user_configured'
};

export const actionAliases = {
  'discover.run_saved_searches': 'daily_discovery',
  'outreach.list_due_and_draft': 'followup_watch',
  'applications.stale_check': 'stale_application_check',
  'review.weekly': 'weekly_retrospective',
  'brief.morning_priority': 'morning_priority_brief'
};

export const defaultAutomations = [
  { name: 'daily_discovery', actionId: 'daily_discovery', schedule: '0 7 * * 1-5', profileId: null, enabled: false, config: { create_review_queue: true } },
  { name: 'followup_watch', actionId: 'followup_watch', schedule: '0 9 * * 1-5', profileId: null, enabled: false, config: { require_approval_to_send: true } },
  { name: 'stale_application_check', actionId: 'stale_application_check', schedule: '0 10 * * 1-5', profileId: null, enabled: false, config: { stale_days: 14 } },
  { name: 'weekly_retrospective', actionId: 'weekly_retrospective', schedule: '0 9 * * 5', profileId: null, enabled: false, config: {} },
  { name: 'morning_priority_brief', actionId: 'morning_priority_brief', schedule: '0 8 * * 1-5', profileId: null, enabled: false, config: {} }
];

function rawAll(s, sql, params = []) {
  const st = s.db.prepare(sql, params), rows = [];
  try { while (st.step()) rows.push(st.getAsObject()); } finally { st.free(); }
  return rows;
}

function rawOne(s, sql, params = []) {
  return rawAll(s, sql, params)[0] || null;
}

function persist(s) {
  fs.writeFileSync(s.p.db, Buffer.from(s.db.export()));
}

export function canonicalActionId(actionId) {
  return actionAliases[actionId] || actionId;
}

export function automationId(name) {
  return slug(name).replaceAll('-', '_');
}

export function normalizeAutomation(row, { includeNext = true, nowDate = new Date() } = {}) {
  if (!row) return null;
  let nextDueAt = null;
  if (includeNext) {
    try { nextDueAt = nextRunAfter(row.schedule, nowDate).toISOString(); } catch {}
  }
  return {
    id: row.id,
    name: row.name,
    actionId: row.action_id,
    schedule: row.schedule,
    profileId: row.profile_id || null,
    enabled: Boolean(row.enabled),
    config: parseJson(row.config_json, {}),
    lastRunAt: row.last_run_at || null,
    lastStatus: row.last_status || null,
    consecutiveFailures: Number(row.consecutive_failures || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextDueAt
  };
}

export function listAutomations(s, opts = {}) {
  return rawAll(s, 'SELECT * FROM automations ORDER BY name').map(row => normalizeAutomation(row, opts));
}

export function getAutomation(s, idOrName) {
  const row = rawOne(s, 'SELECT * FROM automations WHERE id=? OR name=?', [idOrName, idOrName]);
  return normalizeAutomation(row, { includeNext: false });
}

export function createAutomation(s, { name, actionId, schedule, profileId = null, enabled = false, config = {} }) {
  if (!name) throw Error('Missing automation name');
  if (!actionId) throw Error('Missing automation action');
  if (!schedule) throw Error('Missing automation schedule');
  parseCron(schedule);
  const aid = automationId(name);
  const at = now();
  s.db.run(`INSERT INTO automations (id,name,action_id,schedule,profile_id,enabled,config_json,last_status,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, action_id=excluded.action_id, schedule=excluded.schedule, profile_id=excluded.profile_id,
      enabled=excluded.enabled, config_json=excluded.config_json, updated_at=excluded.updated_at`, [
    aid,
    name,
    canonicalActionId(actionId),
    schedule,
    profileId || null,
    enabled ? 1 : 0,
    JSON.stringify(config || {}),
    'never_run',
    at,
    at
  ]);
  syncAutomationsWorkspace(s);
  persist(s);
  return getAutomation(s, aid);
}

export function setAutomationEnabled(s, idOrName, enabled) {
  const row = getAutomation(s, idOrName);
  if (!row) throw Error(`Unknown automation: ${idOrName}`);
  s.db.run('UPDATE automations SET enabled=?, updated_at=? WHERE id=?', [enabled ? 1 : 0, now(), row.id]);
  syncAutomationsWorkspace(s);
  persist(s);
  return getAutomation(s, row.id);
}

export function updateAutomation(s, idOrName, changes = {}) {
  const row = getAutomation(s, idOrName);
  if (!row) throw Error(`Unknown automation: ${idOrName}`);
  const enabledValue = changes.enabled === 'true' ? true : (changes.enabled === 'false' ? false : changes.enabled);
  if (changes.schedule) parseCron(changes.schedule);
  const next = {
    name: changes.name ?? row.name,
    actionId: canonicalActionId(changes.actionId ?? changes.action_id ?? row.actionId),
    schedule: changes.schedule ?? row.schedule,
    profileId: changes.profileId ?? changes.profile_id ?? row.profileId,
    enabled: enabledValue ?? row.enabled,
    config: changes.config ?? row.config
  };
  s.db.run(`UPDATE automations SET name=?, action_id=?, schedule=?, profile_id=?, enabled=?, config_json=?, updated_at=? WHERE id=?`, [
    next.name, next.actionId, next.schedule, next.profileId || null, next.enabled ? 1 : 0, JSON.stringify(next.config || {}), now(), row.id
  ]);
  syncAutomationsWorkspace(s);
  persist(s);
  return getAutomation(s, row.id);
}

export function seedDefaultAutomations(s) {
  const at = now();
  for (const item of defaultAutomations) {
    s.db.run(`INSERT OR IGNORE INTO automations (id,name,action_id,schedule,profile_id,enabled,config_json,last_status,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      automationId(item.name),
      item.name,
      item.actionId,
      item.schedule,
      item.profileId,
      0,
      JSON.stringify(item.config),
      'never_run',
      at,
      at
    ]);
  }
  syncAutomationsWorkspace(s);
}

export function syncAutomationsWorkspace(s) {
  fs.mkdirSync(s.p.automations, { recursive: true });
  const rows = rawAll(s, 'SELECT * FROM automations ORDER BY name').map(row => normalizeAutomation(row, { includeNext: false }));
  const automations = {};
  for (const row of rows) {
    automations[row.name] = {
      id: row.id,
      action: row.actionId,
      schedule: row.schedule,
      profile: row.profileId,
      enabled: row.enabled,
      config: row.config,
      last_run_at: row.lastRunAt,
      last_status: row.lastStatus,
      consecutive_failures: row.consecutiveFailures
    };
  }
  writeYaml(path.join(s.p.automations, 'automations.yaml'), { version: 1, policy, automations });
  fs.writeFileSync(path.join(s.p.automations, 'scheduler-design.json'), JSON.stringify({
    version: 2,
    note: 'Implemented scheduler. Canonical editable mirror is automations.yaml; SQLite remains canonical for dashboard/API queries.',
    configFile: 'automations.yaml',
    policy
  }, null, 2) + '\n');
}

export function appendRunJsonl(s, run) {
  const day = String(run.createdAt || now()).slice(0, 10);
  const file = path.join(s.p.automations, `runs-${day}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(run) + '\n');
}

export function listRuns(s, { limit = 25 } = {}) {
  return rawAll(s, `SELECT * FROM automation_runs ORDER BY created_at DESC LIMIT ${Math.max(1, Math.min(200, Number(limit) || 25))}`).map(row => ({
    id: row.id,
    automationId: row.automation_id || null,
    automationName: row.trigger_name,
    actionId: row.action_id || null,
    trigger: row.trigger_type || row.trigger_name,
    inputs: parseJson(row.inputs_json, {}),
    outputs: parseJson(row.outputs_json, {}),
    counts: parseJson(row.counts_json, {}),
    status: row.status,
    error: row.error || null,
    externalSideEffects: row.external_side_effects,
    startedAt: row.started_at || row.created_at,
    finishedAt: row.finished_at || row.created_at,
    durationMs: Number(row.duration_ms || 0),
    createdAt: row.created_at
  }));
}

export function runId(seed) {
  return id('run', `${seed}:${process.pid}:${process.hrtime.bigint()}`);
}
