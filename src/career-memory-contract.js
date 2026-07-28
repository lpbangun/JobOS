import crypto from 'node:crypto';

import { id } from './utils.js';

export const CAREER_MEMORY_OBSERVATION_SCHEMA = 'jobos.career-memory-observation.v1';
export const CAREER_MEMORY_OBSERVATION_LIST_SCHEMA = 'jobos.career-memory-observation-list.v1';
export const CAREER_MEMORY_PROPOSAL_SCHEMA = 'jobos.career-memory-proposal.v1';
export const CAREER_MEMORY_PROPOSAL_LIST_SCHEMA = 'jobos.career-memory-proposal-list.v1';
export const CAREER_MEMORY_TRANSITION_SCHEMA = 'jobos.career-memory-transition.v1';
export const CAREER_MEMORY_ACTIVE_RULES_SCHEMA = 'jobos.career-memory-active-rules.v1';
export const CAREER_BRIEF_SCHEMA = 'jobos.career-brief.v1';
export const VOICE_POSITIONING_GUIDE_SCHEMA = 'jobos.voice-positioning-guide.v1';
export const CAREER_MEMORY_RETRIEVAL_SCHEMA = 'jobos.career-memory-retrieval.v1';
export const CAREER_MEMORY_VALIDATION_SCHEMA = 'jobos.career-memory-validation.v1';
export const JOB_FEEDBACK_INPUT_SCHEMA = 'jobos.job-feedback-input.v1';
export const ARTIFACT_FEEDBACK_INPUT_SCHEMA = 'jobos.artifact-feedback-input.v1';
export const MEMORY_PROPOSAL_INPUT_SCHEMA = 'jobos.memory-proposal-input.v1';

export const CAREER_MEMORY_SCHEMAS = Object.freeze({
  observation: CAREER_MEMORY_OBSERVATION_SCHEMA,
  observationList: CAREER_MEMORY_OBSERVATION_LIST_SCHEMA,
  proposal: CAREER_MEMORY_PROPOSAL_SCHEMA,
  proposalList: CAREER_MEMORY_PROPOSAL_LIST_SCHEMA,
  transition: CAREER_MEMORY_TRANSITION_SCHEMA,
  activeRules: CAREER_MEMORY_ACTIVE_RULES_SCHEMA,
  careerBrief: CAREER_BRIEF_SCHEMA,
  voicePositioningGuide: VOICE_POSITIONING_GUIDE_SCHEMA,
  retrieval: CAREER_MEMORY_RETRIEVAL_SCHEMA,
  validation: CAREER_MEMORY_VALIDATION_SCHEMA,
  jobFeedbackInput: JOB_FEEDBACK_INPUT_SCHEMA,
  artifactFeedbackInput: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
  memoryProposalInput: MEMORY_PROPOSAL_INPUT_SCHEMA,
});

export const MEMORY_EVENT_TYPES = Object.freeze([
  'job_saved',
  'job_skipped',
  'job_applied',
  'artifact_approved',
  'artifact_rejected',
  'artifact_edited',
]);
export const JOB_DECISIONS = Object.freeze(['save', 'skip', 'apply']);
export const MEMORY_OBSERVATION_SCHEMAS = Object.freeze([
  CAREER_MEMORY_SCHEMAS.observation,
  'jobos.outreach-outcome.v1',
  'jobos.lifecycle-observation.v1',
  'jobos.interview-observation.v1',
]);
export const JOB_REASON_CODES = Object.freeze([
  'role_fit',
  'seniority_fit',
  'company_stage',
  'industry',
  'mission',
  'location',
  'work_model',
  'compensation',
  'skills_match',
  'timing',
  'trust_signal',
  'red_flag',
  'other',
]);
export const ARTIFACT_REASON_CODES = Object.freeze([
  'tone',
  'length',
  'opening',
  'closing',
  'structure',
  'vocabulary',
  'specificity',
  'evidence_selection',
  'positioning',
  'unsupported_claim',
  'factual_error',
  'formatting',
  'other',
]);
export const MEMORY_DOMAINS = Object.freeze(['search', 'writing']);
export const MEMORY_SCOPES = Object.freeze([
  'search',
  'resume',
  'cover_letter',
  'outreach',
  'interview_prep',
  'writing_global',
]);
export const SEARCH_RULE_TYPES = Object.freeze([
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
export const WRITING_RULE_TYPES = Object.freeze([
  'tone',
  'length',
  'opening',
  'closing',
  'avoid_term',
  'avoid_claim',
  'positioning_priority',
  'approved_exemplar',
]);
export const MEMORY_RULE_TYPES = Object.freeze([...SEARCH_RULE_TYPES, ...WRITING_RULE_TYPES]);
export const MEMORY_STATUSES = Object.freeze(['proposed', 'accepted', 'rejected', 'superseded', 'revoked']);
export const CONFIDENCE_BANDS = Object.freeze(['low', 'medium', 'high']);
export const CONFLICT_STATES = Object.freeze(['none', 'present']);
export const EVIDENCE_POLARITIES = Object.freeze(['support', 'conflict']);
export const SIGNAL_POLARITIES = Object.freeze(['prefer', 'avoid']);
export const SIGNAL_MATCH_TYPES = Object.freeze(['exact', 'token']);
export const TONE_VALUES = Object.freeze(['concise', 'warm', 'analytical', 'direct', 'narrative', 'formal']);
export const OPENING_VALUES = Object.freeze(['direct', 'context_first', 'proof_first', 'none']);
export const CLOSING_VALUES = Object.freeze(['gratitude', 'call_to_action', 'none']);
export const SOURCE_ENTITY_TYPES = Object.freeze(['job', 'application', 'artifact']);
export const MEMORY_SOURCES = Object.freeze(['cli', 'tui', 'mcp', 'acp', 'deterministic']);
export const PROJECTION_TYPES = Object.freeze(['career_brief', 'voice_positioning_guide']);
export const PROJECTION_SOURCE_KINDS = Object.freeze([
  'profile_field',
  'proof_point',
  'saved_search',
  'accepted_rule',
  'observation',
  'artifact_revision',
]);
export const MEMORY_ERROR_CODES = Object.freeze([
  'memory_contract_invalid',
  'memory_unknown_key',
  'memory_required_field',
  'memory_enum_invalid',
  'memory_timestamp_invalid',
  'memory_undefined_rejected',
  'memory_number_invalid',
  'memory_reason_count_invalid',
  'memory_reason_duplicate',
  'memory_other_explanation_required',
  'memory_signal_duplicate',
  'memory_evidence_duplicate',
  'memory_domain_scope_invalid',
  'memory_rule_value_invalid',
  'memory_reference_conflict',
]);

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PLAIN_OBJECT = Object.prototype;
const JOB_SIGNAL_FIELDS = Object.freeze([
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

export class CareerMemoryContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CareerMemoryContractError';
    this.type = 'validation';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CareerMemoryContractError(code, message, details);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === PLAIN_OBJECT || prototype === null;
}

function object(value, field) {
  if (!isPlainObject(value)) fail('memory_contract_invalid', `${field} must be an object.`, { field });
  return value;
}

function exactKeys(value, allowed, field) {
  const input = object(value, field);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(input).filter(key => !allowedSet.has(key)).sort();
  if (unknown.length) fail('memory_unknown_key', `${field} contains unknown keys: ${unknown.join(', ')}.`, { field, unknown });
  return input;
}

function normalizedString(value, field, { allowEmpty = false, lower = false } = {}) {
  if (typeof value !== 'string') fail('memory_required_field', `${field} must be a string.`, { field });
  let output = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (lower) output = output.toLowerCase();
  if (!allowEmpty && !output) fail('memory_required_field', `${field} is required.`, { field });
  return output;
}

function optionalString(value, field, options = {}) {
  if (value === undefined || value === null) return '';
  return normalizedString(value, field, { ...options, allowEmpty: true });
}

function enumValue(value, allowed, field) {
  if (!allowed.includes(value)) fail('memory_enum_invalid', `${field} is invalid.`, { field, value, allowed });
  return value;
}

function integer(value, field, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail('memory_number_invalid', `${field} must be an integer between ${minimum} and ${maximum}.`, { field, value, minimum, maximum });
  }
  return value;
}

function stringArray(value, field, { minimum = 1, maximum = 20, lower = true, sort = true } = {}) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    fail('memory_rule_value_invalid', `${field} must contain ${minimum} to ${maximum} values.`, { field, minimum, maximum });
  }
  const output = value.map((item, index) => normalizedString(item, `${field}[${index}]`, { lower }));
  if (new Set(output).size !== output.length) fail('memory_rule_value_invalid', `${field} contains duplicate values.`, { field });
  return sort ? output.sort(compareText) : output;
}

function schema(value, expected) {
  if (value !== expected) fail('memory_contract_invalid', `schema must be ${expected}.`, { field: 'schema', expected, value });
  return value;
}

function requiredReference(value, field = 'referenceId') {
  return normalizedString(value, field);
}

function normalizeReasonCodes(value, allowed, { minimum }) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 5) {
    fail('memory_reason_count_invalid', `reasonCodes must contain ${minimum} to 5 values.`, { minimum, maximum: 5 });
  }
  const normalized = value.map((code, index) => enumValue(code, allowed, `reasonCodes[${index}]`));
  if (new Set(normalized).size !== normalized.length) fail('memory_reason_duplicate', 'reasonCodes must be unique.');
  const positions = new Map(allowed.map((code, index) => [code, index]));
  return normalized.sort((left, right) => positions.get(left) - positions.get(right));
}

function assertOtherExplanation(reasonCodes, publicExplanation) {
  if (reasonCodes.includes('other') && !publicExplanation) {
    fail('memory_other_explanation_required', 'publicExplanation is required when reasonCodes contains other.');
  }
}

export function canonicalJson(value) {
  if (value === undefined) fail('memory_undefined_rejected', 'undefined is not a valid W08 integrity value.');
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('memory_number_invalid', 'Canonical JSON numbers must be finite.', { value });
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) fail('memory_undefined_rejected', 'Sparse arrays are not valid W08 integrity values.', { index });
      return canonicalJson(value[index]);
    });
    return `[${items.join(',')}]`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort(compareText);
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  fail('memory_contract_invalid', 'Canonical JSON accepts only JSON values.', { valueType: typeof value });
}

// packets.js canonicalJson rewrites undefined to null. W08 integrity inputs reject it.
export function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function normalizeRfc3339(value, field = 'timestamp') {
  const match = typeof value === 'string' ? value.match(RFC3339) : null;
  if (!match) fail('memory_timestamp_invalid', `${field} must be an RFC3339 timestamp.`, { field, value });
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth
    || hour > 23 || minute > 59 || second > 59) {
    fail('memory_timestamp_invalid', `${field} must be a real RFC3339 timestamp.`, { field, value });
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail('memory_timestamp_invalid', `${field} must be a real RFC3339 timestamp.`, { field, value });
  return new Date(milliseconds).toISOString();
}

function normalizeJobSignal(value, index) {
  const fieldName = `signals[${index}]`;
  const input = exactKeys(value, ['field', 'polarity', 'value', 'match'], fieldName);
  return {
    field: enumValue(input.field, JOB_SIGNAL_FIELDS, `${fieldName}.field`),
    polarity: enumValue(input.polarity, SIGNAL_POLARITIES, `${fieldName}.polarity`),
    value: normalizedString(input.value, `${fieldName}.value`, { lower: true }),
    match: enumValue(input.match, SIGNAL_MATCH_TYPES, `${fieldName}.match`),
  };
}

function normalizeJobSignals(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) fail('memory_contract_invalid', 'signals must be an array with at most 20 entries.', { field: 'signals' });
  const output = value.map(normalizeJobSignal);
  const positions = new Map(JOB_SIGNAL_FIELDS.map((field, index) => [field, index]));
  output.sort((left, right) => positions.get(left.field) - positions.get(right.field)
    || compareText(left.polarity, right.polarity)
    || compareText(left.value, right.value)
    || compareText(left.match, right.match));
  const identities = output.map(signal => canonicalJson(signal));
  if (new Set(identities).size !== identities.length) fail('memory_signal_duplicate', 'signals must be unique.');
  return output;
}

export function normalizeJobFeedbackInput(value) {
  const input = exactKeys(value, [
    'schema',
    'decision',
    'reasonCodes',
    'signals',
    'publicExplanation',
    'privateNote',
    'referenceId',
    'occurredAt',
  ], 'jobFeedback');
  const reasonCodes = normalizeReasonCodes(input.reasonCodes, JOB_REASON_CODES, { minimum: 1 });
  const publicExplanation = optionalString(input.publicExplanation, 'publicExplanation');
  assertOtherExplanation(reasonCodes, publicExplanation);
  return {
    schema: schema(input.schema, CAREER_MEMORY_SCHEMAS.jobFeedbackInput),
    decision: enumValue(input.decision, JOB_DECISIONS, 'decision'),
    reasonCodes,
    signals: normalizeJobSignals(input.signals),
    publicExplanation,
    privateNote: optionalString(input.privateNote, 'privateNote'),
    referenceId: requiredReference(input.referenceId),
    occurredAt: normalizeRfc3339(input.occurredAt, 'occurredAt'),
  };
}

function normalizeSearchValue(value) {
  const input = exactKeys(value, ['polarity', 'value', 'match'], 'value');
  return {
    polarity: enumValue(input.polarity, SIGNAL_POLARITIES, 'value.polarity'),
    value: normalizedString(input.value, 'value.value', { lower: true }),
    match: enumValue(input.match, SIGNAL_MATCH_TYPES, 'value.match'),
  };
}

function normalizeWritingValue(ruleType, value) {
  if (ruleType === 'tone') {
    const input = exactKeys(value, ['value'], 'value');
    return { value: enumValue(input.value, TONE_VALUES, 'value.value') };
  }
  if (ruleType === 'length') {
    const input = exactKeys(value, ['minWords', 'maxWords'], 'value');
    const minWords = integer(input.minWords, 'value.minWords', 0, 1200);
    const maxWords = integer(input.maxWords, 'value.maxWords', 0, 1200);
    if (minWords > maxWords) fail('memory_rule_value_invalid', 'value.minWords must not exceed value.maxWords.');
    return { minWords, maxWords };
  }
  if (ruleType === 'opening' || ruleType === 'closing') {
    const input = exactKeys(value, ['value'], 'value');
    const allowed = ruleType === 'opening' ? OPENING_VALUES : CLOSING_VALUES;
    return { value: enumValue(input.value, allowed, 'value.value') };
  }
  if (ruleType === 'avoid_term') {
    const input = exactKeys(value, ['terms'], 'value');
    return { terms: stringArray(input.terms, 'value.terms') };
  }
  if (ruleType === 'avoid_claim') {
    const input = exactKeys(value, ['claimPattern', 'reasonCode'], 'value');
    return {
      claimPattern: normalizedString(input.claimPattern, 'value.claimPattern', { lower: true }),
      reasonCode: enumValue(input.reasonCode, ['unsupported', 'unwanted_positioning'], 'value.reasonCode'),
    };
  }
  if (ruleType === 'positioning_priority') {
    const input = exactKeys(value, ['theme', 'proofPointIds'], 'value');
    return {
      theme: normalizedString(input.theme, 'value.theme'),
      proofPointIds: stringArray(input.proofPointIds, 'value.proofPointIds', { maximum: 24, lower: false, sort: false }),
    };
  }
  if (ruleType === 'approved_exemplar') {
    const input = exactKeys(value, ['artifactId', 'revision', 'contentHash', 'startLine', 'endLine', 'excerptHash'], 'value');
    const contentHash = normalizedString(input.contentHash, 'value.contentHash', { lower: true });
    const excerptHash = normalizedString(input.excerptHash, 'value.excerptHash', { lower: true });
    if (!SHA256.test(contentHash) || !SHA256.test(excerptHash)) fail('memory_rule_value_invalid', 'Exemplar hashes must be full lowercase SHA-256 values.');
    const startLine = integer(input.startLine, 'value.startLine', 1, Number.MAX_SAFE_INTEGER);
    const endLine = integer(input.endLine, 'value.endLine', 1, Number.MAX_SAFE_INTEGER);
    if (startLine > endLine) fail('memory_rule_value_invalid', 'value.startLine must not exceed value.endLine.');
    return {
      artifactId: normalizedString(input.artifactId, 'value.artifactId'),
      revision: integer(input.revision, 'value.revision', 1, Number.MAX_SAFE_INTEGER),
      contentHash,
      startLine,
      endLine,
      excerptHash,
    };
  }
  fail('memory_enum_invalid', `Unknown writing rule type: ${ruleType}.`, { ruleType });
}

export function normalizeRuleValue({ domain, ruleType, value }) {
  enumValue(domain, MEMORY_DOMAINS, 'domain');
  if (domain === 'search') {
    enumValue(ruleType, SEARCH_RULE_TYPES, 'ruleType');
    return normalizeSearchValue(value);
  }
  enumValue(ruleType, WRITING_RULE_TYPES, 'ruleType');
  return normalizeWritingValue(ruleType, value);
}

function normalizeArtifactSignal(value, index) {
  const fieldName = `signals[${index}]`;
  const input = exactKeys(value, ['ruleType', 'value'], fieldName);
  const ruleType = enumValue(input.ruleType, WRITING_RULE_TYPES, `${fieldName}.ruleType`);
  return { ruleType, value: normalizeWritingValue(ruleType, input.value) };
}

export function normalizeArtifactFeedbackInput(value, { decision = 'edit' } = {}) {
  const input = exactKeys(value, [
    'schema',
    'reasonCodes',
    'signals',
    'publicExplanation',
    'privateNote',
    'referenceId',
  ], 'artifactFeedback');
  const normalizedDecision = enumValue(decision, ['approve', 'reject', 'edit'], 'decision');
  const reasonCodes = normalizeReasonCodes(input.reasonCodes ?? [], ARTIFACT_REASON_CODES, {
    minimum: normalizedDecision === 'approve' ? 0 : 1,
  });
  const publicExplanation = optionalString(input.publicExplanation, 'publicExplanation');
  assertOtherExplanation(reasonCodes, publicExplanation);
  if (input.signals !== undefined && !Array.isArray(input.signals)) fail('memory_contract_invalid', 'signals must be an array.', { field: 'signals' });
  const signals = (input.signals || []).map(normalizeArtifactSignal);
  const identities = signals.map(signal => canonicalJson(signal));
  if (new Set(identities).size !== identities.length) fail('memory_signal_duplicate', 'signals must be unique.');
  return {
    schema: schema(input.schema, CAREER_MEMORY_SCHEMAS.artifactFeedbackInput),
    reasonCodes,
    signals,
    publicExplanation,
    privateNote: optionalString(input.privateNote, 'privateNote'),
    referenceId: requiredReference(input.referenceId),
  };
}

function normalizeProposalEvidence(value, index) {
  const fieldName = `evidence[${index}]`;
  const input = exactKeys(value, ['observationSchema', 'observationId', 'polarity'], fieldName);
  return {
    observationSchema: enumValue(input.observationSchema, MEMORY_OBSERVATION_SCHEMAS, `${fieldName}.observationSchema`),
    observationId: normalizedString(input.observationId, `${fieldName}.observationId`),
    polarity: enumValue(input.polarity, EVIDENCE_POLARITIES, `${fieldName}.polarity`),
  };
}

export function normalizeMemoryProposalInput(value) {
  const input = exactKeys(value, [
    'schema',
    'domain',
    'scope',
    'ruleType',
    'value',
    'rationale',
    'evidence',
    'referenceId',
    'createdAt',
  ], 'memoryProposal');
  const domain = enumValue(input.domain, MEMORY_DOMAINS, 'domain');
  const scope = enumValue(input.scope, MEMORY_SCOPES, 'scope');
  if ((domain === 'search' && scope !== 'search') || (domain === 'writing' && scope === 'search')) {
    fail('memory_domain_scope_invalid', 'Search proposals require search scope; writing proposals require a writing scope.', { domain, scope });
  }
  const ruleType = enumValue(input.ruleType, domain === 'search' ? SEARCH_RULE_TYPES : WRITING_RULE_TYPES, 'ruleType');
  if (ruleType === 'approved_exemplar' && scope === 'writing_global') {
    fail('memory_domain_scope_invalid', 'approved_exemplar cannot use writing_global scope.', { ruleType, scope });
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    fail('memory_required_field', 'evidence must contain at least one observation.', { field: 'evidence' });
  }
  const evidence = input.evidence.map(normalizeProposalEvidence);
  const identities = evidence.map(item => `${item.observationSchema}\0${item.observationId}`);
  if (new Set(identities).size !== identities.length) fail('memory_evidence_duplicate', 'evidence observation identities must be unique.');
  evidence.sort((left, right) => compareText(left.observationSchema, right.observationSchema)
    || compareText(left.observationId, right.observationId)
    || compareText(left.polarity, right.polarity));
  const output = {
    schema: schema(input.schema, CAREER_MEMORY_SCHEMAS.memoryProposalInput),
    domain,
    scope,
    ruleType,
    value: normalizeRuleValue({ domain, ruleType, value: input.value }),
    rationale: normalizedString(input.rationale, 'rationale'),
    evidence,
    referenceId: requiredReference(input.referenceId),
  };
  if (input.createdAt !== undefined) output.createdAt = normalizeRfc3339(input.createdAt, 'createdAt');
  return output;
}

function idPart(value, field) {
  if (typeof value === 'number') return String(integer(value, field, 1, Number.MAX_SAFE_INTEGER));
  return normalizedString(value, field);
}

export function memoryObservationId({
  profileId,
  sourceSchema,
  sourceEntityType,
  sourceEntityId,
  sourceVersionId,
  eventType,
  referenceId,
}) {
  const seed = [profileId, sourceSchema, sourceEntityType, sourceEntityId, sourceVersionId, eventType, referenceId]
    .map((value, index) => idPart(value, `observationIdPart[${index}]`))
    .join('|');
  return id('memory_observation', seed);
}

export function memoryProposalId({ profileId, domain, scope, ruleType, ruleKey: key, evidenceHash, createdAt }) {
  const seed = [profileId, domain, scope, ruleType, key, evidenceHash, createdAt]
    .map((value, index) => idPart(value, `proposalIdPart[${index}]`))
    .join('|');
  return id('memory_proposal', seed);
}

export function memoryTransitionId({ proposalId, sequence, toStatus, referenceId }) {
  const seed = [
    idPart(proposalId, 'proposalId'),
    idPart(sequence, 'sequence'),
    idPart(toStatus, 'toStatus'),
    idPart(referenceId, 'referenceId'),
  ].join('|');
  return id('memory_transition', seed);
}

export function memoryProjectionId({ profileId, projectionType, revision, sourceStateHash }) {
  const seed = [
    idPart(profileId, 'profileId'),
    idPart(projectionType, 'projectionType'),
    idPart(revision, 'revision'),
    idPart(sourceStateHash, 'sourceStateHash'),
  ].join('|');
  return id('memory_projection', seed);
}

export function memoryRuleKey({ domain, scope, ruleType, value }) {
  return canonicalHash({
    domain: enumValue(domain, MEMORY_DOMAINS, 'domain'),
    scope: enumValue(scope, MEMORY_SCOPES, 'scope'),
    ruleType: enumValue(ruleType, MEMORY_RULE_TYPES, 'ruleType'),
    value: normalizeRuleValue({ domain, ruleType, value }),
  });
}

export function memoryConflictKey({ domain, scope, ruleType, value }) {
  const normalizedValue = normalizeRuleValue({ domain, ruleType, value });
  const target = domain === 'search'
    ? { match: normalizedValue.match, value: normalizedValue.value }
    : normalizedValue;
  return canonicalHash({
    domain: enumValue(domain, MEMORY_DOMAINS, 'domain'),
    ruleType: enumValue(ruleType, MEMORY_RULE_TYPES, 'ruleType'),
    value: target,
  });
}
