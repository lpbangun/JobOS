import path from 'node:path';
import { all, guardedWrite, one, projectAudit, queuePostCommit, recordAudit, run } from './db.js';
import { hash, id, now, parseJson, tokenize } from './utils.js';
import { createArtifact } from './artifacts.js';
import { inventoryForJob } from './requirements.js';
import { writeYaml } from './workspace.js';
import {
  LIFECYCLE_EVENT_INPUT_SCHEMA,
  lifecycleTaskView,
  reconcileApplicationNextAction,
} from './lifecycle.js';
import { syncJob } from './jobs.js';

export const INTERVIEW_STORY_SCHEMA = 'jobos.interview-story.v1';
export const INTERVIEW_STORY_LIST_SCHEMA = 'jobos.interview-story-list.v1';
export const INTERVIEW_QUESTION_SCHEMA = 'jobos.interview-question.v1';
export const INTERVIEW_PACK_SCHEMA = 'jobos.interview-pack.v1';
export const INTERVIEW_DEBRIEF_SCHEMA = 'jobos.interview-debrief.v1';
export const INTERVIEW_DEBRIEF_LIST_SCHEMA = 'jobos.interview-debrief-list.v1';
export const INTERVIEW_OBSERVATION_SCHEMA = 'jobos.interview-observation.v1';
export const INTERVIEW_OBSERVATION_LIST_SCHEMA = 'jobos.interview-observation-list.v1';

export const INTERVIEW_AUDIENCES = Object.freeze([
  'recruiter',
  'hiring_manager',
  'peer_panel',
  'executive',
  'unknown',
]);
export const INTERVIEW_STAGES = Object.freeze([
  'recruiter-screen',
  'interview',
  'hiring-manager',
  'onsite',
  'final',
  'offer',
]);
export const INTERVIEW_STORY_STATES = Object.freeze([
  'draft_needs_verification',
  'verified',
  'retired',
]);
export const INTERVIEW_STORY_CHANGE_KINDS = Object.freeze(['create', 'edit', 'verify', 'retire']);
export const INTERVIEW_STORY_CONTENT_FIELDS = Object.freeze([
  'title',
  'situation',
  'task',
  'action',
  'result',
  'reflection',
]);
export const INTERVIEW_STORY_FACTUAL_FIELDS = Object.freeze(['situation', 'task', 'action', 'result']);
export const INTERVIEW_QUESTION_SOURCE_KINDS = Object.freeze([
  'user_provided',
  'recruiter_provided',
  'interviewer_provided',
]);
export const INTERVIEW_QUESTION_ORIGINS = Object.freeze(['sourced', 'inferred']);
export const INTERVIEW_COVERAGE_STATUSES = Object.freeze(['covered', 'gap']);
export const INTERVIEW_OUTCOME_TYPES = Object.freeze([
  'advanced',
  'no_change',
  'rejected',
  'withdrawn',
  'unknown',
]);
export const INTERVIEW_PROOF_GAP_TYPES = Object.freeze([
  'missing_proof',
  'weak_metric',
  'unsupported_detail',
  'needs_verification',
  'other',
]);
export const INTERVIEW_DEFAULT_AUDIENCE_BY_STAGE = Object.freeze({
  'recruiter-screen': 'recruiter',
  interview: 'unknown',
  'hiring-manager': 'hiring_manager',
  onsite: 'peer_panel',
  final: 'executive',
  offer: 'unknown',
});

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function interviewFieldCode(field) {
  return String(field || 'value')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase() || 'value';
}

export class InterviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InterviewError';
    this.type = 'validation';
    this.code = code;
    this.details = details;
  }
}

export function requireInterviewText(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    const name = interviewFieldCode(field);
    throw new InterviewError(`interview_${name}_required`, `${field} is required.`);
  }
  return text;
}

export function normalizeInterviewTimestamp(value, field) {
  const text = requireInterviewText(value, field);
  const milliseconds = Date.parse(text);
  if (!RFC3339.test(text) || !Number.isFinite(milliseconds)) {
    const name = interviewFieldCode(field);
    throw new InterviewError(
      `interview_${name}_invalid`,
      `${field} must be an RFC3339 timestamp.`,
      { value: text },
    );
  }
  return new Date(milliseconds).toISOString();
}

export function normalizeInterviewEnum(value, field, allowed) {
  const text = requireInterviewText(value, field).toLowerCase();
  if (!Array.isArray(allowed) || !allowed.includes(text)) {
    const name = interviewFieldCode(field);
    throw new InterviewError(
      `interview_${name}_invalid`,
      `Unsupported ${field}: ${text}.`,
      { allowed: Array.isArray(allowed) ? [...allowed] : [] },
    );
  }
  return text;
}

export function normalizeInterviewJson(value, field, shape) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      const name = interviewFieldCode(field);
      throw new InterviewError(`interview_${name}_json_invalid`, `${field} must be valid JSON.`);
    }
  }
  const valid = shape === 'array'
    ? Array.isArray(parsed)
    : shape === 'object'
      ? Boolean(parsed) && typeof parsed === 'object' && !Array.isArray(parsed)
      : false;
  if (!valid) {
    const name = interviewFieldCode(field);
    throw new InterviewError(
      `interview_${name}_shape_invalid`,
      `${field} must be a JSON ${shape}.`,
      { expected: shape },
    );
  }
  return parsed;
}

export function audienceForInterviewStage(stage, audience = null) {
  const normalizedStage = normalizeInterviewEnum(stage, 'stage', INTERVIEW_STAGES);
  return audience === null || audience === undefined || String(audience).trim() === ''
    ? INTERVIEW_DEFAULT_AUDIENCE_BY_STAGE[normalizedStage]
    : normalizeInterviewEnum(audience, 'audience', INTERVIEW_AUDIENCES);
}

export function resolveInterviewOwnership(s, input = {}) {
  const profileId = requireInterviewText(input.profileId, 'profileId');
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) {
    throw new InterviewError('interview_profile_unknown', `Unknown profile: ${profileId}.`);
  }

  const applicationId = input.applicationId
    ? requireInterviewText(input.applicationId, 'applicationId')
    : null;
  const application = applicationId
    ? one(s, 'SELECT * FROM applications WHERE id=?', [applicationId])
    : null;
  if (applicationId && !application) {
    throw new InterviewError(
      'interview_application_unknown',
      `Unknown application: ${applicationId}.`,
    );
  }

  const jobId = input.jobId
    ? requireInterviewText(input.jobId, 'jobId')
    : application?.job_id || null;
  const job = jobId ? one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]) : null;
  if (jobId && !job) {
    throw new InterviewError('interview_job_unknown', `Unknown job: ${jobId}.`);
  }
  if (job && job.profile_id !== profileId) {
    throw new InterviewError(
      'interview_job_profile_mismatch',
      `Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}.`,
    );
  }
  if (application && application.profile_id !== profileId) {
    throw new InterviewError(
      'interview_application_profile_mismatch',
      `Application ${applicationId} belongs to profile ${application.profile_id}, not ${profileId}.`,
    );
  }
  if (application && application.job_id !== jobId) {
    throw new InterviewError(
      'interview_application_job_mismatch',
      `Application ${applicationId} belongs to job ${application.job_id}, not ${jobId}.`,
    );
  }

  const revisionId = input.storyRevisionId
    ? requireInterviewText(input.storyRevisionId, 'storyRevisionId')
    : null;
  const revision = revisionId
    ? one(s, 'SELECT * FROM interview_story_revisions WHERE id=?', [revisionId])
    : null;
  if (revisionId && !revision) {
    throw new InterviewError(
      'interview_story_revision_unknown',
      `Unknown interview story revision: ${revisionId}.`,
    );
  }
  const storyId = input.storyId
    ? requireInterviewText(input.storyId, 'storyId')
    : revision?.story_id || null;
  const story = storyId ? one(s, 'SELECT * FROM interview_stories WHERE id=?', [storyId]) : null;
  if (storyId && !story) {
    throw new InterviewError('interview_story_unknown', `Unknown interview story: ${storyId}.`);
  }
  if (story && story.profile_id !== profileId) {
    throw new InterviewError(
      'interview_story_profile_mismatch',
      `Interview story ${storyId} belongs to profile ${story.profile_id}, not ${profileId}.`,
    );
  }
  if (revision && (revision.story_id !== storyId || revision.profile_id !== profileId)) {
    throw new InterviewError(
      'interview_story_revision_mismatch',
      `Interview story revision ${revisionId} does not belong to story ${storyId} and profile ${profileId}.`,
    );
  }

  const proofPointIds = input.proofPointIds ?? [];
  if (!Array.isArray(proofPointIds)) {
    throw new InterviewError(
      'interview_proof_point_ids_shape_invalid',
      'proofPointIds must be an array.',
      { expected: 'array' },
    );
  }
  const proofPoints = [];
  for (const value of proofPointIds) {
    const proofPointId = requireInterviewText(value, 'proofPointId');
    const proofPoint = one(s, 'SELECT * FROM proof_points WHERE id=?', [proofPointId]);
    if (!proofPoint) {
      throw new InterviewError(
        'interview_proof_point_unknown',
        `Unknown proof point: ${proofPointId}.`,
      );
    }
    if (proofPoint.profile_id !== profileId) {
      throw new InterviewError(
        'interview_proof_point_profile_mismatch',
        `Proof point ${proofPointId} belongs to profile ${proofPoint.profile_id}, not ${profileId}.`,
      );
    }
    proofPoints.push(proofPoint);
  }

  return { profile, job, application, story, storyRevision: revision, proofPoints };
}

function storyText(value) {
  return String(value ?? '').trim();
}

function normalizeStorySource(value, field = 'source') {
  return requireInterviewText(value, field).toLowerCase();
}

function normalizeStoryTags(value, field, allowed = null) {
  if (value === undefined || value === null) return [];
  const items = normalizeInterviewJson(value, field, 'array');
  const normalized = items.map(item => allowed
    ? normalizeInterviewEnum(item, field, allowed)
    : requireInterviewText(item, field));
  return [...new Set(normalized)];
}

function normalizeConfirmedFields(value) {
  const fields = normalizeStoryTags(value ?? [], 'confirmedFields');
  for (const field of fields) {
    if (!INTERVIEW_STORY_CONTENT_FIELDS.includes(field)) {
      throw new InterviewError(
        'interview_confirmed_field_invalid',
        `Unsupported confirmed story field: ${field}.`,
        { allowed: [...INTERVIEW_STORY_CONTENT_FIELDS] },
      );
    }
  }
  const selected = new Set(fields);
  return INTERVIEW_STORY_CONTENT_FIELDS.filter(field => selected.has(field));
}

function normalizeFieldProvenance(value, actor, source) {
  const provenance = value === undefined || value === null
    ? {}
    : normalizeInterviewJson(value, 'fieldProvenance', 'object');
  return Object.fromEntries(INTERVIEW_STORY_CONTENT_FIELDS.map(field => {
    const entry = provenance[field];
    if (entry !== undefined && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
      throw new InterviewError(
        'interview_field_provenance_invalid',
        `fieldProvenance.${field} must be an object.`,
        { field },
      );
    }
    const origin = normalizeInterviewEnum(
      entry?.origin || (actor === 'user' ? 'user' : 'agent'),
      `fieldProvenance.${field}.origin`,
      ['user', 'agent'],
    );
    return [field, {
      origin,
      actor: requireInterviewText(entry?.actor || actor, `fieldProvenance.${field}.actor`),
      source: normalizeStorySource(entry?.source || source, `fieldProvenance.${field}.source`),
      sourceRef: entry?.sourceRef === undefined || entry?.sourceRef === null
        ? null
        : storyText(entry.sourceRef) || null,
    }];
  }));
}

function normalizeFieldEvidence(value) {
  const evidence = value === undefined || value === null
    ? {}
    : normalizeInterviewJson(value, 'fieldEvidence', 'object');
  return Object.fromEntries(INTERVIEW_STORY_FACTUAL_FIELDS.map(field => {
    const ids = evidence[field] === undefined
      ? []
      : normalizeInterviewJson(evidence[field], `fieldEvidence.${field}`, 'array')
        .map(proofPointId => requireInterviewText(proofPointId, 'proofPointId'));
    return [field, [...new Set(ids)]];
  }));
}

function normalizeStoryDraft(input) {
  const actor = requireInterviewText(input.actor, 'actor');
  const source = normalizeStorySource(input.source);
  const confirmedFields = normalizeConfirmedFields(input.confirmedFields);
  if (
    confirmedFields.length
    && (actor !== 'user' || !['cli', 'tui'].includes(source))
  ) {
    throw new InterviewError(
      'interview_story_confirmation_source_untrusted',
      'Only an explicit human CLI or TUI action may confirm agent-authored story fields.',
      { allowed: ['cli', 'tui'] },
    );
  }
  const content = Object.fromEntries(
    INTERVIEW_STORY_CONTENT_FIELDS.map(field => [field, storyText(input[field])]),
  );
  return {
    ...content,
    competencyTags: normalizeStoryTags(input.competencyTags, 'competencyTags'),
    audienceTags: normalizeStoryTags(input.audienceTags, 'audienceTags', INTERVIEW_AUDIENCES),
    fieldProvenance: normalizeFieldProvenance(input.fieldProvenance, actor, source),
    confirmedFields,
    fieldEvidence: normalizeFieldEvidence(input.fieldEvidence),
    actor,
    source,
  };
}

function evidenceProofPointIds(fieldEvidence) {
  return [...new Set(INTERVIEW_STORY_FACTUAL_FIELDS.flatMap(field => (
    fieldEvidence[field].map(evidence => (
      typeof evidence === 'string' ? evidence : evidence.proofPointId
    ))
  )))];
}

function proofSnapshot(proof) {
  return {
    id: proof.id,
    summary: proof.summary,
    evidence: proof.evidence,
    skills: parseJson(proof.skills_json, []),
    metrics: parseJson(proof.metrics_json, []),
    source: proof.source,
    status: proof.status,
    verificationStatus: proof.verification_status,
    sourceResumeEntryId: proof.source_resume_entry_id || null,
    supersedesProofPointId: proof.supersedes_proof_point_id || null,
    updatedAt: proof.updated_at,
  };
}

function snapshotFieldEvidence(fieldEvidence, proofPoints) {
  const proofs = new Map(proofPoints.map(proof => [proof.id, proof]));
  return Object.fromEntries(INTERVIEW_STORY_FACTUAL_FIELDS.map(field => [
    field,
    fieldEvidence[field].map(proofPointId => ({
      proofPointId,
      proofSnapshot: proofSnapshot(proofs.get(proofPointId)),
    })),
  ]));
}

function storyContentHash(payload) {
  const fieldEvidence = Object.fromEntries(INTERVIEW_STORY_FACTUAL_FIELDS.map(field => [
    field,
    payload.fieldEvidence[field].map(evidence => ({
      proofPointId: evidence.proofPointId,
      proofSnapshot: evidence.proofSnapshot,
    })),
  ]));
  return hash(JSON.stringify({
    title: payload.title,
    situation: payload.situation,
    task: payload.task,
    action: payload.action,
    result: payload.result,
    reflection: payload.reflection,
    competencyTags: payload.competencyTags,
    audienceTags: payload.audienceTags,
    fieldProvenance: payload.fieldProvenance,
    fieldEvidence,
  }));
}

function fieldEvidenceForRevision(s, revisionId) {
  const rows = all(s, `SELECT field_name,proof_point_id,position,proof_snapshot_json
    FROM interview_story_field_evidence
    WHERE revision_id=?
    ORDER BY field_name,position,proof_point_id`, [revisionId]);
  const byField = Object.fromEntries(INTERVIEW_STORY_FACTUAL_FIELDS.map(field => [field, []]));
  for (const row of rows) {
    byField[row.field_name].push({
      proofPointId: row.proof_point_id,
      position: Number(row.position),
      proofSnapshot: parseJson(row.proof_snapshot_json, {}),
    });
  }
  return byField;
}

function revisionPayload(s, row) {
  return {
    title: row.title,
    situation: row.situation,
    task: row.task,
    action: row.action,
    result: row.result,
    reflection: row.reflection,
    competencyTags: parseJson(row.competency_tags_json, []),
    audienceTags: parseJson(row.audience_tags_json, []),
    fieldProvenance: parseJson(row.field_provenance_json, {}),
    confirmedFields: parseJson(row.confirmed_fields_json, []),
    fieldEvidence: fieldEvidenceForRevision(s, row.id),
    actor: row.actor,
    source: row.source,
  };
}

function insertStoryRevision(s, {
  storyId,
  profileId,
  revision,
  state,
  changeKind,
  payload,
  supersedesRevisionId = null,
  changeReason = '',
  actor,
  source,
  createdAt,
  verifiedAt = null,
}) {
  const contentHash = storyContentHash(payload);
  const revisionId = id(
    'interview_story_revision',
    `${storyId}:${revision}:${state}:${contentHash}:${createdAt}`,
  );
  run(s, `INSERT INTO interview_story_revisions
    (id,story_id,profile_id,revision,state,change_kind,title,situation,task,action,result,reflection,
     competency_tags_json,audience_tags_json,field_provenance_json,confirmed_fields_json,content_hash,
     supersedes_revision_id,change_reason,actor,source,created_at,verified_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    revisionId,
    storyId,
    profileId,
    revision,
    state,
    changeKind,
    payload.title,
    payload.situation,
    payload.task,
    payload.action,
    payload.result,
    payload.reflection,
    JSON.stringify(payload.competencyTags),
    JSON.stringify(payload.audienceTags),
    JSON.stringify(payload.fieldProvenance),
    JSON.stringify(payload.confirmedFields),
    contentHash,
    supersedesRevisionId,
    changeReason,
    actor,
    source,
    createdAt,
    verifiedAt,
  ]);
  for (const field of INTERVIEW_STORY_FACTUAL_FIELDS) {
    payload.fieldEvidence[field].forEach((evidence, position) => {
      run(s, `INSERT INTO interview_story_field_evidence
        (revision_id,story_id,profile_id,field_name,proof_point_id,position,proof_snapshot_json,linked_at)
        VALUES (?,?,?,?,?,?,?,?)`, [
        revisionId,
        storyId,
        profileId,
        field,
        evidence.proofPointId,
        position,
        JSON.stringify(evidence.proofSnapshot),
        createdAt,
      ]);
    });
  }
  return one(s, 'SELECT * FROM interview_story_revisions WHERE id=?', [revisionId]);
}

function proofStates(s, proofPointIds) {
  if (!proofPointIds.length) return new Map();
  const rows = all(
    s,
    `SELECT * FROM proof_points WHERE id IN (${proofPointIds.map(() => '?').join(',')})`,
    proofPointIds,
  );
  return new Map(rows.map(row => [row.id, row]));
}

function proofBlocker(s, proof, field, proofPointId) {
  if (!proof) return { code: 'proof_missing', field, proofPointId };
  const common = {
    field,
    proofPointId,
    status: proof.status,
    verificationStatus: proof.verification_status,
  };
  if (proof.status === 'retired') {
    const superseded = Boolean(
      one(s, 'SELECT id FROM proof_points WHERE supersedes_proof_point_id=?', [proofPointId]),
    );
    return { code: superseded ? 'proof_superseded' : 'proof_retired', ...common };
  }
  if (proof.status !== 'active') return { code: 'proof_not_active', ...common };
  if (proof.verification_status === 'rejected') return { code: 'proof_rejected', ...common };
  if (proof.verification_status !== 'verified') return { code: 'proof_unverified', ...common };
  return null;
}

function verificationBlockers(s, row, fieldEvidence, confirmedFields = null) {
  const blockers = [];
  const confirmed = new Set(confirmedFields || parseJson(row.confirmed_fields_json, []));
  const provenance = parseJson(row.field_provenance_json, {});
  for (const field of INTERVIEW_STORY_CONTENT_FIELDS) {
    if (!storyText(row[field])) blockers.push({ code: 'required_field_empty', field });
    if (provenance[field]?.origin === 'agent' && !confirmed.has(field)) {
      blockers.push({ code: 'human_confirmation_missing', field });
    }
  }
  const proofPointIds = [...new Set(
    INTERVIEW_STORY_FACTUAL_FIELDS.flatMap(field => fieldEvidence[field].map(item => item.proofPointId)),
  )];
  const currentProofs = proofStates(s, proofPointIds);
  for (const field of INTERVIEW_STORY_FACTUAL_FIELDS) {
    if (!fieldEvidence[field].length) {
      blockers.push({ code: 'factual_field_evidence_missing', field });
      continue;
    }
    for (const evidence of fieldEvidence[field]) {
      const blocker = proofBlocker(s, currentProofs.get(evidence.proofPointId), field, evidence.proofPointId);
      if (blocker) blockers.push(blocker);
    }
  }
  return blockers;
}

function staleProofPointIds(blockers) {
  const stale = new Set(blockers
    .filter(blocker => blocker.proofPointId)
    .map(blocker => blocker.proofPointId));
  return [...stale].sort();
}

function revisionProjection(s, row, { compact = false } = {}) {
  const projection = {
    id: row.id,
    storyId: row.story_id,
    profileId: row.profile_id,
    revision: Number(row.revision),
    state: row.state,
    changeKind: row.change_kind,
    competencyTags: parseJson(row.competency_tags_json, []),
    audienceTags: parseJson(row.audience_tags_json, []),
    contentHash: row.content_hash,
    supersedesRevisionId: row.supersedes_revision_id || null,
    changeReason: row.change_reason || '',
    actor: row.actor,
    source: row.source,
    createdAt: row.created_at,
    verifiedAt: row.verified_at || null,
  };
  if (!compact) {
    Object.assign(projection, {
      title: row.title,
      situation: row.situation,
      task: row.task,
      action: row.action,
      result: row.result,
      reflection: row.reflection,
      fieldProvenance: parseJson(row.field_provenance_json, {}),
      confirmedFields: parseJson(row.confirmed_fields_json, []),
      fieldEvidence: fieldEvidenceForRevision(s, row.id),
    });
  }
  return projection;
}

function storyProjection(s, story, { includeHistory = false, compact = false } = {}) {
  const revisions = all(
    s,
    'SELECT * FROM interview_story_revisions WHERE story_id=? AND profile_id=? ORDER BY revision,id',
    [story.id, story.profile_id],
  );
  const current = revisions.at(-1);
  const activeVerified = current?.state === 'retired'
    ? null
    : revisions.findLast(revision => revision.state === 'verified') || null;
  const activeVerifiedBlockers = activeVerified
    ? verificationBlockers(
      s,
      activeVerified,
      fieldEvidenceForRevision(s, activeVerified.id),
    )
    : [];
  const blockers = current?.state === 'draft_needs_verification'
    ? verificationBlockers(s, current, fieldEvidenceForRevision(s, current.id))
    : activeVerifiedBlockers;
  const staleIds = staleProofPointIds(activeVerifiedBlockers);
  const eligibility = current?.state === 'retired'
    ? 'retired'
    : !activeVerified
      ? 'draft_only'
      : staleIds.length
        ? 'proof_stale'
        : 'eligible';
  const projection = {
    schema: INTERVIEW_STORY_SCHEMA,
    version: 1,
    id: story.id,
    profileId: story.profile_id,
    createdAt: story.created_at,
    currentRevision: revisionProjection(s, current, { compact }),
    activeVerifiedRevision: activeVerified
      ? revisionProjection(s, activeVerified, { compact })
      : null,
    eligibility,
    staleProofPointIds: staleIds,
    verificationBlockers: blockers,
  };
  if (includeHistory) {
    projection.history = revisions.map(revision => revisionProjection(s, revision, { compact }));
  }
  return projection;
}

function storyListProjection(s, profileId, { includeHistory = false, compact = true } = {}) {
  const rows = all(
    s,
    'SELECT * FROM interview_stories WHERE profile_id=? ORDER BY created_at,id',
    [profileId],
  );
  const stories = rows.map(row => {
    const projected = storyProjection(s, row, { includeHistory, compact });
    if (!compact) return projected;
    return {
      schema: projected.schema,
      version: projected.version,
      id: projected.id,
      profileId: projected.profileId,
      createdAt: projected.createdAt,
      currentRevisionId: projected.currentRevision.id,
      currentRevision: projected.currentRevision.revision,
      currentState: projected.currentRevision.state,
      activeVerifiedRevisionId: projected.activeVerifiedRevision?.id || null,
      activeVerifiedRevision: projected.activeVerifiedRevision?.revision || null,
      competencyTags: projected.currentRevision.competencyTags,
      audienceTags: projected.currentRevision.audienceTags,
      eligibility: projected.eligibility,
      staleProofPointIds: projected.staleProofPointIds,
      verificationBlockers: projected.verificationBlockers,
      ...(includeHistory ? { history: projected.history } : {}),
    };
  });
  return {
    schema: INTERVIEW_STORY_LIST_SCHEMA,
    version: 1,
    profileId,
    stories,
  };
}

function syncInterviewStories(s, profileId) {
  writeYaml(
    path.join(s.p.profiles, profileId, 'interviews', 'stories.yaml'),
    {
      ...storyListProjection(s, profileId, { includeHistory: true, compact: false }),
      policy: {
        appendOnlyRevisions: true,
        canonicalStore: 'sqlite',
        proofEligibility: 'evaluated_at_projection_time',
      },
    },
  );
}

function queueStoryProjections(s, profileId, event) {
  queuePostCommit(s, () => syncInterviewStories(s, profileId));
  queuePostCommit(s, () => projectAudit(s, event));
}

function latestStoryRevision(s, storyId, profileId) {
  return one(s, `SELECT * FROM interview_story_revisions
    WHERE story_id=? AND profile_id=?
    ORDER BY revision DESC,id DESC LIMIT 1`, [storyId, profileId]);
}

function recordStoryMutation(s, action, storyId, profileId, revision) {
  const event = recordAudit(s, action, 'interview_story', storyId, {
    schema: INTERVIEW_STORY_SCHEMA,
    profileId,
    storyId,
    revisionId: revision.id,
    revision: Number(revision.revision),
    state: revision.state,
    changeKind: revision.change_kind,
    supersedesRevisionId: revision.supersedes_revision_id || null,
    externalSideEffects: 'none',
  });
  queueStoryProjections(s, profileId, event);
}

export function createInterviewStory(s, input = {}) {
  return guardedWrite(s, () => {
    const draft = normalizeStoryDraft(input);
    const proofPointIds = evidenceProofPointIds(draft.fieldEvidence);
    const ownership = resolveInterviewOwnership(s, {
      profileId: input.profileId,
      proofPointIds,
    });
    const payload = {
      ...draft,
      fieldEvidence: snapshotFieldEvidence(draft.fieldEvidence, ownership.proofPoints),
    };
    const createdAt = now();
    const storyId = id(
      'interview_story',
      `${ownership.profile.id}:${storyContentHash(payload)}:${createdAt}`,
    );
    run(s, 'INSERT INTO interview_stories (id,profile_id,created_at) VALUES (?,?,?)', [
      storyId,
      ownership.profile.id,
      createdAt,
    ]);
    const revision = insertStoryRevision(s, {
      storyId,
      profileId: ownership.profile.id,
      revision: 1,
      state: 'draft_needs_verification',
      changeKind: 'create',
      payload,
      actor: draft.actor,
      source: draft.source,
      createdAt,
    });
    recordStoryMutation(
      s,
      'interview.story.created',
      storyId,
      ownership.profile.id,
      revision,
    );
    return storyProjection(
      s,
      one(s, 'SELECT * FROM interview_stories WHERE id=?', [storyId]),
      { includeHistory: true },
    );
  });
}

export function editInterviewStory(s, input = {}) {
  return guardedWrite(s, () => {
    const draft = normalizeStoryDraft(input);
    const proofPointIds = evidenceProofPointIds(draft.fieldEvidence);
    const ownership = resolveInterviewOwnership(s, {
      profileId: input.profileId,
      storyId: input.storyId,
      proofPointIds,
    });
    const latest = latestStoryRevision(s, ownership.story.id, ownership.profile.id);
    if (latest.state === 'retired') {
      throw new InterviewError(
        'interview_story_retired',
        `Interview story ${ownership.story.id} is retired.`,
      );
    }
    const payload = {
      ...draft,
      fieldEvidence: snapshotFieldEvidence(draft.fieldEvidence, ownership.proofPoints),
    };
    const createdAt = now();
    const revision = insertStoryRevision(s, {
      storyId: ownership.story.id,
      profileId: ownership.profile.id,
      revision: Number(latest.revision) + 1,
      state: 'draft_needs_verification',
      changeKind: 'edit',
      payload,
      supersedesRevisionId: latest.id,
      actor: draft.actor,
      source: draft.source,
      createdAt,
    });
    recordStoryMutation(
      s,
      'interview.story.edited',
      ownership.story.id,
      ownership.profile.id,
      revision,
    );
    return storyProjection(s, ownership.story, { includeHistory: true });
  });
}

export function verifyInterviewStory(s, input = {}) {
  return guardedWrite(s, () => {
    const source = requireInterviewText(input.source, 'source').toLowerCase();
    if (!['cli', 'tui'].includes(source)) {
      throw new InterviewError(
        'interview_story_verification_source_untrusted',
        'Interview story verification requires trusted source cli or tui.',
        { allowed: ['cli', 'tui'] },
      );
    }
    const actor = requireInterviewText(input.actor, 'actor');
    const ownership = resolveInterviewOwnership(s, {
      profileId: input.profileId,
      storyId: input.storyId,
    });
    const revisionNumber = Number(input.revision);
    if (!Number.isInteger(revisionNumber) || revisionNumber < 1) {
      throw new InterviewError(
        'interview_story_revision_invalid',
        'revision must be a positive integer.',
      );
    }
    const selected = one(s, `SELECT * FROM interview_story_revisions
      WHERE story_id=? AND profile_id=? AND revision=?`, [
      ownership.story.id,
      ownership.profile.id,
      revisionNumber,
    ]);
    if (!selected) {
      throw new InterviewError(
        'interview_story_revision_unknown',
        `Unknown revision ${revisionNumber} for interview story ${ownership.story.id}.`,
      );
    }
    const latest = latestStoryRevision(s, ownership.story.id, ownership.profile.id);
    if (selected.id !== latest.id) {
      throw new InterviewError(
        'interview_story_revision_not_latest',
        `Revision ${revisionNumber} is not the latest revision for interview story ${ownership.story.id}.`,
        { latestRevision: Number(latest.revision) },
      );
    }
    if (selected.state !== 'draft_needs_verification') {
      throw new InterviewError(
        'interview_story_revision_not_draft',
        `Revision ${revisionNumber} is not a draft needing verification.`,
        { state: selected.state },
      );
    }
    const selectedPayload = revisionPayload(s, selected);
    resolveInterviewOwnership(s, {
      profileId: ownership.profile.id,
      storyId: ownership.story.id,
      storyRevisionId: selected.id,
      proofPointIds: evidenceProofPointIds(selectedPayload.fieldEvidence),
    });
    const confirmed = new Set(selectedPayload.confirmedFields);
    for (const field of normalizeConfirmedFields(input.confirmedFields)) confirmed.add(field);
    selectedPayload.confirmedFields = INTERVIEW_STORY_CONTENT_FIELDS.filter(field => confirmed.has(field));
    const blockers = verificationBlockers(
      s,
      selected,
      selectedPayload.fieldEvidence,
      selectedPayload.confirmedFields,
    );
    if (blockers.length) {
      throw new InterviewError(
        'interview_story_verification_blocked',
        'Interview story revision cannot be verified.',
        { storyId: ownership.story.id, revision: revisionNumber, blockers },
      );
    }
    const createdAt = now();
    const revision = insertStoryRevision(s, {
      storyId: ownership.story.id,
      profileId: ownership.profile.id,
      revision: Number(latest.revision) + 1,
      state: 'verified',
      changeKind: 'verify',
      payload: selectedPayload,
      supersedesRevisionId: selected.id,
      actor,
      source,
      createdAt,
      verifiedAt: createdAt,
    });
    recordStoryMutation(
      s,
      'interview.story.verified',
      ownership.story.id,
      ownership.profile.id,
      revision,
    );
    return storyProjection(s, ownership.story, { includeHistory: true });
  });
}

export function retireInterviewStory(s, input = {}) {
  return guardedWrite(s, () => {
    const reason = requireInterviewText(input.reason, 'reason');
    const actor = requireInterviewText(input.actor, 'actor');
    const source = normalizeStorySource(input.source);
    if (!['cli', 'tui'].includes(source)) {
      throw new InterviewError(
        'interview_story_retirement_source_untrusted',
        'Interview story retirement requires trusted source cli or tui.',
        { allowed: ['cli', 'tui'] },
      );
    }
    const ownership = resolveInterviewOwnership(s, {
      profileId: input.profileId,
      storyId: input.storyId,
    });
    const latest = latestStoryRevision(s, ownership.story.id, ownership.profile.id);
    if (latest.state === 'retired') {
      throw new InterviewError(
        'interview_story_retired',
        `Interview story ${ownership.story.id} is already retired.`,
      );
    }
    const payload = revisionPayload(s, latest);
    const createdAt = now();
    const revision = insertStoryRevision(s, {
      storyId: ownership.story.id,
      profileId: ownership.profile.id,
      revision: Number(latest.revision) + 1,
      state: 'retired',
      changeKind: 'retire',
      payload,
      supersedesRevisionId: latest.id,
      changeReason: reason,
      actor,
      source,
      createdAt,
    });
    recordStoryMutation(
      s,
      'interview.story.retired',
      ownership.story.id,
      ownership.profile.id,
      revision,
    );
    return storyProjection(s, ownership.story, { includeHistory: true });
  });
}

export function getInterviewStory(s, input = {}) {
  const ownership = resolveInterviewOwnership(s, {
    profileId: input.profileId,
    storyId: input.storyId,
  });
  return storyProjection(s, ownership.story, {
    includeHistory: Boolean(input.includeHistory),
  });
}

export function listInterviewStories(s, input = {}) {
  const ownership = resolveInterviewOwnership(s, { profileId: input.profileId });
  return storyListProjection(s, ownership.profile.id, {
    includeHistory: Boolean(input.includeHistory),
    compact: true,
  });
}

const TRUSTED_INTERVIEW_QUESTION_SOURCES = Object.freeze(['cli', 'tui']);

function normalizeQuestionText(value) {
  return requireInterviewText(value, 'questionText')
    .toLowerCase()
    .replace(/[^a-z0-9+#]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function questionSuccessors(rows) {
  const successors = new Map();
  for (const row of rows) {
    if (row.supersedes_source_id) successors.set(row.supersedes_source_id, row.id);
  }
  return successors;
}

function questionRoots(rows) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const roots = new Map();
  function rootId(row) {
    if (roots.has(row.id)) return roots.get(row.id);
    const visited = new Set([row.id]);
    let current = row;
    while (current.supersedes_source_id) {
      if (visited.has(current.supersedes_source_id)) {
        throw new InterviewError(
          'interview_question_lineage_invalid',
          `Interview question source ${row.id} has cyclic correction lineage.`,
        );
      }
      visited.add(current.supersedes_source_id);
      const parent = byId.get(current.supersedes_source_id);
      if (!parent) {
        throw new InterviewError(
          'interview_question_lineage_invalid',
          `Interview question source ${row.id} has a missing correction parent.`,
        );
      }
      current = parent;
    }
    for (const sourceId of visited) roots.set(sourceId, current.id);
    return current.id;
  }
  for (const row of rows) rootId(row);
  return roots;
}

function questionSourceProjection(row, successors, roots) {
  return {
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    id: row.id,
    rootSourceId: roots.get(row.id),
    profileId: row.profile_id,
    jobId: row.job_id,
    applicationId: row.application_id,
    stage: row.interview_stage,
    audience: row.audience,
    questionText: row.question_text,
    normalizedText: row.normalized_text,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref,
    actor: row.actor,
    source: row.source,
    createdAt: row.created_at,
    supersedesSourceId: row.supersedes_source_id || null,
    supersededBySourceId: successors.get(row.id) || null,
    correctionReason: row.correction_reason || '',
    current: !successors.has(row.id),
  };
}

function questionSourceRows(s, profileId) {
  return all(s, `SELECT * FROM interview_question_sources
    WHERE profile_id=?
    ORDER BY created_at,id`, [profileId]);
}

function questionSourceListProjection(s, profileId, filters = {}) {
  const rows = questionSourceRows(s, profileId);
  const successors = questionSuccessors(rows);
  const roots = questionRoots(rows);
  const selected = rows.filter(row => (
    (!filters.jobId || row.job_id === filters.jobId)
    && (!filters.applicationId || row.application_id === filters.applicationId)
    && (!filters.stage || row.interview_stage === filters.stage)
    && (!filters.audience || row.audience === filters.audience)
  ));
  const sources = selected.map(row => questionSourceProjection(row, successors, roots));
  return {
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    profileId,
    sources,
    currentSources: sources.filter(source => source.current),
  };
}

function syncInterviewQuestionSources(s, profileId) {
  writeYaml(
    path.join(s.p.profiles, profileId, 'interviews', 'question-sources.yaml'),
    {
      schema: INTERVIEW_QUESTION_SCHEMA,
      version: 1,
      profileId,
      policy: {
        appendOnly: true,
        corrections: 'reasoned_latest_only_branchless_chain',
        currentResolution: 'unique_chain_tip',
        canonicalStore: 'sqlite',
      },
      ...questionSourceListProjection(s, profileId),
    },
  );
}

function interviewQuestionsForJobProjection(s, jobId) {
  const job = one(s, 'SELECT id,profile_id FROM jobs WHERE id=?', [jobId]);
  if (!job) {
    throw new InterviewError('interview_job_unknown', `Unknown job: ${jobId}.`);
  }
  const rows = all(s, `SELECT * FROM interview_question_sources
    WHERE profile_id=? AND job_id=?
    ORDER BY application_id,interview_stage,audience,created_at,id`, [job.profile_id, job.id]);
  const successors = questionSuccessors(rows);
  const roots = questionRoots(rows);
  const questions = rows
    .filter(row => !successors.has(row.id))
    .map(row => questionSourceProjection(row, successors, roots));
  return {
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    jobId: job.id,
    profileId: job.profile_id,
    policy: {
      canonicalStore: 'sqlite',
      currentOnly: true,
      stableKey: 'id',
    },
    questions,
  };
}

function syncInterviewQuestionsForJob(s, jobId) {
  writeYaml(
    path.join(s.p.jobs, jobId, 'interviews', 'questions.yaml'),
    interviewQuestionsForJobProjection(s, jobId),
  );
}

function sameQuestionSource(row, input) {
  return row.profile_id === input.profileId
    && row.job_id === input.jobId
    && row.application_id === input.applicationId
    && row.interview_stage === input.stage
    && row.audience === input.audience
    && row.question_text === input.questionText
    && row.normalized_text === input.normalizedText
    && row.source_kind === input.sourceKind
    && row.source_ref === input.sourceRef
    && row.actor === input.actor
    && row.source === input.source
    && (row.supersedes_source_id || null) === (input.supersedesSourceId || null)
    && (row.correction_reason || '') === (input.correctionReason || '');
}

function normalizedQuestionSourceInput(s, input) {
  const source = requireInterviewText(input.source, 'source').toLowerCase();
  if (!TRUSTED_INTERVIEW_QUESTION_SOURCES.includes(source)) {
    throw new InterviewError(
      'interview_question_source_untrusted',
      'Interview question sources can be written only by trusted CLI or TUI input.',
      { allowed: [...TRUSTED_INTERVIEW_QUESTION_SOURCES], source },
    );
  }
  const stage = normalizeInterviewEnum(input.stage, 'stage', INTERVIEW_STAGES);
  const audience = audienceForInterviewStage(stage, input.audience);
  const sourceKind = normalizeInterviewEnum(
    input.sourceKind,
    'sourceKind',
    INTERVIEW_QUESTION_SOURCE_KINDS,
  );
  const questionText = requireInterviewText(input.questionText, 'questionText');
  const sourceRef = String(input.sourceRef ?? '').trim();
  if (sourceKind !== 'user_provided' && !sourceRef) {
    throw new InterviewError(
      'interview_source_ref_required',
      `${sourceKind} questions require sourceRef.`,
    );
  }
  const actor = requireInterviewText(input.actor, 'actor');
  const ownership = resolveInterviewOwnership(s, {
    profileId: input.profileId,
    jobId: input.jobId,
    applicationId: input.applicationId,
  });
  const supersedesSourceId = input.supersedesSourceId
    ? requireInterviewText(input.supersedesSourceId, 'supersedesSourceId')
    : null;
  const correctionReason = supersedesSourceId
    ? requireInterviewText(input.correctionReason, 'correctionReason')
    : String(input.correctionReason ?? '').trim();
  if (!supersedesSourceId && correctionReason) {
    throw new InterviewError(
      'interview_question_correction_reason_invalid',
      'correctionReason is valid only for a correction.',
    );
  }
  return {
    profileId: ownership.profile.id,
    jobId: ownership.job.id,
    applicationId: ownership.application.id,
    stage,
    audience,
    questionText,
    normalizedText: normalizeQuestionText(questionText),
    sourceKind,
    sourceRef,
    actor,
    source,
    supersedesSourceId,
    correctionReason,
  };
}

function projectedQuestionSource(s, row, idempotent) {
  const rows = questionSourceRows(s, row.profile_id);
  return {
    ...questionSourceProjection(row, questionSuccessors(rows), questionRoots(rows)),
    idempotent,
  };
}

export function createInterviewQuestionSource(s, input = {}) {
  return guardedWrite(s, () => {
    const normalized = normalizedQuestionSourceInput(s, input);
    let root = null;
    if (normalized.sourceRef) {
      root = one(s, `SELECT * FROM interview_question_sources
        WHERE profile_id=? AND source_ref=? AND supersedes_source_id IS NULL`, [
        normalized.profileId,
        normalized.sourceRef,
      ]);
    }

    if (!normalized.supersedesSourceId) {
      if (root) {
        if (!sameQuestionSource(root, normalized)) {
          throw new InterviewError(
            'interview_question_reference_conflict',
            `Reference ${normalized.sourceRef} already identifies a different interview question source.`,
          );
        }
        return projectedQuestionSource(s, root, true);
      }
      const rootIdentity = normalized.sourceRef || normalized.normalizedText;
      const questionId = id(
        'interview_question',
        `${normalized.profileId}|${normalized.stage}|${normalized.sourceKind}|${rootIdentity}`,
      );
      const identityRow = one(s, 'SELECT * FROM interview_question_sources WHERE id=?', [questionId]);
      if (identityRow) {
        if (!sameQuestionSource(identityRow, normalized)) {
          throw new InterviewError(
            'interview_question_reference_conflict',
            'The deterministic interview question identity already has different content.',
          );
        }
        return projectedQuestionSource(s, identityRow, true);
      }
      const createdAt = now();
      run(s, `INSERT INTO interview_question_sources
        (id,profile_id,job_id,application_id,interview_stage,audience,question_text,normalized_text,
         source_kind,source_ref,actor,source,created_at,supersedes_source_id,correction_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        questionId,
        normalized.profileId,
        normalized.jobId,
        normalized.applicationId,
        normalized.stage,
        normalized.audience,
        normalized.questionText,
        normalized.normalizedText,
        normalized.sourceKind,
        normalized.sourceRef,
        normalized.actor,
        normalized.source,
        createdAt,
        null,
        '',
      ]);
      const event = recordAudit(
        s,
        'interview.question_source.created',
        'interview_question_source',
        questionId,
        {
          schema: INTERVIEW_QUESTION_SCHEMA,
          profileId: normalized.profileId,
          jobId: normalized.jobId,
          applicationId: normalized.applicationId,
          questionSourceId: questionId,
          rootSourceId: questionId,
          sourceKind: normalized.sourceKind,
          sourceRef: normalized.sourceRef,
          stage: normalized.stage,
          audience: normalized.audience,
          externalSideEffects: 'none',
        },
      );
      queuePostCommit(s, () => syncInterviewQuestionSources(s, normalized.profileId));
      queuePostCommit(s, () => syncInterviewQuestionsForJob(s, normalized.jobId));
      queuePostCommit(s, () => projectAudit(s, event));
      return projectedQuestionSource(
        s,
        one(s, 'SELECT * FROM interview_question_sources WHERE id=?', [questionId]),
        false,
      );
    }

    const superseded = one(
      s,
      'SELECT * FROM interview_question_sources WHERE id=?',
      [normalized.supersedesSourceId],
    );
    if (!superseded) {
      throw new InterviewError(
        'interview_question_supersedes_unknown',
        `Unknown superseded interview question source: ${normalized.supersedesSourceId}.`,
      );
    }
    if (
      superseded.profile_id !== normalized.profileId
      || superseded.job_id !== normalized.jobId
      || superseded.application_id !== normalized.applicationId
      || superseded.interview_stage !== normalized.stage
      || superseded.audience !== normalized.audience
      || superseded.source_kind !== normalized.sourceKind
      || superseded.source_ref !== normalized.sourceRef
    ) {
      throw new InterviewError(
        'interview_question_supersedes_mismatch',
        'Corrections must preserve profile, job, application, stage, audience, source kind, and source reference.',
      );
    }
    if (!normalized.sourceRef) {
      throw new InterviewError(
        'interview_question_correction_reference_required',
        'Interview question corrections require the root source reference.',
      );
    }
    const successor = one(
      s,
      'SELECT * FROM interview_question_sources WHERE supersedes_source_id=?',
      [superseded.id],
    );
    if (successor) {
      if (sameQuestionSource(successor, normalized)) {
        return projectedQuestionSource(s, successor, true);
      }
      throw new InterviewError(
        'interview_question_supersedes_not_current',
        `Interview question source ${superseded.id} is not the current correction tip.`,
      );
    }
    const allRows = questionSourceRows(s, normalized.profileId);
    const roots = questionRoots(allRows);
    const rootSourceId = roots.get(superseded.id);
    if (!root || root.id !== rootSourceId) {
      throw new InterviewError(
        'interview_question_lineage_invalid',
        `Interview question source ${superseded.id} is not in the referenced root chain.`,
      );
    }
    const correctionId = id(
      'interview_question',
      `${rootSourceId}|${superseded.id}|${normalized.normalizedText}|${normalized.correctionReason}`,
    );
    const createdAt = now();
    run(s, `INSERT INTO interview_question_sources
      (id,profile_id,job_id,application_id,interview_stage,audience,question_text,normalized_text,
       source_kind,source_ref,actor,source,created_at,supersedes_source_id,correction_reason)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      correctionId,
      normalized.profileId,
      normalized.jobId,
      normalized.applicationId,
      normalized.stage,
      normalized.audience,
      normalized.questionText,
      normalized.normalizedText,
      normalized.sourceKind,
      normalized.sourceRef,
      normalized.actor,
      normalized.source,
      createdAt,
      superseded.id,
      normalized.correctionReason,
    ]);
    const event = recordAudit(
      s,
      'interview.question_source.corrected',
      'interview_question_source',
      correctionId,
      {
        schema: INTERVIEW_QUESTION_SCHEMA,
        profileId: normalized.profileId,
        jobId: normalized.jobId,
        applicationId: normalized.applicationId,
        questionSourceId: correctionId,
        rootSourceId,
        supersedesSourceId: superseded.id,
        sourceKind: normalized.sourceKind,
        sourceRef: normalized.sourceRef,
        stage: normalized.stage,
        audience: normalized.audience,
        externalSideEffects: 'none',
      },
    );
    queuePostCommit(s, () => syncInterviewQuestionSources(s, normalized.profileId));
    queuePostCommit(s, () => syncInterviewQuestionsForJob(s, normalized.jobId));
    queuePostCommit(s, () => projectAudit(s, event));
    return projectedQuestionSource(
      s,
      one(s, 'SELECT * FROM interview_question_sources WHERE id=?', [correctionId]),
      false,
    );
  });
}

export function listInterviewQuestionSources(s, input = {}) {
  const ownership = resolveInterviewOwnership(s, {
    profileId: input.profileId,
    jobId: input.jobId,
    applicationId: input.applicationId,
  });
  const stage = input.stage === undefined || input.stage === null || String(input.stage).trim() === ''
    ? null
    : normalizeInterviewEnum(input.stage, 'stage', INTERVIEW_STAGES);
  const audience = input.audience === undefined
    || input.audience === null
    || String(input.audience).trim() === ''
    ? null
    : normalizeInterviewEnum(input.audience, 'audience', INTERVIEW_AUDIENCES);
  return questionSourceListProjection(s, ownership.profile.id, {
    jobId: ownership.job?.id || null,
    applicationId: ownership.application?.id || null,
    stage,
    audience,
  });
}

const INTERVIEW_MATCH_SYNONYMS = Object.freeze({
  collaborate: 'collaboration',
  collaborated: 'collaboration',
  collaborative: 'collaboration',
  deliver: 'delivery',
  delivered: 'delivery',
  delivering: 'delivery',
  lead: 'leadership',
  leaders: 'leadership',
  leading: 'leadership',
  led: 'leadership',
  learn: 'learning',
  learned: 'learning',
  manage: 'management',
  managed: 'management',
  manager: 'management',
  managing: 'management',
  own: 'ownership',
  owned: 'ownership',
  owns: 'ownership',
  scaled: 'scale',
  scaling: 'scale',
  scalability: 'scale',
  strategic: 'strategy',
});

function matchTokens(value) {
  const normalized = tokenize(value)
    .map(token => token.replace(/^\.+|\.+$/g, ''))
    .filter(Boolean)
    .map(token => INTERVIEW_MATCH_SYNONYMS[token] || token);
  return [...new Set(normalized)].sort();
}

function overlapTokens(left, right) {
  const rightSet = new Set(right);
  return left.filter(token => rightSet.has(token));
}

function scoreComponent(tokens, cap, weight) {
  const cappedCount = Math.min(cap, tokens.length);
  return {
    tokens,
    count: tokens.length,
    cappedCount,
    weight,
    score: weight * cappedCount,
  };
}

function matcherStoryCandidates(s, profileId) {
  const stories = all(
    s,
    'SELECT * FROM interview_stories WHERE profile_id=? ORDER BY id',
    [profileId],
  );
  const eligible = [];
  const excluded = [];
  for (const row of stories) {
    const projected = storyProjection(s, row, { compact: false });
    if (projected.eligibility !== 'eligible') {
      excluded.push({
        storyId: projected.id,
        reason: projected.eligibility,
        currentRevisionId: projected.currentRevision.id,
        activeVerifiedRevisionId: projected.activeVerifiedRevision?.id || null,
        staleProofPointIds: projected.staleProofPointIds,
        verificationBlockers: projected.verificationBlockers,
      });
      continue;
    }
    const revision = projected.activeVerifiedRevision;
    const linkedProofPointIds = [...new Set(
      INTERVIEW_STORY_FACTUAL_FIELDS.flatMap(field => (
        revision.fieldEvidence[field].map(evidence => evidence.proofPointId)
      )),
    )].sort();
    const currentProofs = proofStates(s, linkedProofPointIds);
    const linkedProofSkills = matchTokens(linkedProofPointIds.flatMap(proofPointId => (
      parseJson(currentProofs.get(proofPointId)?.skills_json, [])
    )).join(' '));
    const competencyTokens = matchTokens(revision.competencyTags.join(' '));
    const audienceTags = [...new Set(revision.audienceTags)].sort();
    const excludedFromOther = new Set([...competencyTokens, ...linkedProofSkills]);
    const otherStoryTokens = matchTokens(INTERVIEW_STORY_CONTENT_FIELDS
      .map(field => revision[field])
      .join(' '))
      .filter(token => !excludedFromOther.has(token));
    eligible.push({
      storyId: projected.id,
      storyRevisionId: revision.id,
      competencyTags: revision.competencyTags,
      audienceTags,
      linkedProofPointIds,
      competencyTokens,
      linkedProofSkills,
      otherStoryTokens,
    });
  }
  eligible.sort((left, right) => (
    left.storyId.localeCompare(right.storyId)
    || left.storyRevisionId.localeCompare(right.storyRevisionId)
  ));
  excluded.sort((left, right) => left.storyId.localeCompare(right.storyId));
  return { eligible, excluded };
}

function scoreStoryForQuestion(story, questionTokens, audience) {
  const competency = scoreComponent(
    overlapTokens(story.competencyTokens, questionTokens),
    2,
    4,
  );
  const proofSkills = scoreComponent(
    overlapTokens(story.linkedProofSkills, questionTokens),
    3,
    2,
  );
  const storyText = scoreComponent(
    overlapTokens(story.otherStoryTokens, questionTokens),
    4,
    1,
  );
  const audienceMatched = story.audienceTags.includes(audience);
  const scoreComponents = {
    competencyTagOverlap: competency,
    linkedProofSkillOverlap: proofSkills,
    otherStoryTokenOverlap: storyText,
    audienceTagMatch: {
      matched: audienceMatched,
      score: audienceMatched ? 2 : 0,
    },
  };
  const reasons = [];
  if (competency.score) reasons.push('competency_tag_overlap');
  if (proofSkills.score) reasons.push('linked_proof_skill_overlap');
  if (storyText.score) reasons.push('other_story_token_overlap');
  if (audienceMatched) reasons.push('audience_tag_match');
  return {
    storyId: story.storyId,
    storyRevisionId: story.storyRevisionId,
    score: competency.score
      + proofSkills.score
      + storyText.score
      + scoreComponents.audienceTagMatch.score,
    scoreComponents,
    reasons,
  };
}

export function matchStoriesToQuestions(s, input = {}) {
  const ownership = resolveInterviewOwnership(s, { profileId: input.profileId });
  const questions = normalizeInterviewJson(input.questions, 'questions', 'array');
  const maxStories = input.maxStories === undefined ? 3 : Number(input.maxStories);
  if (!Number.isInteger(maxStories) || maxStories < 1) {
    throw new InterviewError(
      'interview_max_stories_invalid',
      'maxStories must be a positive integer.',
    );
  }
  const candidates = matcherStoryCandidates(s, ownership.profile.id);
  const eligibleStories = candidates.eligible.map(story => ({
    storyId: story.storyId,
    storyRevisionId: story.storyRevisionId,
    competencyTags: story.competencyTags,
    audienceTags: story.audienceTags,
    linkedProofPointIds: story.linkedProofPointIds,
  }));
  const matches = questions.map((value, position) => {
    const question = normalizeInterviewJson(value, `questions[${position}]`, 'object');
    const questionId = requireInterviewText(question.id, `questions[${position}].id`);
    const text = requireInterviewText(question.text, `questions[${position}].text`);
    const audience = normalizeInterviewEnum(
      question.audience ?? input.audience ?? 'unknown',
      `questions[${position}].audience`,
      INTERVIEW_AUDIENCES,
    );
    const questionTokens = matchTokens(text);
    const scored = candidates.eligible
      .map(story => scoreStoryForQuestion(story, questionTokens, audience))
      .sort((left, right) => (
        right.score - left.score
        || left.storyId.localeCompare(right.storyId)
        || left.storyRevisionId.localeCompare(right.storyRevisionId)
      ));
    const qualifying = scored.filter(candidate => candidate.score >= 3);
    const bounded = qualifying.slice(0, maxStories);
    const gapReason = bounded.length
      ? null
      : candidates.eligible.length
        ? 'insufficient_overlap'
        : candidates.excluded.some(story => story.reason === 'proof_stale')
          ? 'proof_stale'
          : 'no_verified_story';
    return {
      questionId,
      position,
      text,
      normalizedText: normalizeQuestionText(text),
      audience,
      questionTokens,
      coverageStatus: bounded.length ? 'covered' : 'gap',
      gapReason,
      candidateCount: qualifying.length,
      candidates: scored,
      matches: bounded,
      selectedStory: bounded[0] || null,
      alternativeStories: bounded.slice(1),
    };
  });
  return {
    deterministic: true,
    profileId: ownership.profile.id,
    maxStories,
    eligibleStories,
    excludedStories: candidates.excluded,
    questions: matches,
  };
}

const INTERVIEW_QUESTION_TEMPLATES = Object.freeze({
  recruiter: Object.freeze([
    Object.freeze({
      id: 'recruiter.motivation',
      text: 'Why are you interested in this role and company now?',
    }),
    Object.freeze({
      id: 'recruiter.scope',
      text: 'Walk me through the scope and impact of your most relevant work.',
    }),
  ]),
  hiring_manager: Object.freeze([
    Object.freeze({
      id: 'manager.ownership',
      text: 'Tell me about a time you took ownership of a difficult delivery.',
    }),
    Object.freeze({
      id: 'manager.tradeoff',
      text: 'Tell me about a time you made a difficult product tradeoff.',
    }),
  ]),
  peer_panel: Object.freeze([
    Object.freeze({
      id: 'panel.collaboration',
      text: 'Tell me about a time you collaborated across functions to deliver a result.',
    }),
    Object.freeze({
      id: 'panel.conflict',
      text: 'Tell me about a time you resolved conflict with peers.',
    }),
  ]),
  executive: Object.freeze([
    Object.freeze({
      id: 'executive.strategy',
      text: 'Tell me about a time your work shaped strategy and business impact.',
    }),
    Object.freeze({
      id: 'executive.influence',
      text: 'Tell me about a time you influenced senior stakeholders without authority.',
    }),
  ]),
  unknown: Object.freeze([
    Object.freeze({
      id: 'unknown.impact',
      text: 'Tell me about a time you delivered meaningful impact.',
    }),
    Object.freeze({
      id: 'unknown.learning',
      text: 'Tell me about a time you learned and adapted after a setback.',
    }),
  ]),
});

function packOwnership(s, input) {
  const applicationId = requireInterviewText(input.applicationId, 'applicationId');
  const application = one(s, 'SELECT * FROM applications WHERE id=?', [applicationId]);
  if (!application) {
    throw new InterviewError(
      'interview_application_unknown',
      `Unknown application: ${applicationId}.`,
    );
  }
  return resolveInterviewOwnership(s, {
    profileId: input.profileId || application.profile_id,
    jobId: input.jobId || application.job_id,
    applicationId,
  });
}

function sourcedPackQuestions(s, ownership, stage, audience) {
  const listed = questionSourceListProjection(s, ownership.profile.id, {
    jobId: ownership.job.id,
    applicationId: ownership.application.id,
    stage,
    audience,
  });
  return listed.currentSources.map(source => ({
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    id: source.id,
    origin: 'sourced',
    text: source.questionText,
    normalizedText: source.normalizedText,
    stage,
    audience,
    source: {
      questionSourceId: source.id,
      rootSourceId: source.rootSourceId,
      sourceKind: source.sourceKind,
      sourceRef: source.sourceRef,
      actor: source.actor,
      source: source.source,
      createdAt: source.createdAt,
    },
  }));
}

function debriefAudienceCompatible(askedByAudience, packAudience) {
  return askedByAudience === packAudience
    || askedByAudience === 'unknown'
    || packAudience === 'unknown';
}

function debriefObservedPackQuestions(s, ownership, stage, audience) {
  const revisions = all(s, `SELECT
      d.id AS debrief_id,d.profile_id,d.job_id,d.application_id,
      d.interview_stage,d.audience AS debrief_audience,
      r.id AS revision_id,r.revision,r.occurred_at,r.recorded_at,r.actor,r.source,
      r.observed_questions_json
    FROM interview_debriefs d
    JOIN interview_debrief_revisions r ON r.debrief_id=d.id
    WHERE d.profile_id=?
      AND r.revision=(
        SELECT MAX(current.revision)
        FROM interview_debrief_revisions current
        WHERE current.debrief_id=d.id
      )
    ORDER BY r.occurred_at,d.id,r.revision,r.id`, [ownership.profile.id]);
  const questions = [];
  for (const revision of revisions) {
    const observed = parseJson(revision.observed_questions_json, []);
    if (!Array.isArray(observed)) continue;
    observed.forEach((question, questionIndex) => {
      if (!debriefAudienceCompatible(question.askedByAudience, audience)) return;
      questions.push({
        schema: INTERVIEW_QUESTION_SCHEMA,
        version: 1,
        id: question.id,
        origin: 'sourced',
        text: question.text,
        normalizedText: normalizeQuestionText(question.text),
        stage,
        audience,
        source: {
          sourceKind: 'debrief_observed',
          debriefId: revision.debrief_id,
          debriefRevisionId: revision.revision_id,
          debriefRevision: Number(revision.revision),
          questionIndex,
          profileId: revision.profile_id,
          jobId: revision.job_id,
          applicationId: revision.application_id,
          interviewStage: revision.interview_stage,
          debriefAudience: revision.debrief_audience,
          askedByAudience: question.askedByAudience,
          occurredAt: revision.occurred_at,
          recordedAt: revision.recorded_at,
          actor: revision.actor,
          source: revision.source,
        },
      });
    });
  }
  return questions;
}

function inferredPackQuestions(job, stage, audience) {
  const templates = INTERVIEW_QUESTION_TEMPLATES[audience].map(template => ({
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    id: template.id,
    origin: 'inferred',
    text: template.text,
    normalizedText: normalizeQuestionText(template.text),
    stage,
    audience,
    source: null,
    templateId: template.id,
  }));
  const inventory = inventoryForJob(job);
  const orderedRequirements = [...inventory.requirements].sort((left, right) => (
    (left.sourceLine ?? Number.MAX_SAFE_INTEGER) - (right.sourceLine ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id)
  ));
  return [
    ...templates,
    ...orderedRequirements.map(requirement => {
      const text = `Tell me about a specific example that demonstrates: ${requirement.sourceText}`;
      return {
        schema: INTERVIEW_QUESTION_SCHEMA,
        version: 1,
        id: `requirement.${requirement.id}.example`,
        origin: 'inferred',
        text,
        normalizedText: normalizeQuestionText(text),
        stage,
        audience,
        source: null,
        requirementId: requirement.id,
      };
    }),
  ];
}

export function questionsForInterview(s, input = {}) {
  const ownership = packOwnership(s, input);
  const stage = normalizeInterviewEnum(
    input.stage ?? 'interview',
    'stage',
    INTERVIEW_STAGES,
  );
  const audience = audienceForInterviewStage(stage, input.audience);
  const ordered = [
    ...sourcedPackQuestions(s, ownership, stage, audience),
    ...debriefObservedPackQuestions(s, ownership, stage, audience),
    ...inferredPackQuestions(ownership.job, stage, audience),
  ];
  const normalizedTexts = new Set();
  const questions = [];
  for (const question of ordered) {
    if (normalizedTexts.has(question.normalizedText)) continue;
    normalizedTexts.add(question.normalizedText);
    questions.push(question);
  }
  return {
    schema: INTERVIEW_QUESTION_SCHEMA,
    version: 1,
    deterministic: true,
    profileId: ownership.profile.id,
    jobId: ownership.job.id,
    applicationId: ownership.application.id,
    stage,
    audience,
    questions,
  };
}

function proofSnapshotsForRevision(revision) {
  const snapshots = new Map();
  for (const field of INTERVIEW_STORY_FACTUAL_FIELDS) {
    for (const evidence of revision.fieldEvidence[field]) {
      if (!snapshots.has(evidence.proofPointId)) {
        snapshots.set(evidence.proofPointId, evidence.proofSnapshot);
      }
    }
  }
  return [...snapshots.values()];
}

function packStoryMatch(s, match) {
  const story = one(s, 'SELECT * FROM interview_stories WHERE id=?', [match.storyId]);
  const revision = one(
    s,
    'SELECT * FROM interview_story_revisions WHERE id=? AND story_id=?',
    [match.storyRevisionId, match.storyId],
  );
  if (!story || !revision || revision.state !== 'verified') {
    throw new InterviewError(
      'interview_pack_story_invalid',
      `Interview pack match ${match.storyId}/${match.storyRevisionId} is not a verified story revision.`,
    );
  }
  const revisionSnapshot = revisionProjection(s, revision, { compact: false });
  return {
    storySnapshot: {
      id: story.id,
      profileId: story.profile_id,
      createdAt: story.created_at,
      revision: revisionSnapshot,
    },
    proofSnapshots: proofSnapshotsForRevision(revisionSnapshot),
  };
}

function alternativePackMatch(s, match) {
  const snapshots = packStoryMatch(s, match);
  return {
    storyId: match.storyId,
    storyRevisionId: match.storyRevisionId,
    matchScore: match.score,
    matchReasons: {
      codes: match.reasons,
      gapReason: null,
      scoreComponents: match.scoreComponents,
    },
    ...snapshots,
  };
}

function packWarnings(s, profileId, matched) {
  const warnings = matched.excludedStories.map(story => ({
    code: 'excluded_story',
    storyId: story.storyId,
    reason: story.reason,
    currentRevisionId: story.currentRevisionId,
    activeVerifiedRevisionId: story.activeVerifiedRevisionId,
    staleProofPointIds: story.staleProofPointIds,
    verificationBlockers: story.verificationBlockers,
  }));
  const eligibleProofIds = new Set(
    matched.eligibleStories.flatMap(story => story.linkedProofPointIds),
  );
  const proofs = all(
    s,
    'SELECT * FROM proof_points WHERE profile_id=? ORDER BY id',
    [profileId],
  );
  for (const proof of proofs) {
    if (proof.status !== 'active' || proof.verification_status !== 'verified') {
      warnings.push({
        code: 'excluded_proof',
        proofPointId: proof.id,
        reason: proof.status !== 'active'
          ? `status_${proof.status}`
          : `verification_${proof.verification_status}`,
        proofSnapshot: proofSnapshot(proof),
      });
    } else if (!eligibleProofIds.has(proof.id)) {
      warnings.push({
        code: 'proof_not_interview_story',
        proofPointId: proof.id,
        reason: 'proof_is_not_a_verified_interview_story_revision',
        proofSnapshot: proofSnapshot(proof),
      });
    }
  }
  return warnings;
}

export function buildInterviewPack(s, input = {}) {
  const questionSet = questionsForInterview(s, input);
  const matched = matchStoriesToQuestions(s, {
    profileId: questionSet.profileId,
    questions: questionSet.questions,
    audience: questionSet.audience,
    maxStories: 3,
  });
  const items = matched.questions.map((questionMatch, position) => {
    const question = questionSet.questions[position];
    const selected = questionMatch.selectedStory;
    const snapshots = selected
      ? packStoryMatch(s, selected)
      : { storySnapshot: null, proofSnapshots: [] };
    return {
      position,
      questionId: question.id,
      questionOrigin: question.origin,
      questionText: question.text,
      questionSource: question.source,
      stage: questionSet.stage,
      audience: questionSet.audience,
      coverageStatus: questionMatch.coverageStatus,
      gapReason: questionMatch.gapReason,
      storyId: selected?.storyId || null,
      storyRevisionId: selected?.storyRevisionId || null,
      matchScore: selected?.score || 0,
      matchReasons: {
        codes: selected?.reasons || [],
        gapReason: questionMatch.gapReason,
        scoreComponents: selected?.scoreComponents || null,
      },
      alternativeMatches: questionMatch.alternativeStories.map(match => (
        alternativePackMatch(s, match)
      )),
      ...snapshots,
    };
  });
  const coveredCount = items.filter(item => item.coverageStatus === 'covered').length;
  return {
    schema: INTERVIEW_PACK_SCHEMA,
    version: 1,
    deterministic: true,
    profileId: questionSet.profileId,
    jobId: questionSet.jobId,
    applicationId: questionSet.applicationId,
    stage: questionSet.stage,
    audience: questionSet.audience,
    questions: questionSet.questions,
    items,
    coveredCount,
    gapCount: items.length - coveredCount,
    eligibleStories: matched.eligibleStories,
    excludedStories: matched.excludedStories,
    warnings: packWarnings(s, questionSet.profileId, matched),
  };
}

const stageLabels = {
  'recruiter-screen': 'recruiter screen',
  interview: 'interview',
  'hiring-manager': 'hiring manager interview',
  onsite: 'onsite / panel interview',
  final: 'final interview',
  offer: 'offer conversation',
};

function parseProof(p) {
  return { ...p, skills: parseJson(p.skills_json, []), metrics: parseJson(p.metrics_json, []) };
}

function askQuestions(job, facts) {
  const factHooks = facts.slice(0, 3).map(fact => (
    `Given ${fact.claim}, how is the ${job.title} role expected to contribute over the next two quarters?`
  ));
  return [
    ...factHooks,
    `What are the most important problems this ${job.title} hire should solve in the first six months?`,
    'How does the team make tradeoffs between speed, user learning, and operational quality?',
    'What evidence would make you confident that the person in this role is succeeding?',
    'What should I understand about the team, stakeholders, or constraints that is not visible in the job posting?',
  ].slice(0, 8);
}

function refreshSummary(job, company, facts, stakeholders) {
  const factLines = facts.length
    ? facts.slice(0, 5).map(fact => `- ${fact.claim} (${fact.url})`).join('\n')
    : `- No source-backed company facts are stored yet; run \`research company --job ${job.id}\` before the interview.`;
  const people = stakeholders.length
    ? stakeholders.slice(0, 5).map(stakeholder => (
      `- ${stakeholder.name} — ${stakeholder.role}: ${stakeholder.summary}`
    )).join('\n')
    : '- No stakeholder research stored yet.';
  return `## Company / role refresh
- Role: ${job.title}
- Company: ${job.company}
- Location: ${job.location || 'not specified'}
- Application source: ${String(job.url || '').startsWith('jobos:text:') ? 'manual/text import' : job.url || 'not provided'}

### Stored company facts
${factLines}

### Stakeholder context
${people}`;
}

function renderPackStory(item) {
  if (item.coverageStatus === 'gap') {
    return `### ${item.position + 1}. [${item.questionOrigin}] ${item.questionText}
- Coverage: gap (${item.gapReason})
- Story: none; no ineligible or fabricated story was substituted.
- Match reasons: ${item.matchReasons.gapReason}`;
  }
  const revision = item.storySnapshot.revision;
  const proofIds = item.proofSnapshots.map(snapshot => snapshot.id);
  return `### ${item.position + 1}. [${item.questionOrigin}] ${item.questionText}
- Coverage: covered
- Story ID: \`${item.storyId}\`
- Revision ID: \`${item.storyRevisionId}\`
- Proof IDs: ${proofIds.map(proofId => `\`${proofId}\``).join(', ')}
- Match score: ${item.matchScore}
- Match reasons: ${item.matchReasons.codes.join(', ')}
- Alternatives: ${item.alternativeMatches.length
    ? item.alternativeMatches.map(match => (
      `\`${match.storyId}\`/\`${match.storyRevisionId}\` (${match.matchScore})`
    )).join(', ')
    : 'none'}
- STAR story:
  - Situation: ${revision.situation}
  - Task: ${revision.task}
  - Action: ${revision.action}
  - Result: ${revision.result}
  - Reflection: ${revision.reflection}`;
}

function renderPackWarnings(pack) {
  if (!pack.warnings.length) return '- None.';
  return pack.warnings.map(warning => {
    if (warning.code === 'excluded_story') {
      const stale = warning.staleProofPointIds.length
        ? `; stale proofs: ${warning.staleProofPointIds.join(', ')}`
        : '';
      return `- Excluded story warning: \`${warning.storyId}\` (${warning.reason}${stale}).`;
    }
    return `- Excluded proof warning: \`${warning.proofPointId}\` (${warning.reason}).`;
  }).join('\n');
}

function renderInterviewPack({ job, profile, application, pack, proofs, company, stakeholders }) {
  const facts = parseJson(company?.facts_json, []);
  const questionLines = pack.questions.map(question => (
    `- [${question.origin}] \`${question.id}\` — ${question.text}`
  )).join('\n');
  const storyLines = pack.items.map(renderPackStory).join('\n\n');
  const gapLines = pack.items
    .filter(item => item.coverageStatus === 'gap')
    .map(item => `- \`${item.questionId}\`: ${item.gapReason}`)
    .join('\n');
  const asks = askQuestions(job, facts).map(question => `- ${question}`).join('\n');
  const storedProofIds = proofs.length
    ? proofs.map(proof => `\`${proof.id}\``).join(', ')
    : 'none';
  return `# Interview prep packet — ${stageLabels[pack.stage]} for ${job.title} at ${job.company}

Generated: ${now()}

**Application:** ${application.id} (${application.status})
**Profile:** ${profile.name}
**Audience:** ${pack.audience}
**Approval status:** Draft for human review.

${refreshSummary(job, company, facts, stakeholders)}

## Likely interview questions
${questionLines}

## STAR story bank mapped to competencies
${storyLines || '- No interview questions were available.'}

- Stored proof IDs retained for compatibility and review, not promoted into stories: ${storedProofIds}

## Coverage gaps
${gapLines || '- None.'}

## Excluded story and proof warnings
${renderPackWarnings(pack)}

## Questions to ask the interviewer
${asks}

## Final prep checklist
- Rehearse only verified story revisions and their frozen proof snapshots.
- Review every explicit gap instead of inventing an accomplishment.
- Confirm compensation, work model, and next-step timing directly.
- JobOS did not contact the company or any interviewer.
`;
}

function insertInterviewPackItems(s, artifact, pack) {
  for (const item of pack.items) {
    run(s, `INSERT INTO interview_pack_items
      (artifact_id,position,profile_id,job_id,application_id,interview_stage,audience,
       question_id,question_origin,question_text,question_source_json,coverage_status,
       story_id,story_revision_id,match_score,match_reasons_json,alternative_matches_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      artifact.id,
      item.position,
      pack.profileId,
      pack.jobId,
      pack.applicationId,
      pack.stage,
      pack.audience,
      item.questionId,
      item.questionOrigin,
      item.questionText,
      JSON.stringify(item.questionSource),
      item.coverageStatus,
      item.storyId,
      item.storyRevisionId,
      item.matchScore,
      JSON.stringify(item.matchReasons),
      JSON.stringify(item.alternativeMatches),
    ]);
  }
}

export async function prepInterview(
  s,
  applicationId,
  stage = 'interview',
  options = {},
) {
  const application = one(s, 'SELECT * FROM applications WHERE id=?', [applicationId]);
  if (!application) {
    throw new InterviewError(
      'interview_application_unknown',
      `Unknown application: ${applicationId}.`,
    );
  }
  const ownership = resolveInterviewOwnership(s, {
    profileId: application.profile_id,
    jobId: application.job_id,
    applicationId,
  });
  const pack = buildInterviewPack(s, {
    profileId: ownership.profile.id,
    jobId: ownership.job.id,
    applicationId,
    stage,
    audience: options?.audience,
  });
  const proofs = all(
    s,
    'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at,id',
    [ownership.profile.id],
  ).map(parseProof);
  const company = ownership.job.company_id
    ? one(s, 'SELECT * FROM companies WHERE id=?', [ownership.job.company_id])
    : null;
  const stakeholders = all(
    s,
    'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC,id',
    [ownership.job.id],
  ).map(stakeholder => ({
    ...stakeholder,
    links: parseJson(stakeholder.links_json, []),
  }));
  let content = renderInterviewPack({
    job: ownership.job,
    profile: ownership.profile,
    application: ownership.application,
    pack,
    proofs,
    company,
    stakeholders,
  });
  const researchRun = one(
    s,
    `SELECT id,status,finished_at FROM research_runs
      WHERE job_id=? AND profile_id=? AND scope='job'
        AND status IN ('succeeded','partial')
      ORDER BY finished_at DESC,id DESC LIMIT 1`,
    [ownership.job.id, ownership.profile.id],
  );
  if (researchRun) {
    const runRel = path.join('research', 'runs', `${researchRun.id}.md`);
    const stale = !researchRun.finished_at
      || researchRun.finished_at
        < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    content += `\n> Research run: [${researchRun.id}](${runRel}) completed ${researchRun.finished_at}.`;
    if (stale) {
      content += ' This research is more than 30 days old; consider refreshing it.';
    }
    content += '\n';
  } else {
    content += '\n> No people-research run is stored for this job. Run `jobos research people --scope job --job <job-id> --depth standard` before the interview for network-aware preparation.\n';
  }
  const rel = path.join(
    'jobs',
    ownership.job.id,
    'artifacts',
    `interview-prep-${pack.stage}.md`,
  );
  const artifact = createArtifact(s, {
    jobId: ownership.job.id,
    profileId: ownership.profile.id,
    type: 'interview_prep',
    path: rel,
    title: `Interview prep: ${pack.stage} for ${ownership.job.title}`,
    content,
    evidence: pack.items,
    warnings: pack.warnings,
    series: {
      kind: 'interview_prep',
      applicationId,
      stage: pack.stage,
    },
    auditAction: 'interview_prep.created',
    auditPayload: {
      applicationId,
      stage: pack.stage,
      audience: pack.audience,
      deterministic: true,
    },
    mutate(store, createdArtifact) {
      insertInterviewPackItems(store, createdArtifact, pack);
      queuePostCommit(store, () => syncJob(store, ownership.job.id));
    },
  });
  return {
    ...artifact,
    applicationId,
    jobId: ownership.job.id,
    profileId: ownership.profile.id,
    stage: pack.stage,
    audience: pack.audience,
    pack: {
      ...pack,
      artifactId: artifact.id,
      artifactRevision: artifact.revision,
    },
    note: 'Interview prep packet created for human review.',
  };
}

const TRUSTED_INTERVIEW_DEBRIEF_SOURCES = Object.freeze(['cli', 'tui']);
const DEBRIEF_PROVENANCE_FIELDS = Object.freeze([
  'observedQuestions',
  'observedOutcome',
  'proofGaps',
  'storyUses',
  'notes',
]);

function debriefObject(value, field, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InterviewError(code, `${field} must be an object.`);
  }
  return value;
}

function debriefExactKeys(value, allowed, field, code) {
  const object = debriefObject(value, field, code);
  const keys = Object.keys(object).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new InterviewError(code, `${field} must contain exactly: ${allowed.join(', ')}.`);
  }
  return object;
}

function debriefArray(value, field, code) {
  if (!Array.isArray(value)) {
    throw new InterviewError(code, `${field} must be an array.`);
  }
  return value;
}

function debriefNullableText(value, field) {
  if (value == null) return null;
  return requireInterviewText(value, field);
}

function normalizeDebriefQuestions(value, debriefId, revision) {
  const seen = new Set();
  return debriefArray(
    value,
    'observedQuestions',
    'interview_observed_questions_shape_invalid',
  ).map((entry, index) => {
    const allowed = Object.hasOwn(entry || {}, 'id')
      ? ['id', 'text', 'askedByAudience', 'source']
      : ['text', 'askedByAudience', 'source'];
    const question = debriefExactKeys(
      entry,
      allowed,
      `observedQuestions[${index}]`,
      'interview_observed_question_shape_invalid',
    );
    const idValue = `debrief.${debriefId}.${revision}.${index}`;
    if (question.id !== undefined && question.id !== idValue) {
      throw new InterviewError(
        'interview_observed_question_id_invalid',
        `observedQuestions[${index}].id must equal ${idValue}.`,
      );
    }
    const text = requireInterviewText(question.text, `observedQuestions[${index}].text`);
    const askedByAudience = normalizeInterviewEnum(
      question.askedByAudience,
      `observedQuestions[${index}].askedByAudience`,
      INTERVIEW_AUDIENCES,
    );
    const source = normalizeInterviewEnum(
      question.source,
      `observedQuestions[${index}].source`,
      ['user_observed'],
    );
    const duplicateKey = `${text.toLowerCase()}|${askedByAudience}`;
    if (seen.has(duplicateKey)) {
      throw new InterviewError(
        'interview_observed_question_duplicate',
        'Observed questions must not contain duplicate text/audience pairs.',
      );
    }
    seen.add(duplicateKey);
    return { id: idValue, text, askedByAudience, source };
  });
}

function normalizeDebriefOutcome(value) {
  const outcome = debriefExactKeys(
    value,
    ['type', 'note'],
    'observedOutcome',
    'interview_observed_outcome_shape_invalid',
  );
  let type;
  try {
    type = normalizeInterviewEnum(outcome.type, 'observedOutcome.type', INTERVIEW_OUTCOME_TYPES);
  } catch (error) {
    if (error instanceof InterviewError) {
      throw new InterviewError(
        'interview_observed_outcome_type_invalid',
        error.message,
        error.details,
      );
    }
    throw error;
  }
  if (typeof outcome.note !== 'string') {
    throw new InterviewError(
      'interview_observed_outcome_shape_invalid',
      'observedOutcome.note must be a string.',
    );
  }
  return { type, note: outcome.note };
}

function normalizeDebriefProofGaps(value, questionIds) {
  const seen = new Set();
  return debriefArray(value, 'proofGaps', 'interview_proof_gaps_shape_invalid')
    .map((entry, index) => {
      const gap = debriefExactKeys(
        entry,
        ['id', 'type', 'text', 'questionId', 'storyId', 'proofPointId'],
        `proofGaps[${index}]`,
        'interview_proof_gap_shape_invalid',
      );
      const gapId = requireInterviewText(gap.id, `proofGaps[${index}].id`);
      if (seen.has(gapId)) {
        throw new InterviewError(
          'interview_proof_gap_duplicate',
          `Duplicate proof gap id: ${gapId}.`,
        );
      }
      seen.add(gapId);
      let type;
      try {
        type = normalizeInterviewEnum(
          gap.type,
          `proofGaps[${index}].type`,
          INTERVIEW_PROOF_GAP_TYPES,
        );
      } catch (error) {
        if (error instanceof InterviewError) {
          throw new InterviewError('interview_proof_gap_type_invalid', error.message, error.details);
        }
        throw error;
      }
      const questionId = debriefNullableText(gap.questionId, `proofGaps[${index}].questionId`);
      if (questionId && !questionIds.has(questionId)) {
        throw new InterviewError(
          'interview_debrief_question_link_invalid',
          `Proof gap ${gapId} links an unknown observed question: ${questionId}.`,
        );
      }
      return {
        id: gapId,
        type,
        text: requireInterviewText(gap.text, `proofGaps[${index}].text`),
        questionId,
        storyId: debriefNullableText(gap.storyId, `proofGaps[${index}].storyId`),
        proofPointId: debriefNullableText(
          gap.proofPointId,
          `proofGaps[${index}].proofPointId`,
        ),
      };
    });
}

function normalizeDebriefStoryUses(value, questionIds) {
  const seen = new Set();
  return debriefArray(value, 'storyUses', 'interview_story_uses_shape_invalid')
    .map((entry, index) => {
      const storyUse = debriefExactKeys(
        entry,
        ['storyId', 'storyRevisionId', 'questionId', 'adaptationNote'],
        `storyUses[${index}]`,
        'interview_story_use_shape_invalid',
      );
      const storyId = requireInterviewText(storyUse.storyId, `storyUses[${index}].storyId`);
      const storyRevisionId = requireInterviewText(
        storyUse.storyRevisionId,
        `storyUses[${index}].storyRevisionId`,
      );
      const questionId = debriefNullableText(
        storyUse.questionId,
        `storyUses[${index}].questionId`,
      );
      if (questionId && !questionIds.has(questionId)) {
        throw new InterviewError(
          'interview_debrief_question_link_invalid',
          `Story use ${storyId} links an unknown observed question: ${questionId}.`,
        );
      }
      const duplicateKey = `${storyId}|${storyRevisionId}|${questionId || ''}`;
      if (seen.has(duplicateKey)) {
        throw new InterviewError(
          'interview_story_use_duplicate',
          'Story uses must not duplicate a story revision/question link.',
        );
      }
      seen.add(duplicateKey);
      if (typeof storyUse.adaptationNote !== 'string') {
        throw new InterviewError(
          'interview_story_use_shape_invalid',
          `storyUses[${index}].adaptationNote must be a string.`,
        );
      }
      return { storyId, storyRevisionId, questionId, adaptationNote: storyUse.adaptationNote };
    });
}

function normalizeDebriefFieldProvenance(value, actor, source) {
  const provenance = debriefExactKeys(
    value,
    DEBRIEF_PROVENANCE_FIELDS,
    'fieldProvenance',
    'interview_debrief_field_provenance_invalid',
  );
  return Object.fromEntries(DEBRIEF_PROVENANCE_FIELDS.map(field => {
    const entry = debriefExactKeys(
      provenance[field],
      ['origin', 'actor', 'source', 'sourceRef'],
      `fieldProvenance.${field}`,
      'interview_debrief_field_provenance_invalid',
    );
    if (entry.origin !== 'user') {
      throw new InterviewError(
        'interview_debrief_field_provenance_invalid',
        `fieldProvenance.${field}.origin must equal user.`,
      );
    }
    const entryActor = requireInterviewText(entry.actor, `fieldProvenance.${field}.actor`);
    const entrySource = String(entry.source || '').trim().toLowerCase();
    if (entryActor !== actor || entrySource !== source) {
      throw new InterviewError(
        'interview_debrief_field_provenance_invalid',
        `fieldProvenance.${field} must retain the debrief actor and trusted source.`,
      );
    }
    const sourceRef = entry.sourceRef == null
      ? null
      : requireInterviewText(entry.sourceRef, `fieldProvenance.${field}.sourceRef`);
    return [field, { origin: 'user', actor: entryActor, source: entrySource, sourceRef }];
  }));
}

function debriefPayloadHash(payload) {
  return hash(JSON.stringify({
    occurredAt: payload.occurredAt,
    actor: payload.actor,
    source: payload.source,
    observedQuestions: payload.observedQuestions,
    observedOutcome: payload.observedOutcome,
    proofGaps: payload.proofGaps,
    storyUses: payload.storyUses,
    notes: payload.notes,
    fieldProvenance: payload.fieldProvenance,
  }));
}

function normalizeDebriefPayload(s, input, ownership, debriefId, revision, recordedAt) {
  const occurredAt = normalizeInterviewTimestamp(input.occurredAt, 'occurredAt');
  if (Date.parse(occurredAt) > Date.parse(recordedAt)) {
    throw new InterviewError(
      'interview_debrief_occurred_at_future',
      'occurredAt cannot be in the future relative to recordedAt.',
    );
  }
  const actor = requireInterviewText(input.actor, 'actor');
  const source = String(input.source || '').trim().toLowerCase();
  if (!TRUSTED_INTERVIEW_DEBRIEF_SOURCES.includes(source)) {
    throw new InterviewError(
      'interview_debrief_source_untrusted',
      'Interview debriefs require source=cli or source=tui.',
      { allowed: TRUSTED_INTERVIEW_DEBRIEF_SOURCES },
    );
  }
  const observedQuestions = normalizeDebriefQuestions(
    input.observedQuestions,
    debriefId,
    revision,
  );
  const questionIds = new Set(observedQuestions.map(question => question.id));
  const observedOutcome = normalizeDebriefOutcome(input.observedOutcome);
  const proofGaps = normalizeDebriefProofGaps(input.proofGaps, questionIds);
  const storyUses = normalizeDebriefStoryUses(input.storyUses, questionIds);
  if (typeof input.notes !== 'string') {
    throw new InterviewError('interview_debrief_notes_invalid', 'notes must be a string.');
  }
  const fieldProvenance = normalizeDebriefFieldProvenance(
    input.fieldProvenance,
    actor,
    source,
  );

  const proofPointIds = [...new Set(
    proofGaps.map(gap => gap.proofPointId).filter(Boolean),
  )];
  resolveInterviewOwnership(s, {
    profileId: ownership.profile.id,
    jobId: ownership.job.id,
    applicationId: ownership.application.id,
    proofPointIds,
  });
  const storyLinks = new Map();
  for (const gap of proofGaps) {
    if (gap.storyId) storyLinks.set(`${gap.storyId}|`, { storyId: gap.storyId });
  }
  for (const storyUse of storyUses) {
    storyLinks.set(
      `${storyUse.storyId}|${storyUse.storyRevisionId}`,
      {
        storyId: storyUse.storyId,
        storyRevisionId: storyUse.storyRevisionId,
      },
    );
  }
  for (const link of storyLinks.values()) {
    resolveInterviewOwnership(s, {
      profileId: ownership.profile.id,
      jobId: ownership.job.id,
      applicationId: ownership.application.id,
      ...link,
    });
  }

  const payload = {
    occurredAt,
    recordedAt,
    actor,
    source,
    observedQuestions,
    observedOutcome,
    proofGaps,
    storyUses,
    notes: input.notes,
    fieldProvenance,
  };
  return { ...payload, contentHash: debriefPayloadHash(payload) };
}

function debriefLifecycleTrigger(debrief, revision) {
  return {
    schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
    profileId: debrief.profile_id,
    applicationId: debrief.application_id,
    eventId: debrief.id,
    eventType: 'interview_debrief_recorded',
    occurredAt: revision.occurred_at,
    stage: 'interview',
  };
}

function debriefRevisionRows(s, debriefId) {
  return all(s, `SELECT * FROM interview_debrief_revisions
    WHERE debrief_id=? ORDER BY revision,id`, [debriefId]);
}

function debriefRevisionProjection(row, currentRevision) {
  return {
    id: row.id,
    debriefId: row.debrief_id,
    profileId: row.profile_id,
    revision: Number(row.revision),
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    observedQuestions: parseJson(row.observed_questions_json, []),
    observedOutcome: parseJson(row.observed_outcome_json, {}),
    proofGaps: parseJson(row.proof_gaps_json, []),
    storyUses: parseJson(row.story_uses_json, []),
    notes: row.notes,
    fieldProvenance: parseJson(row.field_provenance_json, {}),
    contentHash: row.content_hash,
    supersedesRevisionId: row.supersedes_revision_id || null,
    correctionReason: row.correction_reason || '',
    current: Number(row.revision) === Number(currentRevision),
  };
}

function debriefActionRow(s, debrief) {
  return one(s, `SELECT * FROM tasks
    WHERE application_id=? AND action_kind='application_next_action'
      AND action_code='follow-up-after-interview' AND source_event_id=?
    ORDER BY CASE status WHEN 'open' THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 1`, [
    debrief.application_id,
    debrief.id,
  ]);
}

function debriefProjection(s, row, { includeHistory = true } = {}) {
  const rows = debriefRevisionRows(s, row.id);
  if (!rows.length) {
    throw new InterviewError(
      'interview_debrief_revision_missing',
      `Interview debrief ${row.id} has no revisions.`,
    );
  }
  const currentRow = rows.at(-1);
  const currentRevision = debriefRevisionProjection(currentRow, currentRow.revision);
  const actionRow = debriefActionRow(s, row);
  const result = {
    schema: INTERVIEW_DEBRIEF_SCHEMA,
    version: 1,
    id: row.id,
    profileId: row.profile_id,
    jobId: row.job_id,
    applicationId: row.application_id,
    interviewStage: row.interview_stage,
    audience: row.audience,
    referenceId: row.reference_id,
    createdAt: row.created_at,
    currentRevision,
    lifecycleTrigger: debriefLifecycleTrigger(row, currentRow),
    action: actionRow
      ? lifecycleTaskView(actionRow, { nowDate: new Date(currentRow.recorded_at) })
      : null,
  };
  if (includeHistory) {
    result.history = rows.map(revision => debriefRevisionProjection(revision, currentRow.revision));
  }
  return result;
}

function debriefResult(s, row, { idempotent = false, includeHistory = true } = {}) {
  return {
    ...debriefProjection(s, row, { includeHistory }),
    idempotent,
    exactReplay: idempotent,
  };
}

function insertDebriefRevision(s, debrief, revision, payload, {
  supersedesRevisionId = null,
  correctionReason = '',
} = {}) {
  const revisionId = id(
    'interview_debrief_revision',
    `${debrief.id}:${revision}:${payload.contentHash}:${supersedesRevisionId || ''}:${correctionReason}`,
  );
  run(s, `INSERT INTO interview_debrief_revisions
    (id,debrief_id,profile_id,revision,occurred_at,recorded_at,actor,source,
     observed_questions_json,observed_outcome_json,proof_gaps_json,story_uses_json,
     notes,field_provenance_json,content_hash,supersedes_revision_id,correction_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    revisionId,
    debrief.id,
    debrief.profile_id,
    revision,
    payload.occurredAt,
    payload.recordedAt,
    payload.actor,
    payload.source,
    JSON.stringify(payload.observedQuestions),
    JSON.stringify(payload.observedOutcome),
    JSON.stringify(payload.proofGaps),
    JSON.stringify(payload.storyUses),
    payload.notes,
    JSON.stringify(payload.fieldProvenance),
    payload.contentHash,
    supersedesRevisionId,
    correctionReason,
  ]);
  return one(s, 'SELECT * FROM interview_debrief_revisions WHERE id=?', [revisionId]);
}

function sameDebriefIdentity(row, normalized) {
  return row.profile_id === normalized.profileId
    && row.job_id === normalized.jobId
    && row.application_id === normalized.applicationId
    && row.interview_stage === normalized.interviewStage
    && row.audience === normalized.audience
    && row.reference_id === normalized.referenceId;
}

function recordDebriefAudit(s, action, debrief, revision) {
  return recordAudit(s, action, 'interview_debrief', debrief.id, {
    schema: INTERVIEW_DEBRIEF_SCHEMA,
    profileId: debrief.profile_id,
    jobId: debrief.job_id,
    applicationId: debrief.application_id,
    debriefId: debrief.id,
    revisionId: revision.id,
    revision: Number(revision.revision),
    supersedesRevisionId: revision.supersedes_revision_id || null,
    interviewStage: debrief.interview_stage,
    audience: debrief.audience,
    externalSideEffects: 'none',
  });
}

function debriefRowsForJob(s, jobId) {
  return all(s, `SELECT * FROM interview_debriefs
    WHERE job_id=? ORDER BY application_id,created_at,id`, [jobId]);
}

function syncInterviewDebriefsForJob(s, jobId) {
  const job = one(s, 'SELECT id,profile_id FROM jobs WHERE id=?', [jobId]);
  if (!job) return;
  writeYaml(path.join(s.p.jobs, job.id, 'interviews', 'debriefs.yaml'), {
    schema: INTERVIEW_DEBRIEF_LIST_SCHEMA,
    version: 1,
    jobId: job.id,
    profileId: job.profile_id,
    policy: {
      canonicalStore: 'sqlite',
      appendOnlyRevisions: true,
      currentResolution: 'highest_revision',
      stableKey: 'id',
    },
    debriefs: debriefRowsForJob(s, job.id)
      .map(row => debriefProjection(s, row, { includeHistory: true })),
  });
}

function observationProjection(row, debrief, currentRevision) {
  return {
    schema: INTERVIEW_OBSERVATION_SCHEMA,
    version: 1,
    id: `${debrief.id}:${row.revision}`,
    debriefId: debrief.id,
    profileId: debrief.profile_id,
    jobId: debrief.job_id,
    applicationId: debrief.application_id,
    interviewStage: debrief.interview_stage,
    audience: debrief.audience,
    sourceEntity: {
      type: 'interview_debrief',
      id: debrief.id,
      versionId: row.id,
      revision: Number(row.revision),
      supersedesVersionId: row.supersedes_revision_id || null,
    },
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    current: Number(row.revision) === Number(currentRevision),
    observedQuestions: parseJson(row.observed_questions_json, []),
    observedOutcome: parseJson(row.observed_outcome_json, {}),
    proofGaps: parseJson(row.proof_gaps_json, []),
    storyUses: parseJson(row.story_uses_json, []),
    interpretation: 'attributed_observation_only_no_preference_or_causal_claim',
    externalSideEffects: 'none',
  };
}

function observationRows(s, profileId, start = null, end = null) {
  const where = ['d.profile_id=?'];
  const params = [profileId];
  if (start) {
    where.push('r.occurred_at>=?');
    params.push(start);
  }
  if (end) {
    where.push('r.occurred_at<=?');
    params.push(end);
  }
  return all(s, `SELECT
      r.*,d.job_id,d.application_id,d.interview_stage,d.audience,d.reference_id,d.created_at,
      (SELECT MAX(r2.revision) FROM interview_debrief_revisions r2
        WHERE r2.debrief_id=r.debrief_id) AS current_revision
    FROM interview_debrief_revisions r
    JOIN interview_debriefs d ON d.id=r.debrief_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.occurred_at,r.debrief_id,r.revision,r.id`, params);
}

function syncInterviewObservations(s, profileId) {
  const latest = one(s, `SELECT MAX(r.recorded_at) AS recorded_at
    FROM interview_debrief_revisions r
    JOIN interview_debriefs d ON d.id=r.debrief_id
    WHERE d.profile_id=?`, [profileId]);
  const nowDate = new Date(latest?.recorded_at || 0);
  const projection = listInterviewObservations(s, { profileId, nowDate });
  writeYaml(path.join(s.p.profiles, profileId, 'interviews', 'observations.yaml'), {
    ...projection,
    policy: {
      canonicalStore: 'sqlite',
      appendOnlyRevisions: true,
      currentResolution: 'highest_revision',
      interpretation: 'attributed_observations_only',
      externalSideEffects: 'none',
    },
  });
}

function queueDebriefProjections(s, debrief, event) {
  queuePostCommit(s, () => syncInterviewDebriefsForJob(s, debrief.job_id));
  queuePostCommit(s, () => syncInterviewObservations(s, debrief.profile_id));
  queuePostCommit(s, () => syncJob(s, debrief.job_id));
  queuePostCommit(s, () => projectAudit(s, event));
}

function normalizedDebriefIdentity(s, input) {
  const ownership = resolveInterviewOwnership(s, {
    profileId: input.profileId,
    jobId: input.jobId,
    applicationId: input.applicationId,
  });
  if (!ownership.job || !ownership.application) {
    throw new InterviewError(
      'interview_debrief_ownership_required',
      'Interview debriefs require an owned job and application.',
    );
  }
  return {
    ownership,
    profileId: ownership.profile.id,
    jobId: ownership.job.id,
    applicationId: ownership.application.id,
    interviewStage: normalizeInterviewEnum(
      input.interviewStage,
      'interviewStage',
      INTERVIEW_STAGES,
    ),
    audience: normalizeInterviewEnum(input.audience, 'audience', INTERVIEW_AUDIENCES),
    referenceId: String(input.referenceId || '').trim(),
  };
}

export function recordInterviewDebrief(s, input = {}) {
  return guardedWrite(s, () => {
    const normalized = normalizedDebriefIdentity(s, input);
    const recordedAt = now();
    const identitySeed = normalized.referenceId
      ? `${normalized.profileId}:${normalized.referenceId}`
      : `${normalized.profileId}:${normalized.applicationId}:${input.occurredAt || ''}:${recordedAt}`;
    const debriefId = id('interview_debrief', identitySeed);
    const payload = normalizeDebriefPayload(
      s,
      input,
      normalized.ownership,
      debriefId,
      1,
      recordedAt,
    );
    const existing = normalized.referenceId
      ? one(s, `SELECT * FROM interview_debriefs
        WHERE profile_id=? AND reference_id=?`, [
        normalized.profileId,
        normalized.referenceId,
      ])
      : one(s, 'SELECT * FROM interview_debriefs WHERE id=?', [debriefId]);
    if (existing) {
      const original = one(s, `SELECT * FROM interview_debrief_revisions
        WHERE debrief_id=? AND revision=1`, [existing.id]);
      if (
        !sameDebriefIdentity(existing, normalized)
        || !original
        || original.content_hash !== payload.contentHash
      ) {
        throw new InterviewError(
          'interview_debrief_reference_conflict',
          `Reference ${normalized.referenceId} already identifies a different interview debrief.`,
        );
      }
      return debriefResult(s, existing, { idempotent: true });
    }

    run(s, `INSERT INTO interview_debriefs
      (id,profile_id,job_id,application_id,interview_stage,audience,reference_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`, [
      debriefId,
      normalized.profileId,
      normalized.jobId,
      normalized.applicationId,
      normalized.interviewStage,
      normalized.audience,
      normalized.referenceId,
      recordedAt,
    ]);
    const debrief = one(s, 'SELECT * FROM interview_debriefs WHERE id=?', [debriefId]);
    const revision = insertDebriefRevision(s, debrief, 1, payload);
    const trigger = debriefLifecycleTrigger(debrief, revision);
    reconcileApplicationNextAction(s, {
      applicationId: debrief.application_id,
      trigger,
      nowDate: new Date(revision.occurred_at),
    });
    const event = recordDebriefAudit(s, 'interview.debrief.recorded', debrief, revision);
    queueDebriefProjections(s, debrief, event);
    return debriefResult(s, debrief);
  });
}

export function correctInterviewDebrief(s, input = {}) {
  return guardedWrite(s, () => {
    const profileId = requireInterviewText(input.profileId, 'profileId');
    const debriefId = requireInterviewText(input.debriefId, 'debriefId');
    const debrief = one(s, 'SELECT * FROM interview_debriefs WHERE id=?', [debriefId]);
    if (!debrief) {
      throw new InterviewError(
        'interview_debrief_unknown',
        `Unknown interview debrief: ${debriefId}.`,
      );
    }
    if (debrief.profile_id !== profileId) {
      throw new InterviewError(
        'interview_debrief_profile_mismatch',
        `Interview debrief ${debriefId} belongs to profile ${debrief.profile_id}, not ${profileId}.`,
      );
    }
    const targetRevision = Number(input.targetRevision);
    if (!Number.isInteger(targetRevision) || targetRevision < 1) {
      throw new InterviewError(
        'interview_debrief_target_revision_invalid',
        'targetRevision must be a positive integer.',
      );
    }
    const reason = requireInterviewText(input.reason, 'reason');
    const normalized = normalizedDebriefIdentity(s, input);
    if (!sameDebriefIdentity(debrief, normalized)) {
      throw new InterviewError(
        'interview_debrief_ownership_mismatch',
        'Corrections must preserve profile, job, application, stage, audience, and reference.',
      );
    }
    const target = one(s, `SELECT * FROM interview_debrief_revisions
      WHERE debrief_id=? AND revision=?`, [debrief.id, targetRevision]);
    if (!target) {
      throw new InterviewError(
        'interview_debrief_revision_unknown',
        `Unknown interview debrief revision: ${targetRevision}.`,
      );
    }
    const current = one(s, `SELECT * FROM interview_debrief_revisions
      WHERE debrief_id=? ORDER BY revision DESC,id DESC LIMIT 1`, [debrief.id]);
    const recordedAt = now();
    const payload = normalizeDebriefPayload(
      s,
      input,
      normalized.ownership,
      debrief.id,
      targetRevision + 1,
      recordedAt,
    );
    if (Number(current.revision) !== targetRevision) {
      const successor = one(s, `SELECT * FROM interview_debrief_revisions
        WHERE debrief_id=? AND revision=?`, [debrief.id, targetRevision + 1]);
      if (
        successor
        && successor.supersedes_revision_id === target.id
        && successor.correction_reason === reason
        && successor.content_hash === payload.contentHash
      ) {
        return debriefResult(s, debrief, { idempotent: true });
      }
      throw new InterviewError(
        'interview_debrief_revision_not_current',
        `Interview debrief revision ${targetRevision} is not the latest revision.`,
      );
    }

    const revision = insertDebriefRevision(s, debrief, targetRevision + 1, payload, {
      supersedesRevisionId: target.id,
      correctionReason: reason,
    });
    const trigger = debriefLifecycleTrigger(debrief, revision);
    reconcileApplicationNextAction(s, {
      applicationId: debrief.application_id,
      trigger,
      nowDate: new Date(revision.occurred_at),
    });
    const event = recordDebriefAudit(s, 'interview.debrief.corrected', debrief, revision);
    queueDebriefProjections(s, debrief, event);
    return debriefResult(s, debrief);
  });
}

export function getInterviewDebrief(s, input = {}) {
  const profileId = requireInterviewText(input.profileId, 'profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) {
    throw new InterviewError('interview_profile_unknown', `Unknown profile: ${profileId}.`);
  }
  const debriefId = requireInterviewText(input.debriefId, 'debriefId');
  const row = one(s, 'SELECT * FROM interview_debriefs WHERE id=?', [debriefId]);
  if (!row) {
    throw new InterviewError('interview_debrief_unknown', `Unknown interview debrief: ${debriefId}.`);
  }
  if (row.profile_id !== profileId) {
    throw new InterviewError(
      'interview_debrief_profile_mismatch',
      `Interview debrief ${debriefId} belongs to another profile.`,
    );
  }
  return debriefProjection(s, row, { includeHistory: input.includeHistory !== false });
}

export function listInterviewDebriefs(s, input = {}) {
  const profileId = requireInterviewText(input.profileId, 'profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) {
    throw new InterviewError('interview_profile_unknown', `Unknown profile: ${profileId}.`);
  }
  const applicationId = input.applicationId
    ? requireInterviewText(input.applicationId, 'applicationId')
    : null;
  if (applicationId) {
    resolveInterviewOwnership(s, { profileId, applicationId });
  }
  const rows = applicationId
    ? all(s, `SELECT * FROM interview_debriefs
      WHERE profile_id=? AND application_id=? ORDER BY created_at,id`, [profileId, applicationId])
    : all(s, `SELECT * FROM interview_debriefs
      WHERE profile_id=? ORDER BY created_at,id`, [profileId]);
  return {
    schema: INTERVIEW_DEBRIEF_LIST_SCHEMA,
    version: 1,
    profileId,
    applicationId,
    debriefs: rows.map(row => debriefProjection(
      s,
      row,
      { includeHistory: Boolean(input.includeHistory) },
    )),
  };
}

export function listInterviewObservations(s, {
  profileId,
  sinceDays = null,
  nowDate = new Date(),
} = {}) {
  const owner = requireInterviewText(profileId, 'profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [owner])) {
    throw new InterviewError('interview_profile_unknown', `Unknown profile: ${owner}.`);
  }
  if (!(nowDate instanceof Date) || Number.isNaN(nowDate.getTime())) {
    throw new InterviewError('interview_observation_now_invalid', 'nowDate must be a valid Date.');
  }
  let start = null;
  if (sinceDays != null) {
    const days = Number(sinceDays);
    if (!Number.isInteger(days) || days <= 0) {
      throw new InterviewError(
        'interview_observation_since_invalid',
        'sinceDays must be a positive integer.',
      );
    }
    start = new Date(nowDate.getTime() - days * 86_400_000).toISOString();
  }
  const end = nowDate.toISOString();
  const rows = observationRows(s, owner, start, end);
  return {
    schema: INTERVIEW_OBSERVATION_LIST_SCHEMA,
    version: 1,
    observationSchema: INTERVIEW_OBSERVATION_SCHEMA,
    profileId: owner,
    period: { start, end },
    observations: rows.map(row => observationProjection(
      row,
      {
        id: row.debrief_id,
        profile_id: row.profile_id,
        job_id: row.job_id,
        application_id: row.application_id,
        interview_stage: row.interview_stage,
        audience: row.audience,
      },
      row.current_revision,
    )),
  };
}
