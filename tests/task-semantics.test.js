import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, run } from '../src/db.js';
import { due, openTasks } from '../src/tracking.js';
import { outreachDue } from '../src/outreach.js';
import { callDomainTool } from '../src/domain-tools.js';
import { createProfile } from '../src/profiles.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-task-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Task Surface').profile;
  const insert = ({ id, profileId = profile.id, type = 'review', dueAt = null, status = 'open', createdBy = 'system', actionKind = 'general' }) => {
    run(store, `INSERT INTO tasks (id,title,type,due_at,priority,status,created_by,created_at,updated_at,profile_id,action_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [id, id, type, dueAt, 'normal', status, createdBy, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profileId, actionKind]);
  };
  return { store, profile, insert };
}

test('task inbox and due queries have distinct semantics and category filters', async t => {
  const { store, profile, insert } = await fixture(t);
  insert({ id: 'due-review', dueAt: '2026-07-20T09:00:00.000Z' });
  insert({ id: 'due-followup', type: 'followup', dueAt: '2026-07-20T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'future', dueAt: '2026-07-22T09:00:00.000Z' });
  insert({ id: 'undated' });
  insert({ id: 'closed', dueAt: '2026-07-20T09:00:00.000Z', status: 'done' });

  assert.deepEqual(openTasks(store, { profileId: profile.id }).map(task => task.id), ['due-review', 'due-followup', 'future', 'undated']);
  assert.deepEqual(due(store, { profileId: profile.id, at: '2026-07-21T12:00:00.000Z' }).map(task => task.id), ['due-review', 'due-followup']);
  assert.deepEqual(openTasks(store, { profileId: profile.id, type: 'followup' }).map(task => task.id), ['due-followup']);
  assert.deepEqual(due(store, { profileId: profile.id, at: '2026-07-21T12:00:00.000Z', createdBy: 'outreach' }).map(task => task.id), ['due-followup']);
});

test('task queries require exactly one validated owner scope and support action filters', async t => {
  const { store, profile, insert } = await fixture(t);
  const other = createProfile(store, 'Other Task Surface').profile;
  insert({ id: 'profile-a', actionKind: 'application_next_action' });
  insert({ id: 'profile-b', profileId: other.id });
  insert({ id: 'global', profileId: null });

  assert.throws(() => openTasks(store), /exactly one.*profileId.*global/i);
  assert.throws(() => due(store, { profileId: profile.id, global: true }), /exactly one.*profileId.*global/i);
  assert.throws(() => openTasks(store, { profileId: 'missing-profile' }), /Unknown profile/);
  assert.deepEqual(openTasks(store, { profileId: profile.id, actionKind: 'application_next_action' }).map(task => task.id), ['profile-a']);
  assert.deepEqual(openTasks(store, { global: true }).map(task => task.id), ['global']);
});

test('domain list_tasks is profile-only and returns stable task projections', async t => {
  const { store, profile, insert } = await fixture(t);
  const other = createProfile(store, 'Hidden Task Surface').profile;
  insert({ id: 'visible', createdBy: 'user' });
  insert({ id: 'hidden', profileId: other.id });
  insert({ id: 'global-hidden', profileId: null });

  const tool = await callDomainTool(store, 'list_tasks', { profileId: profile.id });
  assert.deepEqual(tool.map(task => task.id), ['visible']);
  assert.deepEqual(tool[0], {
    id: 'visible',
    profileId: profile.id,
    jobId: null,
    applicationId: null,
    title: 'visible',
    description: '',
    type: 'review',
    createdBy: 'user',
    dueAt: null,
    priority: 'normal',
    status: 'open',
    actionKind: 'general'
  });
  assert.equal('profile_id' in tool[0], false);
});

test('outreach due is an enriched view of due tasks and excludes undated follow-ups', async t => {
  const { store, profile, insert } = await fixture(t);
  insert({ id: 'outreach-due', type: 'followup', dueAt: '2026-07-20T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'outreach-undated', type: 'followup', createdBy: 'outreach' });
  const at = '2026-07-20T08:00:00.000Z';
  for (const [id, taskId] of [['thread-due', 'outreach-due'], ['thread-undated', 'outreach-undated']]) {
    run(store, `INSERT INTO outreach_threads
      (id,artifact_id,job_id,profile_id,stakeholder_id,goal,channel,status,sent_at,next_followup_at,followup_task_id,notes,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, `artifact-${id}`, null, profile.id, null, 'informational', '', 'followup_scheduled', null, null, taskId, '', at, at]);
  }

  const dueTaskIds = due(store, { profileId: profile.id, at: '2026-07-21T12:00:00.000Z', type: 'followup', createdBy: 'outreach' }).map(task => task.id);
  const dueThreads = outreachDue(store, { nowDate: new Date('2026-07-21T12:00:00.000Z') });

  assert.deepEqual(dueTaskIds, ['outreach-due']);
  assert.deepEqual(dueThreads.map(thread => thread.taskId), dueTaskIds);
  assert.equal(dueThreads[0].threadId, 'thread-due');
});

test('TUI due overlay uses true due tasks and renders outreach reminders once with category and source', async t => {
  const { store, profile, insert } = await fixture(t);
  const other = createProfile(store, 'Hidden TUI Tasks').profile;
  insert({ id: 'Follow up with recruiter', type: 'followup', dueAt: '2026-07-20T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'Future reminder', type: 'followup', dueAt: '2026-07-22T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'Undated reminder', type: 'review' });
  insert({ id: 'Review application', type: 'review', dueAt: '2026-07-20T11:00:00.000Z', createdBy: 'system' });
  insert({ id: 'Other profile task', profileId: other.id, dueAt: '2026-07-20T08:00:00.000Z' });
  insert({ id: 'Global task', profileId: null, dueAt: '2026-07-20T08:00:00.000Z' });

  const model = buildTuiModel(store, { profileId: profile.id, at: '2026-07-21T12:00:00.000Z' });
  assert.deepEqual(model.dueTasks.map(task => task.id), ['Follow up with recruiter', 'Review application']);
  assert.equal(model.dueTasks[0].type, 'followup');
  assert.equal(model.dueTasks[0].source, 'outreach');

  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 30;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  const tui = new JobosTui(store, { stdin, stdout, connectAgent: false, color: false });
  tui.model = model;
  tui.state.overlay = 'due';
  const screen = renderTui(model, tui.state, { width: 120, height: 30, color: false });
  assert.equal(screen.split('\n').filter(line => line.includes('[followup/outreach] Follow up with recruiter')).length, 1);
  assert.match(screen, /\[followup\/outreach\]/);
  assert.doesNotMatch(screen, /Future reminder|Undated reminder|OUTREACH FOLLOW-UPS/);

  tui.state.taskFilter = 'followup';
  const filtered = renderTui(model, tui.state, { width: 120, height: 30, color: false });
  assert.match(filtered, /2 \[followup\]/);
  assert.match(filtered, /Follow up with recruiter/);
  assert.doesNotMatch(filtered, /Review application/);

  tui.onOverlayKey('3', { name: '3' });
  assert.equal(tui.state.taskFilter, 'review');
});
