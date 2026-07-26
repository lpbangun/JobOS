import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { artifactContentHash } from './artifacts.js';
import {
  CAREER_BRIEF_SCHEMA,
  MEMORY_SOURCES,
  PROJECTION_SOURCE_KINDS,
  PROJECTION_TYPES,
  VOICE_POSITIONING_GUIDE_SCHEMA,
  canonicalHash,
  memoryProjectionId,
} from './career-memory-contract.js';
import { listMemoryObservations } from './career-memory-observations.js';
import { resolveActiveMemoryRules } from './career-memory-proposals.js';
import { all, guardedWrite, one, queuePostCommit, recordAudit, run } from './db.js';

const ARTIFACT_TYPES = Object.freeze(['resume', 'cover_letter', 'outreach', 'interview_prep']);
const TARGET_FIELDS = Object.freeze([
  'targetRoleFamilies', 'industries', 'companyStages', 'locations', 'salary',
  'dealbreakers', 'skills', 'missionKeywords', 'values', 'workModel',
]);
const SINGLE_WRITING_FIELDS = Object.freeze(['tone', 'length', 'opening', 'closing']);
const SOURCE_KIND_ORDER = new Map(PROJECTION_SOURCE_KINDS.map((value, index) => [value, index]));
const PROJECTION_FILES = Object.freeze({
  career_brief: ['career-brief.yaml', 'career-brief.md'],
  voice_positioning_guide: ['voice-positioning-guide.yaml', 'voice-positioning-guide.md'],
});

class CareerMemoryProjectionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CareerMemoryProjectionError';
    this.type = 'validation';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new CareerMemoryProjectionError(code, message, details);
}

function compareText(left, right) {
  return String(left).localeCompare(String(right));
}

function parseJson(value, fallback) {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function ownerRow(store, profileId) {
  const owner = String(profileId || '').trim();
  if (!owner) fail('memory_projection_profile_required', 'profileId is required.');
  const profile = one(store, 'SELECT * FROM profiles WHERE id=?', [owner]);
  if (!profile) fail('memory_projection_profile_unknown', `Unknown profile: ${owner}.`, { profileId: owner });
  return profile;
}

function normalizedAsOf(asOf) {
  const date = asOf instanceof Date ? new Date(asOf.getTime()) : new Date(asOf);
  if (Number.isNaN(date.getTime())) fail('memory_projection_as_of_invalid', 'asOf must be a valid date.');
  return date;
}

function projectionTypeValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!PROJECTION_TYPES.includes(normalized)) {
    fail('memory_projection_type_invalid', `Unsupported projection type: ${normalized || '(empty)'}.`, { projectionType: normalized });
  }
  return normalized;
}

function artifactTypeValue(value, { optional = true } = {}) {
  if ((value === null || value === undefined || value === '') && optional) return null;
  const normalized = String(value || '').trim().toLowerCase();
  if (!ARTIFACT_TYPES.includes(normalized)) {
    fail('memory_projection_artifact_type_invalid', `Unsupported artifact type: ${normalized || '(empty)'}.`, { artifactType: normalized });
  }
  return normalized;
}

function sourceCollector() {
  const values = new Map();
  return {
    add(sourceKind, sourceId, sourceVersionId, sourceHash) {
      const source = {
        sourceKind: String(sourceKind),
        sourceId: String(sourceId),
        sourceVersionId: String(sourceVersionId),
        sourceHash: String(sourceHash),
      };
      if (!SOURCE_KIND_ORDER.has(source.sourceKind)) fail('memory_projection_source_kind_invalid', `Unsupported source kind: ${source.sourceKind}.`);
      if (!/^[a-f0-9]{64}$/.test(source.sourceHash)) fail('memory_projection_source_hash_invalid', `Invalid source hash for ${source.sourceId}.`);
      const key = `${source.sourceKind}\0${source.sourceId}\0${source.sourceVersionId}`;
      const existing = values.get(key);
      if (existing && existing.sourceHash !== source.sourceHash) {
        fail('memory_projection_source_conflict', `Conflicting source hashes for ${source.sourceId}.`, { sourceId: source.sourceId });
      }
      values.set(key, source);
      return source;
    },
    ordered() {
      return [...values.values()].sort((left, right) =>
        SOURCE_KIND_ORDER.get(left.sourceKind) - SOURCE_KIND_ORDER.get(right.sourceKind)
        || compareText(left.sourceId, right.sourceId)
        || compareText(left.sourceVersionId, right.sourceVersionId)
        || compareText(left.sourceHash, right.sourceHash));
    },
  };
}

function addProfileField(sources, profile, pointer, value) {
  return sources.add('profile_field', `${profile.id}#${pointer}`, profile.updated_at, canonicalHash(value));
}

function acceptedAt(rule) {
  const transition = [...(rule.transitions || [])].reverse().find(item => item.toStatus === 'accepted');
  return transition?.occurredAt || rule.createdAt;
}

function acceptedTransitionId(rule) {
  const transition = [...(rule.transitions || [])].reverse().find(item => item.toStatus === 'accepted');
  return transition?.id || rule.id;
}

function addRuleSources(sources, rule) {
  sources.add('accepted_rule', rule.id, acceptedTransitionId(rule), canonicalHash({
    id: rule.id,
    profileId: rule.profileId,
    domain: rule.domain,
    scope: rule.scope,
    ruleType: rule.ruleType,
    value: rule.value,
    ruleKey: rule.ruleKey,
    conflictKey: rule.conflictKey,
    confidenceMilli: rule.confidenceMilli,
    confidenceBand: rule.confidenceBand,
    evidenceFreshUntil: rule.evidenceFreshUntil,
    acceptedAt: acceptedAt(rule),
    proposalHash: rule.proposalHash,
  }));
  for (const evidence of rule.evidence || []) {
    sources.add('observation', evidence.observationId, evidence.sourceEntity.versionId, evidence.evidenceHash);
  }
}

function proofRows(store, profileId) {
  return all(store, `SELECT * FROM proof_points
    WHERE profile_id=? AND status='active' AND verification_status='verified'
    ORDER BY updated_at DESC,id`, [profileId]);
}

function proofProjection(row) {
  return {
    proofPointId: row.id,
    summary: row.summary,
    updatedAt: row.updated_at,
  };
}

function addProofSource(sources, row) {
  sources.add('proof_point', row.id, row.updated_at, canonicalHash({
    id: row.id,
    profileId: row.profile_id,
    summary: row.summary,
    skills: parseJson(row.skills_json, []),
    metrics: parseJson(row.metrics_json, []),
    status: row.status,
    verificationStatus: row.verification_status,
    updatedAt: row.updated_at,
  }));
}

function searchGuidance(store, profileId, asOf, sources) {
  const resolved = resolveActiveMemoryRules(store, { profileId, domain: 'search', scope: 'search', asOf });
  return resolved.rules.slice(0, 20).map(rule => {
    addRuleSources(sources, rule);
    return {
      ruleId: rule.id,
      scope: rule.scope,
      ruleType: rule.ruleType,
      value: plain(rule.value),
      confidenceMilli: rule.confidenceMilli,
      confidenceBand: rule.confidenceBand,
      acceptedAt: acceptedAt(rule),
      evidenceFreshUntil: rule.evidenceFreshUntil,
      evidenceObservationIds: (rule.evidence || []).map(item => item.observationId),
    };
  });
}

function recentContext(store, profileId, asOf, sources) {
  const listed = listMemoryObservations(store, {
    profileId,
    sinceDays: 90,
    includeHistory: false,
    includePrivateNotes: false,
    nowDate: asOf,
  });
  return listed.observations.slice(0, 12).map(observation => {
    const sourceHash = observation.sourceEntity?.contentHash
      || canonicalHash({
        id: observation.id,
        eventType: observation.eventType,
        source: observation.source,
        sourceEntity: observation.sourceEntity,
        occurredAt: observation.occurredAt,
      });
    sources.add(
      'observation',
      observation.id,
      observation.sourceEntity?.versionId || observation.recordedAt,
      sourceHash,
    );
    return {
      observationId: observation.id,
      eventType: observation.eventType,
      source: observation.source,
      occurredAt: observation.occurredAt,
    };
  });
}

function buildCareerBriefProjection(store, { profileId, asOf }) {
  const profile = ownerRow(store, profileId);
  const at = normalizedAsOf(asOf);
  const preferences = parseJson(profile.preferences_json, {});
  const sources = sourceCollector();
  addProfileField(sources, profile, '/name', profile.name);

  const canonicalTargets = {};
  for (const field of TARGET_FIELDS) {
    const fallback = field === 'salary' ? { min: null, max: null, currency: 'USD' } : (field === 'workModel' ? '' : []);
    canonicalTargets[field] = plain(preferences[field] ?? fallback);
    addProfileField(sources, profile, `/preferences/${field}`, canonicalTargets[field]);
  }
  const strategy = String(preferences.searchStrategy || 'focused');
  addProfileField(sources, profile, '/preferences/searchStrategy', strategy);
  const savedSearches = all(store, `SELECT id,name,adapter,min_fit,config_json,updated_at FROM saved_searches
    WHERE profile_id=? ORDER BY name,id LIMIT 16`, [profile.id]).map(row => {
    const configHash = canonicalHash(parseJson(row.config_json, {}));
    sources.add('saved_search', row.id, row.updated_at, canonicalHash({
      id: row.id, profileId: profile.id, name: row.name, adapter: row.adapter,
      minFit: row.min_fit, configHash, updatedAt: row.updated_at,
    }));
    return { id: row.id, name: row.name, adapter: row.adapter, minFit: row.min_fit, configHash };
  });

  const proofs = proofRows(store, profile.id).slice(0, 24);
  proofs.forEach(row => addProofSource(sources, row));
  const activeGuidance = searchGuidance(store, profile.id, at, sources);
  const context = recentContext(store, profile.id, at, sources);
  const citations = sources.ordered();
  const document = {
    schema: CAREER_BRIEF_SCHEMA,
    version: 1,
    profileId: profile.id,
    revision: null,
    asOf: at.toISOString(),
    sourceStateHash: canonicalHash(citations),
    identity: { profileId: profile.id, name: profile.name },
    canonicalTargets,
    searchStrategy: {
      strategy,
      savedSearches,
      acceptedRuleIds: activeGuidance.map(item => item.ruleId),
    },
    proofInventory: proofs.map(proofProjection),
    activeGuidance,
    recentContext: context,
    citations,
    policy: {
      canonicalStore: 'sqlite',
      facts: 'canonical_sources_only',
      guidance: 'accepted_active_only',
      causalAttribution: false,
      externalSideEffects: 'none',
      modelFineTuning: false,
    },
  };
  return { document, sources: citations };
}

function emptyWritingSection() {
  return {
    tone: null,
    length: null,
    opening: null,
    closing: null,
    avoidTerms: [],
    avoidClaims: [],
    scopedRuleIds: [],
    warnings: [],
  };
}

function scopedRules(rules, scope, ruleType) {
  return rules.filter(rule => rule.scope === scope && rule.ruleType === ruleType);
}

function effectiveRules(rules, scope, ruleType) {
  const scoped = scopedRules(rules, scope, ruleType);
  return scoped.length ? scoped : scopedRules(rules, 'writing_global', ruleType);
}

function singleField(section, field, rules) {
  if (!rules.length) return;
  const values = new Map();
  for (const rule of rules) {
    const key = canonicalHash(rule.value);
    const matching = values.get(key) || [];
    matching.push(rule);
    values.set(key, matching);
  }
  if (values.size > 1) {
    section[field] = null;
    section.warnings.push({
      field,
      reason: 'conflicting_active_rules',
      ruleIds: rules.map(rule => rule.id).sort(compareText),
    });
    return;
  }
  section[field] = { ...plain(rules[0].value), ruleIds: rules.map(rule => rule.id).sort(compareText) };
}

function writingSection(rules, scope) {
  const section = emptyWritingSection();
  const styleTypes = new Set([...SINGLE_WRITING_FIELDS, 'avoid_term', 'avoid_claim']);
  section.scopedRuleIds = rules
    .filter(rule => rule.scope === scope && styleTypes.has(rule.ruleType))
    .map(rule => rule.id)
    .sort(compareText);
  for (const field of SINGLE_WRITING_FIELDS) singleField(section, field, effectiveRules(rules, scope, field));
  section.avoidTerms = effectiveRules(rules, scope, 'avoid_term')
    .sort((left, right) => compareText(left.id, right.id))
    .map(rule => ({
      ruleId: rule.id,
      terms: plain(rule.value.terms || []),
    }));
  section.avoidClaims = effectiveRules(rules, scope, 'avoid_claim')
    .sort((left, right) => compareText(left.id, right.id))
    .map(rule => ({
      ruleId: rule.id,
      claimPattern: rule.value.claimPattern,
      reasonCode: rule.value.reasonCode,
    }));
  section.warnings.sort((left, right) => compareText(left.field, right.field));
  return section;
}

function positioningHierarchy(rules, proofs) {
  const eligible = new Set(proofs.map(row => row.id));
  const used = new Set();
  const hierarchy = [];
  for (const rule of rules.filter(item => item.ruleType === 'positioning_priority')) {
    const proofPointIds = (rule.value.proofPointIds || []).filter(id => eligible.has(id));
    if (!proofPointIds.length) continue;
    proofPointIds.forEach(id => used.add(id));
    hierarchy.push({
      ruleId: rule.id,
      scope: rule.scope,
      theme: rule.value.theme,
      proofPointIds,
    });
  }
  for (const proof of proofs) {
    if (!used.has(proof.id)) hierarchy.push({ ruleId: null, scope: null, theme: null, proofPointIds: [proof.id] });
  }
  return hierarchy;
}

function exemplarProjection(store, profileId, rule, sources) {
  const value = rule.value;
  const artifact = one(store, `SELECT * FROM artifacts
    WHERE id=? AND profile_id=? AND type=? AND revision=? AND approval_status='approved'`, [
    value.artifactId, profileId, rule.scope, value.revision,
  ]);
  if (!artifact) return null;
  const currentHash = artifactContentHash(artifact.content);
  if (artifact.content_hash !== currentHash || value.contentHash !== currentHash) return null;
  const lines = artifact.content.replace(/\r\n/g, '\n').split('\n');
  const snippet = lines.slice(value.startLine - 1, value.endLine).join('\n');
  const excerptHash = crypto.createHash('sha256').update(snippet, 'utf8').digest('hex');
  if (excerptHash !== value.excerptHash) return null;
  sources.add('artifact_revision', artifact.id, String(artifact.revision), artifact.content_hash);
  return {
    ruleId: rule.id,
    artifactType: artifact.type,
    artifactId: artifact.id,
    revision: artifact.revision,
    contentHash: artifact.content_hash,
    startLine: value.startLine,
    endLine: value.endLine,
    excerptHash,
    snippet,
  };
}

function buildVoiceGuideProjection(store, { profileId, asOf }) {
  const profile = ownerRow(store, profileId);
  const at = normalizedAsOf(asOf);
  const preferences = parseJson(profile.preferences_json, {});
  const sources = sourceCollector();
  const communicationStyle = String(preferences.communicationStyle || 'concise, warm, evidence-grounded');
  addProfileField(sources, profile, '/preferences/communicationStyle', communicationStyle);

  const resolved = resolveActiveMemoryRules(store, { profileId: profile.id, domain: 'writing', scope: null, asOf: at });
  const rules = [];
  const exemplars = [];
  for (const rule of resolved.rules) {
    if (rule.ruleType === 'approved_exemplar') {
      const exemplar = exemplarProjection(store, profile.id, rule, sources);
      if (!exemplar) continue;
      exemplars.push(exemplar);
    }
    addRuleSources(sources, rule);
    rules.push(rule);
  }
  const proofs = proofRows(store, profile.id);
  proofs.forEach(row => addProofSource(sources, row));
  const artifactTypes = {};
  for (const type of ARTIFACT_TYPES) artifactTypes[type] = writingSection(rules, type);
  const citations = sources.ordered();
  const document = {
    schema: VOICE_POSITIONING_GUIDE_SCHEMA,
    version: 1,
    profileId: profile.id,
    revision: null,
    asOf: at.toISOString(),
    sourceStateHash: canonicalHash(citations),
    baseline: { communicationStyle },
    global: writingSection(rules, 'writing_global'),
    artifactTypes,
    positioningHierarchy: positioningHierarchy(rules, proofs),
    approvedExemplars: exemplars,
    activeRuleIds: rules.map(rule => rule.id),
    citations,
    policy: {
      selectionAndFramingOnly: true,
      proofsAreFactAuthority: true,
      copyExemplarVerbatim: false,
      externalSideEffects: 'none',
    },
  };
  return { document, sources: citations };
}

function voiceArtifactView(document, artifactType) {
  const type = artifactTypeValue(artifactType);
  if (!type) return document;
  return {
    ...plain(document),
    artifactTypes: { [type]: plain(document.artifactTypes[type]) },
    approvedExemplars: document.approvedExemplars.filter(item => item.artifactType === type).map(plain),
  };
}

export function buildCareerBrief(store, { profileId, asOf = new Date() } = {}) {
  return buildCareerBriefProjection(store, { profileId, asOf }).document;
}

export function buildVoicePositioningGuide(store, { profileId, artifactType = null, asOf = new Date() } = {}) {
  const document = buildVoiceGuideProjection(store, { profileId, asOf }).document;
  return voiceArtifactView(document, artifactType);
}

function documentContentHash(document) {
  return canonicalHash(document);
}

function projectionBuilder(store, projectionType, options) {
  return projectionType === 'career_brief'
    ? buildCareerBriefProjection(store, options)
    : buildVoiceGuideProjection(store, options);
}

function persistedDocument(row) {
  const document = parseJson(row?.document_json, null);
  if (!document) fail('memory_projection_integrity_invalid', `Projection ${row?.id || '(unknown)'} has invalid document JSON.`);
  if (documentContentHash(document) !== row.content_hash) {
    fail('memory_projection_integrity_invalid', `Projection ${row.id} failed its content hash check.`, { projectionId: row.id });
  }
  return document;
}

function projectionMarkdown(document) {
  const title = document.schema === CAREER_BRIEF_SCHEMA ? 'Career Brief' : 'Voice and Positioning Guide';
  return `# ${title}\n\n- Profile: \`${document.profileId}\`\n- Revision: ${document.revision}\n- As of: ${document.asOf}\n- Source state: \`${document.sourceStateHash}\`\n\n## Projection\n\n\`\`\`json\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
}

function syncProjectionMirrors(store, projectionType, document) {
  const [yamlName, markdownName] = PROJECTION_FILES[projectionType];
  const directory = path.join(store.p.profiles, document.profileId, 'memory');
  const safeDocument = plain(document);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, yamlName), YAML.stringify(safeDocument, {
    lineWidth: 0,
    aliasDuplicateObjects: false,
  }));
  fs.writeFileSync(path.join(directory, markdownName), projectionMarkdown(safeDocument));
}

export function refreshMemoryProjection(store, {
  profileId,
  projectionType,
  asOf = new Date(),
  actor = 'system',
  source = 'deterministic',
} = {}) {
  ownerRow(store, profileId);
  const type = projectionTypeValue(projectionType);
  const at = normalizedAsOf(asOf);
  const normalizedActor = String(actor || '').trim();
  const normalizedSource = String(source || '').trim().toLowerCase();
  if (!normalizedActor) fail('memory_projection_actor_required', 'actor is required.');
  if (!MEMORY_SOURCES.includes(normalizedSource)) fail('memory_projection_source_invalid', `Unsupported projection source: ${normalizedSource}.`);

  return guardedWrite(store, () => {
    const built = projectionBuilder(store, type, { profileId, asOf: at });
    const duplicate = one(store, `SELECT * FROM career_memory_projection_revisions
      WHERE profile_id=? AND projection_type=? AND source_state_hash=?`, [profileId, type, built.document.sourceStateHash]);
    if (duplicate) return persistedDocument(duplicate);

    const current = one(store, `SELECT MAX(revision) AS revision FROM career_memory_projection_revisions
      WHERE profile_id=? AND projection_type=?`, [profileId, type]);
    const revision = Number(current?.revision || 0) + 1;
    const document = { ...built.document, revision };
    const contentHash = documentContentHash(document);
    const projectionId = memoryProjectionId({
      profileId,
      projectionType: type,
      revision,
      sourceStateHash: document.sourceStateHash,
    });
    run(store, `INSERT INTO career_memory_projection_revisions
      (id,profile_id,projection_type,revision,as_of,source_state_hash,content_hash,document_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [
      projectionId, profileId, type, revision, document.asOf, document.sourceStateHash,
      contentHash, JSON.stringify(document), document.asOf,
    ]);
    built.sources.forEach((item, position) => run(store, `INSERT INTO career_memory_projection_sources
      (projection_id,profile_id,position,source_kind,source_id,source_version_id,source_hash)
      VALUES (?,?,?,?,?,?,?)`, [
      projectionId, profileId, position, item.sourceKind, item.sourceId, item.sourceVersionId, item.sourceHash,
    ]));
    recordAudit(store, 'career_memory.projection_refreshed', 'career_memory_projection', projectionId, {
      profileId,
      projectionType: type,
      revision,
      sourceStateHash: document.sourceStateHash,
      contentHash,
      actor: normalizedActor,
      source: normalizedSource,
    });
    queuePostCommit(store, () => syncProjectionMirrors(store, type, document));
    return document;
  });
}

function historicalProjection(store, profileId, projectionType, revision) {
  ownerRow(store, profileId);
  if (!Number.isInteger(revision) || revision < 1) fail('memory_projection_revision_invalid', 'revision must be a positive integer.');
  const row = one(store, `SELECT * FROM career_memory_projection_revisions
    WHERE profile_id=? AND projection_type=? AND revision=?`, [profileId, projectionType, revision]);
  if (!row) {
    fail('memory_projection_revision_unknown', `Unknown ${projectionType} revision ${revision} for profile ${profileId}.`, {
      profileId, projectionType, revision,
    });
  }
  return persistedDocument(row);
}

export function getCareerBrief(store, { profileId, revision = null, refresh = false, asOf = new Date() } = {}) {
  if (revision !== null && refresh) fail('memory_projection_get_invalid', 'revision and refresh cannot be combined.');
  if (revision !== null) return historicalProjection(store, profileId, 'career_brief', revision);
  if (refresh) return refreshMemoryProjection(store, { profileId, projectionType: 'career_brief', asOf });
  return buildCareerBrief(store, { profileId, asOf });
}

export function getVoicePositioningGuide(store, {
  profileId,
  artifactType = null,
  revision = null,
  refresh = false,
  asOf = new Date(),
} = {}) {
  const type = artifactTypeValue(artifactType);
  if (revision !== null && refresh) fail('memory_projection_get_invalid', 'revision and refresh cannot be combined.');
  let document;
  if (revision !== null) document = historicalProjection(store, profileId, 'voice_positioning_guide', revision);
  else if (refresh) document = refreshMemoryProjection(store, { profileId, projectionType: 'voice_positioning_guide', asOf });
  else document = buildVoiceGuideProjection(store, { profileId, asOf }).document;
  return voiceArtifactView(document, type);
}
