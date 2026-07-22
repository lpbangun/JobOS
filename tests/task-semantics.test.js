import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, run } from '../src/db.js';
import { due, openTasks } from '../src/tracking.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-task-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const insert = ({ id, type = 'review', dueAt = null, status = 'open', createdBy = 'system' }) => {
    run(store, `INSERT INTO tasks (id,title,type,due_at,priority,status,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [id, id, type, dueAt, 'normal', status, createdBy, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z']);
  };
  return { store, insert };
}

test('task inbox and due queries have distinct semantics and category filters', async t => {
  const { store, insert } = await fixture(t);
  insert({ id: 'due-review', dueAt: '2026-07-20T09:00:00.000Z' });
  insert({ id: 'due-followup', type: 'followup', dueAt: '2026-07-20T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'future', dueAt: '2026-07-22T09:00:00.000Z' });
  insert({ id: 'undated' });
  insert({ id: 'closed', dueAt: '2026-07-20T09:00:00.000Z', status: 'done' });

  assert.deepEqual(openTasks(store).map(task => task.id), ['due-review', 'due-followup', 'future', 'undated']);
  assert.deepEqual(due(store, { at: '2026-07-21T12:00:00.000Z' }).map(task => task.id), ['due-review', 'due-followup']);
  assert.deepEqual(openTasks(store, { type: 'followup' }).map(task => task.id), ['due-followup']);
  assert.deepEqual(due(store, { at: '2026-07-21T12:00:00.000Z', createdBy: 'outreach' }).map(task => task.id), ['due-followup']);
});

test('TUI due overlay uses true due tasks and renders outreach reminders once with category and source', async t => {
  const { store, insert } = await fixture(t);
  insert({ id: 'Follow up with recruiter', type: 'followup', dueAt: '2026-07-20T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'Future reminder', type: 'followup', dueAt: '2026-07-22T10:00:00.000Z', createdBy: 'outreach' });
  insert({ id: 'Undated reminder', type: 'review' });
  insert({ id: 'Review application', type: 'review', dueAt: '2026-07-20T11:00:00.000Z', createdBy: 'system' });

  const model = buildTuiModel(store, { at: '2026-07-21T12:00:00.000Z' });
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
