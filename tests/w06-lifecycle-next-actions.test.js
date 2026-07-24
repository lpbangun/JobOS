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
import { appCreate, appUpdate, recordStatusChange } from '../src/tracking.js';
import { id } from '../src/utils.js';
import { funnel, renderFunnelMarkdown, weekly } from '../src/analytics.js';
import { summarizeOutreachOutcomes } from '../src/outreach-outcomes.js';
import {
  LIFECYCLE_ANALYTICS_SCHEMA,
  lifecycleAnalytics,
} from '../src/lifecycle-analytics.js';
import { callDomainTool, DOMAIN_TOOLS, selectedJobContext } from '../src/domain-tools.js';
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

function seedObservedApplication(fixture, {
  suffix,
  title,
  source,
  events,
  score = null,
}) {
  const filePath = path.join(fixture.root, `analytics-${suffix}.md`);
  writeFileSync(filePath, `Title: ${title}\nCompany: ${suffix} Analytics\nLocation: Remote\n\nAnalytics fixture.\n`);
  const job = importText(fixture.store, { profileId: fixture.profile.id, filePath }).job;
  run(fixture.store, 'UPDATE jobs SET title=?,source=? WHERE id=?', [
    title,
    source,
    job.id,
  ]);
  const application = appCreate(fixture.store, job.id, events[0].status, '', {
    at: events[0].at,
    actor: 'user',
    source: 'test',
  });
  if (score) {
    run(fixture.store, 'UPDATE jobs SET fit_score=?,score_json=? WHERE id=?', [
      score.overall,
      JSON.stringify(score),
      job.id,
    ]);
  }
  for (let index = events.length - 1; index >= 1; index -= 1) {
    recordStatusChange(fixture.store, {
      applicationId: application.id,
      jobId: job.id,
      profileId: fixture.profile.id,
      fromStatus: events[index - 1].status,
      toStatus: events[index].status,
      note: '',
      at: events[index].at,
      actor: 'user',
      source: 'test',
      sourceEventId: null,
    });
  }
  const latest = events.at(-1);
  run(fixture.store, 'UPDATE applications SET status=?,updated_at=? WHERE id=?', [
    latest.status,
    latest.at,
    application.id,
  ]);
  const latestEvent = one(fixture.store, `SELECT * FROM status_changes
    WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [application.id]);
  reconcileApplicationNextAction(fixture.store, {
    applicationId: application.id,
    trigger: lifecycleTrigger(
      fixture.profile.id,
      application.id,
      latestEvent.id,
      'application_status_changed',
      latestEvent.created_at,
    ),
    nowDate: new Date(latestEvent.created_at),
  });
  save(fixture.store);
  return {
    job: one(fixture.store, 'SELECT * FROM jobs WHERE id=?', [job.id]),
    application: one(fixture.store, 'SELECT * FROM applications WHERE id=?', [application.id]),
  };
}

function insertImmutableSubmission(s, { application, job, submittedAt, recordedAt, type = 'user_attestation' }) {
  const artifactId = `artifact_analytics_${application.id}`;
  const packetId = `packet_analytics_${application.id}`;
  const receiptId = `receipt_analytics_${application.id}`;
  run(s, `INSERT INTO artifacts
    (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    artifactId, job.id, application.profile_id, 'resume', `fixtures/${artifactId}.md`, 'Analytics resume', 'fixture',
    '[]', '[]', 'approved', submittedAt, `analytics:${application.id}`, 1, null, `hash_${application.id}`,
    submittedAt, 'test', '',
  ]);
  run(s, `INSERT INTO application_packets
    (id,job_id,profile_id,application_id,attempt_number,revision,content_hash,readiness_status_at_create,readiness_version,packet_version,resume_artifact_id,resume_content_hash,answers_json,identity_json,materials_json,blockers_json,warnings_json,created_at,created_by_source)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    packetId, job.id, application.profile_id, application.id, 1, 1, `packet_hash_${application.id}`,
    'approved', 3, 1, artifactId, `hash_${application.id}`, '[]', '{}', '{}', '[]', '[]', submittedAt, 'cli',
  ]);
  run(s, `INSERT INTO application_receipts
    (id,packet_id,application_id,type,submitted_at,recorded_at,receipt_hash,source,submission_actor)
    VALUES (?,?,?,?,?,?,?,?,?)`, [
    receiptId, packetId, application.id, type, submittedAt, recordedAt, `receipt_hash_${application.id}`, 'cli',
    type === 'adapter_receipt' ? 'configured_adapter' : 'human',
  ]);
  save(s);
  return receiptId;
}

function insertProofGap(s, { profileId, jobId, applicationId, suffix }) {
  const revisionId = `resume_revision_${profileId}`;
  run(s, `INSERT OR IGNORE INTO profile_resume_revisions
    (id,profile_id,revision,schema_version,source_text,source_text_hash,document_json,verification_status,is_current,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [
    revisionId, profileId, 1, 1, 'analytics fixture', `resume_hash_${profileId}`, '{}', 'verified', 1,
    '2026-07-01T00:00:00.000Z',
  ]);
  const artifactId = `artifact_gap_${suffix}`;
  run(s, `INSERT INTO artifacts
    (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at,series_key,revision,supersedes_artifact_id,content_hash,reviewed_at,reviewed_by,review_note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    artifactId, jobId, profileId, 'resume', `fixtures/${artifactId}.md`, 'Gap resume', 'fixture', '[]', '[]',
    'approved', '2026-07-12T00:00:00.000Z', `gap:${applicationId}`, 1, null, `gap_hash_${suffix}`,
    '2026-07-12T00:00:00.000Z', 'test', '',
  ]);
  run(s, `INSERT INTO artifact_resume_documents
    (artifact_id,schema_version,source_resume_revision_id,document_json,coverage_json,validation_json,layout_profile_json,render_manifest_json)
    VALUES (?,?,?,?,?,?,?,?)`, [
    artifactId, 1, revisionId, '{}', JSON.stringify({
      summary: { coverageRatio: 0.5 },
      unsupported: [{
        requirementId: 'requirement_analytics',
        requirement: {
          sourceText: 'Enterprise procurement leadership',
          category: 'experience',
          priority: 'must_have',
        },
      }],
    }), '{}', '{}', '{}',
  ]);
}

async function analyticsFixture(t) {
  const fixture = await actionStore(t);
  const scored = {
    contract: 'jobos.fit-score.v1',
    scoreStatus: 'scored',
    overall: 82,
    evidenceCoverage: 100,
    constraints: [],
  };
  const applications = [];
  for (let index = 0; index < 10; index += 1) {
    const strongGroup = index < 5;
    const events = [
      { status: 'materials-ready', at: `2026-07-${String(8 + index).padStart(2, '0')}T12:00:00.000Z` },
      { status: 'applied', at: `2026-07-${String(9 + index).padStart(2, '0')}T12:00:00.000Z` },
    ];
    if ((strongGroup && index < 4) || index === 5) {
      events.push({ status: 'interview', at: `2026-07-${String(10 + index).padStart(2, '0')}T12:00:00.000Z` });
    }
    if (index === 1) {
      events.push({ status: 'interview', at: '2026-07-11T18:00:00.000Z' });
    }
    if (index === 0) events.push({ status: 'rejected', at: '2026-07-12T12:00:00.000Z' });
    if (index === 4) events.push({ status: 'withdrawn', at: '2026-07-14T12:00:00.000Z' });
    if (index === 9) events.push({ status: 'ghosted', at: '2026-07-20T12:00:00.000Z' });
    const seeded = seedObservedApplication(fixture, {
      suffix: `cohort-${index}`,
      title: strongGroup ? `Product Manager ${index}` : `Software Engineer ${index}`,
      source: strongGroup ? 'referral' : 'text_file',
      events,
      score: index < 5 ? scored : null,
    });
    applications.push(seeded);
  }
  insertImmutableSubmission(fixture.store, {
    ...applications[0],
    submittedAt: '2026-07-08T00:00:00.000Z',
    recordedAt: '2026-07-20T00:00:00.000Z',
  });
  const manualTask = one(fixture.store, `SELECT * FROM tasks
    WHERE application_id=? AND action_kind='application_next_action' AND status='open'`, [
    applications[5].application.id,
  ]);
  rescheduleApplicationNextAction(fixture.store, {
    taskId: manualTask.id,
    profileId: fixture.profile.id,
    dueAt: '2026-07-20T12:00:00.000Z',
    reason: 'Analytics manual schedule fixture',
    source: 'cli',
    nowDate: new Date('2026-07-19T12:00:00.000Z'),
  });
  insertProofGap(fixture.store, {
    profileId: fixture.profile.id,
    jobId: applications[1].job.id,
    applicationId: applications[1].application.id,
    suffix: 'one',
  });
  insertProofGap(fixture.store, {
    profileId: fixture.profile.id,
    jobId: applications[2].job.id,
    applicationId: applications[2].application.id,
    suffix: 'two',
  });
  const legacyFile = path.join(fixture.root, 'legacy-current.md');
  writeFileSync(legacyFile, 'Title: Legacy Role\nCompany: Legacy Analytics\n\nLegacy snapshot.');
  const legacyJob = importText(fixture.store, { profileId: fixture.profile.id, filePath: legacyFile }).job;
  run(fixture.store, `INSERT INTO applications
    (id,job_id,profile_id,status,notes,confirmation_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [
    'app_analytics_legacy', legacyJob.id, fixture.profile.id, 'applied', '', '',
    '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z',
  ]);
  save(fixture.store);
  return { ...fixture, applications, manuallyRescheduledTaskId: manualTask.id };
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

test('W06-ANALYTICS-01 folds ordered observed events, immutable clocks, censoring, and explicit denominators', async t => {
  const fixture = await analyticsFixture(t);
  const nowDate = new Date('2026-07-24T12:00:00.000Z');
  const before = {
    statuses: stableRows(fixture.store, 'status_changes'),
    receipts: stableRows(fixture.store, 'application_receipts'),
  };
  const result = lifecycleAnalytics(fixture.store, {
    profileId: fixture.profile.id,
    sinceDays: 30,
    nowDate,
  });

  assert.equal(result.schema, LIFECYCLE_ANALYTICS_SCHEMA);
  assert.deepEqual(result.period, {
    start: '2026-06-24T12:00:00.000Z',
    end: '2026-07-24T12:00:00.000Z',
    sinceDays: 30,
    basis: 'observed_status_events_and_immutable_submission_events',
  });
  assert.equal(result.currentInventory.basis, 'current_snapshot');
  assert.equal(result.denominators.applicationsWithObservedEvents, 10);
  assert.equal(result.denominators.appliedCohort, 10);
  assert.equal(result.denominators.observedResponses, 5);
  assert.equal(result.denominators.terminalOutcomes, 3);
  assert.equal(result.denominators.completedDwellSegments, 19);
  assert.equal(result.denominators.openDwellSegments, 7);
  assert.equal(result.timeToResponse.sampleCount, 5);
  assert.equal(result.timeToResponse.medianHours, 24);
  assert.equal(result.timeToResponse.p75Hours, 24);
  assert.ok(result.timeToResponse.durationsHours.includes(60), 'immutable submitted_at, not applied status time, anchors response');
  assert.equal(result.stageDwell.byStage.find(stage => stage.stage === 'materials-ready').sampleCount, 10);
  assert.equal(result.stageDwell.byStage.find(stage => stage.stage === 'materials-ready').medianHours, 24);
  assert.deepEqual(result.outcomes.rejected.applicationIds, [fixture.applications[0].application.id]);
  assert.equal(result.outcomes.withdrawn.count, 1);
  assert.equal(result.outcomes.ghosted.count, 1);
  assert.equal(result.stageDwell.byStage.find(stage => stage.stage === 'interview').sampleCount, 2, 'repeated observed stage entries remain distinct dwell segments');
  assert.ok(result.warnings.some(warning => warning.code === 'open_dwell_censored'));
  assert.ok(result.warnings.some(warning => warning.code === 'legacy_unobserved_stage'));
  assert.ok(result.warnings.some(warning => warning.code === 'current_score_not_event_snapshot'));
  assert.equal(result.outreachOutcomes.schema, 'jobos.outreach-outcome-summary.v1');
  assert.deepEqual(result.outreachOutcomes, summarizeOutreachOutcomes(fixture.store, {
    profileId: fixture.profile.id,
    sinceDays: 30,
    nowDate,
  }));
  assert.deepEqual(stableRows(fixture.store, 'status_changes'), before.statuses);
  assert.deepEqual(stableRows(fixture.store, 'application_receipts'), before.receipts);
});

test('W06-RECOMMEND-01 enforces 0/4/5+ descriptive thresholds and deterministic non-causal actions', async t => {
  const fixture = await analyticsFixture(t);
  const nowDate = new Date('2026-07-24T12:00:00.000Z');
  const large = lifecycleAnalytics(fixture.store, {
    profileId: fixture.profile.id,
    sinceDays: 30,
    nowDate,
  });
  const source = large.recommendations.find(item => item.category === 'source');
  const targeting = large.recommendations.find(item => item.category === 'targeting');
  const score = large.recommendations.find(item => item.category === 'score');
  const proof = large.recommendations.find(item => item.category === 'proof');
  const followUp = large.recommendations.find(item => item.category === 'follow_up');
  assert.match(source.action, /next five-role review batch/i);
  assert.match(source.evidence.summary, /referral/i);
  assert.match(source.caution, /descriptive|caus/i);
  assert.match(targeting.action, /next five-role review batch/i);
  assert.match(score.action, /W04.*calibrat/i);
  assert.equal(score.sample.numerator, 5);
  assert.match(proof.action, /Enterprise procurement leadership/);
  assert.match(proof.caution, /only if true.*preserve the gap|preserve it as a gap/i);
  assert.match(followUp.action, /resolve|manually reschedule/i);
  for (const recommendation of large.recommendations) {
    assert.deepEqual(Object.keys(recommendation).sort(), ['action', 'category', 'caution', 'evidence', 'sample']);
    assert.equal(recommendation.sample.period.start, large.period.start);
  }

  const smallProfile = createProfile(fixture.store, 'W06 four sample profile').profile;
  const smallFixture = { ...fixture, profile: smallProfile };
  for (let index = 0; index < 4; index += 1) {
    seedObservedApplication(smallFixture, {
      suffix: `small-${index}`,
      title: index < 2 ? `Product ${index}` : `Engineer ${index}`,
      source: index < 2 ? 'referral' : 'text_file',
      events: [
        { status: 'materials-ready', at: `2026-07-${10 + index}T00:00:00.000Z` },
        { status: 'applied', at: `2026-07-${11 + index}T00:00:00.000Z` },
      ],
    });
  }
  assert.deepEqual(followUp.evidence.manuallyRescheduledActionIds, [fixture.manuallyRescheduledTaskId]);
  const small = lifecycleAnalytics(fixture.store, {
    profileId: smallProfile.id,
    sinceDays: 30,
    nowDate,
  });
  assert.equal(small.denominators.appliedCohort, 4);
  assert.equal(small.timeToResponse.medianHours, null);
  assert.match(small.recommendations.find(item => item.category === 'source').caution, /insufficient/i);
  assert.ok(small.warnings.some(warning => warning.code === 'insufficient_sample'));

  const emptyProfile = createProfile(fixture.store, 'W06 zero sample profile').profile;
  const empty = lifecycleAnalytics(fixture.store, {
    profileId: emptyProfile.id,
    sinceDays: 30,
    nowDate,
  });
  assert.equal(empty.denominators.appliedCohort, 0);
  assert.deepEqual(empty.bySource, []);
  assert.match(empty.recommendations.find(item => item.category === 'targeting').caution, /insufficient/i);
});

test('W06-HANDOFF-01 publishes exact W04/W07/W08 contracts and one compatibility projection', async t => {
  const root = workspaceFromFixture(t);
  const store = await openStore({ workspace: root });
  const profileId = one(store, "SELECT profile_id FROM applications WHERE status='applied'").profile_id;
  const nowDate = new Date('2030-01-01T00:00:00.000Z');
  const lifecycle = lifecycleAnalytics(store, { profileId, sinceDays: 3650, nowDate });
  assert.deepEqual(lifecycle.handoffs, {
    w04: {
      schema: 'jobos.lifecycle-analytics.v1',
      policy: 'descriptive_observed_aggregates_only_no_score_formula',
      fields: ['period', 'denominators', 'observedFunnel', 'stageDwell', 'timeToResponse', 'outcomes', 'scoreObservations'],
    },
    w07: {
      inputSchema: 'jobos.lifecycle-event-input.v1',
      acceptedEventTypes: ['interview_debrief_recorded'],
      required: ['profileId', 'applicationId', 'eventId', 'occurredAt', 'stage'],
      policy: 'debrief_content_remains_w07_owned',
    },
    w08: {
      schema: 'jobos.lifecycle-observation-list.v1',
      observationSchema: 'jobos.lifecycle-observation.v1',
      policy: 'attributed_observations_only_no_preference_interpretation',
    },
  });
  assert.deepEqual(lifecycle.outreachOutcomes, summarizeOutreachOutcomes(store, {
    profileId,
    sinceDays: 3650,
    nowDate,
  }));

  const projection = funnel(store, profileId, 3650, { nowDate });
  assert.equal(projection.lifecycle.schema, LIFECYCLE_ANALYTICS_SCHEMA);
  assert.deepEqual(projection.basis, {
    totals: 'mixed_labeled_inventory_and_observed_events',
    conversion: 'observed_events_only',
    byStage: 'current_snapshot',
    stageReached: 'observed_status_events',
    bySource: 'observed_applied_cohort',
    byRoleFamily: 'observed_applied_cohort',
  });
  // MEDIUM-1: conversion must expose an honestly named canonical key with a backward-compatible alias.
  assert.equal(
    projection.conversion.applyRateAmongApplicationsWithObservedEvents,
    projection.conversion.applyRateFromImportedJobs,
    'canonical conversion key must equal the deprecated alias value',
  );
  assert.deepEqual(projection.conversionAliases, {
    applyRateFromImportedJobs: 'applyRateAmongApplicationsWithObservedEvents',
  }, 'machine-readable alias/deprecation semantics must map the deprecated key to the canonical key');
  assert.equal(projection.totals.applied, projection.lifecycle.observedFunnel.applied);
  assert.equal(projection.totals.responses, projection.lifecycle.observedFunnel.responses);
  assert.equal(projection.totals.interviews, projection.lifecycle.observedFunnel.interviews);
  assert.equal(projection.totals.offers, projection.lifecycle.observedFunnel.offers);
  const markdown = renderFunnelMarkdown(projection);
  assert.match(markdown, /Current inventory/);
  assert.match(markdown, /Observed funnel/);
  assert.match(markdown, /Denominators/);
  assert.match(markdown, /censored/i);
  assert.match(markdown, /Warnings/);

  const review = weekly(store, profileId, { recordRun: false, nowDate });
  assert.deepEqual(review.metrics.outreachOutcomes, review.metrics.lifecycle.outreachOutcomes);
  assert.match(review.content, /Current application actions/);
  assert.match(review.content, /Generated recommendations/);
  assert.doesNotMatch(review.content, /## Recommended experiments/);
});

test('W06-SEAM-01 lifecycle domain tools require ownership and preserve observation attribution', async t => {
  const fixture = await actionStore(t);
  const owned = actionApplication(fixture, 'saved', '2026-07-20T12:00:00.000Z', 'domain-owned');
  const otherProfile = createProfile(fixture.store, 'W06 Other Domain Profile').profile;
  const other = actionApplication(
    { ...fixture, profile: otherProfile },
    'applied',
    '2026-07-21T12:00:00.000Z',
    'domain-other',
  );

  for (const name of ['lifecycle_analytics', 'list_lifecycle_observations']) {
    const definition = DOMAIN_TOOLS.find(tool => tool.name === name);
    assert.ok(definition, `${name} is registered`);
    assert.deepEqual(definition.inputSchema.required, ['profileId']);
    assert.deepEqual(definition.inputSchema.properties.profileId, { type: 'string' });
    assert.deepEqual(definition.inputSchema.properties.sinceDays, { type: 'number' });
  }

  const analytics = await callDomainTool(fixture.store, 'lifecycle_analytics', {
    profileId: fixture.profile.id,
    sinceDays: 3650,
  });
  assert.equal(analytics.schema, LIFECYCLE_ANALYTICS_SCHEMA);
  assert.equal(analytics.profileId, fixture.profile.id);
  assert.doesNotMatch(JSON.stringify(analytics), new RegExp(`${other.application.id}|${other.job.id}`));

  const list = await callDomainTool(fixture.store, 'list_lifecycle_observations', {
    profileId: fixture.profile.id,
    sinceDays: 3650,
  });
  assert.equal(list.schema, 'jobos.lifecycle-observation-list.v1');
  assert.equal(list.profileId, fixture.profile.id);
  assert.ok(list.observations.length > 0);
  assert.ok(list.observations.every(observation => observation.profileId === fixture.profile.id));
  assert.ok(list.observations.every(observation => observation.applicationId === owned.application.id));
  assert.ok(list.observations.every(observation => observation.jobId === owned.job.id));
  assert.ok(list.observations.some(observation => observation.actor === 'user' && observation.source === 'test'));
  assert.doesNotMatch(JSON.stringify(list), new RegExp(`${other.application.id}|${other.job.id}`));

  await assert.rejects(
    callDomainTool(fixture.store, 'lifecycle_analytics', { sinceDays: 30 }),
    error => error.code === 'lifecycle_analytics_profile_required',
  );
  await assert.rejects(
    callDomainTool(fixture.store, 'list_lifecycle_observations', { profileId: 'missing-profile' }),
    error => error.code === 'unknown_profile',
  );
  assert.throws(
    () => selectedJobContext(fixture.store, owned.job.id, otherProfile.id),
    error => error.code === 'unknown_job',
  );
});
