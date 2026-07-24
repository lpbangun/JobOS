import crypto from 'node:crypto';

import { artifactContentHash } from './artifacts.js';
import {
  all,
  guardedWrite,
  one,
  recordAudit,
  run,
} from './db.js';
import {
  CAREER_MEMORY_ACTIVE_RULES_SCHEMA,
  CAREER_MEMORY_OBSERVATION_SCHEMA,
  CAREER_MEMORY_PROPOSAL_LIST_SCHEMA,
  CAREER_MEMORY_PROPOSAL_SCHEMA,
  CAREER_MEMORY_TRANSITION_SCHEMA,
  MEMORY_OBSERVATION_SCHEMAS,
  MEMORY_RULE_TYPES,
  canonicalHash,
  canonicalJson,
  memoryConflictKey,
  memoryProposalId,
  memoryRuleKey,
  memoryTransitionId,
  normalizeMemoryProposalInput,
  normalizeRuleValue,
} from './career-memory-contract.js';
import { listMemoryObservations } from './career-memory-observations.js';
import { parseJson } from './utils.js';

const SEARCH_RULE_TYPES = new Set([
  'role_family',
  'seniority',
  'company_stage',
  'industry',
  'mission',
  'location',
  'work_model',
  'compensation',
  'skill',
  'timing',
  'trust_risk',
]);
const WRITING_SCOPES = new Set(['resume', 'cover_letter', 'outreach', 'interview_prep', 'writing_global']);
const TRUSTED_HUMAN_SOURCES = new Set(['cli', 'tui']);
const UPSTREAM_SCHEMAS = new Set(MEMORY_OBSERVATION_SCHEMAS.filter(schema => schema !== CAREER_MEMORY_OBSERVATION_SCHEMA));
const MAX_EVIDENCE_FRESHNESS_DAYS = 365;
const ACCEPTANCE_TTL_DAYS = Object.freeze({ search: 180, writing: 365 });
const DAY_MS = 86_400_000;
const PROTECTED_PATTERNS = Object.freeze([
  /\b(?:woman|women|female|man|men|male|gender|sex)\b/i,
  /\b(?:race|racial|ethnicity|ethnic|religion|religious)\b/i,
  /\b(?:disability|disabled|medical|pregnan\w*|marital|family status)\b/i,
  /\b(?:citizenship|citizen|visa|work authorization|national origin)\b/i,
  /\b(?:age|young|elderly)\b/i,
]);

function fail(code, message, details = {}) {
  throw Object.assign(new Error(message), { code, type: 'validation', details });
}

function text(value, field, { optional = false } = {}) {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string') fail('memory_contract_invalid', `${field} must be a string.`, { field });
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!normalized && !optional) fail('memory_required_field', `${field} is required.`, { field });
  return normalized;
}

function exactObject(value, keys, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('memory_contract_invalid', `${field} must be an object.`, { field });
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('memory_unknown_key', `${field}.${key} is not allowed.`, { field: `${field}.${key}` });
    if (value[key] === undefined) fail('memory_undefined_rejected', `${field}.${key} cannot be undefined.`, { field: `${field}.${key}` });
  }
  return value;
}

function profileExists(store, profileId) {
  if (!one(store, 'SELECT id FROM profiles WHERE id=?', [profileId])) {
    fail('memory_profile_unknown', `Unknown profile ${profileId}.`, { profileId });
  }
}

function dateValue(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) fail('memory_timestamp_invalid', `${field} must be an RFC3339 timestamp.`, { field });
  return date;
}

function addDays(value, days) {
  return new Date(dateValue(value, 'timestamp').getTime() + days * DAY_MS).toISOString();
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function latestTransitionRow(store, proposalId, profileId) {
  return one(store, `SELECT * FROM career_memory_proposal_transitions
    WHERE proposal_id=? AND profile_id=? ORDER BY sequence DESC LIMIT 1`, [proposalId, profileId]);
}

function transitionRows(store, proposalId, profileId) {
  return all(store, `SELECT * FROM career_memory_proposal_transitions
    WHERE proposal_id=? AND profile_id=? ORDER BY sequence,id`, [proposalId, profileId]);
}

function transitionProjection(row, idempotent = false) {
  const projection = {
    schema: CAREER_MEMORY_TRANSITION_SCHEMA,
    id: row.id,
    proposalId: row.proposal_id,
    profileId: row.profile_id,
    sequence: row.sequence,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    referenceId: row.reference_id,
    replacementProposalId: row.replacement_proposal_id || null,
    undoesTransitionId: row.undoes_transition_id || null,
    actor: row.actor,
    source: row.source,
    occurredAt: row.occurred_at,
    transitionHash: row.transition_hash,
    externalSideEffects: 'none',
  };
  if (idempotent) projection.idempotent = true;
  return projection;
}

function evidenceRows(store, proposalId, profileId) {
  return all(store, `SELECT * FROM career_memory_proposal_evidence
    WHERE proposal_id=? AND profile_id=? ORDER BY position`, [proposalId, profileId]);
}

function evidenceProjection(row) {
  return {
    position: row.position,
    observationSchema: row.observation_schema,
    observationId: row.observation_id,
    sourceEntity: {
      type: row.source_entity_type,
      id: row.source_entity_id,
      versionId: row.source_version_id,
    },
    occurredAt: row.occurred_at,
    polarity: row.polarity,
    weight: row.weight,
    evidenceHash: row.evidence_hash,
  };
}

function proposalProjection(store, row, { includeEvidence = true, includeHistory = true, idempotent = false } = {}) {
  const transitions = transitionRows(store, row.id, row.profile_id).map(item => transitionProjection(item));
  const status = transitions.at(-1)?.toStatus || 'proposed';
  const projection = {
    schema: CAREER_MEMORY_PROPOSAL_SCHEMA,
    id: row.id,
    profileId: row.profile_id,
    domain: row.domain,
    scope: row.scope,
    ruleType: row.rule_type,
    value: parseJson(row.value_json, {}),
    ruleKey: row.rule_key,
    conflictKey: row.conflict_key,
    rationale: row.rationale,
    confidenceMilli: row.confidence_milli,
    confidenceBand: row.confidence_band,
    conflictState: row.conflict_state,
    evidenceHash: row.evidence_hash,
    evidenceFreshUntil: row.evidence_fresh_until,
    createdAt: row.created_at,
    actor: row.actor,
    source: row.source,
    proposalHash: row.proposal_hash,
    status,
    active: status === 'accepted',
    externalSideEffects: 'none',
  };
  if (includeHistory) projection.transitions = transitions;
  if (includeEvidence) projection.evidence = evidenceRows(store, row.id, row.profile_id).map(evidenceProjection);
  if (idempotent) projection.idempotent = true;
  return projection;
}

function allPublicObservations(store) {
  const observations = [];
  for (const { id: profileId } of all(store, 'SELECT id FROM profiles ORDER BY id')) {
    const listed = listMemoryObservations(store, {
      profileId,
      sinceDays: null,
      includeHistory: true,
      includePrivateNotes: false,
      nowDate: new Date(),
    });
    for (const item of listed.observations) observations.push(item);
    for (const item of listed.history || []) observations.push(item);
  }
  return observations;
}

function evidenceIdentity(schema, id) {
  return `${schema}\0${id}`;
}

function observationSchema(observation) {
  return observation.schema;
}

function citationSchema(observation) {
  if (observation.source === 'w05_adapter') return 'jobos.outreach-outcome.v1';
  if (observation.source === 'w06_adapter') return 'jobos.lifecycle-observation.v1';
  if (observation.source === 'w07_adapter') return 'jobos.interview-observation.v1';
  return observationSchema(observation);
}

function sourceRoot(observation) {
  return `${observation.sourceEntity.type}:${observation.sourceEntity.id}`;
}

function sourceWeight(observation) {
  const schema = citationSchema(observation);
  if (schema === CAREER_MEMORY_OBSERVATION_SCHEMA) {
    return observation.actor === 'user'
      && TRUSTED_HUMAN_SOURCES.has(observation.source)
      && ['job', 'application', 'artifact'].includes(observation.sourceEntity.type)
      ? 2
      : 0;
  }
  if (UPSTREAM_SCHEMAS.has(schema)
    && ['w05_adapter', 'w06_adapter', 'w07_adapter'].includes(observation.source)
    && !['unknown', 'unknown_legacy', 'legacy'].includes(observation.actor)) {
    return 1;
  }
  return 0;
}

function evidenceFreshnessDays(observation) {
  return citationSchema(observation) === CAREER_MEMORY_OBSERVATION_SCHEMA
    && observation.sourceEntity.type !== 'artifact'
    ? 180
    : 365;
}

function candidateJobValues(job, field) {
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
  return values.map(value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
}

function tokenMatch(candidate, expected) {
  const tokens = expected.split(/[^a-z0-9]+/).filter(Boolean);
  const candidateTokens = new Set(candidate.split(/[^a-z0-9]+/).filter(Boolean));
  return tokens.length > 0 && tokens.every(token => candidateTokens.has(token));
}

function upstreamSupportsSearchRule(store, observation, input) {
  if (input.domain !== 'search') return false;
  const jobId = observation.payload?.jobId
    || (observation.sourceEntity.type === 'job' ? observation.sourceEntity.id : null);
  if (!jobId) return false;
  const job = one(store, 'SELECT * FROM jobs WHERE id=? AND profile_id=?', [jobId, observation.profileId]);
  if (!job) return false;
  const candidates = candidateJobValues(job, input.ruleType);
  return input.value.match === 'exact'
    ? candidates.includes(input.value.value)
    : candidates.some(candidate => tokenMatch(candidate, input.value.value));
}

function signalRuleType(signal) {
  return signal?.field || signal?.ruleType || '';
}

function signalRuleValue(domain, signal) {
  if (domain === 'search') {
    return normalizeRuleValue({
      domain,
      ruleType: signal.field,
      value: { polarity: signal.polarity, value: signal.value, match: signal.match },
    });
  }
  return normalizeRuleValue({ domain, ruleType: signal.ruleType, value: signal.value });
}

function observationSupportsRule(store, observation, input, polarity) {
  if (UPSTREAM_SCHEMAS.has(citationSchema(observation))) return upstreamSupportsSearchRule(store, observation, input);
  if (citationSchema(observation) !== CAREER_MEMORY_OBSERVATION_SCHEMA) return false;
  if (input.ruleType === 'approved_exemplar') {
    return polarity === 'support'
      && observation.sourceEntity.type === 'artifact'
      && observation.sourceEntity.id === input.value.artifactId
      && observation.sourceEntity.revision === input.value.revision
      && observation.sourceEntity.contentHash === input.value.contentHash;
  }
  const expectedRuleKey = memoryRuleKey(input);
  const expectedConflictKey = memoryConflictKey(input);
  return (observation.signals || []).some(signal => {
    if (signalRuleType(signal) !== input.ruleType) return false;
    let normalized;
    try {
      normalized = signalRuleValue(input.domain, signal);
    } catch {
      return false;
    }
    const candidate = { ...input, value: normalized };
    if (memoryConflictKey(candidate) !== expectedConflictKey) return false;
    const sameRule = memoryRuleKey(candidate) === expectedRuleKey;
    return polarity === 'support' ? sameRule : !sameRule || input.domain === 'writing';
  });
}

function artifactScopeEligible(store, observation, scope) {
  if (observation.sourceEntity.type !== 'artifact' || scope === 'writing_global') return true;
  const artifact = one(store, 'SELECT type,profile_id FROM artifacts WHERE id=?', [observation.sourceEntity.id]);
  return Boolean(artifact && artifact.profile_id === observation.profileId && artifact.type === scope);
}

function contradictsSearchRule(observation, normalized) {
  if (normalized.domain !== 'search'
    || citationSchema(observation) !== CAREER_MEMORY_OBSERVATION_SCHEMA
    || !observation.current) return false;
  const expectedRuleKey = memoryRuleKey(normalized);
  const expectedConflictKey = memoryConflictKey(normalized);
  return (observation.signals || []).some(signal => {
    if (signalRuleType(signal) !== normalized.ruleType) return false;
    try {
      const candidate = { ...normalized, value: signalRuleValue('search', signal) };
      return memoryConflictKey(candidate) === expectedConflictKey
        && memoryRuleKey(candidate) !== expectedRuleKey;
    } catch {
      return false;
    }
  });
}

function hasAmbientConflict(store, row, asOf) {
  if (row.domain !== 'search') return false;
  const normalized = {
    domain: row.domain,
    scope: row.scope,
    ruleType: row.rule_type,
    value: parseJson(row.value_json, {}),
  };
  return allPublicObservations(store).some(observation => {
    if (observation.profileId !== row.profile_id || sourceWeight(observation) === 0
      || !contradictsSearchRule(observation, normalized)) return false;
    const occurredAt = dateValue(observation.occurredAt, 'evidence.occurredAt');
    return occurredAt <= asOf
      && asOf.getTime() - occurredAt.getTime() <= evidenceFreshnessDays(observation) * DAY_MS;
  });
}

function resolveProposalEvidence(store, normalized, createdAt, { includeUncitedConflicts = true } = {}) {
  const observations = allPublicObservations(store);
  const byIdentity = new Map();
  for (const observation of observations) {
    const key = evidenceIdentity(citationSchema(observation), observation.id);
    const values = byIdentity.get(key) || [];
    values.push(observation);
    byIdentity.set(key, values);
  }
  const resolved = [];
  let profileId = null;
  for (const citation of normalized.evidence) {
    const matches = byIdentity.get(evidenceIdentity(citation.observationSchema, citation.observationId)) || [];
    if (matches.length !== 1) {
      fail('memory_evidence_unknown', `Unknown or ambiguous evidence ${citation.observationId}.`, citation);
    }
    const observation = matches[0];
    if (!profileId) profileId = observation.profileId;
    if (observation.profileId !== profileId) {
      fail('memory_evidence_profile_mismatch', 'Proposal evidence must belong to one profile.', {
        expectedProfileId: profileId,
        actualProfileId: observation.profileId,
        observationId: observation.id,
      });
    }
    if (!observation.current) fail('memory_evidence_not_current', `Evidence ${observation.id} is not current.`, { observationId: observation.id });
    const weight = sourceWeight(observation);
    if (weight === 0) {
      fail('memory_evidence_ineligible', `Evidence ${observation.id} is not an attributable eligible observation.`, { observationId: observation.id });
    }
    if (!observation.sourceEntity?.contentHash || !/^[a-f0-9]{64}$/.test(observation.sourceEntity.contentHash)) {
      fail('memory_evidence_hash_invalid', `Evidence ${observation.id} has no valid source hash.`, { observationId: observation.id });
    }
    if (!observation.sourceEntity.versionId) {
      fail('memory_evidence_version_invalid', `Evidence ${observation.id} has no source version.`, { observationId: observation.id });
    }
    if (!observationSupportsRule(store, observation, normalized, citation.polarity)) {
      fail('memory_evidence_rule_mismatch', `Evidence ${observation.id} does not support the proposed rule.`, { observationId: observation.id });
    }
    if (normalized.domain === 'writing' && !artifactScopeEligible(store, observation, normalized.scope)) {
      fail('memory_evidence_scope_mismatch', `Evidence ${observation.id} does not match ${normalized.scope} scope.`, { observationId: observation.id, scope: normalized.scope });
    }
    const occurredAt = dateValue(observation.occurredAt, 'evidence.occurredAt');
    const created = dateValue(createdAt, 'createdAt');
    if (occurredAt > created || created.getTime() - occurredAt.getTime() > evidenceFreshnessDays(observation) * DAY_MS) {
      fail('memory_evidence_stale', `Evidence ${observation.id} is outside the freshness window.`, { observationId: observation.id });
    }
    resolved.push({
      observation,
      observationSchema: citation.observationSchema,
      observationId: citation.observationId,
      sourceEntityType: observation.sourceEntity.type,
      sourceEntityId: observation.sourceEntity.id,
      sourceVersionId: observation.sourceEntity.versionId,
      occurredAt: observation.occurredAt,
      polarity: citation.polarity,
      weight,
      evidenceHash: observation.sourceEntity.contentHash,
    });
  }
  if (includeUncitedConflicts && normalized.domain === 'search') {
    const identities = new Set(resolved.map(item => evidenceIdentity(item.observationSchema, item.observationId)));
    const created = dateValue(createdAt, 'createdAt');
    for (const observation of observations) {
      const schema = citationSchema(observation);
      const identity = evidenceIdentity(schema, observation.id);
      if (observation.profileId !== profileId || identities.has(identity)
        || sourceWeight(observation) === 0 || !contradictsSearchRule(observation, normalized)) continue;
      const occurredAt = dateValue(observation.occurredAt, 'evidence.occurredAt');
      if (occurredAt > created || created.getTime() - occurredAt.getTime() > evidenceFreshnessDays(observation) * DAY_MS) continue;
      resolved.push({
        observation,
        observationSchema: schema,
        observationId: observation.id,
        sourceEntityType: observation.sourceEntity.type,
        sourceEntityId: observation.sourceEntity.id,
        sourceVersionId: observation.sourceEntity.versionId,
        occurredAt: observation.occurredAt,
        polarity: 'conflict',
        weight: sourceWeight(observation),
        evidenceHash: observation.sourceEntity.contentHash,
      });
      identities.add(identity);
    }
  }
  resolved.sort((left, right) => compareText(left.observationSchema, right.observationSchema)
    || compareText(left.observationId, right.observationId)
    || compareText(left.polarity, right.polarity));
  profileExists(store, profileId);
  return { profileId, resolved };
}

function protectedTarget(normalized) {
  const publicText = `${canonicalJson(normalized.value)} ${normalized.rationale}`;
  return PROTECTED_PATTERNS.some(pattern => pattern.test(publicText));
}

function confidenceBand(confidenceMilli) {
  return confidenceMilli >= 850 ? 'high' : confidenceMilli >= 670 ? 'medium' : 'low';
}

function evidenceMetrics(evidence) {
  const supports = evidence.filter(item => item.polarity === 'support');
  const conflicts = evidence.filter(item => item.polarity === 'conflict');
  const supportWeight = supports.reduce((sum, item) => sum + item.weight, 0);
  const conflictWeight = conflicts.reduce((sum, item) => sum + item.weight, 0);
  const total = supportWeight + conflictWeight;
  const ratio = total ? supportWeight / total : 0;
  const confidenceMilli = Math.min(950, Math.round(ratio * 1000));
  const sourceRoots = new Set(supports.map(item => sourceRoot(item.observation)));
  const dates = new Set(supports.map(item => item.occurredAt.slice(0, 10)));
  const directSupportCount = supports.filter(item => item.weight === 2).length;
  return {
    supportCount: supports.length,
    directSupportCount,
    supportWeight,
    conflictWeight,
    sourceRootCount: sourceRoots.size,
    distinctDateCount: dates.size,
    confidenceMilli,
    confidenceBand: confidenceBand(confidenceMilli),
    conflictState: conflictWeight > 0 ? 'present' : 'none',
    ordinaryEvidence: supports.length >= 3
      && directSupportCount >= 1
      && supportWeight >= 4
      && sourceRoots.size >= 2
      && dates.size >= 2
      && conflictWeight === 0,
  };
}

function validateAssetReferences(store, prepared) {
  if (prepared.normalized.ruleType === 'positioning_priority') {
    for (const proofPointId of prepared.normalized.value.proofPointIds) {
      const proof = one(store, 'SELECT profile_id,status,verification_status FROM proof_points WHERE id=?', [proofPointId]);
      if (!proof || proof.profile_id !== prepared.profileId || proof.status !== 'active' || proof.verification_status !== 'verified') {
        fail('memory_proof_ineligible', `Proof point ${proofPointId} is not active, verified, and same-profile.`, { proofPointId });
      }
    }
  }
  if (prepared.normalized.ruleType === 'approved_exemplar') {
    const value = prepared.normalized.value;
    const artifact = one(store, 'SELECT * FROM artifacts WHERE id=?', [value.artifactId]);
    if (!artifact || artifact.profile_id !== prepared.profileId || artifact.revision !== value.revision
      || artifact.approval_status !== 'approved' || artifact.content_hash !== value.contentHash
      || artifactContentHash(artifact.content) !== value.contentHash) {
      fail('memory_artifact_ineligible', `Artifact ${value.artifactId} is not an exact approved same-profile revision.`, { artifactId: value.artifactId });
    }
    const lines = String(artifact.content).split(/\r?\n/);
    if (value.endLine > lines.length) fail('memory_artifact_ineligible', 'Exemplar line range exceeds the artifact.', { artifactId: value.artifactId });
    const excerpt = lines.slice(value.startLine - 1, value.endLine).join('\n');
    const excerptHash = crypto.createHash('sha256').update(excerpt, 'utf8').digest('hex');
    if (excerptHash !== value.excerptHash) fail('memory_artifact_ineligible', 'Exemplar excerpt hash does not match.', { artifactId: value.artifactId });
  }
}

function prepareProposal(store, value, { includeUncitedConflicts = true } = {}) {
  const normalized = normalizeMemoryProposalInput(value);
  const createdAt = normalized.createdAt || new Date().toISOString();
  if (protectedTarget(normalized)) fail('memory_protected_target', 'Protected or sensitive targeting is not allowed in career memory guidance.');
  const { profileId, resolved } = resolveProposalEvidence(store, normalized, createdAt, { includeUncitedConflicts });
  const hasAssociationEvidence = resolved.some(item => UPSTREAM_SCHEMAS.has(item.observationSchema));
  if (hasAssociationEvidence && !normalized.rationale.toLowerCase().includes('observed association, not cause')) {
    fail('memory_causal_rationale_required', 'Association evidence requires the phrase “observed association, not cause”.');
  }
  const metrics = evidenceMetrics(resolved);
  const exemplarException = normalized.ruleType === 'approved_exemplar'
    && resolved.length === 1
    && resolved[0].polarity === 'support'
    && resolved[0].weight === 2;
  if (normalized.ruleType === 'approved_exemplar' && !exemplarException) {
    fail('memory_exemplar_evidence_invalid', 'An approved exemplar requires exactly one direct supporting artifact observation.');
  }
  const evidenceHash = canonicalHash(resolved.map(item => ({
    observationSchema: item.observationSchema,
    observationId: item.observationId,
    sourceEntityType: item.sourceEntityType,
    sourceEntityId: item.sourceEntityId,
    sourceVersionId: item.sourceVersionId,
    occurredAt: item.occurredAt,
    polarity: item.polarity,
    weight: item.weight,
    evidenceHash: item.evidenceHash,
  })));
  const ruleKey = memoryRuleKey(normalized);
  const conflictKey = memoryConflictKey(normalized);
  const freshnessEvidence = resolved.filter(item => item.polarity === 'support');
  const evidenceFreshUntil = (freshnessEvidence.length ? freshnessEvidence : resolved)
    .map(item => addDays(item.occurredAt, evidenceFreshnessDays(item.observation))).sort()[0];
  const confidenceMilli = exemplarException ? 500 : metrics.confidenceMilli;
  const proposalConfidenceBand = confidenceBand(confidenceMilli);
  const id = memoryProposalId({
    profileId,
    domain: normalized.domain,
    scope: normalized.scope,
    ruleType: normalized.ruleType,
    ruleKey,
    evidenceHash,
    createdAt,
  });
  const proposalHash = canonicalHash({
    schema: CAREER_MEMORY_PROPOSAL_SCHEMA,
    id,
    profileId,
    domain: normalized.domain,
    scope: normalized.scope,
    ruleType: normalized.ruleType,
    value: normalized.value,
    ruleKey,
    conflictKey,
    rationale: normalized.rationale,
    confidenceMilli,
    confidenceBand: proposalConfidenceBand,
    conflictState: metrics.conflictState,
    evidenceHash,
    evidenceFreshUntil,
    createdAt,
    actor: 'deterministic',
    source: 'deterministic',
  });
  const prepared = {
    normalized,
    profileId,
    resolved,
    metrics,
    exemplarException,
    evidenceHash,
    ruleKey,
    conflictKey,
    evidenceFreshUntil,
    confidenceMilli,
    confidenceBand: proposalConfidenceBand,
    id,
    proposalHash,
    createdAt,
  };
  validateAssetReferences(store, prepared);
  return prepared;
}

function syntheticProjection(prepared) {
  const transitionId = memoryTransitionId({ proposalId: prepared.id, sequence: 1, toStatus: 'proposed', referenceId: prepared.normalized.referenceId });
  return {
    schema: CAREER_MEMORY_PROPOSAL_SCHEMA,
    id: prepared.id,
    profileId: prepared.profileId,
    domain: prepared.normalized.domain,
    scope: prepared.normalized.scope,
    ruleType: prepared.normalized.ruleType,
    value: prepared.normalized.value,
    ruleKey: prepared.ruleKey,
    conflictKey: prepared.conflictKey,
    rationale: prepared.normalized.rationale,
    confidenceMilli: prepared.confidenceMilli,
    confidenceBand: prepared.confidenceBand,
    conflictState: prepared.metrics.conflictState,
    evidenceHash: prepared.evidenceHash,
    evidenceFreshUntil: prepared.evidenceFreshUntil,
    createdAt: prepared.createdAt,
    actor: 'deterministic',
    source: 'deterministic',
    proposalHash: prepared.proposalHash,
    status: 'proposed',
    active: false,
    gates: gateProjection(prepared),
    evidence: prepared.resolved.map((item, position) => evidenceProjection({
      position,
      observation_schema: item.observationSchema,
      observation_id: item.observationId,
      source_entity_type: item.sourceEntityType,
      source_entity_id: item.sourceEntityId,
      source_version_id: item.sourceVersionId,
      occurred_at: item.occurredAt,
      polarity: item.polarity,
      weight: item.weight,
      evidence_hash: item.evidenceHash,
    })),
    transitions: [{
      schema: CAREER_MEMORY_TRANSITION_SCHEMA,
      id: transitionId,
      proposalId: prepared.id,
      profileId: prepared.profileId,
      sequence: 1,
      fromStatus: null,
      toStatus: 'proposed',
      reason: '',
      referenceId: prepared.normalized.referenceId,
      replacementProposalId: null,
      undoesTransitionId: null,
      actor: 'deterministic',
      source: 'deterministic',
      occurredAt: prepared.createdAt,
      transitionHash: initialTransitionHash(prepared),
      externalSideEffects: 'none',
    }],
    externalSideEffects: 'none',
  };
}

function gateProjection(prepared) {
  return {
    label: prepared.exemplarException ? 'explicit_exemplar_exception' : 'ordinary_evidence',
    ordinaryEvidence: prepared.metrics.ordinaryEvidence,
    supportCount: prepared.metrics.supportCount,
    directSupportCount: prepared.metrics.directSupportCount,
    supportWeight: prepared.metrics.supportWeight,
    conflictWeight: prepared.metrics.conflictWeight,
    sourceRootCount: prepared.metrics.sourceRootCount,
    distinctDateCount: prepared.metrics.distinctDateCount,
  };
}

function initialTransitionHash(prepared) {
  return canonicalHash({
    operation: 'create',
    proposalId: prepared.id,
    sequence: 1,
    fromStatus: null,
    toStatus: 'proposed',
    referenceId: prepared.normalized.referenceId,
    actor: 'deterministic',
    source: 'deterministic',
    occurredAt: prepared.createdAt,
    proposalHash: prepared.proposalHash,
  });
}

function attachGates(projection, prepared) {
  projection.gates = gateProjection(prepared);
  return projection;
}

function insertPreparedProposal(store, prepared) {
  run(store, `INSERT INTO career_memory_proposals
    (id,profile_id,schema_version,domain,scope,rule_type,value_json,rule_key,conflict_key,rationale,confidence_milli,confidence_band,conflict_state,evidence_hash,evidence_fresh_until,created_at,actor,source,proposal_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    prepared.id,
    prepared.profileId,
    1,
    prepared.normalized.domain,
    prepared.normalized.scope,
    prepared.normalized.ruleType,
    canonicalJson(prepared.normalized.value),
    prepared.ruleKey,
    prepared.conflictKey,
    prepared.normalized.rationale,
    prepared.confidenceMilli,
    prepared.confidenceBand,
    prepared.metrics.conflictState,
    prepared.evidenceHash,
    prepared.evidenceFreshUntil,
    prepared.createdAt,
    'deterministic',
    'deterministic',
    prepared.proposalHash,
  ]);
  prepared.resolved.forEach((item, position) => run(store, `INSERT INTO career_memory_proposal_evidence
    (proposal_id,profile_id,position,observation_schema,observation_id,source_entity_type,source_entity_id,source_version_id,occurred_at,polarity,weight,evidence_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    prepared.id,
    prepared.profileId,
    position,
    item.observationSchema,
    item.observationId,
    item.sourceEntityType,
    item.sourceEntityId,
    item.sourceVersionId,
    item.occurredAt,
    item.polarity,
    item.weight,
    item.evidenceHash,
  ]));
  appendTransitionRow(store, {
    proposalId: prepared.id,
    profileId: prepared.profileId,
    sequence: 1,
    fromStatus: null,
    toStatus: 'proposed',
    reason: '',
    referenceId: prepared.normalized.referenceId,
    replacementProposalId: null,
    undoesTransitionId: null,
    actor: 'deterministic',
    source: 'deterministic',
    occurredAt: prepared.createdAt,
    transitionHash: initialTransitionHash(prepared),
  });
  recordAudit(store, 'career_memory.proposal_created', 'career_memory_proposal', prepared.id, {
    profileId: prepared.profileId,
    domain: prepared.normalized.domain,
    scope: prepared.normalized.scope,
    ruleType: prepared.normalized.ruleType,
    proposalHash: prepared.proposalHash,
    evidenceHash: prepared.evidenceHash,
  });
}

export function createMemoryProposal(store, input) {
  return guardedWrite(store, () => {
    const normalized = normalizeMemoryProposalInput(input);
    const references = all(store, `SELECT p.*,t.profile_id AS reference_profile_id
      FROM career_memory_proposal_transitions t
      JOIN career_memory_proposals p ON p.id=t.proposal_id AND p.profile_id=t.profile_id
      WHERE t.reference_id=? ORDER BY t.profile_id`, [normalized.referenceId]);
    for (const reference of references) {
      const replayInput = normalized.createdAt
        ? normalized
        : { ...normalized, createdAt: reference.created_at };
      const replayPrepared = prepareProposal(store, replayInput);
      if (replayPrepared.profileId !== reference.reference_profile_id) continue;
      if (reference.proposal_hash !== replayPrepared.proposalHash) {
        fail('memory_reference_conflict', `Reference ${normalized.referenceId} already names different content.`);
      }
      return attachGates(proposalProjection(store, reference, { idempotent: true }), replayPrepared);
    }
    const prepared = prepareProposal(store, normalized);
    const duplicate = one(store, 'SELECT * FROM career_memory_proposals WHERE profile_id=? AND proposal_hash=? ORDER BY id LIMIT 1', [prepared.profileId, prepared.proposalHash]);
    if (duplicate) {
      fail('memory_reference_conflict', `Proposal content already exists under reference ${transitionRows(store, duplicate.id, duplicate.profile_id)[0].reference_id}.`);
    }
    insertPreparedProposal(store, prepared);
    return attachGates(proposalProjection(store, one(store, 'SELECT * FROM career_memory_proposals WHERE id=?', [prepared.id])), prepared);
  });
}

function proposalRow(store, profileId, proposalId) {
  profileExists(store, profileId);
  const row = one(store, 'SELECT * FROM career_memory_proposals WHERE id=? AND profile_id=?', [proposalId, profileId]);
  if (!row) fail('memory_proposal_unknown', `Unknown proposal ${proposalId}.`, { profileId, proposalId });
  return row;
}

export function getMemoryProposal(store, { profileId, proposalId, includeHistory = true }) {
  const owner = text(profileId, 'profileId');
  const id = text(proposalId, 'proposalId');
  return proposalProjection(store, proposalRow(store, owner, id), { includeEvidence: true, includeHistory });
}

export function listMemoryProposals(store, { profileId, statuses = null, domain = null, scope = null, includeEvidence = true }) {
  const owner = text(profileId, 'profileId');
  profileExists(store, owner);
  const allowedStatuses = statuses == null ? null : new Set(statuses.map(value => text(value, 'status')));
  const rows = all(store, 'SELECT * FROM career_memory_proposals WHERE profile_id=? ORDER BY created_at DESC,id', [owner]);
  const proposals = rows.map(row => proposalProjection(store, row, { includeEvidence })).filter(proposal => {
    if (allowedStatuses && !allowedStatuses.has(proposal.status)) return false;
    if (domain && proposal.domain !== domain) return false;
    if (scope && proposal.scope !== scope) return false;
    return true;
  });
  return {
    schema: CAREER_MEMORY_PROPOSAL_LIST_SCHEMA,
    profileId: owner,
    filters: { statuses: statuses || [], domain, scope, includeEvidence },
    proposals,
    externalSideEffects: 'none',
  };
}

function storedPrepared(store, row) {
  const storedEvidence = evidenceRows(store, row.id, row.profile_id);
  const normalized = {
    schema: 'jobos.memory-proposal-input.v1',
    domain: row.domain,
    scope: row.scope,
    ruleType: row.rule_type,
    value: parseJson(row.value_json, {}),
    rationale: row.rationale,
    evidence: storedEvidence.map(item => ({
      observationSchema: item.observation_schema,
      observationId: item.observation_id,
      polarity: item.polarity,
    })),
    referenceId: transitionRows(store, row.id, row.profile_id)[0].reference_id,
    createdAt: row.created_at,
  };
  const prepared = prepareProposal(store, normalized, { includeUncitedConflicts: false });
  if (prepared.profileId !== row.profile_id || prepared.proposalHash !== row.proposal_hash || prepared.evidenceHash !== row.evidence_hash) {
    fail('memory_proposal_integrity_invalid', `Proposal ${row.id} no longer matches its immutable hashes.`, { proposalId: row.id });
  }
  return prepared;
}

function validateAcceptance(store, row, nowDate) {
  const prepared = storedPrepared(store, row);
  const now = dateValue(nowDate, 'nowDate');
  if (now > dateValue(row.evidence_fresh_until, 'evidenceFreshUntil')) {
    fail('memory_evidence_stale', `Proposal ${row.id} evidence is stale.`, { proposalId: row.id });
  }
  if (row.conflict_state === 'present' || hasAmbientConflict(store, row, now)) {
    fail('memory_conflict_present', `Proposal ${row.id} has contradictory evidence.`, { proposalId: row.id });
  }
  if (!prepared.exemplarException && !prepared.metrics.ordinaryEvidence) {
    fail('memory_evidence_insufficient', `Proposal ${row.id} does not meet ordinary evidence thresholds.`, gateProjection(prepared));
  }
  if (prepared.confidenceBand === 'low' && !prepared.exemplarException) {
    fail('memory_confidence_insufficient', `Proposal ${row.id} is below medium confidence.`, { proposalId: row.id });
  }
  validateAssetReferences(store, prepared);
  if (row.scope === 'writing_global') validateGlobalPromotion(store, row, now);
  return prepared;
}

function acceptedRows(store, profileId) {
  return all(store, `SELECT p.*,t.occurred_at AS accepted_at
    FROM career_memory_proposals p
    JOIN career_memory_proposal_transitions t ON t.proposal_id=p.id AND t.profile_id=p.profile_id
    JOIN (SELECT proposal_id,MAX(sequence) AS sequence FROM career_memory_proposal_transitions GROUP BY proposal_id) latest
      ON latest.proposal_id=t.proposal_id AND latest.sequence=t.sequence
    WHERE p.profile_id=? AND t.to_status='accepted'`, [profileId]);
}

function proposalValidity(store, row, asOf) {
  try {
    storedPrepared(store, row);
  } catch (error) {
    const reason = error.code === 'memory_proof_ineligible'
      ? 'proof_ineligible'
      : error.code === 'memory_artifact_ineligible'
        ? 'artifact_ineligible'
        : error.code === 'memory_evidence_not_current'
          ? 'evidence_not_current'
          : 'evidence_invalid';
    return { valid: false, reason };
  }
  if (row.conflict_state === 'present' || hasAmbientConflict(store, row, asOf)) return { valid: false, reason: 'conflict_present' };
  if (asOf > dateValue(row.evidence_fresh_until, 'evidenceFreshUntil')) return { valid: false, reason: 'evidence_stale' };
  const ttl = ACCEPTANCE_TTL_DAYS[row.domain];
  if (asOf > new Date(dateValue(row.accepted_at, 'acceptedAt').getTime() + ttl * DAY_MS)) return { valid: false, reason: 'acceptance_expired' };
  return { valid: true, reason: null };
}

function validateGlobalPromotion(store, row, asOf) {
  const active = acceptedRows(store, row.profile_id).filter(candidate => candidate.domain === 'writing'
    && candidate.scope !== 'writing_global'
    && candidate.conflict_key === row.conflict_key
    && proposalValidity(store, candidate, asOf).valid);
  if (new Set(active.map(candidate => candidate.scope)).size < 2) {
    fail('memory_global_promotion_insufficient', 'Global writing guidance requires active accepted matching rules in two artifact scopes.', { proposalId: row.id });
  }
}

function trustedHuman(actor, source) {
  if (actor !== 'user' || !TRUSTED_HUMAN_SOURCES.has(source)) {
    fail('memory_transition_source_untrusted', 'Proposal lifecycle decisions require a trusted CLI/TUI human source.', { actor, source });
  }
}

function transitionRequestHash({ operation = 'transition', profileId, proposalId, transitionId = null, action = null, reason, referenceId, actor, source, occurredAt }) {
  return canonicalHash({ operation, profileId, proposalId, transitionId, action, reason, referenceId, actor, source, occurredAt });
}

function appendTransitionRow(store, input) {
  const id = memoryTransitionId({
    proposalId: input.proposalId,
    sequence: input.sequence,
    toStatus: input.toStatus,
    referenceId: input.referenceId,
  });
  run(store, `INSERT INTO career_memory_proposal_transitions
    (id,proposal_id,profile_id,sequence,from_status,to_status,reason,reference_id,replacement_proposal_id,undoes_transition_id,actor,source,occurred_at,transition_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    id,
    input.proposalId,
    input.profileId,
    input.sequence,
    input.fromStatus,
    input.toStatus,
    input.reason,
    input.referenceId,
    input.replacementProposalId || null,
    input.undoesTransitionId || null,
    input.actor,
    input.source,
    input.occurredAt,
    input.transitionHash,
  ]);
  return one(store, 'SELECT * FROM career_memory_proposal_transitions WHERE id=?', [id]);
}

function replayTransition(store, profileId, referenceId, request) {
  const row = one(store, 'SELECT * FROM career_memory_proposal_transitions WHERE profile_id=? AND reference_id=?', [profileId, referenceId]);
  if (!row) return null;
  const requestHash = transitionRequestHash({ ...request, occurredAt: row.occurred_at });
  if (row.transition_hash !== requestHash) fail('memory_reference_conflict', `Reference ${referenceId} already names different transition content.`);
  return transitionProjection(row, true);
}

function appendLifecycleTransition(store, row, {
  toStatus,
  reason,
  referenceId,
  replacementProposalId = null,
  undoesTransitionId = null,
  actor,
  source,
  occurredAt,
  transitionHash,
}) {
  const current = latestTransitionRow(store, row.id, row.profile_id);
  return appendTransitionRow(store, {
    proposalId: row.id,
    profileId: row.profile_id,
    sequence: current.sequence + 1,
    fromStatus: current.to_status,
    toStatus,
    reason,
    referenceId,
    replacementProposalId,
    undoesTransitionId,
    actor,
    source,
    occurredAt,
    transitionHash,
  });
}

export function transitionMemoryProposal(store, {
  profileId,
  proposalId,
  action,
  reason = '',
  referenceId,
  actor,
  source,
  nowDate = new Date(),
}) {
  const owner = text(profileId, 'profileId');
  const id = text(proposalId, 'proposalId');
  const normalizedAction = text(action, 'action');
  const normalizedReason = text(reason, 'reason', { optional: true });
  const reference = text(referenceId, 'referenceId');
  const normalizedActor = text(actor, 'actor');
  const normalizedSource = text(source, 'source');
  const occurredAt = dateValue(nowDate, 'nowDate').toISOString();
  if (!['accept', 'reject', 'revoke'].includes(normalizedAction)) fail('memory_transition_invalid', `Unsupported transition action ${normalizedAction}.`);
  if (['reject', 'revoke'].includes(normalizedAction) && !normalizedReason) {
    fail('memory_transition_reason_required', `${normalizedAction} requires a reason.`);
  }
  trustedHuman(normalizedActor, normalizedSource);
  const request = {
    profileId: owner, proposalId: id, action: normalizedAction, reason: normalizedReason,
    referenceId: reference, actor: normalizedActor, source: normalizedSource,
  };
  const requestHash = transitionRequestHash({ ...request, occurredAt });
  return guardedWrite(store, () => {
    profileExists(store, owner);
    const replay = replayTransition(store, owner, reference, request);
    if (replay) return replay;
    const row = proposalRow(store, owner, id);
    const current = latestTransitionRow(store, id, owner);
    const expected = normalizedAction === 'accept' ? 'proposed' : normalizedAction === 'reject' ? 'proposed' : 'accepted';
    if (current.to_status !== expected) {
      fail('memory_transition_not_current', `${normalizedAction} cannot transition ${current.to_status}.`, { proposalId: id, status: current.to_status });
    }
    const toStatus = normalizedAction === 'accept' ? 'accepted' : normalizedAction === 'reject' ? 'rejected' : 'revoked';
    if (normalizedAction === 'accept') {
      validateAcceptance(store, row, dateValue(nowDate, 'nowDate'));
      const conflicts = acceptedRows(store, owner)
        .filter(candidate => candidate.scope === row.scope && candidate.conflict_key === row.conflict_key && candidate.id !== row.id)
        .sort((left, right) => compareText(left.created_at, right.created_at) || compareText(left.id, right.id));
      for (const conflict of conflicts) {
        const internalReference = `supersede:${reference}:${conflict.id}`;
        const internalOccurredAt = occurredAt;
        const internalHash = transitionRequestHash({
          profileId: owner,
          proposalId: conflict.id,
          action: 'supersede',
          reason: 'Superseded by accepted proposal.',
          referenceId: internalReference,
          actor: normalizedActor,
          source: normalizedSource,
          occurredAt: internalOccurredAt,
        });
        appendLifecycleTransition(store, conflict, {
          toStatus: 'superseded',
          reason: 'Superseded by accepted proposal.',
          referenceId: internalReference,
          replacementProposalId: row.id,
          actor: normalizedActor,
          source: normalizedSource,
          occurredAt: internalOccurredAt,
          transitionHash: internalHash,
        });
      }
    }
    const appended = appendLifecycleTransition(store, row, {
      toStatus,
      reason: normalizedReason,
      referenceId: reference,
      actor: normalizedActor,
      source: normalizedSource,
      occurredAt,
      transitionHash: requestHash,
    });
    recordAudit(store, 'career_memory.proposal_transitioned', 'career_memory_proposal', row.id, {
      profileId: owner,
      transitionId: appended.id,
      fromStatus: appended.from_status,
      toStatus: appended.to_status,
      reason: appended.reason,
      referenceId: appended.reference_id,
    });
    return transitionProjection(appended);
  });
}

export function undoMemoryTransition(store, {
  profileId,
  transitionId,
  reason,
  referenceId,
  actor,
  source,
  nowDate = new Date(),
}) {
  const owner = text(profileId, 'profileId');
  const targetId = text(transitionId, 'transitionId');
  const normalizedReason = text(reason, 'reason');
  const reference = text(referenceId, 'referenceId');
  const normalizedActor = text(actor, 'actor');
  const normalizedSource = text(source, 'source');
  const occurredAt = dateValue(nowDate, 'nowDate').toISOString();
  trustedHuman(normalizedActor, normalizedSource);
  const request = {
    operation: 'undo', profileId: owner, proposalId: null, transitionId: targetId, reason: normalizedReason,
    referenceId: reference, actor: normalizedActor, source: normalizedSource,
  };
  const requestHash = transitionRequestHash({ ...request, occurredAt });
  return guardedWrite(store, () => {
    profileExists(store, owner);
    const replay = replayTransition(store, owner, reference, request);
    if (replay) return replay;
    const target = one(store, 'SELECT * FROM career_memory_proposal_transitions WHERE id=? AND profile_id=?', [targetId, owner]);
    if (!target) fail('memory_transition_unknown', `Unknown transition ${targetId}.`, { transitionId: targetId });
    const current = latestTransitionRow(store, target.proposal_id, owner);
    if (current.id !== target.id) fail('memory_transition_not_current', `Transition ${targetId} is no longer current.`, { transitionId: targetId });
    const proposal = proposalRow(store, owner, target.proposal_id);
    let toStatus;
    if (target.to_status === 'rejected') {
      toStatus = 'proposed';
    } else if (target.to_status === 'revoked') {
      validateAcceptance(store, proposal, dateValue(nowDate, 'nowDate'));
      toStatus = 'accepted';
    } else if (target.to_status === 'superseded') {
      const replacement = proposalRow(store, owner, target.replacement_proposal_id);
      const replacementCurrent = latestTransitionRow(store, replacement.id, owner);
      if (replacementCurrent.to_status !== 'accepted') {
        fail('memory_transition_not_current', 'Supersession replacement is no longer the current accepted rule.', { transitionId: targetId });
      }
      validateAcceptance(store, proposal, dateValue(nowDate, 'nowDate'));
      const replacementReference = `undo-replacement:${reference}:${replacement.id}`;
      appendLifecycleTransition(store, replacement, {
        toStatus: 'revoked',
        reason: normalizedReason,
        referenceId: replacementReference,
        undoesTransitionId: target.id,
        actor: normalizedActor,
        source: normalizedSource,
        occurredAt,
        transitionHash: transitionRequestHash({
          operation: 'undo-replacement', profileId: owner, proposalId: replacement.id, transitionId: target.id,
          reason: normalizedReason, referenceId: replacementReference, actor: normalizedActor, source: normalizedSource, occurredAt,
        }),
      });
      toStatus = 'accepted';
    } else {
      fail('memory_transition_undo_invalid', `Transition to ${target.to_status} cannot be undone.`, { transitionId: targetId });
    }
    const appended = appendLifecycleTransition(store, proposal, {
      toStatus,
      reason: normalizedReason,
      referenceId: reference,
      undoesTransitionId: target.id,
      actor: normalizedActor,
      source: normalizedSource,
      occurredAt,
      transitionHash: requestHash,
    });
    recordAudit(store, 'career_memory.proposal_transition_undone', 'career_memory_proposal', proposal.id, {
      profileId: owner,
      transitionId: appended.id,
      undoesTransitionId: target.id,
      toStatus,
      reason: normalizedReason,
      referenceId: reference,
    });
    return transitionProjection(appended);
  });
}

function scopeSelected(candidateScope, requestedScope) {
  if (!requestedScope) return true;
  if (candidateScope === requestedScope) return true;
  return requestedScope !== 'writing_global' && WRITING_SCOPES.has(requestedScope) && candidateScope === 'writing_global';
}

export function resolveActiveMemoryRules(store, { profileId, domain = null, scope = null, asOf = new Date() }) {
  const owner = text(profileId, 'profileId');
  profileExists(store, owner);
  const nowDate = dateValue(asOf, 'asOf');
  const accepted = acceptedRows(store, owner).filter(row => (!domain || row.domain === domain) && scopeSelected(row.scope, scope));
  const valid = [];
  const excluded = [];
  for (const row of accepted) {
    const validity = proposalValidity(store, row, nowDate);
    if (validity.valid) valid.push(row);
    else excluded.push({ proposalId: row.id, reason: validity.reason });
  }
  const groups = new Map();
  for (const row of valid) {
    const key = `${row.profile_id}\0${row.scope}\0${row.conflict_key}`;
    const rows = groups.get(key) || [];
    rows.push(row);
    groups.set(key, rows);
  }
  const conflictedIds = new Set();
  const invariantViolations = [];
  for (const rows of groups.values()) {
    if (rows.length < 2) continue;
    const proposalIds = rows.map(row => row.id).sort(compareText);
    proposalIds.forEach(id => conflictedIds.add(id));
    invariantViolations.push({
      profileId: owner,
      scope: rows[0].scope,
      conflictKey: rows[0].conflict_key,
      proposalIds,
    });
  }
  invariantViolations.sort((left, right) => compareText(left.scope, right.scope) || compareText(left.conflictKey, right.conflictKey));
  for (const proposalId of conflictedIds) excluded.push({ proposalId, reason: 'active_conflict_invariant' });
  const scopeOrder = new Map(['resume', 'cover_letter', 'outreach', 'interview_prep', 'search', 'writing_global'].map((value, index) => [value, index]));
  const typeOrder = new Map(MEMORY_RULE_TYPES.map((value, index) => [value, index]));
  const rows = valid.filter(row => !conflictedIds.has(row.id)).sort((left, right) =>
    (scopeOrder.get(left.scope) ?? 99) - (scopeOrder.get(right.scope) ?? 99)
    || (typeOrder.get(left.rule_type) ?? 99) - (typeOrder.get(right.rule_type) ?? 99)
    || compareText(right.accepted_at, left.accepted_at)
    || compareText(left.id, right.id));
  return {
    schema: CAREER_MEMORY_ACTIVE_RULES_SCHEMA,
    profileId: owner,
    asOf: nowDate.toISOString(),
    filters: { domain, scope },
    rules: rows.map(row => ({ ...proposalProjection(store, row), active: true })),
    excluded: excluded.sort((left, right) => compareText(left.proposalId, right.proposalId) || compareText(left.reason, right.reason)),
    invariantViolations,
    externalSideEffects: 'none',
  };
}

function candidateScope(store, observation, domain) {
  if (domain === 'search') return 'search';
  if (observation.sourceEntity.type !== 'artifact') return null;
  const artifact = one(store, 'SELECT type FROM artifacts WHERE id=? AND profile_id=?', [observation.sourceEntity.id, observation.profileId]);
  return artifact && WRITING_SCOPES.has(artifact.type) && artifact.type !== 'writing_global' ? artifact.type : null;
}

function derivationCandidates(store, profileId, asOf) {
  const listed = listMemoryObservations(store, {
    profileId,
    sinceDays: MAX_EVIDENCE_FRESHNESS_DAYS,
    includeHistory: false,
    includePrivateNotes: false,
    nowDate: asOf,
  });
  const native = listed.observations.filter(item => citationSchema(item) === CAREER_MEMORY_OBSERVATION_SCHEMA
    && item.current
    && asOf.getTime() - dateValue(item.occurredAt, 'observation.occurredAt').getTime() <= evidenceFreshnessDays(item) * DAY_MS);
  const candidates = new Map();
  for (const observation of native) {
    for (const signal of observation.signals || []) {
      const ruleType = signalRuleType(signal);
      if (ruleType === 'approved_exemplar') continue;
      const domain = SEARCH_RULE_TYPES.has(ruleType) ? 'search' : 'writing';
      if (!MEMORY_RULE_TYPES.includes(ruleType)) continue;
      const scope = candidateScope(store, observation, domain);
      if (!scope) continue;
      let value;
      try {
        value = signalRuleValue(domain, signal);
      } catch {
        continue;
      }
      const ruleKey = memoryRuleKey({ domain, scope, ruleType, value });
      if (!candidates.has(ruleKey)) candidates.set(ruleKey, { domain, scope, ruleType, value });
    }
  }
  const proposals = [];
  for (const candidate of candidates.values()) {
    const candidateRuleKey = memoryRuleKey(candidate);
    const candidateConflictKey = memoryConflictKey(candidate);
    const evidence = [];
    for (const observation of native) {
      for (const signal of observation.signals || []) {
        if (signalRuleType(signal) !== candidate.ruleType) continue;
        let value;
        try {
          value = signalRuleValue(candidate.domain, signal);
        } catch {
          continue;
        }
        const signalCandidate = { ...candidate, value };
        if (memoryConflictKey(signalCandidate) !== candidateConflictKey) continue;
        evidence.push({
          observationSchema: CAREER_MEMORY_OBSERVATION_SCHEMA,
          observationId: observation.id,
          polarity: memoryRuleKey(signalCandidate) === candidateRuleKey ? 'support' : 'conflict',
        });
        break;
      }
    }
    evidence.sort((left, right) => compareText(left.observationSchema, right.observationSchema) || compareText(left.observationId, right.observationId));
    const referenceId = `derived:${canonicalHash({ profileId, ...candidate, evidence, asOf: asOf.toISOString() })}`;
    proposals.push({
      schema: 'jobos.memory-proposal-input.v1',
      ...candidate,
      rationale: 'Repeated direct observations support this visible, reversible guidance.',
      evidence,
      referenceId,
      createdAt: asOf.toISOString(),
    });
  }
  proposals.sort((left, right) => compareText(left.domain, right.domain)
    || compareText(left.scope, right.scope)
    || (MEMORY_RULE_TYPES.indexOf(left.ruleType) - MEMORY_RULE_TYPES.indexOf(right.ruleType))
    || compareText(canonicalJson(left.value), canonicalJson(right.value)));
  return proposals;
}

export function deriveMemoryProposals(store, { profileId, asOf = new Date(), dryRun = false, source = 'deterministic' }) {
  const owner = text(profileId, 'profileId');
  profileExists(store, owner);
  if (source !== 'deterministic') fail('memory_source_invalid', 'Deterministic derivation requires source=deterministic.');
  const nowDate = dateValue(asOf, 'asOf');
  const inputs = derivationCandidates(store, owner, nowDate);
  const proposals = dryRun
    ? inputs.map(input => syntheticProjection(prepareProposal(store, input)))
    : inputs.map(input => createMemoryProposal(store, input));
  return {
    schema: CAREER_MEMORY_PROPOSAL_LIST_SCHEMA,
    profileId: owner,
    asOf: nowDate.toISOString(),
    dryRun: Boolean(dryRun),
    proposals,
    externalSideEffects: 'none',
  };
}
