import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import initSqlJs from 'sql.js';

import { all, one, openStore, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate, appUpdate } from '../src/tracking.js';
import { id } from '../src/utils.js';
import {
  LIFECYCLE_EVENT_INPUT_SCHEMA,
  LIFECYCLE_NEXT_ACTION_SCHEMA,
  lifecycleTaskView,
  listLifecycleObservations,
  reconcileApplicationNextAction,
  rescheduleApplicationNextAction,
} from '../src/lifecycle.js';

const require = createRequire(import.meta.url);
const fixturePath = path.resolve('tests/fixtures/w06-schema12.sqlite');

function workspaceFromFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w06-schema12-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(fixturePath, path.join(root, '.jobos', 'jobos.sqlite'));
  return root;
}

async function rawFixtureRows(table, columns = '*') {
  const SQL = await initSqlJs({ locateFile: file => path.join(path.dirname(require.resolve('sql.js')), file) });
  const db = new SQL.Database(readFileSync(fixturePath));
  try {
    const statement = db.prepare(`SELECT ${columns} FROM ${table} ORDER BY id`);
    const rows = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject());
    } finally {
      statement.free();
    }
    return rows;
  } finally {
    db.close();
  }
}

function stableRows(store, table, columns = '*') {
  return all(store, `SELECT ${columns} FROM ${table} ORDER BY id`);
}

function countRows(store, table) {
  return Number(one(store, `SELECT COUNT(*) AS count FROM ${table}`).count);
}
async function actionStore(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w06-action-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, `W06 Action ${path.basename(root)}`).profile;
  return { root, store, profile };
}

function actionApplication(fixture, status, occurredAt, suffix) {
  const filePath = path.join(fixture.root, `job-${suffix}.md`);
  writeFileSync(filePath, `Title: ${suffix} Lifecycle Role\nCompany: ${suffix} Example\nLocation: Remote\n\nLifecycle fixture.\n`);
  const job = importText(fixture.store, { profileId: fixture.profile.id, filePath }).job;
  const application = appCreate(fixture.store, job.id, status, `${suffix} fixture.`);
  const statusEvent = one(fixture.store, 'SELECT * FROM status_changes WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [application.id]);
  run(fixture.store, 'UPDATE status_changes SET created_at=?,actor=?,source=? WHERE id=?', [occurredAt, 'user', 'test', statusEvent.id]);
  run(fixture.store, 'UPDATE applications SET created_at=?,updated_at=? WHERE id=?', [occurredAt, occurredAt, application.id]);
  save(fixture.store);
  return {
    job,
    application: one(fixture.store, 'SELECT * FROM applications WHERE id=?', [application.id]),
    statusEvent: one(fixture.store, 'SELECT * FROM status_changes WHERE id=?', [statusEvent.id]),
  };
}

function lifecycleTrigger(profileId, applicationId, eventId, eventType, occurredAt, extra = {}) {
  return {
    schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
    profileId,
    applicationId,
    eventId,
    eventType,
    occurredAt,
    ...extra,
  };
}

test('W06-MIGRATE-01 schema 12 migrates without rewriting W02/W05/application event truth', async t => {
  const before = {
    packets: await rawFixtureRows('application_packets'),
    receipts: await rawFixtureRows('application_receipts'),
    outcomes: await rawFixtureRows('outreach_outcomes'),
    applications: await rawFixtureRows('applications'),
    statuses: await rawFixtureRows('status_changes'),
  };
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });

  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'").value, '13');
  assert.deepEqual(all(store, 'PRAGMA foreign_key_check'), []);
  assert.deepEqual(stableRows(store, 'application_packets'), before.packets);
  assert.deepEqual(stableRows(store, 'application_receipts'), before.receipts);
  assert.deepEqual(stableRows(store, 'outreach_outcomes'), before.outcomes);
  assert.deepEqual(stableRows(store, 'applications'), before.applications);
  assert.deepEqual(
    stableRows(store, 'status_changes', 'id,application_id,job_id,profile_id,from_status,to_status,note,created_at'),
    before.statuses,
  );
  assert.ok(stableRows(store, 'status_changes').every(row => row.actor === 'unknown_legacy' && row.source === 'legacy' && row.source_event_id === null));
  assert.equal(one(store, "SELECT value FROM meta WHERE key='migration_w06_lifecycle_backfill'").value, '1');
});

test('W06-ISO-01 migration derives ownership without guessing global tasks', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const applied = one(store, "SELECT * FROM applications WHERE status='applied'");
  const rejected = one(store, "SELECT * FROM applications WHERE status='rejected'");
  const appliedJob = one(store, 'SELECT profile_id FROM jobs WHERE id=?', [applied.job_id]);

  const legacy = one(store, "SELECT * FROM tasks WHERE id LIKE 'task_%' AND application_id=? AND created_by='system'", [applied.id]);
  const stale = one(store, "SELECT * FROM tasks WHERE id='task_w06_stale_application_check'");
  const unrelated = one(store, "SELECT * FROM tasks WHERE id='task_w06_unrelated_review'");
  const outreach = one(store, "SELECT tasks.* FROM tasks JOIN outreach_threads ON outreach_threads.followup_task_id=tasks.id");
  const globalFailure = one(store, "SELECT * FROM tasks WHERE id='task_w06_global_automation_failure'");

  assert.equal(legacy.profile_id, applied.profile_id);
  assert.equal(stale.profile_id, applied.profile_id);
  assert.equal(unrelated.profile_id, appliedJob.profile_id);
  assert.equal(outreach.profile_id, applied.profile_id, 'outreach relationship is the final ownership fallback');
  assert.equal(outreach.job_id, null, 'migration does not invent a missing job link');
  assert.equal(globalFailure.profile_id, null);
  assert.equal(globalFailure.action_kind, 'general');

  assert.equal(legacy.status, 'superseded');
  assert.equal(stale.status, 'superseded');
  assert.equal(unrelated.status, 'open');
  assert.equal(outreach.status, 'open');

  assert.equal(countRows(store, 'tasks'), 7, 'two substitutes are retained and one W06 action is added');
  assert.equal(countRows(store, 'tasks'), stableRows(store, 'tasks').length);
  assert.equal(all(store, "SELECT id FROM tasks WHERE application_id=? AND action_kind='application_next_action' AND status='open'", [rejected.id]).length, 0);
  const current = all(store, "SELECT * FROM tasks WHERE application_id=? AND action_kind='application_next_action' AND status='open'", [applied.id]);
  assert.equal(current.length, 1);
  assert.equal(current[0].profile_id, applied.profile_id);
  assert.equal(current[0].stage, 'applied');
  assert.equal(current[0].action_code, 'employer-follow-up');
  assert.equal(current[0].source_event_type, 'submission_attested');
  assert.equal(current[0].source_event_id, one(store, "SELECT id FROM application_receipts WHERE type='user_attestation'").id);
  assert.equal(current[0].schedule_source, 'manual');
  assert.equal(current[0].due_at, '2030-01-07T12:00:00.000Z');
  assert.equal(current[0].policy_due_at, '2026-07-27T12:00:00.000Z');
});

test('W06-MIGRATE-02 reopening is byte-stable for lifecycle and append-only records', async t => {
  const root = workspaceFromFixture(t);
  const first = await openStore({ workspace: root });
  const before = {
    lifecycle: stableRows(first, 'tasks', 'id,profile_id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,action_kind,action_code,stage,source_event_type,source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,manual_rescheduled_at,manual_reschedule_reason'),
    tasks: countRows(first, 'tasks'),
    statuses: countRows(first, 'status_changes'),
    packets: countRows(first, 'application_packets'),
    receipts: countRows(first, 'application_receipts'),
    outcomes: countRows(first, 'outreach_outcomes'),
    audits: countRows(first, 'audit_log'),
  };
  first.db.close();

  const reopened = await openStore({ workspace: root });
  assert.deepEqual(
    stableRows(reopened, 'tasks', 'id,profile_id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,action_kind,action_code,stage,source_event_type,source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,manual_rescheduled_at,manual_reschedule_reason'),
    before.lifecycle,
  );
  const expectedCounts = {
    tasks: before.tasks,
    status_changes: before.statuses,
    application_packets: before.packets,
    application_receipts: before.receipts,
    outreach_outcomes: before.outcomes,
    audit_log: before.audits,
  };
  for (const [table, expected] of Object.entries(expectedCounts)) {
    assert.equal(countRows(reopened, table), expected);
  }
});

test('W06-ACTION-01 every active stage has one deterministic dated policy action and terminal stages have none', async t => {
  const fixture = await actionStore(t);
  const occurredAt = '2026-07-24T15:30:00.000Z';
  const expected = {
    saved: ['review-pursuit', '2026-07-27T15:30:00.000Z'],
    researching: ['complete-research', '2026-07-28T15:30:00.000Z'],
    'materials-ready': ['complete-submission', '2026-07-27T15:30:00.000Z'],
    applied: ['record-submission-evidence', '2026-07-27T15:30:00.000Z'],
    'recruiter-screen': ['prepare-recruiter-screen', '2026-07-27T15:30:00.000Z'],
    interview: ['prepare-interview', '2026-07-27T15:30:00.000Z'],
    offer: ['review-offer', '2026-07-27T15:30:00.000Z'],
  };
  for (const [status, [actionCode, dueAt]] of Object.entries(expected)) {
    const seeded = actionApplication(fixture, status, occurredAt, status);
    const trigger = lifecycleTrigger(
      fixture.profile.id,
      seeded.application.id,
      seeded.statusEvent.id,
      'application_created',
      occurredAt,
    );
    const first = reconcileApplicationNextAction(fixture.store, {
      applicationId: seeded.application.id,
      trigger,
      nowDate: new Date('2026-07-24T16:00:00.000Z'),
    });
    const replay = reconcileApplicationNextAction(fixture.store, {
      applicationId: seeded.application.id,
      trigger,
      nowDate: new Date('2035-01-01T00:00:00.000Z'),
    });
    assert.equal(first.id, replay.id);
    assert.equal(first.id, id('task', `${seeded.application.id}:${seeded.statusEvent.id}:${actionCode}:${seeded.statusEvent.id}`));
    assert.equal(first.action_code, actionCode);
    assert.equal(first.due_at, dueAt);
    assert.equal(first.policy_due_at, dueAt);
    assert.equal(first.urgent_at, actionCode === 'complete-research' ? '2026-07-30T15:30:00.000Z' : '2026-07-29T15:30:00.000Z');
    assert.equal(first.source_event_id, seeded.statusEvent.id);
    assert.equal(all(fixture.store, `SELECT id FROM tasks WHERE application_id=?
      AND action_kind='application_next_action' AND status='open'`, [seeded.application.id]).length, 1);
  }

  for (const status of ['rejected', 'withdrawn', 'ghosted']) {
    const seeded = actionApplication(fixture, status, occurredAt, status);
    const result = reconcileApplicationNextAction(fixture.store, {
      applicationId: seeded.application.id,
      trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', occurredAt),
    });
    assert.equal(result, null);
    assert.equal(all(fixture.store, `SELECT id FROM tasks WHERE application_id=?
      AND action_kind='application_next_action' AND status='open'`, [seeded.application.id]).length, 0);
  }
});

test('W06-ACTION-02 forward, backward, note, and duplicate reconciliation replace rather than delete actions', async t => {
  const fixture = await actionStore(t);
  const seeded = actionApplication(fixture, 'saved', '2026-07-24T12:00:00.000Z', 'transition');
  const initial = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', '2026-07-24T12:00:00.000Z'),
  });
  const immutableBefore = {
    statuses: stableRows(fixture.store, 'status_changes'),
    receipts: stableRows(fixture.store, 'application_receipts'),
    outcomes: stableRows(fixture.store, 'outreach_outcomes'),
  };
  const notes = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, 'audit_note_event', 'application_notes_updated', '2026-07-25T12:00:00.000Z'),
  });
  assert.equal(notes.id, initial.id);
  assert.equal(notes.source_event_id, 'audit_note_event');
  assert.deepEqual(stableRows(fixture.store, 'status_changes'), immutableBefore.statuses);
  assert.deepEqual(stableRows(fixture.store, 'application_receipts'), immutableBefore.receipts);
  assert.deepEqual(stableRows(fixture.store, 'outreach_outcomes'), immutableBefore.outcomes);

  appUpdate(fixture.store, seeded.application.id, 'researching', 'Advance.');
  let researchEvent = one(fixture.store, "SELECT * FROM status_changes WHERE application_id=? AND to_status='researching' ORDER BY id DESC LIMIT 1", [seeded.application.id]);
  run(fixture.store, 'UPDATE status_changes SET created_at=? WHERE id=?', ['2026-07-27T12:00:00.000Z', researchEvent.id]);
  researchEvent = one(fixture.store, 'SELECT * FROM status_changes WHERE id=?', [researchEvent.id]);
  const research = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, researchEvent.id, 'application_status_changed', researchEvent.created_at),
  });
  assert.equal(research.action_code, 'complete-research');
  assert.equal(one(fixture.store, 'SELECT status FROM tasks WHERE id=?', [initial.id]).status, 'superseded');

  appUpdate(fixture.store, seeded.application.id, 'saved', 'Return.');
  let savedAgainEvent = one(fixture.store, "SELECT * FROM status_changes WHERE application_id=? AND from_status='researching' AND to_status='saved' ORDER BY created_at DESC,id DESC LIMIT 1", [seeded.application.id]);
  run(fixture.store, 'UPDATE status_changes SET created_at=? WHERE id=?', ['2026-07-28T12:00:00.000Z', savedAgainEvent.id]);
  savedAgainEvent = one(fixture.store, 'SELECT * FROM status_changes WHERE id=?', [savedAgainEvent.id]);
  const savedAgain = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, savedAgainEvent.id, 'application_status_changed', savedAgainEvent.created_at),
  });
  assert.equal(savedAgain.action_code, 'review-pursuit');
  assert.notEqual(savedAgain.id, initial.id, 'a repeated stage has a new observed stage anchor');
  assert.equal(one(fixture.store, 'SELECT status FROM tasks WHERE id=?', [research.id]).status, 'superseded');
  assert.equal(all(fixture.store, "SELECT id FROM tasks WHERE application_id=? AND action_kind='application_next_action'", [seeded.application.id]).length, 3);
});

test('W06-ACTION-03 database uniqueness rejects a second current application action', async t => {
  const fixture = await actionStore(t);
  const seeded = actionApplication(fixture, 'saved', '2026-07-24T12:00:00.000Z', 'unique');
  const action = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', seeded.statusEvent.created_at),
  });
  assert.throws(() => run(fixture.store, `INSERT INTO tasks (
    id,job_id,application_id,title,description,type,due_at,priority,status,created_by,
    created_at,updated_at,profile_id,action_kind,action_code,stage,source_event_type,
    source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,
    manual_rescheduled_at,manual_reschedule_reason
  ) SELECT ?,job_id,application_id,title,description,type,due_at,priority,status,created_by,
    created_at,updated_at,profile_id,action_kind,action_code,stage,source_event_type,
    source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,
    manual_rescheduled_at,manual_reschedule_reason FROM tasks WHERE id=?`, ['task_w06_illegal_duplicate', action.id]), /UNIQUE constraint failed/);
});

test('W06-ACTION-04 interview debrief action remains anchored until the stage changes', async t => {
  const fixture = await actionStore(t);
  const seeded = actionApplication(fixture, 'interview', '2026-07-24T12:00:00.000Z', 'debrief');
  const prepare = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', seeded.statusEvent.created_at),
  });
  const debrief = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, 'w07_debrief_exact', 'interview_debrief_recorded', '2026-07-27T18:15:00.000Z', { stage: 'interview' }),
  });
  assert.equal(debrief.action_code, 'follow-up-after-interview');
  assert.equal(debrief.source_event_id, 'w07_debrief_exact');
  assert.equal(debrief.due_at, '2026-07-28T18:15:00.000Z');
  assert.equal(one(fixture.store, 'SELECT status FROM tasks WHERE id=?', [prepare.id]).status, 'superseded');
  const afterNote = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, 'later_note', 'application_notes_updated', '2026-07-28T10:00:00.000Z'),
  });
  assert.equal(afterNote.id, debrief.id);
  assert.equal(afterNote.source_event_id, 'w07_debrief_exact');

  appUpdate(fixture.store, seeded.application.id, 'offer', 'Offer observed.');
  const offerEvent = one(fixture.store, "SELECT * FROM status_changes WHERE application_id=? AND to_status='offer' ORDER BY created_at DESC,id DESC LIMIT 1", [seeded.application.id]);
  const offer = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, offerEvent.id, 'application_status_changed', offerEvent.created_at),
  });
  assert.equal(offer.action_code, 'review-offer');
  assert.equal(one(fixture.store, 'SELECT status FROM tasks WHERE id=?', [debrief.id]).status, 'superseded');
});

test('W06-ACTION-05 manual rescheduling preserves policy date and survives same-action reconciliation', async t => {
  const fixture = await actionStore(t);
  const seeded = actionApplication(fixture, 'saved', '2026-07-24T12:00:00.000Z', 'manual');
  const action = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', seeded.statusEvent.created_at),
  });
  save(fixture.store);
  const manual = rescheduleApplicationNextAction(fixture.store, {
    taskId: action.id,
    profileId: fixture.profile.id,
    dueAt: '2026-08-02T09:45:00Z',
    reason: 'Hiring team requested a later check-in.',
    actor: 'user',
    source: 'cli',
    nowDate: new Date('2026-07-27T09:00:00.000Z'),
  });
  assert.equal(manual.schema, LIFECYCLE_NEXT_ACTION_SCHEMA);
  assert.equal(manual.dueAt, '2026-08-02T09:45:00.000Z');
  assert.equal(manual.policyDueAt, '2026-07-27T12:00:00.000Z');
  assert.equal(manual.urgentAt, '2026-08-04T09:45:00.000Z');
  assert.equal(manual.scheduleSource, 'manual');
  assert.equal(manual.manualRescheduleReason, 'Hiring team requested a later check-in.');
  assert.equal(manual.state, 'waiting');
  const reconciled = reconcileApplicationNextAction(fixture.store, {
    applicationId: seeded.application.id,
    trigger: lifecycleTrigger(fixture.profile.id, seeded.application.id, 'manual_note', 'application_notes_updated', '2026-07-28T09:00:00.000Z'),
  });
  assert.equal(reconciled.id, action.id);
  assert.equal(reconciled.due_at, '2026-08-02T09:45:00.000Z');
  assert.equal(reconciled.policy_due_at, '2026-07-27T12:00:00.000Z');
  assert.equal(reconciled.schedule_source, 'manual');
  assert.equal(reconciled.manual_reschedule_reason, 'Hiring team requested a later check-in.');
  assert.equal(lifecycleTaskView(reconciled, { nowDate: new Date('2026-08-03T09:45:00.000Z') }).state, 'overdue');
  assert.equal(lifecycleTaskView(reconciled, { nowDate: new Date('2026-08-04T09:45:00.000Z') }).state, 'urgent');
});

test('W06-ACTION-06 trigger and ownership validation reject before writes', async t => {
  const fixture = await actionStore(t);
  const seeded = actionApplication(fixture, 'saved', '2026-07-24T12:00:00.000Z', 'validation');
  const before = countRows(fixture.store, 'tasks');
  const valid = lifecycleTrigger(fixture.profile.id, seeded.application.id, seeded.statusEvent.id, 'application_created', seeded.statusEvent.created_at);
  for (const [trigger, code] of [
    [{ ...valid, schema: 'wrong' }, 'invalid_lifecycle_event_schema'],
    [{ ...valid, profileId: 'profile_other' }, 'lifecycle_profile_mismatch'],
    [{ ...valid, applicationId: 'app_other' }, 'lifecycle_application_mismatch'],
    [{ ...valid, eventType: 'scheduler_tick' }, 'unsupported_lifecycle_event'],
    [{ ...valid, occurredAt: '2026-07-24' }, 'invalid_lifecycle_timestamp'],
    [lifecycleTrigger(fixture.profile.id, seeded.application.id, 'bad_debrief', 'interview_debrief_recorded', seeded.statusEvent.created_at, { stage: 'offer' }), 'invalid_interview_debrief_stage'],
  ]) {
    assert.throws(
      () => reconcileApplicationNextAction(fixture.store, { applicationId: seeded.application.id, trigger }),
      error => error?.code === code,
    );
  }
  assert.equal(countRows(fixture.store, 'tasks'), before);
});

test('W06-ACTION-07 lifecycle observations read attributed status and immutable receipt events without duplication', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const profileId = one(store, "SELECT profile_id FROM applications WHERE status='applied'").profile_id;
  const before = {
    statuses: countRows(store, 'status_changes'),
    receipts: countRows(store, 'application_receipts'),
    outcomes: countRows(store, 'outreach_outcomes'),
  };
  const result = listLifecycleObservations(store, {
    profileId,
    sinceDays: 3650,
    nowDate: new Date('2030-01-01T00:00:00.000Z'),
  });
  assert.equal(result.schema, 'jobos.lifecycle-observation-list.v1');
  assert.equal(result.observationSchema, 'jobos.lifecycle-observation.v1');
  assert.deepEqual(result.period, {
    start: '2020-01-04T00:00:00.000Z',
    end: '2030-01-01T00:00:00.000Z',
    sinceDays: 3650,
  });
  assert.ok(result.observations.some(event => event.type === 'submission_attested' && event.actor === 'human' && event.source === 'cli'));
  assert.ok(result.observations.some(event => event.type === 'receipt_confirmed'));
  assert.ok(result.observations.some(event => event.type === 'application_status_changed' && event.actor === 'unknown_legacy' && event.source === 'legacy'));
  assert.deepEqual(
    result.observations.map(event => [event.occurredAt, event.id]),
    [...result.observations].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)).map(event => [event.occurredAt, event.id]),
  );
  assert.equal(countRows(store, 'status_changes'), before.statuses);
  assert.equal(countRows(store, 'application_receipts'), before.receipts);
  assert.equal(countRows(store, 'outreach_outcomes'), before.outcomes);
});
