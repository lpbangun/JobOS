import { one, all, run, save, audit } from './db.js';
import { id, now, parseJson, redFlags, tokenize } from './utils.js';
import { assertJobLivenessGate, resolveJobLiveness, syncJob } from './jobs.js';
import { generateJson, llmConfig } from './llm.js';
import { activeVerifiedProofs } from './profiles.js';
import { buildRequirementCoverage, inventoryForJob, requirementTextsForJob } from './requirements.js';

export const FIT_CONTRACT = 'jobos.fit-score.v1';
export const FIT_DIMENSION_WEIGHTS = Object.freeze({
  roleFit: 28,
  domainFit: 18,
  seniority: 14,
  locationWorkModel: 12,
  compensation: 8,
  missionInterest: 14,
  networkAccess: 6
});

const dimensionKeys = Object.freeze(Object.keys(FIT_DIMENSION_WEIGHTS));
const evidenceKinds = new Set(['job_field', 'job_requirement', 'profile_preference', 'proof_point', 'research_run', 'relationship_edge', 'contact_point']);
const candidateEvidenceKinds = new Set(['profile_preference', 'proof_point']);
const jobEvidenceKinds = new Set(['job_field', 'job_requirement']);
const constraintStatuses = new Set(['confirmed', 'possible', 'unknown', 'cleared']);
const modes = new Set(['deterministic-degraded', 'llm', 'agent']);
const sourceEvidenceFields = Object.freeze([
  'label',
  'source',
  'url',
  'sourceUrl',
  'source_url',
  'sourceObservationId',
  'source_observation_id',
  'sourceObservationIds',
  'source_observation_ids'
]);

function clampInteger(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 100) throw new Error(`Fit dimension score must be an integer from 0 to 100; received ${value}`);
  return number;
}

function evidenceKey(value) {
  return `${value.kind}:${value.id}:${value.field || ''}`;
}

function uniqueEvidence(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value || !evidenceKinds.has(value.kind) || !String(value.id || '').trim()) throw new Error('Invalid fit evidence reference');
    const normalized = { kind: value.kind, id: String(value.id), ...(value.field ? { field: String(value.field) } : {}) };
    const key = evidenceKey(normalized);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(normalized);
    }
  }
  return result;
}

function validateDimension(key, value) {
  if (!value || typeof value !== 'object') throw new Error(`Missing fit dimension: ${key}`);
  if (!['scored', 'unknown', 'contradicted'].includes(value.status)) throw new Error(`Invalid status for fit dimension ${key}`);
  const evidenceRefs = uniqueEvidence(value.evidenceRefs || []);
  const reason = String(value.reason || '').trim();
  if (!reason) throw new Error(`Fit dimension ${key} requires a reason`);
  if (value.status === 'unknown') {
    if (value.score !== null) throw new Error(`Unknown fit dimension ${key} must have score null`);
  } else {
    clampInteger(value.score);
    if (key !== 'networkAccess') {
      if (!evidenceRefs.some(item => candidateEvidenceKinds.has(item.kind))) throw new Error(`Scored fit dimension ${key} requires candidate evidence`);
      if (!evidenceRefs.some(item => jobEvidenceKinds.has(item.kind))) throw new Error(`Scored fit dimension ${key} requires job evidence`);
    } else if (!evidenceRefs.some(item => item.kind === 'research_run')) {
      throw new Error('Scored networkAccess requires a research run evidence reference');
    }
  }
  return {
    status: value.status,
    score: value.status === 'unknown' ? null : clampInteger(value.score),
    weight: FIT_DIMENSION_WEIGHTS[key],
    reason,
    evidenceRefs
  };
}

function validateConstraint(value, index) {
  if (!value || !['dealbreaker', 'contradiction'].includes(value.kind)) throw new Error(`Invalid fit constraint at index ${index}`);
  if (!constraintStatuses.has(value.status)) throw new Error(`Invalid fit constraint status at index ${index}`);
  const preferenceRef = value.preferenceRef ? uniqueEvidence([value.preferenceRef])[0] : null;
  const jobEvidenceRefs = uniqueEvidence(value.jobEvidenceRefs || []);
  if (value.status === 'confirmed') {
    if (!preferenceRef || preferenceRef.kind !== 'profile_preference') throw new Error('Confirmed fit constraint requires a preference reference');
    if (!jobEvidenceRefs.some(item => jobEvidenceKinds.has(item.kind))) throw new Error('Confirmed fit constraint requires job evidence');
  }
  return {
    id: String(value.id || `constraint-${index + 1}`),
    kind: value.kind,
    dimension: String(value.dimension || ''),
    status: value.status,
    preferenceRef,
    jobEvidenceRefs,
    reason: String(value.reason || '').trim() || 'Constraint requires review.'
  };
}

function validatePostingRisk(value, index) {
  const evidenceRefs = uniqueEvidence(value?.evidenceRefs || []);
  if (!evidenceRefs.every(item => jobEvidenceKinds.has(item.kind))) throw new Error(`Posting risk ${index} may cite only job evidence`);
  return {
    code: String(value?.code || `posting-risk-${index + 1}`),
    status: value?.status === 'unknown' ? 'unknown' : 'observed',
    reason: String(value?.reason || '').trim() || 'Posting risk requires review.',
    evidenceRefs
  };
}

export function finalizeFitScore(input) {
  if (!input || typeof input !== 'object') throw new Error('Fit score input is required');
  const dimensions = {};
  for (const key of dimensionKeys) dimensions[key] = validateDimension(key, input.dimensions?.[key]);
  if (Object.keys(input.dimensions || {}).some(key => !dimensionKeys.includes(key))) throw new Error('Unsupported fit dimension');
  const constraints = (input.constraints || []).map(validateConstraint);
  const postingRisks = (input.postingRisks || []).map(validatePostingRisk);
  const known = Object.values(dimensions).filter(value => value.status !== 'unknown');
  const knownWeight = known.reduce((sum, value) => sum + value.weight, 0);
  const evidenceCoverage = Math.max(0, Math.min(100, knownWeight));
  const coreKnown = dimensions.roleFit.status !== 'unknown' && dimensions.seniority.status !== 'unknown';
  const sufficient = coreKnown && knownWeight >= 70;
  const baseOverall = sufficient
    ? Math.max(0, Math.min(100, Math.round(known.reduce((sum, value) => sum + value.weight * value.score, 0) / knownWeight)))
    : null;
  const confirmedDealbreaker = constraints.some(value => value.kind === 'dealbreaker' && value.status === 'confirmed');
  const confirmedContradiction = constraints.some(value => value.kind === 'contradiction' && value.status === 'confirmed');
  const unresolvedConstraint = constraints.some(value => ['possible', 'unknown'].includes(value.status));
  let overall = baseOverall;
  let scoreStatus = 'scored';
  if (confirmedDealbreaker) {
    overall = 0;
    scoreStatus = 'review_required';
  } else if (!sufficient) {
    overall = null;
    scoreStatus = 'insufficient_evidence';
  } else if (confirmedContradiction) {
    overall = Math.min(baseOverall, 59);
    scoreStatus = 'review_required';
  } else if (evidenceCoverage < 85 || unresolvedConstraint) {
    scoreStatus = 'review_required';
  }
  const noConstraintConcern = !confirmedDealbreaker && !confirmedContradiction && !unresolvedConstraint;
  const confidence = evidenceCoverage === 100 && noConstraintConcern
    ? 'high'
    : evidenceCoverage >= 85 && noConstraintConcern
      ? 'medium'
      : 'low';
  return {
    contract: FIT_CONTRACT,
    jobId: String(input.jobId || ''),
    profileId: String(input.profileId || ''),
    overall,
    baseOverall,
    scoreStatus,
    evidenceCoverage,
    confidence,
    mode: modes.has(input.mode) ? input.mode : 'deterministic-degraded',
    dimensions,
    constraints,
    postingRisks,
    reasoning: String(input.reasoning || '').trim() || 'Fit was finalized from the displayed evidence-backed dimensions.',
    provider: input.provider && typeof input.provider === 'object' ? input.provider : null,
    providerError: input.providerError && typeof input.providerError === 'object' ? input.providerError : null,
    generatedAt: String(input.generatedAt || now())
  };
}

export function qualifiesForHighFit(fit, threshold = 70) {
  const minimum = Number(threshold);
  return Boolean(
    fit?.contract === FIT_CONTRACT
    && fit.scoreStatus === 'scored'
    && Number(fit.evidenceCoverage) >= 85
    && Number.isFinite(Number(fit.overall))
    && Number.isFinite(minimum)
    && Number(fit.overall) >= minimum
    && !(fit.constraints || []).some(value => value.status !== 'cleared')
  );
}

export function deserializeFitScore(value, { persistedOverall = null, jobId = '', profileId = '' } = {}) {
  const parsed = typeof value === 'string' ? parseJson(value, null) : value;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.contract === FIT_CONTRACT) return parsed;
  return {
    ...parsed,
    contract: 'legacy_unversioned',
    jobId: String(parsed.jobId || jobId),
    profileId: String(parsed.profileId || profileId),
    overall: parsed.overall ?? persistedOverall,
    scoreStatus: 'review_required',
    warnings: [
      ...(Array.isArray(parsed.warnings) ? parsed.warnings : []),
      { code: 'legacy_fit_contract', message: 'This fit score predates jobos.fit-score.v1. Rescore explicitly before using it for a new high-fit decision.' }
    ]
  };
}

function decisionClass(row) {
  if (row?.postingLiveness?.status === 'expired') return 4;
  const fit = row?.fit;
  if (fit?.constraints?.some(value => value.kind === 'dealbreaker' && value.status === 'confirmed')) return 3;
  if (fit?.constraints?.some(value => value.kind === 'contradiction' && value.status === 'confirmed')) return 2;
  if (fit?.scoreStatus !== 'scored') return 1;
  return 0;
}

export function compareFitDecisions(left, right) {
  const classDifference = decisionClass(left) - decisionClass(right);
  if (classDifference) return classDifference;
  const overallDifference = Number(right?.fit?.overall ?? -1) - Number(left?.fit?.overall ?? -1);
  if (overallDifference) return overallDifference;
  const coverageDifference = Number(right?.fit?.evidenceCoverage ?? 0) - Number(left?.fit?.evidenceCoverage ?? 0);
  if (coverageDifference) return coverageDifference;
  return String(left?.jobId || left?.id || left?.fit?.jobId || '').localeCompare(String(right?.jobId || right?.id || right?.fit?.jobId || ''));
}

function fieldRef(job, field) {
  return { kind: 'job_field', id: job.id, field };
}

function preferenceRef(profile, field) {
  return { kind: 'profile_preference', id: profile.id, field };
}

function hasMeaningfulEvidence(value) {
  if (Array.isArray(value)) return value.some(hasMeaningfulEvidence);
  if (value && typeof value === 'object') return Object.values(value).some(hasMeaningfulEvidence);
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'boolean') return true;
  const text = String(value ?? '').trim();
  return Boolean(text) && text.toLowerCase() !== 'unknown';
}

function preferenceSupportsEvidence(prefs, field) {
  if (field === 'salary') {
    const salary = prefs.salary && typeof prefs.salary === 'object' ? prefs.salary : {};
    return [salary.min, salary.max].some(value => Number.isFinite(Number(value)) && Number(value) > 0);
  }
  return hasMeaningfulEvidence(prefs[field]);
}

function preferenceEvidence(profile, prefs, fields) {
  return fields.filter(field => preferenceSupportsEvidence(prefs, field)).map(field => preferenceRef(profile, field));
}

function unknownDimension(key, reason, evidenceRefs = []) {
  return { status: 'unknown', score: null, weight: FIT_DIMENSION_WEIGHTS[key], reason, evidenceRefs };
}

function scoredDimension(key, scoreValue, reason, evidenceRefs, status = 'scored') {
  return { status, score: Math.max(0, Math.min(100, Math.round(scoreValue))), weight: FIT_DIMENSION_WEIGHTS[key], reason, evidenceRefs: uniqueEvidence(evidenceRefs) };
}

function tokenScore(candidateText, jobText, { base = 20, perHit = 15, ceiling = 95 } = {}) {
  const candidate = [...new Set(tokenize(candidateText).filter(value => value.length > 1))];
  const job = new Set(tokenize(jobText));
  const hits = candidate.filter(value => job.has(value));
  return { score: Math.min(ceiling, base + hits.length * perHit), hits };
}

function proofSignals(job, proofs) {
  const inventory = inventoryForJob(job);
  const coverage = buildRequirementCoverage(inventory, proofs);
  const byDimension = { roleFit: [], domainFit: [], seniority: [] };
  for (const item of [...coverage.matched, ...coverage.partiallySupported]) {
    const category = item.requirement.category;
    const targets = category === 'domain'
      ? ['domainFit']
      : category === 'seniority' || category === 'experience'
        ? ['seniority', 'roleFit']
        : ['roleFit'];
    for (const target of targets) byDimension[target].push(item);
  }
  return { inventory, coverage, byDimension };
}

function proofContribution(items) {
  return Math.min(20, items.reduce((sum, item) => sum + (item.status === 'supported' ? 8 : 3), 0));
}

function proofEvidence(items) {
  return uniqueEvidence(items.flatMap(item => [
    { kind: 'job_requirement', id: item.requirementId },
    ...item.proofPointIds.map(proofId => ({ kind: 'proof_point', id: proofId }))
  ]));
}

function compensationFacts(job) {
  const structured = parseJson(job.compensation_json, {});
  const text = String(job.compensation || structured.text || '');
  const values = [structured.min, structured.max].filter(value => value != null && value !== '').map(Number).filter(Number.isFinite);
  if (!values.length) {
    const parsed = [...text.matchAll(/\$?([\d,.]+)\s*([kK])?/g)]
      .map(match => Number(match[1].replaceAll(',', '')) * (match[2] ? 1000 : 1))
      .filter(value => value >= 10000);
    values.push(...parsed);
  }
  return { text, min: values.length ? Math.min(...values) : null, max: values.length ? Math.max(...values) : null };
}

function deterministicConstraints(job, profile, prefs, dimensions) {
  const constraints = [];
  const text = `${job.title}\n${job.location}\n${job.compensation}\n${job.work_model}\n${job.description}`.toLowerCase();
  const jobOnsite = /\b(on[- ]?site|in office|five days|5 days)\b/.test(text) && !/remote work is available/.test(text);
  const candidateRemote = String(prefs.workModel || '').toLowerCase() === 'remote';
  const locationEvidence = [fieldRef(job, job.work_model && job.work_model !== 'unknown' ? 'work_model' : 'description')];
  if (candidateRemote && jobOnsite) {
    constraints.push({
      id: id('constraint', `${job.id}:${profile.id}:onsite-remote`),
      kind: 'contradiction',
      dimension: 'locationWorkModel',
      status: 'confirmed',
      preferenceRef: preferenceRef(profile, 'workModel'),
      jobEvidenceRefs: locationEvidence,
      reason: 'The explicit remote work-model preference conflicts with the posting’s direct on-site requirement.'
    });
    dimensions.locationWorkModel = { ...dimensions.locationWorkModel, status: 'contradicted', score: Math.min(dimensions.locationWorkModel.score ?? 10, 10) };
  }
  for (const [index, raw] of (Array.isArray(prefs.dealbreakers) ? prefs.dealbreakers : []).entries()) {
    const dealbreaker = String(raw || '').trim();
    if (!dealbreaker) continue;
    const normalized = dealbreaker.toLowerCase();
    let matched = false;
    let unknown = false;
    let dimension = 'roleFit';
    let evidence = fieldRef(job, 'description');
    if (/equity.*only|no cash|no salary/.test(normalized)) {
      dimension = 'compensation';
      evidence = fieldRef(job, 'compensation');
      const compensation = compensationFacts(job);
      matched = /equity only|no salary|no cash compensation/.test(compensation.text.toLowerCase());
      unknown = !compensation.text.trim() && compensation.max === null;
    } else if (/remote|on[- ]?site|office/.test(normalized) && candidateRemote) {
      dimension = 'locationWorkModel';
      evidence = locationEvidence[0];
      matched = jobOnsite;
      unknown = !String(job.location || '').trim() && (!job.work_model || job.work_model === 'unknown');
    } else {
      unknown = true;
    }
    constraints.push({
      id: id('constraint', `${job.id}:${profile.id}:dealbreaker:${index}:${normalized}`),
      kind: 'dealbreaker',
      dimension,
      status: matched ? 'confirmed' : unknown ? 'unknown' : 'cleared',
      preferenceRef: preferenceRef(profile, 'dealbreakers'),
      jobEvidenceRefs: matched ? [evidence] : [],
      reason: matched
        ? `The explicit dealbreaker “${dealbreaker}” matches direct structured posting evidence.`
        : unknown
          ? `The posting does not contain enough structured evidence to clear or confirm the explicit dealbreaker “${dealbreaker}”.`
          : `Direct structured posting evidence does not trigger the explicit dealbreaker “${dealbreaker}”.`
    });
  }
  return constraints;
}

function deterministicProposal(job, profile, proofs) {
  const prefs = parseJson(profile.preferences_json, {});
  const requirementText = requirementTextsForJob(job).join('\n');
  const fullText = `${job.title}\n${job.company}\n${job.location}\n${job.work_model}\n${job.description}\n${requirementText}`;
  const proof = proofSignals(job, proofs);
  const dimensions = {};

  const rolePreferenceFields = ['targetRoleFamilies', 'skills'];
  const rolePreference = rolePreferenceFields.flatMap(field => Array.isArray(prefs[field]) ? prefs[field] : []).join(' ');
  const roleProofItems = proof.byDimension.roleFit;
  if (!rolePreference.trim() && !roleProofItems.length) dimensions.roleFit = unknownDimension('roleFit', 'No target role family, skill preference, or active verified requirement proof is available.', [fieldRef(job, 'title')]);
  else {
    const direct = tokenScore(rolePreference, `${job.title}\n${requirementText}`, { base: 20, perHit: 15 });
    const outsideTrack = /\b(backend|infrastructure|payments engineer|enterprise account executive|quota|cold outbound|closing deals)\b/i.test(`${job.title}\n${requirementText}`)
      && !/\b(backend|infrastructure|payments|engineer|developer|software|sales|account executive|quota|business development)\b/i.test(rolePreference);
    const proofBoost = proofContribution(roleProofItems);
    const scoreValue = outsideTrack ? Math.min(25, direct.score) : Math.min(100, direct.score + proofBoost);
    const refs = [fieldRef(job, 'title'), ...preferenceEvidence(profile, prefs, rolePreferenceFields), ...proofEvidence(roleProofItems)];
    dimensions.roleFit = scoredDimension('roleFit', scoreValue, `Role fit compares the posting title and structured requirements with declared role preferences${proofBoost ? ` and ${roleProofItems.length} active verified requirement-proof match(es)` : ''}.`, refs);
  }

  const domainPreferenceFields = ['industries', 'missionKeywords'];
  const domainPreference = domainPreferenceFields.flatMap(field => Array.isArray(prefs[field]) ? prefs[field] : []).join(' ');
  const domainProofItems = proof.byDimension.domainFit;
  if (!domainPreference.trim() && !domainProofItems.length) dimensions.domainFit = unknownDimension('domainFit', 'No domain preference or active verified domain proof is available.', [fieldRef(job, 'description')]);
  else {
    const direct = tokenScore(domainPreference, fullText, { base: 25, perHit: 12 });
    const proofBoost = proofContribution(domainProofItems);
    dimensions.domainFit = scoredDimension('domainFit', Math.min(100, direct.score + proofBoost), `Domain fit compares declared industries and mission terms with the posting${proofBoost ? ' and cites active verified domain proof' : ''}.`, [fieldRef(job, 'description'), ...preferenceEvidence(profile, prefs, domainPreferenceFields), ...proofEvidence(domainProofItems)]);
  }

  const roleTargets = (prefs.targetRoleFamilies || []).join(' ');
  if (!roleTargets.trim() || !String(job.title || '').trim()) dimensions.seniority = unknownDimension('seniority', 'Seniority cannot be compared without both a target role family and a posting title.', [fieldRef(job, 'title')]);
  else {
    const seniorTerms = /\b(senior|staff|principal|lead|head of|director|executive)\b/i;
    const jobSenior = seniorTerms.test(`${job.title}\n${requirementText}`);
    const profileSenior = seniorTerms.test(roleTargets);
    let scoreValue = jobSenior && !profileSenior ? 55 : jobSenior && profileSenior ? 85 : !jobSenior && profileSenior ? 65 : 75;
    const proofItems = proof.byDimension.seniority;
    scoreValue = Math.min(100, scoreValue + proofContribution(proofItems));
    dimensions.seniority = scoredDimension('seniority', scoreValue, 'Seniority compares explicit level language in the posting with declared target role families and any active verified level evidence.', [fieldRef(job, 'title'), preferenceRef(profile, 'targetRoleFamilies'), ...proofEvidence(proofItems)]);
  }

  const candidateLocation = [...(prefs.locations || []), prefs.workModel || ''].filter(Boolean).join(' ');
  const jobLocation = [job.location || '', job.work_model && job.work_model !== 'unknown' ? job.work_model : ''].filter(Boolean).join(' ');
  if (!candidateLocation.trim() || !jobLocation.trim()) dimensions.locationWorkModel = unknownDimension('locationWorkModel', 'Location or work-model evidence is missing on the candidate or posting side.', [fieldRef(job, jobLocation ? 'location' : 'work_model'), ...(candidateLocation ? [preferenceRef(profile, 'workModel')] : [])]);
  else {
    const candidateRemote = /\bremote\b/i.test(candidateLocation);
    const jobOnsite = /\b(on[- ]?site|in office|five days|5 days)\b/i.test(`${jobLocation}\n${job.description}`) && !/remote work is available/i.test(job.description);
    const jobRemote = /\bremote\b/i.test(jobLocation);
    const locationMatch = tokenScore(candidateLocation, jobLocation, { base: 45, perHit: 20, ceiling: 90 });
    const scoreValue = candidateRemote && jobOnsite ? 10 : candidateRemote && jobRemote ? 90 : locationMatch.score;
    dimensions.locationWorkModel = scoredDimension('locationWorkModel', scoreValue, 'Location and work-model fit compares explicit profile preferences with posting location/work-model fields.', [...preferenceEvidence(profile, prefs, ['locations', 'workModel']), fieldRef(job, job.work_model && job.work_model !== 'unknown' ? 'work_model' : 'location')]);
  }

  const salary = prefs.salary && typeof prefs.salary === 'object' ? prefs.salary : {};
  const candidateMinimum = Number(salary.min);
  const compensation = compensationFacts(job);
  if (!Number.isFinite(candidateMinimum) || candidateMinimum <= 0 || (!compensation.text.trim() && compensation.max === null)) dimensions.compensation = unknownDimension('compensation', 'Candidate salary preference or posting compensation evidence is missing.', [preferenceRef(profile, 'salary'), fieldRef(job, 'compensation')]);
  else {
    let scoreValue = 65;
    if (/equity only|no salary|no cash compensation/i.test(compensation.text)) scoreValue = 0;
    else if (compensation.max !== null && compensation.max < candidateMinimum) scoreValue = 20;
    else if (compensation.max !== null) scoreValue = 85;
    dimensions.compensation = scoredDimension('compensation', scoreValue, 'Compensation fit compares the explicit candidate salary floor with direct posting compensation evidence.', [preferenceRef(profile, 'salary'), fieldRef(job, 'compensation')]);
  }

  const missionPreferenceFields = ['missionKeywords', 'values', 'industries'];
  const missionPreference = missionPreferenceFields.flatMap(field => Array.isArray(prefs[field]) ? prefs[field] : []).join(' ');
  if (!missionPreference.trim() || !String(job.description || '').trim()) dimensions.missionInterest = unknownDimension('missionInterest', 'Mission/value preference or posting mission evidence is missing.', [fieldRef(job, 'description')]);
  else {
    const mission = tokenScore(missionPreference, fullText, { base: 30, perHit: 12 });
    dimensions.missionInterest = scoredDimension('missionInterest', mission.score, 'Mission interest compares declared mission, value, and industry preferences with posting description evidence.', [...preferenceEvidence(profile, prefs, missionPreferenceFields), fieldRef(job, 'description')]);
  }

  dimensions.networkAccess = unknownDimension('networkAccess', 'No completed people-research run provides local network-path evidence.');
  const constraints = deterministicConstraints(job, profile, prefs, dimensions);
  const lower = fullText.toLowerCase();
  const postingRisks = redFlags.filter(term => lower.includes(term)).map(term => ({
    code: `posting_risk_${term.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
    status: 'observed',
    reason: `The posting contains review signal “${term}”. This is non-numeric and requires diligence.`,
    evidenceRefs: [fieldRef(job, 'description')]
  }));
  return {
    dimensions,
    constraints,
    postingRisks,
    reasoning: 'Deterministic degraded scoring finalized explicit preferences, structured requirements, active verified proofs, and local evidence without hidden boosts or penalties.'
  };
}

function referenceAllowlists(job, profile, proofs) {
  const explanation = new Set();
  const support = new Set();
  const add = (value, supportsScore) => {
    const key = evidenceKey(value);
    explanation.add(key);
    if (supportsScore) support.add(key);
  };
  const prefs = parseJson(profile.preferences_json, {});
  for (const field of ['title', 'company', 'location', 'description', 'compensation', 'work_model', 'requirements_json']) {
    const supportsScore = field === 'compensation'
      ? (() => {
          const facts = compensationFacts(job);
          return Boolean(facts.text.trim()) || facts.max !== null;
        })()
      : field === 'requirements_json'
        ? inventoryForJob(job).requirements.length > 0
        : hasMeaningfulEvidence(job[field]);
    add(fieldRef(job, field), supportsScore);
  }
  for (const field of ['targetRoleFamilies', 'industries', 'locations', 'salary', 'dealbreakers', 'skills', 'missionKeywords', 'values', 'workModel']) {
    add(preferenceRef(profile, field), preferenceSupportsEvidence(prefs, field));
  }
  for (const requirement of inventoryForJob(job).requirements) add({ kind: 'job_requirement', id: requirement.id }, true);
  for (const proof of proofs) add({ kind: 'proof_point', id: proof.id }, true);
  return { explanation, support };
}

function providerError(error, fallbackType = 'provider_error') {
  const message = String(error?.message || error || 'Provider scoring failed')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .slice(0, 300);
  return { type: String(error?.type || fallbackType), ...(error?.code ? { code: String(error.code) } : {}), message };
}

function normalizeProviderProposal(raw, { job, profile, proofs, cfg }) {
  if (!raw || typeof raw !== 'object') throw Object.assign(new Error('Provider fit proposal must be an object'), { type: 'malformed_provider_output' });
  const protectedKeys = ['overall', 'baseOverall', 'confidence', 'liveness', 'postingLiveness', 'scoreStatus', 'evidenceCoverage', 'weights'];
  if (protectedKeys.some(key => Object.hasOwn(raw, key))) throw Object.assign(new Error('Provider fit proposal attempted to set a protected field'), { type: 'malformed_provider_output' });
  if (!raw.dimensions || dimensionKeys.some(key => !raw.dimensions[key])) throw Object.assign(new Error('Provider fit proposal is missing a dimension'), { type: 'malformed_provider_output' });
  const allowlists = referenceAllowlists(job, profile, proofs);
  const dimensions = {};
  let constraints;
  let postingRisks;
  try {
    for (const key of dimensionKeys) {
      const value = raw.dimensions[key];
      if (key === 'networkAccess') {
        dimensions[key] = unknownDimension(key, 'Provider network-access proposals are ignored; local stored evidence is authoritative.');
        continue;
      }
      const normalized = validateDimension(key, { ...value, weight: FIT_DIMENSION_WEIGHTS[key] });
      const allowedRefs = normalized.status === 'unknown' ? allowlists.explanation : allowlists.support;
      if (normalized.evidenceRefs.some(item => !allowedRefs.has(evidenceKey(item)))) throw new Error(`Unsupported provider evidence reference for ${key}`);
      dimensions[key] = normalized;
    }
    if (!Array.isArray(raw.constraints) || !Array.isArray(raw.postingRisks)) throw new Error('Provider constraints and postingRisks must be arrays');
    constraints = raw.constraints.map((value, index) => {
      if (!value?.preferenceRef || !Array.isArray(value.jobEvidenceRefs) || value.jobEvidenceRefs.length === 0) throw new Error(`Provider constraint ${index} requires cited candidate and job evidence`);
      const normalized = validateConstraint({ ...value, status: value.status === 'confirmed' ? 'possible' : value.status }, index);
      const refs = [normalized.preferenceRef, ...normalized.jobEvidenceRefs].filter(Boolean);
      const allowedRefs = normalized.status === 'unknown' ? allowlists.explanation : allowlists.support;
      if (refs.some(item => !allowedRefs.has(evidenceKey(item)))) throw new Error(`Unsupported provider constraint evidence reference at index ${index}`);
      return normalized;
    });
    postingRisks = raw.postingRisks.map((value, index) => {
      const normalized = validatePostingRisk(value, index);
      const allowedRefs = normalized.status === 'unknown' ? allowlists.explanation : allowlists.support;
      if (!normalized.evidenceRefs.length || normalized.evidenceRefs.some(item => !allowedRefs.has(evidenceKey(item)))) throw new Error(`Unsupported provider posting-risk evidence reference at index ${index}`);
      return normalized;
    });
  } catch (error) {
    throw Object.assign(new Error(error.message), { type: 'malformed_provider_output' });
  }
  return {
    mode: cfg.provider === 'agent' ? 'agent' : 'llm',
    dimensions,
    constraints,
    postingRisks,
    reasoning: String(raw.reasoning || 'Provider proposed evidence-backed fit dimensions.'),
    provider: { provider: cfg.provider, model: cfg.model, baseUrl: cfg.baseUrl }
  };
}

function mergeConstraints(authoritative, proposed) {
  const merged = [...authoritative];
  for (const value of proposed) {
    const existing = authoritative.find(item => item.kind === value.kind && item.dimension === value.dimension);
    if (!existing) merged.push(value);
  }
  return merged;
}

export function networkAccessFromEvidence(s, { jobId, profileId, nowMs = Date.now() }) {
  const cutoff = new Date(nowMs - 30 * 24 * 60 * 60 * 1000).toISOString();
  const latestRun = one(s, `SELECT id,finished_at FROM research_runs WHERE job_id=? AND profile_id=? AND scope='job' AND status IN ('succeeded','partial') ORDER BY finished_at DESC LIMIT 1`, [jobId, profileId]);
  if (!latestRun) return unknownDimension('networkAccess', 'No completed people-research run exists for this job and profile.');

  const sourceEvidence = value => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) && parsed.some(item =>
        item
        && typeof item === 'object'
        && !Array.isArray(item)
        && sourceEvidenceFields.some(field => {
          const fieldValue = item[field];
          if (Array.isArray(fieldValue)) {
            return fieldValue.some(candidate => typeof candidate === 'string' && hasMeaningfulEvidence(candidate));
          }
          return typeof fieldValue === 'string' && hasMeaningfulEvidence(fieldValue);
        })
      );
    } catch {
      return false;
    }
  };
  const sourceIds = value => {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? [...new Set(parsed.map(item => String(item || '').trim()).filter(Boolean))] : [];
    } catch {
      return [];
    }
  };
  const isFresh = (...timestamps) => timestamps.every(value => Boolean(value) && value >= cutoff);
  const pathPrefix = (fresh, timestamps) => fresh
    ? ''
    : `The source-backed path evidence is older than 30 days (${timestamps.filter(Boolean).sort()[0] || 'unknown date'}). `;
  const edgePath = edgeTypes => all(s, `SELECT re.id,re.evidence_json,re.created_at AS evidence_at,rr.id AS run_id,rr.finished_at
    FROM relationship_edges re
    JOIN person_candidates pc ON pc.job_id=? AND pc.research_run_id IS NOT NULL AND (
      re.to_id=pc.id
      OR (pc.person_id IS NOT NULL AND re.to_id=pc.person_id)
      OR (pc.person_id IS NOT NULL AND re.to_id IN (SELECT id FROM stakeholders WHERE job_id=? AND person_id=pc.person_id))
    )
    JOIN research_runs rr ON rr.id=pc.research_run_id AND rr.profile_id=? AND rr.job_id=? AND rr.scope='job' AND rr.status IN ('succeeded','partial')
    WHERE re.from_type='profile' AND re.from_id=? AND re.edge_type IN (${edgeTypes.map(() => '?').join(',')})
    ORDER BY rr.finished_at DESC,re.created_at DESC,re.id`, [jobId, jobId, profileId, jobId, profileId, ...edgeTypes])
    .find(row => sourceEvidence(row.evidence_json));

  const direct = edgePath(['direct_connection']);
  if (direct) {
    const fresh = isFresh(direct.finished_at, direct.evidence_at);
    return scoredDimension('networkAccess', fresh ? 90 : 75, `${pathPrefix(fresh, [direct.finished_at, direct.evidence_at])}A source-backed direct connection provides a network path to a stakeholder.`, [
      { kind: 'research_run', id: direct.run_id },
      { kind: 'relationship_edge', id: direct.id }
    ]);
  }

  const mutual = edgePath(['shared_employer', 'shared_school', 'shared_open_source', 'shared_event']);
  if (mutual) {
    const fresh = isFresh(mutual.finished_at, mutual.evidence_at);
    return scoredDimension('networkAccess', fresh ? 75 : 60, `${pathPrefix(fresh, [mutual.finished_at, mutual.evidence_at])}A source-backed mutual affiliation provides a potential network path to a stakeholder.`, [
      { kind: 'research_run', id: mutual.run_id },
      { kind: 'relationship_edge', id: mutual.id }
    ]);
  }

  const contactRows = all(s, `SELECT cp.id,cp.source_observation_ids_json,cp.created_at AS evidence_at,rr.id AS run_id,rr.finished_at
    FROM contact_points cp
    JOIN research_runs rr ON rr.id=cp.origin_research_run_id
      AND rr.profile_id=? AND rr.job_id=? AND rr.scope='job' AND rr.status IN ('succeeded','partial')
    WHERE cp.human_approved=1 AND cp.do_not_use=0 AND (
      cp.stakeholder_id IN (SELECT id FROM stakeholders WHERE job_id=?)
      OR cp.person_id IN (
        SELECT person_id FROM person_candidates
        WHERE job_id=? AND research_run_id=rr.id AND person_id IS NOT NULL
      )
    )
    ORDER BY rr.finished_at DESC,cp.created_at DESC,cp.id`, [profileId, jobId, jobId, jobId]);
  const approvedContact = contactRows.find(row => {
    const ids = sourceIds(row.source_observation_ids_json);
    if (!ids.length) return false;
    const linked = one(s, `SELECT 1 AS present FROM research_run_sources rrs
      JOIN source_observations so ON so.id=rrs.source_observation_id
      WHERE rrs.run_id=? AND rrs.source_observation_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`, [row.run_id, ...ids]);
    return Boolean(linked);
  });
  if (approvedContact) {
    const fresh = isFresh(approvedContact.finished_at, approvedContact.evidence_at);
    return scoredDimension('networkAccess', fresh ? 60 : 45, `${pathPrefix(fresh, [approvedContact.finished_at, approvedContact.evidence_at])}A human-approved contact point provides a source-backed contact path.`, [
      { kind: 'research_run', id: approvedContact.run_id },
      { kind: 'contact_point', id: approvedContact.id }
    ]);
  }

  const fresh = Boolean(latestRun.finished_at && latestRun.finished_at >= cutoff);
  const runRef = { kind: 'research_run', id: latestRun.id };
  if (fresh) return scoredDimension('networkAccess', 25, 'Fresh completed people research found no direct, mutual, or approved contact path.', [runRef]);
  return unknownDimension('networkAccess', `The completed research run is older than 30 days (${latestRun.finished_at}). No current source-backed network path is available.`, [runRef]);
}

function scoringPrompt({ job, profile, proofs }) {
  const prefs = parseJson(profile.preferences_json, {});
  return `Propose evidence-backed candidate-fit dimensions for this job. Return JSON with dimensions roleFit, domainFit, seniority, locationWorkModel, compensation, missionInterest, and networkAccess. Each dimension is {status: scored|unknown|contradicted, score: integer 0-100 or null for unknown, reason, evidenceRefs}. Also return constraints, postingRisks, and reasoning. Do not return overall, weights, confidence, liveness, or other protected fields. Network access is replaced from local evidence. Use only the IDs and fields supplied below.\n\nPROFILE:\n${JSON.stringify({ id: profile.id, preferences: prefs }, null, 2)}\n\nACTIVE VERIFIED PROOFS:\n${JSON.stringify(proofs.map(value => ({ id: value.id, summary: value.summary, skills: value.skills })), null, 2)}\n\nJOB:\n${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, workModel: job.work_model, compensation: job.compensation, description: job.description, requirements: inventoryForJob(job) }, null, 2)}`;
}

export async function score(s, jobId, profileId, opts = {}) {
  let job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Object.assign(new Error(`Job ${jobId} belongs to profile ${job.profile_id}, not ${profileId}`), { code: 'profile_job_mismatch', type: 'validation' });
  const liveness = await resolveJobLiveness(s, jobId, opts);
  assertJobLivenessGate(liveness, 'be scored');
  job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  const proofs = activeVerifiedProofs(s, profileId);
  const deterministic = deterministicProposal(job, profile, proofs);
  const cfg = opts.providerConfig || llmConfig();
  let proposal = { ...deterministic, mode: 'deterministic-degraded', provider: null, providerError: null };
  if (cfg.configured) {
    try {
      const generateScore = opts.generateScore || generateJson;
      const result = await generateScore({
        schemaName: 'jobos_fit_score_v1',
        system: 'You are JobOS fit scoring. Propose only evidence-backed candidate-fit dimensions and explicit uncertainties. Never invent evidence.',
        user: scoringPrompt({ job, profile, proofs }),
        workspace: s.root
      });
      if (!result?.ok) throw Object.assign(new Error(result?.reason || 'Provider scoring was unavailable'), { type: 'provider_unavailable' });
      proposal = { ...normalizeProviderProposal(result.json, { job, profile, proofs, cfg: result.config || cfg }), providerError: null };
      const authoritativeConstraints = deterministicConstraints(job, profile, parseJson(profile.preferences_json, {}), proposal.dimensions);
      proposal.constraints = mergeConstraints(authoritativeConstraints, proposal.constraints);
    } catch (error) {
      if (error?.type === 'agent_error') throw error;
      proposal = {
        ...deterministic,
        mode: 'deterministic-degraded',
        provider: null,
        providerError: providerError(error, error?.type === 'malformed_provider_output' ? 'malformed_provider_output' : 'transport_error'),
        reasoning: `${deterministic.reasoning} Provider output was discarded and the deterministic fallback was finalized instead.`
      };
    }
  }
  proposal.dimensions = { ...proposal.dimensions, networkAccess: networkAccessFromEvidence(s, { jobId, profileId, nowMs: typeof opts.now === 'function' ? opts.now() : Date.now() }) };
  const fit = finalizeFitScore({
    jobId,
    profileId,
    mode: proposal.mode,
    dimensions: proposal.dimensions,
    constraints: proposal.constraints,
    postingRisks: proposal.postingRisks,
    reasoning: proposal.reasoning,
    provider: proposal.provider,
    providerError: proposal.providerError,
    generatedAt: now()
  });
  const highFit = qualifiesForHighFit(fit, opts.threshold ?? 70);
  run(s, 'UPDATE jobs SET fit_score=?,score_json=?,high_fit=?,updated_at=? WHERE id=?', [fit.overall, JSON.stringify(fit), highFit ? 1 : 0, now(), jobId]);
  audit(s, 'job.scored', 'job', jobId, { contract: FIT_CONTRACT, jobId, profileId, overall: fit.overall, scoreStatus: fit.scoreStatus, evidenceCoverage: fit.evidenceCoverage, mode: fit.mode });
  syncJob(s, jobId);
  save(s);
  return {
    ...fit,
    postingLiveness: liveness.handoff,
    ...(liveness.warning ? { warnings: [liveness.warning] } : {})
  };
}

function scoreLabel(value) {
  return value.status === 'unknown' ? 'unknown' : `${value.score}/100`;
}

export function scoreMd(job, scoreValue) {
  const fit = deserializeFitScore(scoreValue, { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id });
  if (!fit) return `# Fit score: ${job.title} at ${job.company}\n\nNo fit score is stored.\n`;
  if (fit.contract !== FIT_CONTRACT) return `# Fit score: ${job.title} at ${job.company}\n\nOverall: **${fit.overall ?? 'unknown'}${fit.overall == null ? '' : '/100'}**\n\nWarning: **Legacy unversioned fit score. Rescore explicitly before using it for a new high-fit decision.**\n`;
  const dimensions = Object.entries(fit.dimensions).map(([key, value]) => `- **${key}:** ${scoreLabel(value)} (${value.status}, weight ${value.weight}%) — ${value.reason}`).join('\n');
  const risks = fit.postingRisks.length ? fit.postingRisks.map(value => `- **${value.code}:** ${value.reason}`).join('\n') : '- None observed. This does not replace diligence.';
  const constraints = fit.constraints.length ? fit.constraints.map(value => `- **${value.kind}/${value.status}:** ${value.reason}`).join('\n') : '- None recorded.';
  return `# Fit score: ${job.title} at ${job.company}\n\nContract: **${FIT_CONTRACT}**\n\nOverall: **${fit.overall ?? 'unknown'}${fit.overall == null ? '' : '/100'}**\n\nBase overall: **${fit.baseOverall ?? 'unknown'}${fit.baseOverall == null ? '' : '/100'}**\n\nDecision: **${fit.scoreStatus}**\n\nEvidence coverage: **${fit.evidenceCoverage}%**\n\nMode: **${fit.mode}**\n\nConfidence: **${fit.confidence}**\n\n## Dimensions\n${dimensions}\n\n## Candidate constraints\n${constraints}\n\n## Posting status / legitimacy signals (non-numeric)\n${risks}\n\n## Reasoning\n${fit.reasoning}\n\n_Human review remains required before applying or sending materials._\n`;
}
