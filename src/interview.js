import path from 'node:path';
import { all, guardedWrite, one, projectAudit, queuePostCommit, recordAudit, run } from './db.js';
import { hash, id, now, parseJson, slug, tokenize } from './utils.js';
import { createArtifact } from './artifacts.js';
import { requirements } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';
import { writeYaml } from './workspace.js';

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

const stageLabels = {
  'recruiter-screen': 'recruiter screen',
  interview: 'interview',
  'hiring-manager': 'hiring manager interview',
  onsite: 'onsite / panel interview',
  final: 'final interview',
  offer: 'offer conversation'
};

function parseProof(p) {
  return { ...p, skills: parseJson(p.skills_json, []), metrics: parseJson(p.metrics_json, []) };
}

function competencies(job, proofs) {
  const words = new Set(tokenize(`${job.title} ${job.description}`));
  const reqs = requirements(job.description).slice(0, 8);
  const useful = new Set(['discovery','analytics','roadmap','stakeholder','communication','launch','learning','education','ai','workflow','product','strategy','experiments','operations','research','cross-functional']);
  const fromReqs = reqs.map(r => {
    const tokens = tokenize(r).filter(t => useful.has(t) || /discover|analytic|roadmap|stakeholder|launch|learning|product|experiment|research|cross/.test(t));
    return tokens.slice(0, 2).join(' ');
  }).filter(Boolean);
  const proofSkills = proofs.flatMap(p => p.skills || []).map(String).filter(skill => words.has(skill.toLowerCase()) && (useful.has(skill.toLowerCase()) || skill.length > 5));
  return [...new Set([...fromReqs, ...proofSkills, 'product judgment', 'cross-functional leadership'].filter(Boolean))].slice(0, 8);
}

function relevantProofs(job, proofs) {
  const jobTokens = new Set(tokenize(`${job.title} ${job.description}`));
  return proofs.map(p => ({
    ...p,
    relevance: tokenize(`${p.summary} ${(p.skills || []).join(' ')}`).filter(t => jobTokens.has(t)).length
  })).sort((a, b) => b.relevance - a.relevance || a.summary.localeCompare(b.summary));
}

function likelyQuestions(job, stage, comps) {
  const reqs = requirements(job.description).slice(0, 5);
  const role = job.title;
  const company = job.company;
  const base = [
    `How would you approach the first 30-60-90 days as ${role} at ${company}?`,
    `Which signals would you use to decide whether this ${role} work is succeeding?`,
    `Tell me about a time you had to make tradeoffs similar to: ${reqs[0] || 'this role\'s core responsibilities'}.`,
    `What would you need to learn about ${company}'s users, team, and constraints before recommending a roadmap?`
  ];
  if (/recruiter/.test(stage)) base.unshift(`What is your concise narrative for why ${role} at ${company} fits your search now?`);
  if (/manager|onsite|final|interview/.test(stage)) base.push(...comps.slice(0, 4).map(c => `Walk me through a specific example that shows ${c} in a high-stakes work context.`));
  return [...new Set(base)].slice(0, 10);
}

function storyForProof(proof, competency) {
  const metric = proof.metrics?.length ? ` Metrics to mention: ${proof.metrics.join(', ')}.` : '';
  const evidence = proof.evidence ? ` Evidence/source: ${proof.evidence}.` : '';
  return `- **${competency}:** use proof \`${proof.id}\` — ${proof.summary}${metric}${evidence}\n  - Situation: set the context and constraints behind this proof.\n  - Task: explain what you owned or influenced.\n  - Action: name the decisions, collaboration, analysis, or delivery work you performed.\n  - Result: quantify only with stored metrics/evidence; otherwise state the qualitative result and say what you learned.`;
}

function askQuestions(job, facts) {
  const factHooks = facts.slice(0, 3).map(f => `Given ${f.claim}, how is the ${job.title} role expected to contribute over the next two quarters?`);
  return [
    ...factHooks,
    `What are the most important problems this ${job.title} hire should solve in the first six months?`,
    'How does the team make tradeoffs between speed, user learning, and operational quality?',
    'What evidence would make you confident that the person in this role is succeeding?',
    'What should I understand about the team, stakeholders, or constraints that is not visible in the job posting?'
  ].slice(0, 8);
}

function refreshSummary(job, company, facts, stakeholders) {
  const factLines = facts.length ? facts.slice(0, 5).map(f => `- ${f.claim} (${f.url})`).join('\n') : '- No source-backed company facts are stored yet; run `research company --job '+job.id+'` before the interview.';
  const people = stakeholders.length ? stakeholders.slice(0, 5).map(s => `- ${s.name} — ${s.role}: ${s.summary}`).join('\n') : '- No stakeholder research stored yet.';
  return `## Company / role refresh\n- Role: ${job.title}\n- Company: ${job.company}\n- Location: ${job.location || 'not specified'}\n- Application source: ${String(job.url || '').startsWith('jobos:text:') ? 'manual/text import' : job.url || 'not provided'}\n\n### Stored company facts\n${factLines}\n\n### Stakeholder context\n${people}`;
}

function fallbackPacket({ job, prof, app, stage, proofs, company, stakeholders }) {
  const facts = parseJson(company?.facts_json, []);
  const comps = competencies(job, proofs);
  const ranked = relevantProofs(job, proofs);
  const stories = comps.slice(0, 6).map((c, idx) => ranked[idx % Math.max(ranked.length, 1)] ? storyForProof(ranked[idx % ranked.length], c) : `- **${c}:** add a stored proof point before relying on this story.`).join('\n');
  const qs = likelyQuestions(job, stage, comps).map(q => `- ${q}`).join('\n');
  const asks = askQuestions(job, facts).map(q => `- ${q}`).join('\n');
  const proofWarning = proofs.length ? '- Stories below are mapped to stored proof points; verify details before the interview.' : '- No proof points exist for this profile; packet avoids inventing STAR stories.';
  return `# Interview prep packet — ${stageLabels[stage] || stage} for ${job.title} at ${job.company}\n\nGenerated: ${now()}\n\n**Application:** ${app.id} (${app.status})\n**Profile:** ${prof.name}\n**Approval status:** Draft for human review.\n\n${refreshSummary(job, company, facts, stakeholders)}\n\n## Likely interview questions\n${qs}\n\n## STAR story bank mapped to competencies\n${stories || '- Add proof points to generate story mappings.'}\n\n## Questions to ask the interviewer\n${asks}\n\n## Final prep checklist\n- Prepare a 60-second narrative connecting ${prof.name} to ${job.title}.\n- Choose 3 proof-backed stories above and rehearse them out loud.\n- Confirm compensation, location/work model, and next-step timeline directly with the company.\n- Do not claim unstored accomplishments; add proof points if a story is missing.\n\n## Evidence and safety notes\n${proofWarning}\n- JobOS generated an internal prep packet only. It did not contact the company, schedule interviews, or send messages.\n`;
}

function llmPrompt({ job, prof, app, stage, proofs, company, stakeholders }) {
  return `Generate a role-specific interview prep packet as JSON. Do not invent accomplishments. STAR stories must cite supplied proofPointId values only. Return: likelyQuestions array, starStories array ({competency, proofPointId, situation, task, action, result, rehearsalNote}), questionsToAsk array, refreshSummary string, warnings array.\n\nAPPLICATION: ${JSON.stringify(app)}\nPROFILE: ${JSON.stringify({ id: prof.id, name: prof.name, preferences: parseJson(prof.preferences_json, {}) })}\nJOB: ${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description, requirements: requirements(job.description) })}\nSTAGE: ${stage}\nCOMPANY_FACTS: ${company?.facts_json || '[]'}\nSTAKEHOLDERS: ${JSON.stringify(stakeholders)}\nPROOF_POINTS: ${JSON.stringify(proofs.map(p => ({ id: p.id, summary: p.summary, evidence: p.evidence, skills: p.skills, metrics: p.metrics })))}\n`;
}

function renderLlmPacket({ job, prof, app, stage, json, proofs, company, stakeholders }) {
  const proofIds = new Set(proofs.map(p => p.id));
  const proofById = new Map(proofs.map(p => [p.id, p]));
  const warnings = Array.isArray(json.warnings) ? json.warnings.map(String) : [];
  const questions = (Array.isArray(json.likelyQuestions) ? json.likelyQuestions : []).map(String).filter(Boolean).slice(0, 10);
  const stories = (Array.isArray(json.starStories) ? json.starStories : []).filter(s => proofIds.has(s.proofPointId)).slice(0, 8);
  if (stories.length < Math.min(3, proofs.length)) warnings.push('LLM returned fewer than three valid proof-grounded STAR stories; review manually.');
  const facts = parseJson(company?.facts_json, []);
  const qs = (questions.length ? questions : likelyQuestions(job, stage, competencies(job, proofs))).map(q => `- ${q}`).join('\n');
  const storyBlock = stories.length ? stories.map(s => {
    const proof = proofById.get(s.proofPointId);
    const metrics = proof.metrics?.length ? ` Stored metrics: ${proof.metrics.join(', ')}.` : '';
    return `- **${s.competency || 'Role competency'}** _(proof: ${s.proofPointId})_\n  - Proof: ${proof.summary}${metrics}\n  - Situation: set the context using only details you can verify from this proof/evidence.\n  - Task: explain what you personally owned or influenced.\n  - Action: describe decisions, collaboration, analysis, or delivery work that is directly supported by the proof.\n  - Result: quantify only with stored metrics/evidence; otherwise state the qualitative result and learning.\n  - Rehearsal note: ${s.rehearsalNote ? String(s.rehearsalNote).slice(0, 180) : 'Keep it concise and evidence-grounded; do not add unstored details.'}`;
  }).join('\n') : relevantProofs(job, proofs).slice(0, 4).map((p, idx) => storyForProof(p, competencies(job, proofs)[idx] || job.title)).join('\n');
  const asks = (Array.isArray(json.questionsToAsk) && json.questionsToAsk.length ? json.questionsToAsk.map(String) : askQuestions(job, facts)).slice(0, 8).map(q => `- ${q}`).join('\n');
  return `# LLM interview prep packet — ${stageLabels[stage] || stage} for ${job.title} at ${job.company}\n\nGenerated: ${now()}\n\n**Application:** ${app.id} (${app.status})\n**Profile:** ${prof.name}\n**Approval status:** Draft for human review.\n\n${refreshSummary(job, company, facts, stakeholders)}\n\n## Role-specific likely questions\n${qs}\n\n## STAR stories mapped from proof points\n${storyBlock || '- Add proof points to generate story mappings.'}\n\n## Questions to ask the interviewer\n${asks}\n\n## Warnings\n${warnings.length ? warnings.map(w => `- ${w}`).join('\n') : '- None; story claims are rendered from stored proof summaries/metrics only. LLM suggestions are limited to question selection, competencies, and rehearsal notes.'}\n\n## Human gate\nJobOS generated an internal prep packet only. It did not contact the company, schedule interviews, or send messages.\n`;
}

export async function prepInterview(s, applicationId, stage = 'interview') {
  const app = one(s, 'SELECT * FROM applications WHERE id=?', [applicationId]);
  if (!app) throw Error(`Unknown application: ${applicationId}`);
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [app.job_id]);
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [app.profile_id]);
  if (!job || !prof) throw Error('Application is missing linked job or profile');
  const proofs = all(s, 'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at', [prof.id]).map(parseProof);
  const company = job.company_id ? one(s, 'SELECT * FROM companies WHERE id=?', [job.company_id]) : null;
  const stakeholders = all(s, 'SELECT * FROM stakeholders WHERE job_id=? ORDER BY updated_at DESC', [job.id]).map(st => ({ ...st, links: parseJson(st.links_json, []) }));
  // Look up the latest people-research run for this job
  const researchRun = one(s, `SELECT id,status,finished_at FROM research_runs WHERE job_id=? AND profile_id=? AND scope='job' AND status IN ('succeeded','partial') ORDER BY finished_at DESC LIMIT 1`, [job.id, prof.id]);
  const researchInfo = researchRun
    ? { runId: researchRun.id, finishedAt: researchRun.finished_at, stale: !researchRun.finished_at || researchRun.finished_at < new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() }
    : null;
  const at = now();
  let content;
  const cfg = llmConfig();
  if (cfg.configured && proofs.length) {
    try {
      const result = await generateJson({ schemaName: 'jobos_interview_prep', system: 'You are JobOS interview prep. Create useful, role-specific prep while grounding every accomplishment in supplied proof IDs.', user: llmPrompt({ job, prof, app, stage, proofs, company, stakeholders }) });
      if (result.ok) content = renderLlmPacket({ job, prof, app, stage, json: result.json, proofs, company, stakeholders });

    } catch (e) {
      if (e?.type === 'agent_error') throw e;
    }
  }
  if (!content) content = fallbackPacket({ job, prof, app, stage, proofs, company, stakeholders });
  // Prepend research run context
  if (researchInfo) {
    const runRel = path.join('research', 'runs', `${researchInfo.runId}.md`);
    const runLine = `\n> Research run: [${researchInfo.runId}](${runRel}) completed ${researchInfo.finishedAt}.`;
    const staleWarning = researchInfo.stale ? ' ⚠️ This research is more than 30 days old. Consider running fresh people research before the interview.' : '';
    content = content + runLine + staleWarning + '\n';
  } else {
    content = content + '\n> ⚠️ No people-research run found for this job. Run `jobos research people --scope job --job <job-id> --depth standard` before the interview for network-aware preparation.\n';
  }
  const safeStage = slug(stage);
  const rel = path.join('jobs', job.id, 'artifacts', `interview-prep-${safeStage}.md`);
  const evidence = proofs.map(p => ({ proofPointId: p.id, summary: p.summary, evidence: p.evidence, metrics: p.metrics }));
  const artifact = createArtifact(s, {
    jobId: job.id,
    profileId: prof.id,
    type: 'interview_prep',
    path: rel,
    title: `Interview prep: ${stage} for ${job.title}`,
    content,
    evidence,
    warnings: [],
    series: { kind: 'interview_prep', applicationId, stage },
    auditAction: 'interview_prep.created',
    auditPayload: { applicationId, stage }
  });
  return { ...artifact, applicationId, jobId: job.id, profileId: prof.id, stage, note: 'Interview prep packet created for human review.' };
}
