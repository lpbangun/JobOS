import path from 'node:path';
import { all, audit, one, run, save } from './db.js';
import { id, now } from './utils.js';
import { writeYaml } from './workspace.js';
import { classifyStakeholder } from './outreach.js';
import { projectContactConfidenceV2 } from './research/contacts.js';

export const OUTREACH_OUTCOME_SCHEMA = 'jobos.outreach-outcome.v1';
export const OUTREACH_OUTCOME_LIST_SCHEMA = 'jobos.outreach-outcome-list.v1';
export const OUTREACH_OUTCOME_SUMMARY_SCHEMA = 'jobos.outreach-outcome-summary.v1';
export const OUTREACH_OUTCOME_TYPES = Object.freeze([
  'reply_positive',
  'reply_neutral',
  'reply_negative',
  'meeting_booked',
  'no_response',
  'bounced',
  'declined',
]);

const outcomeTypes = new Set(OUTREACH_OUTCOME_TYPES);

export class OutreachOutcomeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'OutreachOutcomeError';
    this.code = code;
    this.type = 'validation';
    this.details = details;
  }
}

function requiredText(value, code, message) {
  const text = String(value || '').trim();
  if (!text) throw new OutreachOutcomeError(code, message);
  return text;
}

function rfc3339(value, field) {
  const text = requiredText(value, `outreach_outcome_${field}_required`, `${field} is required.`);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds) || !/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    throw new OutreachOutcomeError(`outreach_outcome_${field}_invalid`, `${field} must be an RFC3339 timestamp.`, { value: text });
  }
  return new Date(milliseconds).toISOString();
}

function rawContact(row) {
  return row ? {
    id: row.id,
    personId: row.person_id || null,
    stakeholderId: row.stakeholder_id || null,
    companyId: row.company_id || null,
    type: row.type,
    value: row.value,
    normalizedValue: row.normalized_value,
    evidenceTier: row.evidence_tier,
    rawEvidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: JSON.parse(row.source_observation_ids_json || '[]'),
    checks: JSON.parse(row.checks_json || '{}'),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function rowProjection(row, { includeNotes = false } = {}) {
  const projection = {
    schema: OUTREACH_OUTCOME_SCHEMA,
    id: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    jobId: row.job_id || null,
    stakeholderId: row.stakeholder_id || null,
    contactId: row.contact_point_id || null,
    roleClass: row.role_class,
    contactTier: row.contact_tier || null,
    contactPath: row.contact_path || null,
    channel: row.channel,
    outcomeType: row.outcome_type,
    occurredAt: row.occurred_at,
    windowEndAt: row.window_end_at || null,
    recordedAt: row.recorded_at,
    actor: row.actor,
    source: row.source,
    referenceId: row.reference_id || null,
    supersedesOutcomeId: row.supersedes_outcome_id || null,
    correctionReason: row.correction_reason || null,
  };
  if (includeNotes) projection.note = row.note || '';
  return projection;
}

function withHistory(rows, options) {
  const supersededBy = new Map();
  for (const row of rows) if (row.supersedes_outcome_id) supersededBy.set(row.supersedes_outcome_id, row.id);
  return rows.map(row => ({
    ...rowProjection(row, options),
    supersededById: supersededBy.get(row.id) || null,
    current: !supersededBy.has(row.id),
  }));
}

function syncOutreachOutcomes(s, profileId) {
  const rows = all(s, 'SELECT * FROM outreach_outcomes WHERE profile_id=? ORDER BY occurred_at,id', [profileId]);
  writeYaml(path.join(s.p.profiles, profileId, 'outreach', 'outcomes.yaml'), {
    schema: OUTREACH_OUTCOME_SCHEMA,
    version: 1,
    profileId,
    policy: {
      appendOnly: true,
      corrections: 'replacement_records_with_supersedes_reference',
      interpretation: 'observations_only_no_probability_or_causal_claim',
      notes: 'local_only',
    },
    outcomes: withHistory(rows, { includeNotes: true }),
  });
}

function sameReferencedObservation(existing, input) {
  return existing.thread_id === input.threadId
    && existing.profile_id === input.profileId
    && existing.outcome_type === input.type
    && existing.occurred_at === input.occurredAt
    && (existing.window_end_at || null) === (input.windowEndAt || null)
    && (existing.supersedes_outcome_id || null) === (input.supersedesOutcomeId || null);
}

export function recordOutreachOutcome(s, input, { includeNotes = true } = {}) {
  const threadId = requiredText(input.threadId, 'outreach_outcome_thread_required', 'threadId is required.');
  const profileId = requiredText(input.profileId, 'outreach_outcome_profile_required', 'profileId is required.');
  const type = requiredText(input.type, 'outreach_outcome_type_required', 'type is required.').toLowerCase();
  if (!outcomeTypes.has(type)) {
    throw new OutreachOutcomeError('outreach_outcome_type_invalid', `Unsupported outreach outcome type: ${type}.`, { allowed: OUTREACH_OUTCOME_TYPES });
  }
  const occurredAt = rfc3339(input.occurredAt, 'occurred_at');
  const windowEndAt = input.windowEndAt ? rfc3339(input.windowEndAt, 'window_end') : null;
  const recordedAt = now();
  if (type === 'no_response' && !windowEndAt) {
    throw new OutreachOutcomeError('outreach_outcome_window_required', 'no_response requires an explicit observation window end timestamp.');
  }
  if (windowEndAt && Date.parse(windowEndAt) < Date.parse(occurredAt)) {
    throw new OutreachOutcomeError('outreach_outcome_window_invalid', 'windowEndAt must be at or after occurredAt.');
  }

  const profile = one(s, 'SELECT id FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw new OutreachOutcomeError('outreach_outcome_profile_unknown', `Unknown profile: ${profileId}.`);
  const thread = one(s, 'SELECT * FROM outreach_threads WHERE id=?', [threadId]);
  if (!thread) throw new OutreachOutcomeError('outreach_outcome_thread_unknown', `Unknown outreach thread: ${threadId}.`);
  if (thread.profile_id !== profileId) {
    throw new OutreachOutcomeError('outreach_outcome_profile_mismatch', `Outreach thread ${threadId} belongs to profile ${thread.profile_id}, not ${profileId}.`);
  }
  if (!thread.sent_at || !Number.isFinite(Date.parse(thread.sent_at))) {
    throw new OutreachOutcomeError('outreach_outcome_thread_unsent', `Outreach thread ${threadId} has no human-recorded sent boundary.`);
  }
  const sentMilliseconds = Date.parse(thread.sent_at);
  const occurredMilliseconds = Date.parse(occurredAt);
  const recordedMilliseconds = Date.parse(recordedAt);
  if (occurredMilliseconds < sentMilliseconds) {
    throw new OutreachOutcomeError('outreach_outcome_before_send', 'occurredAt cannot precede the human-recorded sentAt timestamp.');
  }
  if (occurredMilliseconds > recordedMilliseconds) {
    throw new OutreachOutcomeError('outreach_outcome_future', 'occurredAt cannot be in the future relative to recordedAt.');
  }
  if (windowEndAt && Date.parse(windowEndAt) > recordedMilliseconds) {
    throw new OutreachOutcomeError('outreach_outcome_window_future', 'windowEndAt must be completed before the outcome is recorded.');
  }
  const frozenChannel = String(thread.channel || '').trim().toLowerCase();
  if (!frozenChannel) {
    throw new OutreachOutcomeError('outreach_outcome_thread_channel_missing', `Outreach thread ${threadId} has no frozen sent channel.`);
  }
  const suppliedChannel = String(input.channel || '').trim().toLowerCase();
  if (suppliedChannel && suppliedChannel !== frozenChannel) {
    throw new OutreachOutcomeError('outreach_outcome_channel_mismatch', `Outcome channel ${suppliedChannel} does not match thread channel ${frozenChannel}.`);
  }

  const supersedesOutcomeId = input.supersedesOutcomeId ? String(input.supersedesOutcomeId).trim() : null;
  const referenceId = String(input.referenceId || '').trim();
  const normalized = { threadId, profileId, type, occurredAt, windowEndAt, supersedesOutcomeId };
  if (referenceId) {
    const existing = one(s, 'SELECT * FROM outreach_outcomes WHERE profile_id=? AND reference_id=?', [profileId, referenceId]);
    if (existing) {
      if (!sameReferencedObservation(existing, normalized)) {
        throw new OutreachOutcomeError('outreach_outcome_reference_conflict', `Reference ${referenceId} already identifies a different outreach outcome.`);
      }
      return { ...rowProjection(existing, { includeNotes }), idempotent: true, externalSideEffects: 'none', causalAttribution: false };
    }
  }
  if (supersedesOutcomeId) {
    const original = one(s, 'SELECT * FROM outreach_outcomes WHERE id=?', [supersedesOutcomeId]);
    if (!original) throw new OutreachOutcomeError('outreach_outcome_supersedes_unknown', `Unknown superseded outcome: ${supersedesOutcomeId}.`);
    if (original.profile_id !== profileId || original.thread_id !== threadId) {
      throw new OutreachOutcomeError('outreach_outcome_supersedes_mismatch', 'Corrections must remain in the original profile and outreach thread.');
    }
    if (one(s, 'SELECT id FROM outreach_outcomes WHERE supersedes_outcome_id=?', [supersedesOutcomeId])) {
      throw new OutreachOutcomeError('outreach_outcome_already_superseded', `Outcome ${supersedesOutcomeId} already has a correction.`);
    }
  }

  const stakeholder = thread.stakeholder_id ? one(s, 'SELECT * FROM stakeholders WHERE id=?', [thread.stakeholder_id]) : null;
  const contactRow = thread.contact_point_id ? one(s, 'SELECT * FROM contact_points WHERE id=?', [thread.contact_point_id]) : null;
  const contact = rawContact(contactRow);
  const contactConfidence = contact ? projectContactConfidenceV2(s, contact, { nowDate: new Date(occurredAt) }) : null;
  const roleClass = classifyStakeholder({ role: stakeholder?.role || '' });
  const contactPath = contact?.type || (thread.channel ? `channel:${thread.channel}` : 'unknown');
  const channel = frozenChannel;
  const actor = String(input.actor || 'user').trim() || 'user';
  const source = String(input.source || 'cli').trim() || 'cli';
  const note = String(input.note || '');
  const correctionReason = String(input.correctionReason || '');
  const outcomeId = id('outcome', referenceId
    ? `${profileId}:${referenceId}`
    : `${threadId}:${type}:${occurredAt}:${windowEndAt || ''}:${supersedesOutcomeId || ''}:${recordedAt}`);

  run(s, `INSERT INTO outreach_outcomes
    (id,thread_id,profile_id,job_id,stakeholder_id,contact_point_id,role_class,contact_tier,contact_path,channel,outcome_type,occurred_at,window_end_at,recorded_at,note,actor,source,reference_id,supersedes_outcome_id,correction_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    outcomeId,
    threadId,
    profileId,
    thread.job_id || null,
    thread.stakeholder_id || null,
    thread.contact_point_id || null,
    roleClass,
    contactConfidence?.evidenceTier || '',
    contactPath,
    channel,
    type,
    occurredAt,
    windowEndAt,
    recordedAt,
    note,
    actor,
    source,
    referenceId,
    supersedesOutcomeId,
    correctionReason,
  ]);
  audit(s, supersedesOutcomeId ? 'outreach.outcome.corrected' : 'outreach.outcome.recorded', 'outreach_outcome', outcomeId, {
    schema: OUTREACH_OUTCOME_SCHEMA,
    threadId,
    profileId,
    jobId: thread.job_id || null,
    stakeholderId: thread.stakeholder_id || null,
    contactPointId: thread.contact_point_id || null,
    roleClass,
    contactTier: contactConfidence?.evidenceTier || null,
    contactPath,
    channel,
    outcomeType: type,
    occurredAt,
    windowEndAt,
    actor,
    source,
    referenceId: referenceId || null,
    supersedesOutcomeId,
    causalAttribution: false,
  });
  syncOutreachOutcomes(s, profileId);
  save(s);
  const created = one(s, 'SELECT * FROM outreach_outcomes WHERE id=?', [outcomeId]);
  return { ...rowProjection(created, { includeNotes }), idempotent: false, externalSideEffects: 'none', causalAttribution: false };
}

export function listOutreachOutcomes(s, { profileId, sinceDays = null, includeNotes = false, nowDate = new Date() } = {}) {
  const owner = requiredText(profileId, 'outreach_outcome_profile_required', 'profileId is required.');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [owner])) {
    throw new OutreachOutcomeError('outreach_outcome_profile_unknown', `Unknown profile: ${owner}.`);
  }
  let rows;
  let start = null;
  if (sinceDays != null) {
    const days = Math.max(1, Number(sinceDays));
    if (!Number.isFinite(days)) throw new OutreachOutcomeError('outreach_outcome_since_invalid', 'sinceDays must be a positive number.');
    start = new Date(nowDate.getTime() - days * 86_400_000).toISOString();
    rows = all(s, 'SELECT * FROM outreach_outcomes WHERE profile_id=? AND occurred_at>=? ORDER BY occurred_at,id', [owner, start]);
  } else {
    rows = all(s, 'SELECT * FROM outreach_outcomes WHERE profile_id=? ORDER BY occurred_at,id', [owner]);
  }
  return {
    schema: OUTREACH_OUTCOME_LIST_SCHEMA,
    outcomeSchema: OUTREACH_OUTCOME_SCHEMA,
    profileId: owner,
    period: { start, end: nowDate.toISOString() },
    outcomes: withHistory(rows, { includeNotes }),
  };
}

function currentRows(rows) {
  const superseded = new Set(rows.map(row => row.supersedes_outcome_id).filter(Boolean));
  return rows.filter(row => !superseded.has(row.id));
}

function countByType(rows) {
  return OUTREACH_OUTCOME_TYPES.reduce((counts, type) => ({ ...counts, [type]: rows.filter(row => row.outcome_type === type).length }), {});
}

function groupObserved(rows, key, label) {
  const values = new Map();
  for (const row of rows) {
    const value = String(row[key] || 'unknown');
    if (!values.has(value)) values.set(value, []);
    values.get(value).push(row);
  }
  return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([value, group]) => ({
    [label]: value,
    observationDenominator: group.length,
    counts: countByType(group),
    sampleLabel: `${group.length} observed outcome record(s) in this sample; no causal interpretation.`,
  }));
}

function observedRate(rows, types, denominator, label) {
  const threadIds = new Set(rows.filter(row => types.includes(row.outcome_type)).map(row => row.thread_id));
  const numerator = threadIds.size;
  return {
    numerator,
    denominator,
    percent: denominator ? Math.round((numerator / denominator) * 1000) / 10 : null,
    label: `${numerator} of ${denominator} sent-thread cohort member(s) had ${label} observed in this sample.`,
  };
}

export function summarizeOutreachOutcomes(s, { profileId, sinceDays = 30, nowDate = new Date(), minimumSampleSize = 5 } = {}) {
  const owner = requiredText(profileId, 'outreach_outcome_profile_required', 'profileId is required.');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [owner])) {
    throw new OutreachOutcomeError('outreach_outcome_profile_unknown', `Unknown profile: ${owner}.`);
  }
  const days = Math.max(1, Number(sinceDays || 30));
  const end = nowDate.toISOString();
  const start = new Date(nowDate.getTime() - days * 86_400_000).toISOString();
  const sentThreads = all(s, `SELECT id,sent_at,channel FROM outreach_threads
    WHERE profile_id=? AND sent_at IS NOT NULL AND sent_at>=? AND sent_at<=?
    ORDER BY id`, [owner, start, end]);
  const sentThreadIds = new Set(sentThreads.map(thread => thread.id));
  const sentThreadById = new Map(sentThreads.map(thread => [thread.id, thread]));
  const completeHistory = all(s, `SELECT * FROM outreach_outcomes
    WHERE profile_id=? AND occurred_at<=?
    ORDER BY occurred_at,id`, [owner, end]);
  const observed = currentRows(completeHistory).filter(row => {
    if (!sentThreadIds.has(row.thread_id)) return false;
    const thread = sentThreadById.get(row.thread_id);
    return Date.parse(row.occurred_at) >= Date.parse(thread.sent_at)
      && String(row.channel || '').toLowerCase() === String(thread.channel || '').toLowerCase();
  });
  const observedThreadIds = new Set(observed.map(row => row.thread_id));
  const sentDenominator = sentThreadIds.size;
  const insufficientData = observedThreadIds.size < Number(minimumSampleSize);
  return {
    schema: OUTREACH_OUTCOME_SUMMARY_SCHEMA,
    profileId: owner,
    period: { start, end, sinceDays: days, basis: 'human_recorded_sent_at' },
    cohort: {
      definition: 'threads human-recorded as sent during the observation period',
      threadIds: [...sentThreadIds].sort(),
      numeratorPolicy: 'unique current outcome threads must belong to the sent-thread denominator cohort',
      recordPolicy: 'counts and groups contain current outcome records only for the same sent-thread cohort',
    },
    denominators: {
      sentThreads: sentDenominator,
      observedThreads: observedThreadIds.size,
      observedOutcomeRecords: observed.length,
      missingOutcomeThreads: Math.max(0, sentDenominator - observedThreadIds.size),
    },
    counts: countByType(observed),
    rates: {
      anyReply: observedRate(observed, ['reply_positive', 'reply_neutral', 'reply_negative'], sentDenominator, 'a reply'),
      replyPositive: observedRate(observed, ['reply_positive'], sentDenominator, 'a positive reply'),
      meetingBooked: observedRate(observed, ['meeting_booked'], sentDenominator, 'a booked meeting'),
      bounced: observedRate(observed, ['bounced'], sentDenominator, 'a bounce'),
    },
    byRoleClass: groupObserved(observed, 'role_class', 'roleClass'),
    byChannel: groupObserved(observed, 'channel', 'channel'),
    byContactTier: groupObserved(observed, 'contact_tier', 'contactTier'),
    byContactPath: groupObserved(observed, 'contact_path', 'contactPath'),
    insufficientData,
    minimumSampleSize: Number(minimumSampleSize),
    sampleLabel: insufficientData
      ? `Insufficient data: ${observedThreadIds.size} observed sent-thread cohort member(s) in this sample; show counts and denominators only.`
      : `${observedThreadIds.size} observed sent-thread cohort member(s) in this sample; comparisons remain descriptive only.`,
    interpretation: 'Observed records for the sent-thread cohort in this sample only. Meeting records do not establish that outreach caused a meeting.',
    handoff: {
      schema: OUTREACH_OUTCOME_SUMMARY_SCHEMA,
      consumers: ['W06', 'W08'],
      consumerPolicy: 'observations_only_no_next_action_or_learning',
      nextActionPolicyIncluded: false,
      learnedPreferencePolicyIncluded: false,
    },
  };
}

export function renderOutreachOutcomeSummaryMarkdown(summary) {
  const counts = OUTREACH_OUTCOME_TYPES.map(type => `- ${type}: ${summary.counts[type]} observed outcome record(s)`).join('\n');
  return `## Observed outreach outcomes

Observation period: ${summary.period.start} through ${summary.period.end}
Cohort: ${summary.cohort.definition}. Counts, groups, and rate numerators use current outcomes from this same cohort.


### Denominators
- Sent outreach threads: ${summary.denominators.sentThreads}
- Threads with an observed outcome: ${summary.denominators.observedThreads}
- Observed outcome records: ${summary.denominators.observedOutcomeRecords}
- Sent threads with missing outcomes: ${summary.denominators.missingOutcomeThreads}

### Counts
${counts}

### Descriptive rates
- Any reply: ${summary.rates.anyReply.numerator}/${summary.rates.anyReply.denominator}${summary.rates.anyReply.percent == null ? '' : ` (${summary.rates.anyReply.percent}%)`}
- Meeting booked: ${summary.rates.meetingBooked.numerator}/${summary.rates.meetingBooked.denominator}${summary.rates.meetingBooked.percent == null ? '' : ` (${summary.rates.meetingBooked.percent}%)`}
- Bounced: ${summary.rates.bounced.numerator}/${summary.rates.bounced.denominator}${summary.rates.bounced.percent == null ? '' : ` (${summary.rates.bounced.percent}%)`}

${summary.sampleLabel}

These are observed records in this sample. They do not establish that a role, contact tier, wording, or channel caused an outcome.`;
}
