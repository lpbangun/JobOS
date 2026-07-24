import {
  all,
  guardedWrite,
  one,
  projectAudit,
  queuePostCommit,
  recordAudit,
  run,
} from './db.js';
import { syncJob } from './jobs.js';
import { id } from './utils.js';

export const LIFECYCLE_NEXT_ACTION_SCHEMA = 'jobos.lifecycle-next-action.v1';
export const LIFECYCLE_EVENT_INPUT_SCHEMA = 'jobos.lifecycle-event-input.v1';
export const LIFECYCLE_OBSERVATION_SCHEMA = 'jobos.lifecycle-observation.v1';
export const LIFECYCLE_OBSERVATION_LIST_SCHEMA = 'jobos.lifecycle-observation-list.v1';

export const ACTIVE_APPLICATION_STATUSES = new Set([
  'saved',
  'researching',
  'materials-ready',
  'applied',
  'recruiter-screen',
  'interview',
  'offer',
]);

const TERMINAL_APPLICATION_STATUSES = new Set(['rejected', 'withdrawn', 'ghosted']);
const ACCEPTED_EVENT_TYPES = new Set([
  'application_created',
  'application_status_changed',
  'application_notes_updated',
  'submission_attested',
  'receipt_confirmed',
  'configured_submission_confirmed',
  'interview_debrief_recorded',
]);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

const POLICY = Object.freeze({
  saved: Object.freeze({
    actionCode: 'review-pursuit',
    businessDays: 1,
    title: 'Review pursuit decision',
    description: 'Review the pursuit decision; run the existing application plan for the job/profile.',
  }),
  researching: Object.freeze({
    actionCode: 'complete-research',
    businessDays: 2,
    title: 'Complete application research',
    description: 'Complete source-backed company/people research; no external contact.',
  }),
  'materials-ready': Object.freeze({
    actionCode: 'complete-submission',
    businessDays: 1,
    title: 'Complete application submission',
    description: 'Run `jobos applications plan --job <job> --profile <profile> --json` and complete the live-form/packet step it reports.',
  }),
  'recruiter-screen': Object.freeze({
    actionCode: 'prepare-recruiter-screen',
    businessDays: 1,
    title: 'Prepare recruiter screen',
    description: 'Prepare the recruiter screen and confirm the next recorded stage.',
  }),
  interview: Object.freeze({
    actionCode: 'prepare-interview',
    businessDays: 1,
    title: 'Prepare interview',
    description: 'Run existing interview prep for the application.',
  }),
  offer: Object.freeze({
    actionCode: 'review-offer',
    businessDays: 1,
    title: 'Review offer',
    description: 'Review the offer and record the next status; do not add negotiation semantics.',
  }),
});

function lifecycleError(code, message) {
  return Object.assign(new Error(message), { code, type: 'validation' });
}

function normalizeRfc3339(value, field) {
  if (typeof value !== 'string' || !RFC3339.test(value) || Number.isNaN(Date.parse(value))) {
    throw lifecycleError('invalid_lifecycle_timestamp', `${field} must be an RFC3339 timestamp.`);
  }
  return new Date(value).toISOString();
}

function addUtcBusinessDays(value, count) {
  const date = new Date(value);
  let remaining = count;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return date.toISOString();
}

function validateTrigger(applicationId, trigger) {
  if (!trigger || trigger.schema !== LIFECYCLE_EVENT_INPUT_SCHEMA) {
    throw lifecycleError('invalid_lifecycle_event_schema', `trigger.schema must equal ${LIFECYCLE_EVENT_INPUT_SCHEMA}.`);
  }
  for (const field of ['profileId', 'applicationId', 'eventId', 'eventType', 'occurredAt']) {
    if (typeof trigger[field] !== 'string' || !trigger[field].trim()) {
      throw lifecycleError('invalid_lifecycle_event', `trigger.${field} is required.`);
    }
  }
  if (trigger.applicationId !== applicationId) {
    throw lifecycleError('lifecycle_application_mismatch', 'trigger.applicationId does not match applicationId.');
  }
  if (!ACCEPTED_EVENT_TYPES.has(trigger.eventType)) {
    throw lifecycleError('unsupported_lifecycle_event', `Unsupported lifecycle event type: ${trigger.eventType}.`);
  }
  if (trigger.eventType === 'interview_debrief_recorded' && trigger.stage !== 'interview') {
    throw lifecycleError('invalid_interview_debrief_stage', 'Interview debrief events require stage=interview.');
  }
  return { ...trigger, occurredAt: normalizeRfc3339(trigger.occurredAt, 'trigger.occurredAt') };
}

function stageAnchor(s, application) {
  const observed = one(s, `SELECT id,created_at FROM status_changes
    WHERE application_id=? AND to_status=?
    ORDER BY created_at DESC,id DESC LIMIT 1`, [application.id, application.status]);
  return observed
    ? { id: observed.id, occurredAt: observed.created_at }
    : { id: application.id, occurredAt: application.created_at };
}

function earliestSubmissionEvidence(s, applicationId) {
  return one(s, `SELECT id,type,submitted_at,recorded_at FROM application_receipts
    WHERE application_id=? AND type IN ('user_attestation','adapter_receipt')
    ORDER BY submitted_at,recorded_at,id LIMIT 1`, [applicationId]);
}

function persistedInterviewDebrief(s, applicationId, anchor) {
  return one(s, `SELECT * FROM tasks
    WHERE application_id=? AND action_kind='application_next_action'
      AND stage='interview' AND action_code='follow-up-after-interview'
      AND source_event_type='interview_debrief_recorded' AND waiting_since>=?
    ORDER BY waiting_since,id LIMIT 1`, [applicationId, anchor.occurredAt]);
}

function actionPolicy(s, application, trigger, anchor) {
  if (application.status === 'interview') {
    const persisted = persistedInterviewDebrief(s, application.id, anchor);
    if (trigger.eventType === 'interview_debrief_recorded' || persisted) {
      const debrief = trigger.eventType === 'interview_debrief_recorded'
        ? { id: trigger.eventId, occurredAt: trigger.occurredAt }
        : { id: persisted.source_event_id, occurredAt: persisted.waiting_since };
      return {
        actionCode: 'follow-up-after-interview',
        businessDays: 1,
        title: 'Complete post-interview follow-up',
        description: 'Complete the post-interview employer follow-up/next-stage update; W06 stores no story content.',
        policyAnchorId: debrief.id,
        policyAnchorAt: debrief.occurredAt,
        sourceEventType: 'interview_debrief_recorded',
        sourceEventId: debrief.id,
        sourceEventAt: debrief.occurredAt,
      };
    }
  }

  if (application.status === 'applied') {
    const evidence = earliestSubmissionEvidence(s, application.id);
    if (evidence) {
      return {
        actionCode: 'employer-follow-up',
        businessDays: 5,
        title: 'Follow up on employer application',
        description: 'Follow up on the employer application; this is separate from outreach threads and JobOS must never auto-send it.',
        policyAnchorId: evidence.id,
        policyAnchorAt: evidence.submitted_at,
        sourceEventType: evidence.type === 'adapter_receipt' ? 'configured_submission_confirmed' : 'submission_attested',
        sourceEventId: evidence.id,
        sourceEventAt: evidence.submitted_at,
      };
    }
    return {
      actionCode: 'record-submission-evidence',
      businessDays: 1,
      title: 'Record submission evidence',
      description: 'Bind the existing applied claim to an exact packet/receipt or correct the status; do not infer submission.',
      policyAnchorId: anchor.id,
      policyAnchorAt: anchor.occurredAt,
      sourceEventType: trigger.eventType,
      sourceEventId: trigger.eventId,
      sourceEventAt: trigger.occurredAt,
    };
  }

  const policy = POLICY[application.status];
  if (!policy) return null;
  return {
    ...policy,
    policyAnchorId: anchor.id,
    policyAnchorAt: anchor.occurredAt,
    sourceEventType: trigger.eventType,
    sourceEventId: trigger.eventId,
    sourceEventAt: trigger.occurredAt,
  };
}

function sameValue(left, right) {
  return (left ?? null) === (right ?? null);
}

function updateTargetIfChanged(s, current, values) {
  const columns = Object.keys(values);
  if (columns.every(column => sameValue(current[column], values[column]))) return;
  run(s, `UPDATE tasks SET ${columns.map(column => `${column}=?`).join(',')} WHERE id=?`, [
    ...columns.map(column => values[column]),
    current.id,
  ]);
}

export function reconcileApplicationNextAction(s, { applicationId, trigger, nowDate = new Date() }) {
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) {
    throw lifecycleError('invalid_lifecycle_now', 'nowDate must be a valid Date.');
  }
  const event = validateTrigger(applicationId, trigger);
  const application = one(s, 'SELECT * FROM applications WHERE id=?', [applicationId]);
  if (!application) throw lifecycleError('unknown_application', `Unknown application: ${applicationId}.`);
  if (application.profile_id !== event.profileId) {
    throw lifecycleError('lifecycle_profile_mismatch', 'Lifecycle event profile does not own the application.');
  }

  const openRows = all(s, `SELECT * FROM tasks
    WHERE application_id=? AND action_kind='application_next_action' AND status='open'
    ORDER BY id`, [applicationId]);
  if (TERMINAL_APPLICATION_STATUSES.has(application.status) || !ACTIVE_APPLICATION_STATUSES.has(application.status)) {
    for (const row of openRows) run(s, "UPDATE tasks SET status='superseded' WHERE id=?", [row.id]);
    return null;
  }

  const anchor = stageAnchor(s, application);
  const policy = actionPolicy(s, application, event, anchor);
  if (!policy) return null;
  const taskId = id('task', `${application.id}:${anchor.id}:${policy.actionCode}:${policy.policyAnchorId}`);
  const existingTarget = one(s, 'SELECT * FROM tasks WHERE id=?', [taskId]);
  const existingManual = openRows.find(row => row.stage === application.status
    && row.action_code === policy.actionCode
    && row.schedule_source === 'manual');
  const preserveManual = existingManual && existingManual.id === taskId;
  const policyDueAt = addUtcBusinessDays(policy.policyAnchorAt, policy.businessDays);
  const dueAt = preserveManual ? existingManual.due_at : policyDueAt;
  const urgentAt = preserveManual ? existingManual.urgent_at : addUtcBusinessDays(dueAt, 2);

  for (const row of openRows) {
    if (row.id !== taskId) run(s, "UPDATE tasks SET status='superseded' WHERE id=?", [row.id]);
  }

  const values = {
    job_id: application.job_id,
    application_id: application.id,
    title: policy.title,
    description: policy.description,
    type: 'followup',
    due_at: dueAt,
    priority: 'normal',
    status: 'open',
    created_by: 'lifecycle',
    updated_at: policy.sourceEventAt,
    profile_id: application.profile_id,
    action_kind: 'application_next_action',
    action_code: policy.actionCode,
    stage: application.status,
    source_event_type: policy.sourceEventType,
    source_event_id: policy.sourceEventId,
    waiting_since: policy.policyAnchorAt,
    policy_due_at: policyDueAt,
    urgent_at: urgentAt,
    schedule_source: preserveManual ? 'manual' : 'policy',
    manual_rescheduled_at: preserveManual ? existingManual.manual_rescheduled_at : null,
    manual_reschedule_reason: preserveManual ? existingManual.manual_reschedule_reason : '',
  };

  if (existingTarget) {
    updateTargetIfChanged(s, existingTarget, values);
  } else {
    run(s, `INSERT INTO tasks (
      id,job_id,application_id,title,description,type,due_at,priority,status,created_by,
      created_at,updated_at,profile_id,action_kind,action_code,stage,source_event_type,
      source_event_id,waiting_since,policy_due_at,urgent_at,schedule_source,
      manual_rescheduled_at,manual_reschedule_reason
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      taskId,
      values.job_id,
      values.application_id,
      values.title,
      values.description,
      values.type,
      values.due_at,
      values.priority,
      values.status,
      values.created_by,
      policy.sourceEventAt,
      values.updated_at,
      values.profile_id,
      values.action_kind,
      values.action_code,
      values.stage,
      values.source_event_type,
      values.source_event_id,
      values.waiting_since,
      values.policy_due_at,
      values.urgent_at,
      values.schedule_source,
      values.manual_rescheduled_at,
      values.manual_reschedule_reason,
    ]);
  }
  return one(s, 'SELECT * FROM tasks WHERE id=?', [taskId]);
}

export function lifecycleTaskView(row, { nowDate = new Date() } = {}) {
  if (!row) return null;
  if (row.action_kind !== 'application_next_action') {
    throw lifecycleError('not_lifecycle_action', 'Expected an application_next_action task.');
  }
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) {
    throw lifecycleError('invalid_lifecycle_now', 'nowDate must be a valid Date.');
  }
  const nowMs = nowDate.getTime();
  const dueMs = Date.parse(row.due_at);
  const urgentMs = Date.parse(row.urgent_at);
  const state = nowMs < dueMs ? 'waiting' : nowMs < urgentMs ? 'overdue' : 'urgent';
  return {
    schema: LIFECYCLE_NEXT_ACTION_SCHEMA,
    id: row.id,
    profileId: row.profile_id,
    jobId: row.job_id,
    applicationId: row.application_id,
    stage: row.stage,
    actionCode: row.action_code,
    title: row.title,
    description: row.description,
    dueAt: row.due_at,
    policyDueAt: row.policy_due_at,
    urgentAt: row.urgent_at,
    state,
    scheduleSource: row.schedule_source,
    manualRescheduledAt: row.manual_rescheduled_at,
    manualRescheduleReason: row.manual_reschedule_reason,
    sourceEvent: {
      type: row.source_event_type,
      id: row.source_event_id,
      occurredAt: row.updated_at,
    },
  };
}

export function rescheduleApplicationNextAction(s, {
  taskId,
  profileId,
  dueAt,
  reason,
  actor = 'user',
  source = 'cli',
  nowDate = new Date(),
}) {
  const normalizedDueAt = normalizeRfc3339(dueAt, 'dueAt');
  const normalizedReason = String(reason || '').trim();
  if (!normalizedReason) throw lifecycleError('lifecycle_reschedule_reason_required', 'A non-empty reschedule reason is required.');
  if (typeof profileId !== 'string' || !profileId.trim()) throw lifecycleError('lifecycle_profile_required', 'profileId is required.');
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) throw lifecycleError('invalid_lifecycle_now', 'nowDate must be a valid Date.');
  const rescheduledAt = nowDate.toISOString();

  return guardedWrite(s, () => {
    const row = one(s, `SELECT * FROM tasks WHERE id=? AND profile_id=?
      AND action_kind='application_next_action' AND status='open'`, [taskId, profileId]);
    if (!row) throw lifecycleError('lifecycle_action_not_reschedulable', 'Open lifecycle action not found for this profile.');
    const urgentAt = addUtcBusinessDays(normalizedDueAt, 2);
    run(s, `UPDATE tasks SET due_at=?,urgent_at=?,schedule_source='manual',
      manual_rescheduled_at=?,manual_reschedule_reason=? WHERE id=?`, [
      normalizedDueAt,
      urgentAt,
      rescheduledAt,
      normalizedReason,
      taskId,
    ]);
    const auditEvent = recordAudit(s, 'application.next_action_rescheduled', 'task', taskId, {
      jobId: row.job_id,
      profileId,
      applicationId: row.application_id,
      dueAt: normalizedDueAt,
      policyDueAt: row.policy_due_at,
      reason: normalizedReason,
      actor,
      source,
    });
    queuePostCommit(s, () => {
      projectAudit(s, auditEvent);
      if (row.job_id) syncJob(s, row.job_id);
    });
    return lifecycleTaskView(one(s, 'SELECT * FROM tasks WHERE id=?', [taskId]), { nowDate });
  });
}

export function backfillLifecycleActions(s) {
  if (one(s, "SELECT value FROM meta WHERE key='migration_w06_lifecycle_backfill'")) return [];
  const affectedJobIds = new Set();
  const applications = all(s, 'SELECT * FROM applications ORDER BY id');
  for (const application of applications) {
    const legacyId = id('task', `${application.id}:review-next-action`);
    const substitutes = all(s, `SELECT * FROM tasks WHERE application_id=? AND (
      id=? OR (title LIKE 'Review stale application:%' AND created_by LIKE 'automation%')
    ) ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END,created_at,id`, [application.id, legacyId, legacyId]);
    const manualLegacy = substitutes.find(row => row.id === legacyId
      && row.due_at
      && Date.parse(row.updated_at) > Date.parse(row.created_at));
    for (const substitute of substitutes) {
      if (substitute.status !== 'superseded') {
        run(s, "UPDATE tasks SET status='superseded' WHERE id=?", [substitute.id]);
        affectedJobIds.add(application.job_id);
      }
    }
    const latestStatus = one(s, `SELECT id,created_at FROM status_changes
      WHERE application_id=? AND to_status=? ORDER BY created_at DESC,id DESC LIMIT 1`, [application.id, application.status]);
    const trigger = {
      schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
      profileId: application.profile_id,
      applicationId: application.id,
      eventId: latestStatus?.id || application.id,
      eventType: latestStatus ? 'application_status_changed' : 'application_created',
      occurredAt: latestStatus?.created_at || application.created_at,
    };
    const action = reconcileApplicationNextAction(s, {
      applicationId: application.id,
      trigger,
      nowDate: new Date(trigger.occurredAt),
    });
    if (action) {
      affectedJobIds.add(application.job_id);
      if (manualLegacy) {
        run(s, `UPDATE tasks SET due_at=?,urgent_at=?,schedule_source='manual',
          manual_rescheduled_at=?,manual_reschedule_reason=? WHERE id=?`, [
          manualLegacy.due_at,
          addUtcBusinessDays(manualLegacy.due_at, 2),
          manualLegacy.updated_at,
          'Migrated manually edited legacy due date.',
          action.id,
        ]);
      }
    }
  }
  run(s, "INSERT INTO meta (key,value) VALUES ('migration_w06_lifecycle_backfill','1')");
  return [...affectedJobIds].sort();
}

function receiptObservationType(type) {
  if (type === 'user_attestation') return 'submission_attested';
  if (type === 'adapter_receipt') return 'configured_submission_confirmed';
  return 'receipt_confirmed';
}

export function listLifecycleObservations(s, { profileId, sinceDays = 30, nowDate = new Date() }) {
  if (typeof profileId !== 'string' || !profileId.trim()) throw lifecycleError('lifecycle_profile_required', 'profileId is required.');
  const profile = one(s, 'SELECT id FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw lifecycleError('unknown_profile', `Unknown profile: ${profileId}.`);
  if (!Number.isInteger(sinceDays) || sinceDays < 0) throw lifecycleError('invalid_since_days', 'sinceDays must be a non-negative integer.');
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) throw lifecycleError('invalid_lifecycle_now', 'nowDate must be a valid Date.');
  const end = nowDate.toISOString();
  const start = new Date(nowDate.getTime() - sinceDays * 86_400_000).toISOString();
  const statusObservations = all(s, `SELECT * FROM status_changes
    WHERE profile_id=? AND created_at>=? AND created_at<=?`, [profileId, start, end]).map(row => ({
    schema: LIFECYCLE_OBSERVATION_SCHEMA,
    id: row.id,
    profileId: row.profile_id,
    applicationId: row.application_id,
    jobId: row.job_id,
    type: 'application_status_changed',
    occurredAt: row.created_at,
    actor: row.actor,
    source: row.source,
    sourceEventId: row.source_event_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
  }));
  const receiptObservations = all(s, `SELECT application_receipts.*,applications.profile_id,jobs.id AS job_id
    FROM application_receipts
    JOIN applications ON applications.id=application_receipts.application_id
    JOIN jobs ON jobs.id=applications.job_id
    WHERE applications.profile_id=?`, [profileId]).map(row => ({
    schema: LIFECYCLE_OBSERVATION_SCHEMA,
    id: row.id,
    profileId: row.profile_id,
    applicationId: row.application_id,
    jobId: row.job_id,
    type: receiptObservationType(row.type),
    occurredAt: row.type === 'imported_evidence' ? row.recorded_at : row.submitted_at,
    actor: row.submission_actor,
    source: row.source,
    sourceEventId: row.id,
  })).filter(observation => observation.occurredAt >= start && observation.occurredAt <= end);
  const observations = [...statusObservations, ...receiptObservations]
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  return {
    schema: LIFECYCLE_OBSERVATION_LIST_SCHEMA,
    observationSchema: LIFECYCLE_OBSERVATION_SCHEMA,
    profileId,
    period: { start, end, sinceDays },
    observations,
  };
}
