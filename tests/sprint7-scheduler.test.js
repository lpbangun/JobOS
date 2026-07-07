import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, run, save } from '../src/db.js';
import { matchesCron, nextRunAfter, isDue } from '../src/scheduler/cron.js';
import { createAutomation, getAutomation, listAutomations } from '../src/scheduler/store.js';
import { acquireSchedulerLock, dueAutomations, runAutomationByName, runDueAutomations } from '../src/scheduler/core.js';

function makeRoot() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-scheduler-test-'));
}

function cli(root, args) {
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  return result.stdout.trim();
}

test('cron parser supports lists, ranges, steps, and UTC due evaluation', () => {
  const mondayMorning = new Date('2026-07-06T07:00:00.000Z');
  assert.equal(matchesCron('0 7 * * 1-5', mondayMorning), true);
  assert.equal(matchesCron('*/15 7-9 * * 1,3,5', new Date('2026-07-06T08:30:00.000Z')), true);
  assert.equal(matchesCron('*/15 7-9 * * 1,3,5', new Date('2026-07-06T08:31:00.000Z')), false);
  assert.equal(matchesCron('0 9 1,15 * 1', new Date('2026-07-06T09:00:00.000Z')), true);
  assert.equal(matchesCron('0 9 1,15 * 1', new Date('2026-07-15T09:00:00.000Z')), true);
  assert.equal(matchesCron('0 9 1,15 * 1', new Date('2026-07-08T09:00:00.000Z')), false);
  assert.equal(nextRunAfter('0 7 * * 1-5', new Date('2026-07-03T07:00:00.000Z')).toISOString(), '2026-07-06T07:00:00.000Z');
  assert.equal(isDue('* * * * *', '2026-07-04T10:00:00.000Z', new Date('2026-07-04T10:01:00.000Z')), true);
  assert.equal(isDue('* * * * *', '2026-07-04T10:01:00.000Z', new Date('2026-07-04T10:01:30.000Z')), false);
});

test('due evaluation skips an unmatchable schedule without blocking other automations', async () => {
  const root = makeRoot();
  const s = await openStore({ workspace: root });
  createAutomation(s, { name: 'bad_schedule', actionId: 'morning_priority_brief', schedule: '0 0 31 2 *', enabled: true });
  createAutomation(s, { name: 'good_schedule', actionId: 'morning_priority_brief', schedule: '* * * * *', enabled: true });
  const due = dueAutomations(s, { nowDate: new Date('2026-07-04T10:01:00.000Z') });
  assert.deepEqual(due.map(a => a.name), ['good_schedule']);
});

test('init seeds disabled default automations and writes YAML mirror', async () => {
  const root = makeRoot();
  const s = await openStore({ workspace: root });
  const automations = listAutomations(s);
  assert.deepEqual(automations.map(a => a.name).sort(), ['daily_discovery', 'followup_watch', 'morning_priority_brief', 'stale_application_check', 'weekly_retrospective'].sort());
  assert.ok(automations.every(a => a.enabled === false));
  const yaml = readFileSync(path.join(root, 'jobos-workspace', 'automations', 'automations.yaml'), 'utf8');
  assert.match(yaml, /autoApply: disabled/);
  assert.match(yaml, /morning_priority_brief:/);
  const design = JSON.parse(readFileSync(path.join(root, 'jobos-workspace', 'automations', 'scheduler-design.json'), 'utf8'));
  assert.equal(design.configFile, 'automations.yaml');
});

test('scheduler run-once executes due automation, records run row, JSONL, and priority brief export', () => {
  const root = makeRoot();
  cli(root, ['init', '--json']);
  const profile = JSON.parse(cli(root, ['profile', 'create', 'PM EdTech', '--json']));
  const now = new Date();
  const schedule = `${now.getUTCMinutes()} ${now.getUTCHours()} * * *`;
  JSON.parse(cli(root, ['automation', 'create', 'brief_now', '--action', 'morning_priority_brief', '--schedule', schedule, '--profile', profile.id, '--enabled', '--json']));
  const result = JSON.parse(cli(root, ['scheduler', 'run-once', '--json']));
  assert.equal(result.due, 1);
  assert.equal(result.runs[0].status, 'succeeded');
  assert.equal(result.runs[0].externalSideEffects, 'none');
  const runs = JSON.parse(cli(root, ['runs', 'list', '--json']));
  assert.equal(runs[0].automationName, 'brief_now');
  assert.ok(existsSync(path.join(root, 'jobos-workspace', result.runs[0].outputs.briefs[0].path)));
  const day = result.runs[0].createdAt.slice(0, 10);
  const jsonl = readFileSync(path.join(root, 'jobos-workspace', 'automations', `runs-${day}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(jsonl.at(-1).automationName, 'brief_now');
});

test('manual failing automation records failures, auto-disables after three, and creates review task', async () => {
  const root = makeRoot();
  const s = await openStore({ workspace: root });
  createAutomation(s, { name: 'bad_action', actionId: 'missing_action', schedule: '* * * * *', enabled: true });
  for (let i = 0; i < 3; i++) {
    const runRecord = await runAutomationByName(s, 'bad_action', { nowDate: new Date(`2026-07-04T10:0${i}:00.000Z`) });
    assert.equal(runRecord.status, 'failed');
  }
  const automation = getAutomation(s, 'bad_action');
  assert.equal(automation.enabled, false);
  assert.equal(automation.consecutiveFailures, 3);
  const tasks = JSON.parse(cli(root, ['tasks', 'due', '--json']));
  assert.ok(tasks.some(t => t.title.includes('Review disabled automation: bad_action')));
});

test('scheduler lock guard prevents concurrent run-once writers', async () => {
  const root = makeRoot();
  const s = await openStore({ workspace: root });
  const release = acquireSchedulerLock(s);
  try {
    await assert.rejects(() => runDueAutomations(s), /Scheduler already running/);
  } finally {
    release();
  }
});

test('followup watch creates review-gated draft artifacts without sending', async () => {
  const root = makeRoot();
  const profile = JSON.parse(cli(root, ['profile', 'create', 'PM EdTech', '--json']));
  const job = JSON.parse(cli(root, ['jobs', 'import-text', '--profile', profile.id, '--file', path.join(process.cwd(), 'samples/job-description.md'), '--json']));
  const s = await openStore({ workspace: root });
  run(s, 'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', ['task_followup_test', job.id, null, 'Follow up with recruiter', 'Ask whether there is a timeline update.', 'followup', '2026-07-04T09:00:00.000Z', 'normal', 'open', 'test', '2026-07-04T08:00:00.000Z', '2026-07-04T08:00:00.000Z']);
  save(s);
  createAutomation(s, { name: 'followup_now', actionId: 'followup_watch', schedule: '* * * * *', profileId: profile.id, enabled: true });
  const runRecord = await runAutomationByName(s, 'followup_now', { nowDate: new Date('2026-07-04T09:01:00.000Z') });
  assert.equal(runRecord.status, 'succeeded');
  assert.equal(runRecord.counts.drafted, 1);
  const artifacts = JSON.parse(cli(root, ['runs', 'list', '--json']));
  assert.equal(artifacts[0].outputs.followups[0].approvalStatus, 'draft_needs_human_review');
  const draft = readFileSync(path.join(root, 'jobos-workspace', artifacts[0].outputs.followups[0].path), 'utf8');
  assert.match(draft, /Draft only/);
  assert.doesNotMatch(draft, /sent email/i);
});
