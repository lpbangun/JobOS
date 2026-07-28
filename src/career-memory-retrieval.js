import crypto from 'node:crypto';

import {
  CAREER_MEMORY_RETRIEVAL_SCHEMA,
  CAREER_MEMORY_VALIDATION_SCHEMA,
} from './career-memory-contract.js';
import { listMemoryObservations } from './career-memory-observations.js';
import { resolveActiveMemoryRules } from './career-memory-proposals.js';
import { one } from './db.js';
import { parseJson } from './utils.js';

const SEARCH_GUIDANCE_SCHEMA = 'jobos.career-memory-search-guidance.v1';
const CONSUMERS = new Set(['discovery', 'scoring', 'tailoring', 'outreach', 'interview_prep']);
const TAILORING_ARTIFACT_TYPES = new Set(['resume', 'cover_letter']);
const SEARCH_CONSUMERS = new Set(['discovery', 'scoring']);
const WRITING_CONSUMERS = new Set(['tailoring', 'outreach', 'interview_prep']);
const DAY_MS = 86_400_000;

const DEFAULT_BUDGETS = Object.freeze({
  discovery: Object.freeze({ maxRules: 8, maxObservations: 8, lookbackDays: 180, maxUtf8Bytes: 4000 }),
  scoring: Object.freeze({ maxRules: 8, maxObservations: 0, lookbackDays: null, maxUtf8Bytes: 3000 }),
  tailoring: Object.freeze({ maxRules: 12, maxObservations: 6, lookbackDays: 365, maxUtf8Bytes: 6000 }),
  outreach: Object.freeze({ maxRules: 10, maxObservations: 4, lookbackDays: 365, maxUtf8Bytes: 5000 }),
  interview_prep: Object.freeze({ maxRules: 10, maxObservations: 6, lookbackDays: 365, maxUtf8Bytes: 6000 }),
});

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

function requiredText(value, field) {
  if (typeof value !== 'string' || !value.trim()) fail(`memory_${field}_invalid`, `${field} must be a non-empty string.`, { field });
  return value.trim();
}

function dateValue(value, field) {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) fail(`memory_${field}_invalid`, `${field} must be a valid date.`, { field });
  return parsed;
}

function exactKeys(value, allowed, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`memory_${field}_invalid`, `${field} must be an object.`, { field });
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) fail(`memory_${field}_invalid`, `${field} contains unsupported fields.`, { field, extra });
  return value;
}

function normalizedBudget(consumer, override) {
  const defaults = DEFAULT_BUDGETS[consumer];
  if (override === null || override === undefined) return { ...defaults };
  const input = exactKeys(override, ['maxRules', 'maxObservations', 'lookbackDays', 'maxUtf8Bytes'], 'budgets');
  const result = { ...defaults, ...input };
  for (const key of ['maxRules', 'maxObservations', 'maxUtf8Bytes']) {
    if (!Number.isInteger(result[key]) || result[key] < 0 || result[key] > defaults[key]) {
      fail('memory_budgets_invalid', `${key} must be an integer within the public ${consumer} bound.`, { consumer, key, maximum: defaults[key] });
    }
  }
  if (defaults.lookbackDays === null) {
    if (result.lookbackDays !== null) fail('memory_budgets_invalid', 'scoring lookbackDays must remain null.', { consumer, key: 'lookbackDays' });
  } else if (!Number.isInteger(result.lookbackDays) || result.lookbackDays < 0 || result.lookbackDays > defaults.lookbackDays) {
    fail('memory_budgets_invalid', `lookbackDays must be an integer within the public ${consumer} bound.`, {
      consumer,
      key: 'lookbackDays',
      maximum: defaults.lookbackDays,
    });
  }
  return result;
}

function normalizePublicValue(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
}

function tokenMatch(candidate, expected) {
  const tokens = expected.split(/[^a-z0-9]+/).filter(Boolean);
  const candidateTokens = new Set(candidate.split(/[^a-z0-9]+/).filter(Boolean));
  return tokens.length > 0 && tokens.every(token => candidateTokens.has(token));
}

function canonicalJobValues(job, field) {
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
  return values.map(normalizePublicValue).filter(Boolean);
}

function ruleMatchesJob(rule, job) {
  if (rule.domain !== 'search' || rule.scope !== 'search') return false;
  const value = rule.value;
  if (!value || !['prefer', 'avoid'].includes(value.polarity) || !['exact', 'token'].includes(value.match)) return false;
  const expected = normalizePublicValue(value.value);
  const candidates = canonicalJobValues(job, rule.ruleType);
  return value.match === 'exact'
    ? candidates.includes(expected)
    : candidates.some(candidate => tokenMatch(candidate, expected));
}

function requireProfile(store, profileId) {
  if (!one(store, 'SELECT id FROM profiles WHERE id=?', [profileId])) {
    fail('memory_profile_unknown', `Unknown profile: ${profileId}.`, { profileId });
  }
}

function requireOwnedJob(store, profileId, jobId, required) {
  if (jobId === null || jobId === undefined || jobId === '') {
    if (required) fail('memory_job_required', 'jobId is required for this consumer.', { profileId });
    return null;
  }
  const normalized = requiredText(jobId, 'job_id');
  const job = one(store, 'SELECT * FROM jobs WHERE id=? AND profile_id=?', [normalized, profileId]);
  if (!job) fail('memory_job_unknown', `Unknown job for profile ${profileId}: ${normalized}.`, { profileId, jobId: normalized });
  return job;
}

function consumerScope(consumer, artifactType) {
  if (consumer === 'tailoring') return artifactType;
  if (consumer === 'outreach') return 'outreach';
  if (consumer === 'interview_prep') return 'interview_prep';
  return 'search';
}

function acceptedAt(rule) {
  for (let index = (rule.transitions?.length || 0) - 1; index >= 0; index -= 1) {
    if (rule.transitions[index].toStatus === 'accepted') return rule.transitions[index].occurredAt;
  }
  return null;
}

function evidenceCitation(evidence) {
  return {
    schema: evidence.observationSchema,
    id: evidence.observationId,
    versionId: evidence.sourceEntity.versionId,
  };
}

function observationCitation(observation) {
  const schema = observation.source === 'w05_adapter'
    ? 'jobos.outreach-outcome.v1'
    : observation.source === 'w06_adapter'
      ? 'jobos.lifecycle-observation.v1'
      : observation.source === 'w07_adapter'
        ? 'jobos.interview-observation.v1'
        : observation.schema;
  return { schema, id: observation.id, versionId: observation.sourceEntity.versionId };
}

function retrievalRule(rule) {
  return {
    id: rule.id,
    domain: rule.domain,
    scope: rule.scope,
    ruleType: rule.ruleType,
    value: rule.value,
    acceptedAt: acceptedAt(rule),
    evidenceFreshUntil: rule.evidenceFreshUntil,
    citations: (rule.evidence || []).map(evidenceCitation),
  };
}

function containsProtectedData(observation) {
  const publicGuidanceData = JSON.stringify({
    reasonCodes: observation.reasonCodes,
    signals: observation.signals,
    publicExplanation: observation.publicExplanation,
    payload: observation.payload,
  });
  return PROTECTED_PATTERNS.some(pattern => pattern.test(publicGuidanceData));
}

function observationJobId(observation) {
  if (observation.sourceEntity.type === 'job') return observation.sourceEntity.id;
  return observation.payload?.jobId || null;
}

function searchObservationRelevant(observation, job) {
  if (observationJobId(observation) === job.id) return true;
  return (observation.signals || []).some(signal => {
    if (!signal || typeof signal !== 'object') return false;
    const expected = normalizePublicValue(signal.value);
    const candidates = canonicalJobValues(job, signal.field);
    return signal.match === 'exact'
      ? candidates.includes(expected)
      : signal.match === 'token' && candidates.some(candidate => tokenMatch(candidate, expected));
  });
}

function artifactObservationRelevant(store, observation, artifactType, job) {
  if (observation.sourceEntity.type !== 'artifact') return false;
  const artifact = one(store, 'SELECT type,job_id FROM artifacts WHERE id=? AND profile_id=?', [observation.sourceEntity.id, observation.profileId]);
  if (!artifact || artifact.type !== artifactType) return false;
  return !job || artifact.job_id === null || artifact.job_id === job.id;
}

function observationRelevant(store, observation, consumer, job, artifactType) {
  if (SEARCH_CONSUMERS.has(consumer)) return searchObservationRelevant(observation, job);
  if (consumer === 'tailoring') return artifactObservationRelevant(store, observation, artifactType, job);
  const sourceMatches = consumer === 'outreach'
    ? observation.source === 'w05_adapter'
    : observation.source === 'w07_adapter';
  return sourceMatches && (!job || observationJobId(observation) === job.id);
}

function uniqueCitations(rules, observations) {
  const output = [];
  const seen = new Set();
  const append = citation => {
    const key = `${citation.schema}\0${citation.id}\0${citation.versionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    output.push(citation);
  };
  for (const rule of rules) rule.citations.forEach(append);
  for (const observation of observations) append(observationCitation(observation));
  return output;
}

function applyBudgets(rules, observations, budgets) {
  const selectedRules = rules.slice(0, budgets.maxRules);
  const selectedObservations = observations.slice(0, budgets.maxObservations);
  const dropped = {
    rules: rules.length - selectedRules.length,
    observations: observations.length - selectedObservations.length,
  };
  const outputRules = [];
  const outputObservations = [];
  let usedUtf8Bytes = 0;
  let exhausted = false;
  for (const [kind, items, output] of [
    ['rules', selectedRules, outputRules],
    ['observations', selectedObservations, outputObservations],
  ]) {
    for (let index = 0; index < items.length; index += 1) {
      const bytes = Buffer.byteLength(JSON.stringify(items[index]), 'utf8');
      if (exhausted || usedUtf8Bytes + bytes > budgets.maxUtf8Bytes) {
        dropped[kind] += items.length - index;
        exhausted = true;
        break;
      }
      output.push(items[index]);
      usedUtf8Bytes += bytes;
    }
  }
  return { rules: outputRules, observations: outputObservations, dropped, usedUtf8Bytes };
}

export function retrieveCareerMemory(store, {
  profileId,
  consumer,
  jobId = null,
  artifactType = null,
  asOf = new Date(),
  budgets = null,
} = {}) {
  const owner = requiredText(profileId, 'profile_id');
  requireProfile(store, owner);
  const selectedConsumer = requiredText(consumer, 'consumer');
  if (!CONSUMERS.has(selectedConsumer)) fail('memory_consumer_invalid', `Unsupported career-memory consumer: ${selectedConsumer}.`, { consumer: selectedConsumer });
  if (selectedConsumer === 'tailoring') {
    if (!TAILORING_ARTIFACT_TYPES.has(artifactType)) fail('memory_artifact_type_invalid', 'tailoring requires artifactType resume or cover_letter.', { artifactType });
  } else if (artifactType !== null && artifactType !== undefined) {
    fail('memory_artifact_type_unexpected', `${selectedConsumer} does not accept artifactType.`, { artifactType });
  }
  const nowDate = dateValue(asOf, 'as_of');
  const job = requireOwnedJob(store, owner, jobId, SEARCH_CONSUMERS.has(selectedConsumer));
  const limits = normalizedBudget(selectedConsumer, budgets);
  const domain = SEARCH_CONSUMERS.has(selectedConsumer) ? 'search' : 'writing';
  const scope = consumerScope(selectedConsumer, artifactType);
  const active = resolveActiveMemoryRules(store, { profileId: owner, domain, scope, asOf: nowDate });
  const listed = listMemoryObservations(store, {
    profileId: owner,
    sinceDays: null,
    includeHistory: false,
    includePrivateNotes: false,
    nowDate,
  });
  const relevant = [];
  let irrelevant = 0;
  let protectedCount = 0;
  let outsideLookback = 0;
  const cutoff = limits.lookbackDays === null
    ? null
    : new Date(nowDate.getTime() - limits.lookbackDays * DAY_MS).toISOString();
  for (const observation of listed.observations) {
    if (!observationRelevant(store, observation, selectedConsumer, job, artifactType)) {
      irrelevant += 1;
      continue;
    }
    if (containsProtectedData(observation)) {
      protectedCount += 1;
      continue;
    }
    if (cutoff && observation.occurredAt < cutoff) {
      outsideLookback += 1;
      continue;
    }
    const { privateNote, ...publicObservation } = observation;
    relevant.push(publicObservation);
  }
  const preparedRules = active.rules.map(retrievalRule);
  const bounded = applyBudgets(preparedRules, relevant, limits);
  return {
    schema: CAREER_MEMORY_RETRIEVAL_SCHEMA,
    profileId: owner,
    consumer: selectedConsumer,
    jobId: job?.id || null,
    artifactType: selectedConsumer === 'tailoring' ? artifactType : null,
    asOf: nowDate.toISOString(),
    budgets: {
      maxRules: limits.maxRules,
      maxObservations: limits.maxObservations,
      lookbackDays: limits.lookbackDays,
      maxUtf8Bytes: limits.maxUtf8Bytes,
      usedUtf8Bytes: bounded.usedUtf8Bytes,
    },
    rules: bounded.rules,
    observations: bounded.observations,
    citations: uniqueCitations(bounded.rules, bounded.observations),
    exclusions: {
      rules: active.excluded,
      observations: {
        superseded: listed.excluded.superseded,
        outsideLookback,
        privateNotes: listed.excluded.privateNotes,
        irrelevant,
        protected: protectedCount,
      },
      budget: bounded.dropped,
    },
    policy: {
      acceptedGuidanceOnly: true,
      currentObservationsOnly: true,
      privateNotes: 'excluded',
      protectedSensitiveData: 'excluded',
      facts: 'canonical_sources_only',
    },
    externalSideEffects: 'none',
  };
}

export function evaluateSearchGuidance(store, { profileId, jobId, asOf = new Date() } = {}) {
  const owner = requiredText(profileId, 'profile_id');
  const nowDate = dateValue(asOf, 'as_of');
  requireProfile(store, owner);
  const job = requireOwnedJob(store, owner, jobId, true);
  const active = resolveActiveMemoryRules(store, { profileId: owner, domain: 'search', scope: 'search', asOf: nowDate });
  const matched = active.rules.map(retrievalRule).filter(rule => ruleMatchesJob(rule, job));
  const adjustment = Math.max(-10, Math.min(10, matched.reduce((total, rule) => total + (rule.value.polarity === 'prefer' ? 2 : -2), 0)));
  return {
    schema: SEARCH_GUIDANCE_SCHEMA,
    adjustment,
    matchedRuleIds: matched.map(rule => rule.id),
    citations: uniqueCitations(matched, []),
    explanation: 'accepted guidance; fit score unchanged',
  };
}

function stringArray(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) fail('memory_validation_output_invalid', `${field} must be an array of strings.`, { field });
  return value;
}

function validationError(code, ruleIds, details) {
  return { code, ruleIds, details };
}

function firstRule(rules, type) {
  return rules.find(rule => rule.ruleType === type) || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function containsExemplarExcerpt(text, value) {
  const normalizedLines = text.replace(/\r\n?/g, '\n').split('\n');
  const lineCount = value.endLine - value.startLine + 1;
  for (let index = 0; index + lineCount <= normalizedLines.length; index += 1) {
    if (sha256(normalizedLines.slice(index, index + lineCount).join('\n')) === value.excerptHash) return true;
  }
  return false;
}


export function validateWritingGuidance(output, retrievalPacket) {
  if (!retrievalPacket || retrievalPacket.schema !== CAREER_MEMORY_RETRIEVAL_SCHEMA || !WRITING_CONSUMERS.has(retrievalPacket.consumer) || !Array.isArray(retrievalPacket.rules)) {
    fail('memory_retrieval_packet_invalid', 'A writing-scoped career-memory retrieval packet is required.');
  }
  const candidate = typeof output === 'string' ? { text: output } : output;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate) || typeof candidate.text !== 'string') {
    fail('memory_validation_output_invalid', 'output must contain text.');
  }
  const text = candidate.text.normalize('NFKC');
  const normalizedText = normalizePublicValue(text);
  const proofPointIds = stringArray(candidate.proofPointIds, 'proofPointIds');
  const claims = stringArray(candidate.claims, 'claims');
  const exemplarExcerptHashes = stringArray(candidate.exemplarExcerptHashes, 'exemplarExcerptHashes');
  const rules = retrievalPacket.rules.filter(rule => rule.domain === 'writing');
  const errors = [];
  const wordCount = text.trim() ? text.trim().split(/\s+/u).length : 0;

  const length = firstRule(rules, 'length');
  if (length && (wordCount < length.value.minWords || wordCount > length.value.maxWords)) {
    errors.push(validationError('memory_writing_length_invalid', [length.id], { wordCount, minWords: length.value.minWords, maxWords: length.value.maxWords }));
  }
  const opening = firstRule(rules, 'opening');
  if (opening && candidate.openingVariant !== opening.value.value) {
    errors.push(validationError('memory_writing_opening_invalid', [opening.id], { expected: opening.value.value, actual: candidate.openingVariant ?? null }));
  }
  const closing = firstRule(rules, 'closing');
  if (closing && candidate.closingVariant !== closing.value.value) {
    errors.push(validationError('memory_writing_closing_invalid', [closing.id], { expected: closing.value.value, actual: candidate.closingVariant ?? null }));
  }
  for (const rule of rules.filter(item => item.ruleType === 'avoid_term')) {
    const matches = rule.value.terms.filter(term => normalizedText.includes(normalizePublicValue(term)));
    if (matches.length) errors.push(validationError('memory_writing_avoid_term', [rule.id], { terms: matches }));
  }
  const normalizedClaims = claims.map(normalizePublicValue);
  for (const rule of rules.filter(item => item.ruleType === 'avoid_claim')) {
    const pattern = normalizePublicValue(rule.value.claimPattern);
    if (normalizedText.includes(pattern) || normalizedClaims.some(claim => claim.includes(pattern))) {
      errors.push(validationError('memory_writing_avoid_claim', [rule.id], { claimPattern: rule.value.claimPattern, reasonCode: rule.value.reasonCode }));
    }
  }
  const positioning = firstRule(rules, 'positioning_priority');
  const allowedProofPointIds = positioning ? positioning.value.proofPointIds : [];
  const disallowedProofPointIds = positioning ? proofPointIds.filter(id => !allowedProofPointIds.includes(id)) : [];
  if (disallowedProofPointIds.length) {
    errors.push(validationError('memory_writing_proof_not_allowed', [positioning.id], { proofPointIds: disallowedProofPointIds }));
  }
  for (const rule of rules.filter(item => item.ruleType === 'approved_exemplar')) {
    if (containsExemplarExcerpt(candidate.text, rule.value) || exemplarExcerptHashes.includes(rule.value.excerptHash)) {
      errors.push(validationError('memory_writing_exemplar_copied', [rule.id], { artifactId: rule.value.artifactId, revision: rule.value.revision }));
    }
  }

  return {
    schema: CAREER_MEMORY_VALIDATION_SCHEMA,
    valid: errors.length === 0,
    errors,
    wordCount,
    appliedRuleIds: rules.map(rule => rule.id),
    allowedProofPointIds,
    externalSideEffects: 'none',
  };
}
