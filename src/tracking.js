import { one, all, run, save, audit } from './db.js';
import { id, now, validStatuses } from './utils.js';
import { syncJob } from './jobs.js';
import {
  LIFECYCLE_EVENT_INPUT_SCHEMA,
  lifecycleTaskView,
  reconcileApplicationNextAction,
} from './lifecycle.js';
export { validStatuses } from './utils.js';
export const stageOrder = Array.from(validStatuses);

export function applicationId(jobId, profileId) { return id('app', `${jobId}:${profileId}`); }

export function recordStatusChange(s, {
  applicationId,
  jobId,
  profileId,
  fromStatus,
  toStatus,
  note,
  at,
  actor,
  source,
  sourceEventId,
}) {
  const sid = id('status', `${applicationId}:${fromStatus || 'new'}:${toStatus}:${at}`);
  run(s, `INSERT INTO status_changes
    (id,application_id,job_id,profile_id,from_status,to_status,note,created_at,actor,source,source_event_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    sid,
    applicationId,
    jobId,
    profileId,
    fromStatus || null,
    toStatus,
    note || '',
    at,
    actor,
    source,
    sourceEventId,
  ]);
  return sid;
}

function mutationTime(value) {
  const occurredAt = value instanceof Date ? value.toISOString() : String(value);
  if (Number.isNaN(Date.parse(occurredAt))) throw Error(`Invalid application event time: ${occurredAt}`);
  return new Date(occurredAt).toISOString();
}

function applicationMutationResult(s, application, at) {
  const action = one(s, `SELECT * FROM tasks WHERE application_id=?
    AND action_kind='application_next_action' AND status='open'`, [application.id]);
  return {
    ...application,
    nextAction: action ? lifecycleTaskView(action, { nowDate: new Date(at) }) : null,
    researchRecommendation: recommendResearch(s, {
      jobId: application.job_id,
      profileId: application.profile_id,
      status: application.status,
    }),
  };
}

function reconcileApplicationMutation(s, application, eventId, eventType, occurredAt) {
  return reconcileApplicationNextAction(s, {
    applicationId: application.id,
    trigger: {
      schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
      profileId: application.profile_id,
      applicationId: application.id,
      eventId,
      eventType,
      occurredAt,
    },
    nowDate: new Date(occurredAt),
  });
}

export function appCreate(s, jid, status, notes = '', {
  persist = true,
  at = now(),
  actor = 'user',
  source = 'domain',
  sourceEventId = null,
} = {}) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jid]);
  if (!job) throw Error(`Unknown job: ${jid}`);
  const occurredAt = mutationTime(at);
  const aid = applicationId(jid, job.profile_id);
  const existing = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  if (existing) {
    if (existing.status !== status) {
      const statusChangeId = recordStatusChange(s, {
        applicationId: aid,
        jobId: jid,
        profileId: job.profile_id,
        fromStatus: existing.status,
        toStatus: status,
        note: notes || existing.notes,
        at: occurredAt,
        actor,
        source,
        sourceEventId,
      });
      run(s, 'UPDATE applications SET status=?,notes=?,updated_at=? WHERE id=?', [status, notes || existing.notes, occurredAt, aid]);
      audit(s, 'application.status_changed', 'application', aid, {
        jobId: jid,
        profileId: job.profile_id,
        status,
        fromStatus: existing.status,
        toStatus: status,
        receiptBound: false,
      }, 'none');
      const application = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
      reconcileApplicationMutation(s, application, statusChangeId, 'application_status_changed', occurredAt);
      syncJob(s, jid);
      if (persist) save(s);
    } else if (notes) {
      run(s, 'UPDATE applications SET notes=?,updated_at=? WHERE id=?', [notes, occurredAt, aid]);
      const auditEvent = audit(s, 'application.notes_updated', 'application', aid, {
        jobId: jid,
        profileId: job.profile_id,
        status,
        notes,
      }, 'none');
      const application = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
      reconcileApplicationMutation(s, application, auditEvent.id, 'application_notes_updated', auditEvent.createdAt);
      syncJob(s, jid);
      if (persist) save(s);
    }
    return applicationMutationResult(s, one(s, 'SELECT * FROM applications WHERE id=?', [aid]), occurredAt);
  }

  run(s, `INSERT INTO applications
    (id,job_id,profile_id,status,notes,confirmation_url,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [aid, jid, job.profile_id, status, notes, '', occurredAt, occurredAt]);
  const statusChangeId = recordStatusChange(s, {
    applicationId: aid,
    jobId: jid,
    profileId: job.profile_id,
    fromStatus: null,
    toStatus: status,
    note: notes,
    at: occurredAt,
    actor,
    source,
    sourceEventId,
  });
  audit(s, 'application.created', 'application', aid, {
    jobId: jid,
    profileId: job.profile_id,
    status,
    toStatus: status,
  }, 'none');
  const application = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  reconcileApplicationMutation(s, application, statusChangeId, 'application_created', occurredAt);
  syncJob(s, jid);
  if (persist) save(s);
  return applicationMutationResult(s, application, occurredAt);
}

export function appUpdate(s, aid, status, notes = null, {
  persist = true,
  at = now(),
  actor = 'user',
  source = 'domain',
  sourceEventId = null,
} = {}) {
  if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
  const existing = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
  if (!existing) throw Error(`Unknown application: ${aid}`);
  const occurredAt = mutationTime(at);
  if (existing.status !== status) {
    const noteOmitted = notes === null;
    const statusChangeId = recordStatusChange(s, {
      applicationId: aid,
      jobId: existing.job_id,
      profileId: existing.profile_id,
      fromStatus: existing.status,
      toStatus: status,
      note: noteOmitted ? '' : (notes || ''),
      at: occurredAt,
      actor,
      source,
      sourceEventId,
    });
    run(s, 'UPDATE applications SET status=?,notes=?,updated_at=? WHERE id=?', [
      status,
      noteOmitted ? existing.notes : notes,
      occurredAt,
      aid,
    ]);
    audit(s, 'application.status_changed', 'application', aid, {
      jobId: existing.job_id,
      profileId: existing.profile_id,
      status,
      fromStatus: existing.status,
      toStatus: status,
      receiptBound: false,
    }, 'none');
    const application = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
    reconcileApplicationMutation(s, application, statusChangeId, 'application_status_changed', occurredAt);
    syncJob(s, existing.job_id);
    if (persist) save(s);
  } else if (notes !== null) {
    run(s, 'UPDATE applications SET notes=?,updated_at=? WHERE id=?', [notes, occurredAt, aid]);
    const auditEvent = audit(s, 'application.notes_updated', 'application', aid, {
      jobId: existing.job_id,
      profileId: existing.profile_id,
      status,
      notes,
    }, 'none');
    const application = one(s, 'SELECT * FROM applications WHERE id=?', [aid]);
    reconcileApplicationMutation(s, application, auditEvent.id, 'application_notes_updated', auditEvent.createdAt);
    syncJob(s, existing.job_id);
    if (persist) save(s);
  }
  return applicationMutationResult(s, one(s, 'SELECT * FROM applications WHERE id=?', [aid]), occurredAt);
}

function taskQueryFilters({ type = null, createdBy = null } = {}) {
  const clauses = ['status="open"'];
  const params = [];
  if (type) {
    clauses.push('type=?');
    params.push(type);
  }
  if (createdBy) {
    clauses.push('created_by=?');
    params.push(createdBy);
  }
  return { clauses, params };
}

/** All open tasks, including future and undated inbox items. */
export function openTasks(s, filters = {}) {
  const { clauses, params } = taskQueryFilters(filters);
  return all(s, `SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY due_at IS NULL,due_at,created_at`, params);
}

/** Open tasks whose non-null due time has passed. */
export function due(s, { at = now(), ...filters } = {}) {
  const dueAt = at instanceof Date ? at.toISOString() : String(at);
  const { clauses, params } = taskQueryFilters(filters);
  clauses.push('due_at IS NOT NULL', 'due_at<=?');
  params.push(dueAt);
  return all(s, `SELECT * FROM tasks WHERE ${clauses.join(' AND ')} ORDER BY due_at,created_at`, params);
}

export function _writeApp(s, jobId, profileId, status, notes = '', {
  receiptBound = false,
  skipIfExists = false,
  persist = true,
  at = now(),
  actor = 'system',
  source = 'domain',
  sourceEventId = null,
} = {}) {
  const appId = applicationId(jobId, profileId);
  const existing = one(s, 'SELECT * FROM applications WHERE id=?', [appId]);
  if (skipIfExists && existing) return applicationMutationResult(s, existing, mutationTime(at));
  return appCreate(s, jobId, status, notes, { persist, at, actor, source, sourceEventId });
}

export function recommendResearch(s, { jobId, profileId, status }) {
  if (!status) return null;
  if (['saved', 'researching', 'materials-ready', 'applied'].includes(status)) {
    return { nextAction: `jobos research people --scope job --job ${jobId} --profile ${profileId} --depth standard`, label: 'Run people research for this job to discover network paths and stakeholders.' };
  }
  if (status === 'recruiter-screen') {
    const recruiter = one(s, `SELECT person_id FROM stakeholders WHERE job_id=? AND person_id IS NOT NULL AND person_id!='' AND lower(role) LIKE '%recruit%' ORDER BY updated_at DESC LIMIT 1`, [jobId]);
    if (recruiter?.person_id) {
      return { nextAction: `jobos research people --scope person --person ${recruiter.person_id} --profile ${profileId} --depth standard`, label: 'Refresh source-backed research for the known recruiter.' };
    }
    return { nextAction: `jobos research people --scope job --job ${jobId} --profile ${profileId} --depth standard`, label: 'Refresh job people research for the recruiter-screen stage.' };
  }
  if (status === 'interview') {
    return { nextAction: `jobos research people --scope job --job ${jobId} --profile ${profileId} --depth standard`, label: 'Refresh people research before the interview.' };
  }
  return null;
}
