import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, run as dbRun, save } from '../src/db.js';
import { addWatchlist } from '../src/discovery.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-cleanup-cli-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_API_KEY: '' };
  const runCli = args => spawnSync(process.execPath, ['src/cli.js', ...args, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
  const cli = args => {
    const result = runCli(args);
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { root, cli, runCli };
}

test('task CLI requires one scope, isolates profile/global rows, and reschedules lifecycle actions', async () => {
  const { root, cli, runCli } = fixture();
  cli(['init']);
  const profile = cli(['profile', 'create', 'CLI Tasks A']);
  const other = cli(['profile', 'create', 'CLI Tasks B']);
  const store = await openStore({ workspace: root });
  const rows = [
    ['due-review', profile.id, 'general', 'review', 'system', '2026-07-20T09:00:00.000Z'],
    ['due-followup', profile.id, 'general', 'followup', 'outreach', '2026-07-20T10:00:00.000Z'],
    ['future-followup', profile.id, 'general', 'followup', 'outreach', '2999-07-20T10:00:00.000Z'],
    ['undated-review', profile.id, 'general', 'review', 'system', null],
    ['other-profile', other.id, 'general', 'review', 'system', '2026-07-20T08:00:00.000Z'],
    ['global-failure', null, 'general', 'review', 'automation', '2026-07-20T08:00:00.000Z']
  ];
  for (const [id, profileId, actionKind, type, createdBy, dueAt] of rows) {
    dbRun(store, `INSERT INTO tasks
      (id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,profile_id,action_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, null, null, id, '', type, dueAt, 'normal', 'open', createdBy, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profileId, actionKind]);
  }
  dbRun(store, `INSERT INTO tasks
    (id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,profile_id,action_kind,action_code,stage,
      source_event_type,source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,manual_reschedule_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'lifecycle-action', 'Prepare interview', 'Prepare it', 'review', '2026-07-22T09:00:00.000Z', 'high', 'open', 'lifecycle',
    '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profile.id, 'application_next_action', 'prepare-interview', 'interview',
    'application_status_changed', 'status-1', '2026-07-20T08:00:00.000Z', '2026-07-22T09:00:00.000Z',
    '2026-07-24T09:00:00.000Z', 'policy', ''
  ]);
  save(store);

  const missing = runCli(['tasks', 'list']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /exactly one.*--profile.*--global/i);
  const both = runCli(['tasks', 'due', '--profile', profile.id, '--global']);
  assert.equal(both.status, 2);

  assert.deepEqual(cli(['tasks', 'due', '--profile', profile.id, '--type', 'followup']).map(task => task.id), ['due-followup']);
  assert.deepEqual(cli(['tasks', 'list', '--profile', profile.id, '--created-by', 'outreach']).map(task => task.id), ['due-followup', 'future-followup']);
  assert.deepEqual(cli(['tasks', 'list', '--global']).map(task => task.id), ['global-failure']);

  const rescheduled = cli(['tasks', 'reschedule', 'lifecycle-action', '--profile', profile.id, '--due', '2026-08-03T09:30:00Z', '--reason', 'Hiring manager requested next week']);
  assert.equal(rescheduled.profileId, profile.id);
  assert.equal(rescheduled.dueAt, '2026-08-03T09:30:00.000Z');
  assert.equal(rescheduled.policyDueAt, '2026-07-22T09:00:00.000Z');
  assert.equal(rescheduled.scheduleSource, 'manual');
  assert.equal(rescheduled.manualRescheduleReason, 'Hiring manager requested next week');
  assert.equal('profile_id' in rescheduled, false);
});

test('watchlist alias creates a canonical search and legacy migration is explicit', async () => {
  const { root, cli } = fixture();
  const profile = cli(['profile', 'create', 'PM']);
  const alias = cli(['watchlist', 'add', '--profile', profile.id, '--company', 'Acme', '--adapter', 'greenhouse', '--board-token', 'acme']);
  assert.equal(alias.config.preset, 'company-watch');
  assert.equal(alias.deprecated, true);
  assert.ok(cli(['searches', 'list']).some(search => search.id === alias.id));

  const store = await openStore({ workspace: root });
  addWatchlist(store, { company: 'Legacy Co', adapter: 'lever', handle: 'legacy', notes: 'old row' });
  const migration = cli(['searches', 'migrate-watchlist', '--profile', profile.id]);
  assert.equal(migration.total, 1);
  assert.equal(migration.created, 1);
  const compatibility = cli(['watchlist', 'list']).filter(item => item.company === 'Legacy Co');
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0].legacy, false);
});

test('agent registry distinguishes pursue dependencies from standalone and streaming commands', () => {
  const { cli } = fixture();
  const guide = cli(['agent-guide']);
  const pursue = guide.commands.find(command => command.name === 'pursue');
  const score = guide.commands.find(command => command.name === 'score');
  const loop = guide.commands.find(command => command.name === 'loop scheduler');
  assert.equal(pursue.runsDependencies, true);
  assert.equal(score.relatedWorkflow, 'pursue');
  assert.equal(score.runsDependencies, false);
  assert.equal(loop.category, 'agent-stream');
  assert.equal(loop.audience, 'agent');
});
