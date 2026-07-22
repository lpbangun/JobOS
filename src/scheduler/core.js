import fs from 'node:fs';
import path from 'node:path';
import { all, one, run, save, audit, reload } from '../db.js';
import { id, now } from '../utils.js';
import { isDue } from './cron.js';
import { appendRunJsonl, getAutomation, listAutomations, listRuns, runId, setAutomationEnabled, syncAutomationsWorkspace } from './store.js';
import { runAction } from './actions.js';

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireSchedulerLock(s) {
  fs.mkdirSync(s.p.state, { recursive: true });
  const file = path.join(s.p.state, 'scheduler.pid');
  try {
    const fd = fs.openSync(file, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    if (pidAlive(pid)) throw Error(`Scheduler already running with PID ${pid}`);
    fs.rmSync(file, { force: true });
    return acquireSchedulerLock(s);
  }
  return () => {
    try {
      if (fs.existsSync(file) && Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.rmSync(file, { force: true });
    } catch {}
  };
}

export function dueAutomations(s, { nowDate = new Date() } = {}) {
  const due = [];
  let recordedInvalid = false;
  for (const automation of listAutomations(s, { includeNext: false })) {
    if (!automation.enabled) continue;
    try {
      if (isDue(automation.schedule, automation.lastRunAt, nowDate)) due.push(automation);
    } catch (e) {
      audit(s, 'automation.schedule_invalid', 'automation', automation.id, { schedule: automation.schedule, error: e.message });
      recordedInvalid = true;
    }
  }
  if (recordedInvalid) save(s);
  return due;
}

function createReviewTaskForFailure(s, automation, error, at) {
  const tid = id('task', `automation-failed:${automation.id}:${at}`);
  run(s, 'INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
    tid,
    null,
    null,
    `Review disabled automation: ${automation.name}`,
    `Automation ${automation.name} failed 3 consecutive times and was disabled. Last error: ${error}`,
    'review',
    at,
    'high',
    'open',
    'automation',
    at,
    at
  ]);
  return tid;
}

export async function runAutomation(s, idOrAutomation, { trigger = 'manual', nowDate = new Date(), runAction: executeAction = runAction } = {}) {
  const automation = typeof idOrAutomation === 'string' ? getAutomation(s, idOrAutomation) : idOrAutomation;
  if (!automation) throw Error(`Unknown automation: ${idOrAutomation}`);
  const started = nowDate.toISOString();
  const rid = runId(`${automation.id}:${trigger}:${started}`);
  const inputs = { automationId: automation.id, automationName: automation.name, actionId: automation.actionId, profileId: automation.profileId, config: automation.config };
  audit(s, 'automation.started', 'automation', automation.id, { runId: rid, trigger, actionId: automation.actionId });
  let status = 'succeeded';
  let outputs = {};
  let counts = {};
  let error = null;
  try {
    const result = await executeAction(s, automation, { nowDate });
    outputs = result?.outputs || result || {};
    counts = result?.counts || {};
    if (['succeeded', 'partial', 'failed'].includes(result?.derivedStatus)) status = result.derivedStatus;
    if (status === 'failed') error = result?.error || 'Automation action reported failure';
  } catch (e) {
    status = 'failed';
    error = e.message;
  }
  const finishedDate = new Date();
  const finished = finishedDate.toISOString();
  const duration = Math.max(0, finishedDate.getTime() - new Date(started).getTime());
  const failures = status === 'failed' ? automation.consecutiveFailures + 1 : 0;
  let disabled = false;
  let failureTaskId = null;
  if (failures >= 3) {
    disabled = true;
    failureTaskId = createReviewTaskForFailure(s, automation, error, finished);
  }
  run(s, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,automation_id,action_id,trigger_type,started_at,finished_at,duration_ms,error,counts_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    rid,
    automation.name,
    JSON.stringify(inputs),
    JSON.stringify({ ...outputs, disabled, failureTaskId }),
    status,
    'none',
    started,
    automation.id,
    automation.actionId,
    trigger,
    started,
    finished,
    duration,
    error,
    JSON.stringify(counts)
  ]);
  run(s, 'UPDATE automations SET last_run_at=?, last_status=?, consecutive_failures=?, enabled=CASE WHEN ? THEN 0 ELSE enabled END, updated_at=? WHERE id=?', [finished, status, failures, disabled ? 1 : 0, finished, automation.id]);
  const auditAction = status === 'succeeded' ? 'automation.succeeded' : status === 'partial' ? 'automation.partial' : 'automation.failed';
  audit(s, auditAction, 'automation_run', rid, { automationId: automation.id, actionId: automation.actionId, status, error, disabled, failureTaskId });
  const runRecord = {
    id: rid,
    automationId: automation.id,
    automationName: automation.name,
    actionId: automation.actionId,
    trigger,
    inputs,
    outputs: { ...outputs, disabled, failureTaskId },
    counts,
    status,
    error,
    externalSideEffects: 'none',
    startedAt: started,
    finishedAt: finished,
    durationMs: duration,
    createdAt: started
  };
  appendRunJsonl(s, runRecord);
  syncAutomationsWorkspace(s);
  save(s);
  return runRecord;
}

export async function runDueAutomations(s, { nowDate = new Date(), locked = false } = {}) {
  const release = locked ? null : acquireSchedulerLock(s);
  try {
    reload(s);
    const due = dueAutomations(s, { nowDate });
    const runs = [];
    for (const automation of due) runs.push(await runAutomation(s, automation, { trigger: 'schedule', nowDate }));
    return { ok: true, checkedAt: nowDate.toISOString(), due: due.length, runs };
  } finally {
    release?.();
  }
}

export async function runAutomationByName(s, idOrName, options = {}) {
  return await runAutomation(s, idOrName, { trigger: options.trigger || 'manual', nowDate: options.nowDate || new Date() });
}

export async function schedulerStatus(s) {
  reload(s);
  const lock = path.join(s.p.state, 'scheduler.pid');
  let pid = null, running = false;
  if (fs.existsSync(lock)) {
    pid = Number(fs.readFileSync(lock, 'utf8').trim());
    running = pidAlive(pid);
  }
  return {
    running,
    pid: running ? pid : null,
    automations: listAutomations(s),
    recentRuns: listRuns(s, { limit: 10 })
  };
}

export async function startScheduler(s, { intervalSeconds = 60, onTick = null } = {}) {
  const release = acquireSchedulerLock(s);
  let stopped = false;
  let wake = null;
  const stop = () => {
    stopped = true;
    wake?.();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    while (!stopped) {
      const result = await runDueAutomations(s, { nowDate: new Date(), locked: true });
      onTick?.(result);
      if (stopped) break;
      await new Promise(resolve => {
        wake = resolve;
        setTimeout(resolve, Math.max(1, Number(intervalSeconds) || 60) * 1000);
      });
      wake = null;
    }
  } finally {
    release();
  }
}

export function recentRuns(s, limit = 25) {
  return listRuns(s, { limit });
}
