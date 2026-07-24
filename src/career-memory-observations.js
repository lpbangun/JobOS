import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import {
  all,
  guardedWrite,
  one,
  projectAudit,
  queuePostCommit,
  recordAudit,
  run,
} from './db.js';
import { listInterviewObservations } from './interview.js';
import { listLifecycleObservations } from './lifecycle.js';
import { listOutreachOutcomes } from './outreach-outcomes.js';
import { now } from './utils.js';
import {
  ARTIFACT_FEEDBACK_INPUT_SCHEMA,
  CAREER_MEMORY_OBSERVATION_LIST_SCHEMA,
  CAREER_MEMORY_OBSERVATION_SCHEMA,
  JOB_FEEDBACK_INPUT_SCHEMA,
  MEMORY_EVENT_TYPES,
  MEMORY_SOURCES,
  canonicalHash,
  canonicalJson,
  memoryObservationId,
  normalizeArtifactFeedbackInput,
  normalizeJobFeedbackInput,
  normalizeRfc3339,
} from './career-memory-contract.js';

const DAY_MS = 86_400_000;
const ADAPTER_END = new Date('9999-12-31T23:59:59.999Z');
const ADAPTER_DAYS = Math.ceil(ADAPTER_END.getTime() / DAY_MS) + 1;
const NATIVE_SOURCES = new Set(['cli', 'tui']);
const NON_ATTRIBUTABLE_ACTORS = new Set(['unknown', 'unknown_legacy', 'legacy', 'system']);
const JOB_EVENT_BY_DECISION = Object.freeze({
  save: 'job_saved',
  skip: 'job_skipped',
  apply: 'job_applied',
});
const JOB_STATUS_BY_DECISION = Object.freeze({ save: 'saved', skip: 'archived' });
const ARTIFACT_DECISION_BY_EVENT = Object.freeze({
  artifact_approved: 'approve',
  artifact_rejected: 'reject',
  artifact_edited: 'edit',
});
const APPLIED_OR_LATER = new Set([
  'applied',
  'recruiter-screen',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
]);
const ARTIFACT_ACTION_BY_EVENT = Object.freeze({
  artifact_approved: 'artifact.approved',
  artifact_rejected: 'artifact.rejected',
  artifact_edited: 'artifact.edited',
});
const ARTIFACT_SIGNAL_REASONS = Object.freeze({
  tone: ['tone'],
  length: ['length'],
  opening: ['opening'],
  closing: ['closing'],
  avoid_term: ['vocabulary'],
  avoid_claim: ['unsupported_claim', 'factual_error'],
  positioning_priority: ['positioning', 'evidence_selection', 'specificity'],
  approved_exemplar: ['evidence_selection'],
});
const COMMON_EVENT_TYPES = Object.freeze([
  ...MEMORY_EVENT_TYPES,
  'reply_positive',
  'reply_neutral',
  'reply_negative',
  'meeting_booked',
  'no_response',
  'bounced',
  'declined',
  'application_status_changed',
  'submission_attested',
  'configured_submission_confirmed',
  'receipt_confirmed',
  'interview_debrief_recorded',
]);
const eventPositions = new Map(COMMON_EVENT_TYPES.map((value, index) => [value, index]));

export class CareerMemoryObservationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CareerMemoryObservationError';
    this.code = code;
    this.type = 'validation';
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CareerMemoryObservationError(code, message, details);
}

function text(value, field, { allowEmpty = false, lower = false } = {}) {
  if (typeof value !== 'string') fail('memory_required_field', `${field} is required.`, { field });
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!allowEmpty && !normalized) fail('memory_required_field', `${field} is required.`, { field });
  return lower ? normalized.toLowerCase() : normalized;
}

function optionalText(value, field) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, field, { allowEmpty: true });
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function exactObject(value, allowed, field) {
  canonicalJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('memory_contract_invalid', `${field} must be an object.`, { field });
  }
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length) fail('memory_unknown_key', `${field} contains unknown keys: ${unknown.join(', ')}.`, { field, unknown });
  return value;
}

function validNowDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail('memory_timestamp_invalid', 'nowDate must be a valid Date.', { field: 'nowDate' });
  }
  return value;
}

function requireProfile(s, profileId) {
  const owner = text(profileId, 'profileId');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [owner])) {
    fail('memory_profile_unknown', `Unknown profile: ${owner}.`, { profileId: owner });
  }
  return owner;
}

function normalizeActor(actor) {
  const value = text(actor, 'actor');
  if (NON_ATTRIBUTABLE_ACTORS.has(value.toLowerCase())) {
    fail('memory_actor_invalid', 'actor must identify the user who made the decision.', { actor: value });
  }
  return value;
}

function normalizeNativeSource(source) {
  const value = text(source, 'source', { lower: true });
  if (!MEMORY_SOURCES.includes(value) || !NATIVE_SOURCES.has(value)) {
    fail('memory_source_invalid', 'W08 observations can be recorded only by trusted CLI or TUI human flows.', { source: value });
  }
  return value;
}

function compareObservation(left, right) {
  return right.occurredAt.localeCompare(left.occurredAt)
    || right.recordedAt.localeCompare(left.recordedAt)
    || left.id.localeCompare(right.id);
}

function jobSourceContent(job) {
  return {
    id: job.id,
    profileId: job.profile_id,
    status: job.status,
    title: job.title,
    company: job.company,
    location: job.location || '',
    workModel: job.work_model || '',
    compensation: job.compensation || '',
    description: job.description,
    requirements: parseJson(job.requirements_json, []),
    department: job.department || '',
    postedDate: job.posted_date || '',
  };
}

function latestJobStatusEvent(s, jobId) {
  return one(s, `SELECT * FROM audit_log
    WHERE action='job.status_changed' AND entity_type='job' AND entity_id=?
    ORDER BY rowid DESC LIMIT 1`, [jobId]);
}

function resolveJobSource(s, { profileId, jobId, decision, expected = null }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) fail('memory_source_unknown', `Unknown job: ${jobId}.`, { jobId });
  if (job.profile_id !== profileId) {
    fail('memory_profile_source_mismatch', `Job ${jobId} does not belong to profile ${profileId}.`, { profileId, jobId });
  }
  const requiredStatus = JOB_STATUS_BY_DECISION[decision];
  const statusEvent = latestJobStatusEvent(s, jobId);
  const eventPayload = parseJson(statusEvent?.payload_json, {});
  if (job.status !== requiredStatus || !statusEvent || eventPayload.status !== requiredStatus) {
    fail('memory_source_state_invalid', `Job ${jobId} is not in the canonical ${requiredStatus} state.`, {
      jobId,
      expectedStatus: requiredStatus,
      actualStatus: job.status,
    });
  }
  const source = {
    type: 'job',
    id: job.id,
    versionId: statusEvent.id,
    revision: null,
    contentHash: canonicalHash(jobSourceContent(job)),
  };
  if (expected && canonicalJson(source) !== canonicalJson(expected)) {
    fail('memory_source_version_stale', `Job ${jobId} no longer matches observation source version ${expected.versionId}.`, {
      jobId,
      expected,
      current: source,
    });
  }
  return { job, source };
}

function resolveApplicationSource(s, { profileId, jobId, expected = null }) {
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) fail('memory_source_unknown', `Unknown job: ${jobId}.`, { jobId });
  if (job.profile_id !== profileId) {
    fail('memory_profile_source_mismatch', `Job ${jobId} does not belong to profile ${profileId}.`, { profileId, jobId });
  }
  const application = one(s, 'SELECT * FROM applications WHERE profile_id=? AND job_id=?', [profileId, jobId]);
  if (!application || !APPLIED_OR_LATER.has(application.status)) {
    fail('memory_source_state_invalid', `Job ${jobId} has no owned application at applied-or-later status.`, {
      profileId,
      jobId,
      applicationStatus: application?.status || null,
    });
  }
  const receipt = one(s, `SELECT * FROM application_receipts WHERE application_id=?
    ORDER BY CASE type WHEN 'user_attestation' THEN 0 WHEN 'adapter_receipt' THEN 1 ELSE 2 END,
    recorded_at DESC,id DESC LIMIT 1`, [application.id]);
  if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.receipt_hash)) {
    fail('memory_source_state_invalid', `Application ${application.id} has no valid immutable receipt evidence.`, {
      applicationId: application.id,
    });
  }
  const source = {
    type: 'application',
    id: application.id,
    versionId: receipt.id,
    revision: null,
    contentHash: receipt.receipt_hash,
  };
  if (expected && canonicalJson(source) !== canonicalJson(expected)) {
    fail('memory_source_version_stale', `Application ${application.id} no longer matches observation source version ${expected.versionId}.`, {
      applicationId: application.id,
      expected,
      current: source,
    });
  }
  return { application, job, receipt, source };
}

function currentArtifactRevision(s, artifact) {
  return one(s, 'SELECT MAX(revision) AS revision FROM artifacts WHERE series_key=?', [artifact.series_key])?.revision || 0;
}

function resolveArtifactSource(s, { profileId, artifactId, eventType, expected = null }) {
  const artifact = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!artifact) fail('memory_source_unknown', `Unknown artifact: ${artifactId}.`, { artifactId });
  if (artifact.profile_id !== profileId) {
    fail('memory_profile_source_mismatch', `Artifact ${artifactId} does not belong to profile ${profileId}.`, { profileId, artifactId });
  }
  const action = ARTIFACT_ACTION_BY_EVENT[eventType];
  if (!action) fail('memory_event_type_invalid', `Unsupported artifact observation event: ${eventType}.`, { eventType });
  const event = one(s, `SELECT * FROM audit_log WHERE action=? AND entity_type='artifact' AND entity_id=?
    ORDER BY created_at DESC,id DESC LIMIT 1`, [action, artifactId]);
  const requiredStatus = eventType === 'artifact_approved'
    ? 'approved'
    : eventType === 'artifact_rejected' ? 'rejected' : null;
  const revisionCurrent = Number(currentArtifactRevision(s, artifact)) === Number(artifact.revision);
  if (!event || (requiredStatus && artifact.approval_status !== requiredStatus) || (eventType === 'artifact_edited' && !revisionCurrent)) {
    fail('memory_source_state_invalid', `Artifact ${artifactId} is not current for ${eventType}.`, {
      artifactId,
      eventType,
      approvalStatus: artifact.approval_status,
      revisionCurrent,
    });
  }
  const source = {
    type: 'artifact',
    id: artifact.id,
    versionId: event.id,
    revision: Number(artifact.revision),
    contentHash: artifact.content_hash,
  };
  if (expected && canonicalJson(source) !== canonicalJson(expected)) {
    fail('memory_source_version_stale', `Artifact ${artifactId} no longer matches observation source version ${expected.versionId}.`, {
      artifactId,
      expected,
      current: source,
    });
  }
  return { artifact, source };
}

function canonicalCandidateValues(job, field) {
  const native = parseJson(job.source_native_json, {});
  const parsedRequirements = parseJson(job.requirements_json, []);
  const requirements = Array.isArray(parsedRequirements)
    ? parsedRequirements
    : Object.values(parsedRequirements || {}).flatMap(value => Array.isArray(value) ? value : []);
  const requirementText = requirements.flatMap(item => {
    if (typeof item === 'string') return [item];
    if (!item || typeof item !== 'object') return [];
    return [item.text, item.requirement, item.name, item.skill].filter(Boolean);
  });
  const values = {
    role_family: [job.title],
    seniority: [job.title],
    company_stage: [native.companyStage, native.company_stage],
    industry: [native.industry],
    mission: [native.mission, job.description],
    location: [job.location],
    work_model: [job.work_model],
    compensation: [job.compensation],
    skill: requirementText,
    timing: [job.posted_date],
    trust_risk: [job.liveness_status],
  }[field] || [];
  return values.map(value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
}

function tokenMatch(candidate, signalValue) {
  const tokens = signalValue.split(/[^a-z0-9]+/).filter(Boolean);
  const candidateTokens = new Set(candidate.split(/[^a-z0-9]+/).filter(Boolean));
  return tokens.length > 0 && tokens.every(token => candidateTokens.has(token));
}

function validateJobSignals(job, signals) {
  for (const signal of signals) {
    const candidates = canonicalCandidateValues(job, signal.field);
    const matched = signal.match === 'exact'
      ? candidates.includes(signal.value)
      : candidates.some(candidate => tokenMatch(candidate, signal.value));
    if (!matched) {
      fail('memory_signal_source_mismatch', `Signal ${signal.field}=${signal.value} is not present in the canonical job source.`, {
        field: signal.field,
        value: signal.value,
        match: signal.match,
        jobId: job.id,
      });
    }
  }
}

function validateArtifactSignals(reasonCodes, signals) {
  for (const signal of signals) {
    const allowedReasons = ARTIFACT_SIGNAL_REASONS[signal.ruleType] || [];
    if (!allowedReasons.some(reason => reasonCodes.includes(reason))) {
      fail('memory_signal_reason_mismatch', `Signal ${signal.ruleType} is not supported by the selected artifact feedback reasons.`, {
        ruleType: signal.ruleType,
        reasonCodes,
      });
    }
  }
}

function normalizeSourceEntity(value) {
  const input = exactObject(value, ['type', 'id', 'versionId', 'revision', 'contentHash'], 'sourceEntity');
  const type = text(input.type, 'sourceEntity.type', { lower: true });
  if (!['job', 'application', 'artifact'].includes(type)) {
    fail('memory_source_entity_invalid', 'Phase 2 native observations require a job, application, or artifact source.', { type });
  }
  const revision = input.revision === null ? null : Number(input.revision);
  if (revision !== null && (!Number.isInteger(revision) || revision < 1)) {
    fail('memory_source_revision_invalid', 'sourceEntity.revision must be null or a positive integer.', { revision: input.revision });
  }
  const contentHash = text(input.contentHash, 'sourceEntity.contentHash', { lower: true });
  if (!/^[a-f0-9]{64}$/.test(contentHash)) {
    fail('memory_source_hash_invalid', 'sourceEntity.contentHash must be a full lowercase SHA-256 hash.');
  }
  return {
    type,
    id: text(input.id, 'sourceEntity.id'),
    versionId: text(input.versionId, 'sourceEntity.versionId'),
    revision,
    contentHash,
  };
}

function validateExactSource(s, input) {
  if (input.sourceEntity.type === 'job') {
    const decision = Object.entries(JOB_EVENT_BY_DECISION).find(([, eventType]) => eventType === input.eventType)?.[0];
    if (!decision || decision === 'apply') {
      fail('memory_source_event_mismatch', `${input.eventType} is not a job-status-backed event.`, { eventType: input.eventType });
    }
    return resolveJobSource(s, {
      profileId: input.profileId,
      jobId: input.sourceEntity.id,
      decision,
      expected: input.sourceEntity,
    });
  }
  if (input.sourceEntity.type === 'application') {
    if (input.eventType !== 'job_applied') {
      fail('memory_source_event_mismatch', `${input.eventType} is not an application-backed job event.`, { eventType: input.eventType });
    }
    const application = one(s, 'SELECT job_id FROM applications WHERE id=? AND profile_id=?', [
      input.sourceEntity.id,
      input.profileId,
    ]);
    if (!application) {
      fail('memory_profile_source_mismatch', `Application ${input.sourceEntity.id} does not belong to profile ${input.profileId}.`, {
        profileId: input.profileId,
        applicationId: input.sourceEntity.id,
      });
    }
    return resolveApplicationSource(s, {
      profileId: input.profileId,
      jobId: application.job_id,
      expected: input.sourceEntity,
    });
  }
  return resolveArtifactSource(s, {
    profileId: input.profileId,
    artifactId: input.sourceEntity.id,
    eventType: input.eventType,
    expected: input.sourceEntity,
  });
}
function rowPublicProjection(row, current) {
  const sourceEntity = {
    type: row.source_entity_type,
    id: row.source_entity_id,
    versionId: row.source_version_id,
    revision: row.source_revision === null ? null : Number(row.source_revision),
    contentHash: row.source_content_hash,
  };
  return {
    schema: CAREER_MEMORY_OBSERVATION_SCHEMA,
    id: row.id,
    profileId: row.profile_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    sourceEntity,
    reasonCodes: parseJson(row.reason_codes_json, []),
    signals: parseJson(row.signal_json, []),
    publicExplanation: row.public_explanation || '',
    hasPrivateNote: Boolean(row.private_note),
    current,
    supersedesObservationId: row.supersedes_observation_id || null,
    payload: parseJson(row.payload_json, {}),
    interpretation: 'attributed_observation_only_no_preference_or_causal_claim',
    externalSideEffects: 'none',
  };
}

function operationResult(projection, idempotent) {
  Object.defineProperty(projection, 'idempotent', {
    value: idempotent,
    enumerable: false,
  });
  return projection;
}

function resolveJobFeedbackSource(s, { profileId, jobId, decision }) {
  return decision === 'apply'
    ? resolveApplicationSource(s, { profileId, jobId })
    : resolveJobSource(s, { profileId, jobId, decision });
}

function nativeRows(s, profileId) {
  const rows = all(s, `SELECT o.*,
    EXISTS(SELECT 1 FROM career_memory_observations successor
      WHERE successor.supersedes_observation_id=o.id) AS has_successor
    FROM career_memory_observations o WHERE o.profile_id=?`, [profileId]);
  return rows.map(row => ({ row, projection: rowPublicProjection(row, !Boolean(row.has_successor)) }));
}

function integrityInput(input) {
  const publicInput = {
    profileId: input.profileId,
    eventType: input.eventType,
    sourceSchema: input.sourceSchema,
    sourceEntity: input.sourceEntity,
    occurredAt: input.occurredAt,
    actor: input.actor,
    source: input.source,
    reasonCodes: input.reasonCodes,
    signals: input.signals,
    publicExplanation: input.publicExplanation,
    payload: input.payload,
    referenceId: input.referenceId,
    supersedesObservationId: input.supersedesObservationId,
    undoesObservationId: input.undoesObservationId,
    correctionReason: input.correctionReason,
  };
  return {
    publicHash: canonicalHash(publicInput),
    privateNoteHash: canonicalHash(input.privateNote),
  };
}

function normalizeAppendInput(value) {
  const input = exactObject(value, [
    'profileId',
    'eventType',
    'sourceSchema',
    'sourceEntity',
    'occurredAt',
    'actor',
    'source',
    'reasonCodes',
    'signals',
    'publicExplanation',
    'privateNote',
    'payload',
    'referenceId',
    'supersedesObservationId',
    'undoesObservationId',
    'correctionReason',
  ], 'observation');
  const eventType = text(input.eventType, 'eventType', { lower: true });
  if (!MEMORY_EVENT_TYPES.includes(eventType)) fail('memory_event_type_invalid', `Unsupported W08 event type: ${eventType}.`, { eventType });
  const sourceSchema = text(input.sourceSchema, 'sourceSchema');
  if (![JOB_FEEDBACK_INPUT_SCHEMA, ARTIFACT_FEEDBACK_INPUT_SCHEMA].includes(sourceSchema)) {
    fail('memory_source_schema_invalid', `Unsupported native observation schema: ${sourceSchema}.`, { sourceSchema });
  }
  const normalized = {
    profileId: text(input.profileId, 'profileId'),
    eventType,
    sourceSchema,
    sourceEntity: normalizeSourceEntity(input.sourceEntity),
    occurredAt: normalizeRfc3339(input.occurredAt, 'occurredAt'),
    actor: normalizeActor(input.actor),
    source: normalizeNativeSource(input.source),
    reasonCodes: input.reasonCodes,
    signals: input.signals,
    publicExplanation: optionalText(input.publicExplanation, 'publicExplanation'),
    privateNote: optionalText(input.privateNote, 'privateNote'),
    payload: input.payload,
    referenceId: text(input.referenceId, 'referenceId'),
    supersedesObservationId: input.supersedesObservationId ? text(input.supersedesObservationId, 'supersedesObservationId') : null,
    undoesObservationId: input.undoesObservationId ? text(input.undoesObservationId, 'undoesObservationId') : null,
    correctionReason: optionalText(input.correctionReason, 'correctionReason'),
  };
  const payloadInput = exactObject(normalized.payload, ['decision'], 'payload');
  const payloadDecision = text(payloadInput.decision, 'payload.decision', { lower: true });
  if (normalized.sourceSchema === JOB_FEEDBACK_INPUT_SCHEMA) {
    const normalizedFeedback = normalizeJobFeedbackInput({
      schema: JOB_FEEDBACK_INPUT_SCHEMA,
      decision: payloadDecision,
      reasonCodes: normalized.reasonCodes,
      signals: normalized.signals,
      publicExplanation: normalized.publicExplanation,
      privateNote: normalized.privateNote,
      referenceId: normalized.referenceId,
      occurredAt: normalized.occurredAt,
    });
    if (JOB_EVENT_BY_DECISION[normalizedFeedback.decision] !== normalized.eventType) {
      fail('memory_source_event_mismatch', `Job decision ${normalizedFeedback.decision} does not match ${normalized.eventType}.`, {
        decision: normalizedFeedback.decision,
        eventType: normalized.eventType,
      });
    }
    Object.assign(normalized, {
      reasonCodes: normalizedFeedback.reasonCodes,
      signals: normalizedFeedback.signals,
      publicExplanation: normalizedFeedback.publicExplanation,
      privateNote: normalizedFeedback.privateNote,
      payload: { decision: normalizedFeedback.decision },
    });
  } else {
    const decision = ARTIFACT_DECISION_BY_EVENT[normalized.eventType];
    if (payloadDecision !== decision) {
      fail('memory_source_event_mismatch', `Artifact decision ${payloadDecision} does not match ${normalized.eventType}.`, {
        decision: payloadDecision,
        eventType: normalized.eventType,
      });
    }
    const normalizedFeedback = normalizeArtifactFeedbackInput({
      schema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
      reasonCodes: normalized.reasonCodes,
      signals: normalized.signals,
      publicExplanation: normalized.publicExplanation,
      privateNote: normalized.privateNote,
      referenceId: normalized.referenceId,
    }, { decision });
    validateArtifactSignals(normalizedFeedback.reasonCodes, normalizedFeedback.signals);
    Object.assign(normalized, {
      reasonCodes: normalizedFeedback.reasonCodes,
      signals: normalizedFeedback.signals,
      publicExplanation: normalizedFeedback.publicExplanation,
      privateNote: normalizedFeedback.privateNote,
      payload: { decision },
    });
  }
  if (normalized.sourceEntity.type === 'job' && normalized.sourceSchema !== JOB_FEEDBACK_INPUT_SCHEMA) {
    fail('memory_source_schema_mismatch', 'Job observations require the job feedback schema.');
  }
  if (normalized.sourceEntity.type === 'application' && normalized.sourceSchema !== JOB_FEEDBACK_INPUT_SCHEMA) {
    fail('memory_source_schema_mismatch', 'Application-backed job observations require the job feedback schema.');
  }
  if (normalized.sourceEntity.type === 'artifact' && normalized.sourceSchema !== ARTIFACT_FEEDBACK_INPUT_SCHEMA) {
    fail('memory_source_schema_mismatch', 'Artifact observations require the artifact feedback schema.');
  }
  if (normalized.supersedesObservationId && !normalized.correctionReason) {
    fail('memory_correction_reason_required', 'A correction reason is required when superseding an observation.');
  }
  if (!normalized.supersedesObservationId && normalized.correctionReason) {
    fail('memory_correction_target_required', 'correctionReason requires supersedesObservationId.');
  }
  if (normalized.undoesObservationId && normalized.undoesObservationId !== normalized.supersedesObservationId) {
    fail('memory_undo_target_invalid', 'Undo restorations must supersede the observation they undo.');
  }
  canonicalJson(normalized.payload);
  return normalized;
}

function existingByReference(s, profileId, referenceId) {
  return one(s, 'SELECT * FROM career_memory_observations WHERE profile_id=? AND reference_id=?', [profileId, referenceId]);
}

function prepareAppend(s, value) {
  const input = normalizeAppendInput(value);
  requireProfile(s, input.profileId);
  const resolved = validateExactSource(s, input);
  if (['job', 'application'].includes(input.sourceEntity.type)) validateJobSignals(resolved.job, input.signals);
  return { input, observationHash: canonicalHash(integrityInput(input)) };
}

function referencedReplay(s, input, observationHash) {
  const existing = existingByReference(s, input.profileId, input.referenceId);
  if (!existing) return null;
  if (existing.observation_hash !== observationHash) {
    fail('memory_reference_conflict', `Reference ${input.referenceId} already identifies different observation content.`, {
      profileId: input.profileId,
      referenceId: input.referenceId,
    });
  }
  const hasSuccessor = one(s, 'SELECT id FROM career_memory_observations WHERE supersedes_observation_id=?', [existing.id]);
  return operationResult(rowPublicProjection(existing, !hasSuccessor), true);
}

function preflightReplay(s, value) {
  const prepared = prepareAppend(s, value);
  return referencedReplay(s, prepared.input, prepared.observationHash);
}

function assertSuccessorTarget(s, input) {
  if (!input.supersedesObservationId) return;
  const target = one(s, 'SELECT * FROM career_memory_observations WHERE id=? AND profile_id=?', [
    input.supersedesObservationId,
    input.profileId,
  ]);
  if (!target) fail('memory_observation_unknown', `Unknown observation: ${input.supersedesObservationId}.`);
  if (one(s, 'SELECT id FROM career_memory_observations WHERE supersedes_observation_id=?', [target.id])) {
    fail('memory_observation_not_current', `Observation ${target.id} already has a successor.`, { observationId: target.id });
  }
  if (target.event_type !== input.eventType
    || target.source_schema !== input.sourceSchema
    || target.source_entity_type !== input.sourceEntity.type
    || target.source_entity_id !== input.sourceEntity.id
    || target.source_version_id !== input.sourceEntity.versionId) {
    fail('memory_correction_source_mismatch', 'Correction and undo rows must retain the original source identity.', {
      observationId: target.id,
    });
  }
}

export function appendMemoryObservation(s, value) {
  if (!s._inGuardedWrite) fail('memory_transaction_required', 'appendMemoryObservation must run inside guardedWrite.');
  const { input, observationHash } = prepareAppend(s, value);
  const replay = referencedReplay(s, input, observationHash);
  if (replay) return replay;
  assertSuccessorTarget(s, input);
  const observationId = memoryObservationId({
    profileId: input.profileId,
    sourceSchema: input.sourceSchema,
    sourceEntityType: input.sourceEntity.type,
    sourceEntityId: input.sourceEntity.id,
    sourceVersionId: input.sourceEntity.versionId,
    eventType: input.eventType,
    referenceId: input.referenceId,
  });
  const recordedAt = now();
  run(s, `INSERT INTO career_memory_observations (
    id,profile_id,schema_version,event_type,source_schema,source_entity_type,
    source_entity_id,source_version_id,source_revision,source_content_hash,
    occurred_at,recorded_at,actor,source,reason_codes_json,signal_json,
    public_explanation,private_note,payload_json,reference_id,
    supersedes_observation_id,undoes_observation_id,correction_reason,observation_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    observationId,
    input.profileId,
    1,
    input.eventType,
    input.sourceSchema,
    input.sourceEntity.type,
    input.sourceEntity.id,
    input.sourceEntity.versionId,
    input.sourceEntity.revision,
    input.sourceEntity.contentHash,
    input.occurredAt,
    recordedAt,
    input.actor,
    input.source,
    canonicalJson(input.reasonCodes),
    canonicalJson(input.signals),
    input.publicExplanation,
    input.privateNote,
    canonicalJson(input.payload),
    input.referenceId,
    input.supersedesObservationId,
    input.undoesObservationId,
    input.correctionReason,
    observationHash,
  ]);
  const created = one(s, 'SELECT * FROM career_memory_observations WHERE id=?', [observationId]);
  return operationResult(rowPublicProjection(created, true), false);
}

function queueObservationProjections(s, profileId, event) {
  queuePostCommit(s, () => syncMemoryObservations(s, profileId));
  queuePostCommit(s, () => projectAudit(s, event));
}

function observationAudit(s, action, observation) {
  const row = one(s, 'SELECT * FROM career_memory_observations WHERE id=?', [observation.id]);
  return recordAudit(s, action, 'career_memory_observation', observation.id, {
    profileId: observation.profileId,
    eventType: observation.eventType,
    sourceSchema: row.source_schema,
    sourceEntity: observation.sourceEntity,
    reasonCodes: observation.reasonCodes,
    signals: observation.signals,
    publicExplanation: observation.publicExplanation,
    hasPrivateNote: observation.hasPrivateNote,
    referenceId: row.reference_id,
    supersedesObservationId: row.supersedes_observation_id || null,
    undoesObservationId: row.undoes_observation_id || null,
    correctionReason: row.correction_reason || '',
    observationHash: row.observation_hash,
  }, 'none');
}

function jobObservationInput(owner, feedback, sourceEntity, actor, source) {
  return {
    profileId: owner,
    eventType: JOB_EVENT_BY_DECISION[feedback.decision],
    sourceSchema: JOB_FEEDBACK_INPUT_SCHEMA,
    sourceEntity,
    occurredAt: feedback.occurredAt,
    actor,
    source,
    reasonCodes: feedback.reasonCodes,
    signals: feedback.signals,
    publicExplanation: feedback.publicExplanation,
    privateNote: feedback.privateNote,
    payload: { decision: feedback.decision },
    referenceId: feedback.referenceId,
  };
}

export function recordJobFeedback(s, { profileId, jobId, input, actor, source }) {
  const owner = requireProfile(s, profileId);
  const feedback = normalizeJobFeedbackInput(input);
  const identity = resolveJobFeedbackSource(s, {
    profileId: owner,
    jobId: text(jobId, 'jobId'),
    decision: feedback.decision,
  });
  validateJobSignals(identity.job, feedback.signals);
  const replay = preflightReplay(s, jobObservationInput(owner, feedback, identity.source, actor, source));
  if (replay) return replay;
  return guardedWrite(s, () => {
    const current = resolveJobFeedbackSource(s, {
      profileId: owner,
      jobId: identity.job.id,
      decision: feedback.decision,
    });
    validateJobSignals(current.job, feedback.signals);
    const observation = appendMemoryObservation(
      s,
      jobObservationInput(owner, feedback, current.source, actor, source),
    );
    if (observation.idempotent) return observation;
    const event = observationAudit(s, 'career_memory.observation_recorded', observation);
    queueObservationProjections(s, owner, event);
    return observation;
  });
}

function normalizeReplacement(row, replacement, { referenceId, occurredAt }) {
  const input = exactObject(replacement, ['reasonCodes', 'signals', 'publicExplanation', 'privateNote'], 'replacement');
  const payload = parseJson(row.payload_json, {});
  if (row.source_schema === JOB_FEEDBACK_INPUT_SCHEMA) {
    return normalizeJobFeedbackInput({
      schema: JOB_FEEDBACK_INPUT_SCHEMA,
      decision: payload.decision,
      reasonCodes: input.reasonCodes,
      signals: input.signals,
      publicExplanation: input.publicExplanation,
      privateNote: input.privateNote,
      referenceId,
      occurredAt,
    });
  }
  return normalizeArtifactFeedbackInput({
    schema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
    reasonCodes: input.reasonCodes,
    signals: input.signals,
    publicExplanation: input.publicExplanation,
    privateNote: input.privateNote,
    referenceId,
  }, { decision: payload.decision });
}

function sourceEntityFromRow(row) {
  return {
    type: row.source_entity_type,
    id: row.source_entity_id,
    versionId: row.source_version_id,
    revision: row.source_revision === null ? null : Number(row.source_revision),
    contentHash: row.source_content_hash,
  };
}

function correctionObservationInput(target, replacement, {
  owner,
  correctionReason,
  referenceId,
  actor,
  source,
  occurredAt,
}) {
  const normalized = normalizeReplacement(target, replacement, { referenceId, occurredAt });
  if (target.source_schema === ARTIFACT_FEEDBACK_INPUT_SCHEMA) {
    validateArtifactSignals(normalized.reasonCodes, normalized.signals);
  }
  return {
    profileId: owner,
    eventType: target.event_type,
    sourceSchema: target.source_schema,
    sourceEntity: sourceEntityFromRow(target),
    occurredAt,
    actor,
    source,
    reasonCodes: normalized.reasonCodes,
    signals: normalized.signals,
    publicExplanation: normalized.publicExplanation,
    privateNote: normalized.privateNote,
    payload: parseJson(target.payload_json, {}),
    referenceId,
    supersedesObservationId: target.id,
    correctionReason,
  };
}

function requireOwnedObservation(s, owner, observationId) {
  const row = one(s, 'SELECT * FROM career_memory_observations WHERE id=? AND profile_id=?', [observationId, owner]);
  if (!row) fail('memory_observation_unknown', `Unknown observation: ${observationId}.`, { observationId });
  return row;
}


export function correctMemoryObservation(s, {
  profileId,
  observationId,
  replacement,
  reason,
  referenceId,
  actor,
  source,
  occurredAt,
}) {
  const owner = requireProfile(s, profileId);
  const targetId = text(observationId, 'observationId');
  const correctionReason = text(reason, 'reason');
  const normalizedReference = text(referenceId, 'referenceId');
  const normalizedOccurredAt = normalizeRfc3339(occurredAt, 'occurredAt');
  const options = {
    owner,
    correctionReason,
    referenceId: normalizedReference,
    actor,
    source,
    occurredAt: normalizedOccurredAt,
  };
  const initialTarget = requireOwnedObservation(s, owner, targetId);
  const replay = preflightReplay(s, correctionObservationInput(initialTarget, replacement, options));
  if (replay) return replay;
  return guardedWrite(s, () => {
    const target = requireOwnedObservation(s, owner, targetId);
    const observation = appendMemoryObservation(s, correctionObservationInput(target, replacement, options));
    if (observation.idempotent) return observation;
    const event = observationAudit(s, 'career_memory.observation_corrected', observation);
    queueObservationProjections(s, owner, event);
    return observation;
  });
}

function undoObservationInput(target, previous, {
  owner,
  correctionReason,
  referenceId,
  actor,
  source,
  occurredAt,
}) {
  return {
    profileId: owner,
    eventType: target.event_type,
    sourceSchema: target.source_schema,
    sourceEntity: sourceEntityFromRow(target),
    occurredAt,
    actor,
    source,
    reasonCodes: parseJson(previous.reason_codes_json, []),
    signals: parseJson(previous.signal_json, []),
    publicExplanation: previous.public_explanation || '',
    privateNote: '',
    payload: parseJson(previous.payload_json, {}),
    referenceId,
    supersedesObservationId: target.id,
    undoesObservationId: target.id,
    correctionReason,
  };
}

function undoRows(s, owner, targetId) {
  const target = requireOwnedObservation(s, owner, targetId);
  if (!target.supersedes_observation_id) {
    fail('memory_undo_target_invalid', 'Only a current correction or restoration can be undone.', { observationId: target.id });
  }
  const previous = one(s, 'SELECT * FROM career_memory_observations WHERE id=? AND profile_id=?', [
    target.supersedes_observation_id,
    owner,
  ]);
  if (!previous) fail('memory_undo_target_invalid', `Observation ${target.id} has no restorable predecessor.`);
  return { target, previous };
}

export function undoMemoryObservation(s, {
  profileId,
  observationId,
  reason,
  referenceId,
  actor,
  source,
  occurredAt,
}) {
  const owner = requireProfile(s, profileId);
  const targetId = text(observationId, 'observationId');
  const correctionReason = text(reason, 'reason');
  const normalizedReference = text(referenceId, 'referenceId');
  const normalizedOccurredAt = normalizeRfc3339(occurredAt, 'occurredAt');
  const options = {
    owner,
    correctionReason,
    referenceId: normalizedReference,
    actor,
    source,
    occurredAt: normalizedOccurredAt,
  };
  const initial = undoRows(s, owner, targetId);
  const replay = preflightReplay(s, undoObservationInput(initial.target, initial.previous, options));
  if (replay) return replay;
  return guardedWrite(s, () => {
    const current = undoRows(s, owner, targetId);
    const observation = appendMemoryObservation(s, undoObservationInput(current.target, current.previous, options));
    if (observation.idempotent) return observation;
    const event = observationAudit(s, 'career_memory.observation_undone', observation);
    queueObservationProjections(s, owner, event);
    return observation;
  });
}

export function getMemoryObservation(s, { profileId, observationId, includePrivateNote = false }) {
  const owner = requireProfile(s, profileId);
  const targetId = text(observationId, 'observationId');
  const row = one(s, `SELECT o.*,
    EXISTS(SELECT 1 FROM career_memory_observations successor
      WHERE successor.supersedes_observation_id=o.id) AS has_successor
    FROM career_memory_observations o WHERE o.id=? AND o.profile_id=?`, [targetId, owner]);
  if (!row) fail('memory_observation_unknown', `Unknown observation: ${targetId}.`, { observationId: targetId });
  const projection = rowPublicProjection(row, !Boolean(row.has_successor));
  if (includePrivateNote) projection.privateNote = row.private_note || '';
  return projection;
}

function adaptOutreach(s, profileId) {
  const outcomes = listOutreachOutcomes(s, {
    profileId,
    sinceDays: null,
    includeNotes: false,
    nowDate: ADAPTER_END,
  }).outcomes;
  return outcomes.map(outcome => {
    const immutable = {
      schema: outcome.schema,
      id: outcome.id,
      threadId: outcome.threadId,
      profileId: outcome.profileId,
      jobId: outcome.jobId,
      stakeholderId: outcome.stakeholderId,
      contactId: outcome.contactId,
      roleClass: outcome.roleClass,
      contactTier: outcome.contactTier,
      contactPath: outcome.contactPath,
      channel: outcome.channel,
      outcomeType: outcome.outcomeType,
      occurredAt: outcome.occurredAt,
      recordedAt: outcome.recordedAt,
      actor: outcome.actor,
      source: outcome.source,
      referenceId: outcome.referenceId,
      supersedesOutcomeId: outcome.supersedesOutcomeId,
      correctionReason: outcome.correctionReason,
    };
    return {
      schema: CAREER_MEMORY_OBSERVATION_SCHEMA,
      id: outcome.id,
      profileId,
      eventType: outcome.outcomeType,
      occurredAt: outcome.occurredAt,
      recordedAt: outcome.recordedAt,
      actor: outcome.actor,
      source: 'w05_adapter',
      sourceEntity: {
        type: 'outreach_thread',
        id: outcome.threadId,
        versionId: outcome.id,
        revision: null,
        contentHash: canonicalHash(immutable),
      },
      reasonCodes: [],
      signals: [],
      publicExplanation: '',
      hasPrivateNote: false,
      current: outcome.current,
      supersedesObservationId: outcome.supersedesOutcomeId,
      payload: {
        jobId: outcome.jobId,
        stakeholderId: outcome.stakeholderId,
        contactId: outcome.contactId,
        roleClass: outcome.roleClass,
        contactTier: outcome.contactTier,
        contactPath: outcome.contactPath,
        channel: outcome.channel,
        windowEndAt: outcome.windowEndAt,
      },
      interpretation: 'attributed_observation_only_no_preference_or_causal_claim',
      externalSideEffects: 'none',
    };
  });
}

function adaptLifecycle(s, profileId) {
  const observations = listLifecycleObservations(s, {
    profileId,
    sinceDays: ADAPTER_DAYS,
    nowDate: ADAPTER_END,
  }).observations;
  return observations.filter(observation => observation.type !== 'interview_debrief_recorded').map(observation => ({
    schema: CAREER_MEMORY_OBSERVATION_SCHEMA,
    id: observation.id,
    profileId,
    eventType: observation.type,
    occurredAt: observation.occurredAt,
    recordedAt: observation.occurredAt,
    actor: observation.actor,
    source: 'w06_adapter',
    sourceEntity: {
      type: 'application',
      id: observation.applicationId,
      versionId: observation.id,
      revision: null,
      contentHash: canonicalHash(observation),
    },
    reasonCodes: [],
    signals: [],
    publicExplanation: '',
    hasPrivateNote: false,
    current: true,
    supersedesObservationId: null,
    payload: {
      applicationId: observation.applicationId,
      jobId: observation.jobId,
      sourceEventId: observation.sourceEventId,
      ...(observation.type === 'application_status_changed'
        ? { fromStatus: observation.fromStatus, toStatus: observation.toStatus }
        : {}),
    },
    interpretation: 'attributed_observation_only_no_preference_or_causal_claim',
    externalSideEffects: 'none',
  }));
}

function adaptInterview(s, profileId) {
  const observations = listInterviewObservations(s, {
    profileId,
    sinceDays: null,
    nowDate: ADAPTER_END,
  }).observations;
  const observationIdsByVersion = new Map(observations.map(observation => [
    observation.sourceEntity.versionId,
    observation.id,
  ]));
  return observations.map(observation => {
    const immutable = {
      schema: observation.schema,
      version: observation.version,
      id: observation.id,
      debriefId: observation.debriefId,
      profileId: observation.profileId,
      jobId: observation.jobId,
      applicationId: observation.applicationId,
      interviewStage: observation.interviewStage,
      audience: observation.audience,
      sourceEntity: observation.sourceEntity,
      occurredAt: observation.occurredAt,
      recordedAt: observation.recordedAt,
      actor: observation.actor,
      source: observation.source,
      observedQuestions: observation.observedQuestions,
      observedOutcome: observation.observedOutcome,
      proofGaps: observation.proofGaps,
      storyUses: observation.storyUses,
    };
    return {
      schema: CAREER_MEMORY_OBSERVATION_SCHEMA,
      id: observation.id,
      profileId,
      eventType: 'interview_debrief_recorded',
      occurredAt: observation.occurredAt,
      recordedAt: observation.recordedAt,
      actor: observation.actor,
      source: 'w07_adapter',
      sourceEntity: {
        type: observation.sourceEntity.type,
        id: observation.sourceEntity.id,
        versionId: observation.sourceEntity.versionId,
        revision: observation.sourceEntity.revision,
        contentHash: canonicalHash(immutable),
      },
      reasonCodes: [],
      signals: [],
      publicExplanation: '',
      hasPrivateNote: false,
      current: observation.current,
      supersedesObservationId: observationIdsByVersion.get(observation.sourceEntity.supersedesVersionId) || null,
      payload: {
        jobId: observation.jobId,
        applicationId: observation.applicationId,
        interviewStage: observation.interviewStage,
        audience: observation.audience,
        observedQuestions: observation.observedQuestions,
        outcome: observation.observedOutcome,
        proofGaps: observation.proofGaps,
        storyUses: observation.storyUses,
      },
      interpretation: 'attributed_observation_only_no_preference_or_causal_claim',
      externalSideEffects: 'none',
    };
  });
}

function normalizedTypes(types) {
  if (types === null || types === undefined) return [];
  if (!Array.isArray(types)) fail('memory_types_invalid', 'types must be an array.');
  canonicalJson(types);
  const output = types.map((value, index) => {
    const normalized = text(value, `types[${index}]`, { lower: true });
    if (!eventPositions.has(normalized)) fail('memory_event_type_invalid', `Unsupported observation type: ${normalized}.`, { eventType: normalized });
    return normalized;
  });
  if (new Set(output).size !== output.length) fail('memory_event_type_duplicate', 'types must be unique.');
  return output.sort((left, right) => eventPositions.get(left) - eventPositions.get(right));
}

function collectObservations(s, profileId) {
  return [
    ...nativeRows(s, profileId).map(item => ({ ...item.projection, _privateNote: item.row.private_note || '' })),
    ...adaptOutreach(s, profileId),
    ...adaptLifecycle(s, profileId),
    ...adaptInterview(s, profileId),
  ];
}

export function listMemoryObservations(s, {
  profileId,
  types = null,
  sinceDays = 365,
  includeHistory = false,
  includePrivateNotes = false,
  nowDate = new Date(),
} = {}) {
  const owner = requireProfile(s, profileId);
  const endDate = validNowDate(nowDate);
  const normalized = normalizedTypes(types);
  let start = null;
  if (sinceDays !== null) {
    if (!Number.isInteger(sinceDays) || sinceDays < 0) {
      fail('memory_since_days_invalid', 'sinceDays must be a non-negative integer.', { sinceDays });
    }
    start = new Date(endDate.getTime() - sinceDays * DAY_MS).toISOString();
  }
  const end = endDate.toISOString();
  const allRows = collectObservations(s, owner);
  const typeMatch = row => normalized.length === 0 || normalized.includes(row.eventType);
  const periodMatch = row => (!start || row.occurredAt >= start) && row.occurredAt <= end;
  const outsidePeriod = allRows.filter(row => typeMatch(row) && !periodMatch(row)).length;
  const superseded = allRows.filter(row => typeMatch(row) && periodMatch(row) && !row.current && !includeHistory).length;
  const selected = allRows
    .filter(row => typeMatch(row) && periodMatch(row) && (includeHistory || row.current))
    .sort(compareObservation);
  const privateNotes = includePrivateNotes ? 0 : selected.filter(row => Boolean(row._privateNote)).length;
  const observations = selected.map(row => {
    const { _privateNote, ...projection } = row;
    if (includePrivateNotes && row.source !== 'w05_adapter' && row.source !== 'w06_adapter' && row.source !== 'w07_adapter') {
      projection.privateNote = _privateNote || '';
    }
    return projection;
  });
  return {
    schema: CAREER_MEMORY_OBSERVATION_LIST_SCHEMA,
    observationSchema: CAREER_MEMORY_OBSERVATION_SCHEMA,
    profileId: owner,
    period: { start, end, sinceDays },
    filters: { types: normalized, currentOnly: !includeHistory },
    observations,
    excluded: { superseded, outsidePeriod, privateNotes },
  };
}

function writePlainYaml(file, document) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, YAML.stringify(document, { lineWidth: 0, aliasDuplicateObjects: false }));
}

export function syncMemoryObservations(s, profileId) {
  const owner = requireProfile(s, profileId);
  const historyList = listMemoryObservations(s, {
    profileId: owner,
    sinceDays: null,
    includeHistory: true,
    includePrivateNotes: false,
    nowDate: ADAPTER_END,
  });
  const history = historyList.observations;
  const current = history.filter(observation => observation.current);
  const document = {
    schema: CAREER_MEMORY_OBSERVATION_LIST_SCHEMA,
    observationSchema: CAREER_MEMORY_OBSERVATION_SCHEMA,
    version: 1,
    profileId: owner,
    current,
    history,
    excluded: historyList.excluded,
    policy: {
      canonicalStore: 'sqlite',
      appendOnly: true,
      currentResolution: 'no_successor_for_native_or_upstream_current_version',
      privateNotes: 'sqlite_only',
      interpretation: 'attributed_observations_only_no_preferences_or_causal_claims',
      externalSideEffects: 'none',
    },
  };
  const file = path.join(s.p.profiles, owner, 'career', 'memory.yaml');
  writePlainYaml(file, document);
  return { file, document };
}
