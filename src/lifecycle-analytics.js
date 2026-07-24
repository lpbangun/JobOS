import { all, one } from './db.js';
import { ACTIVE_APPLICATION_STATUSES, lifecycleTaskView } from './lifecycle.js';
import { summarizeOutreachOutcomes } from './outreach-outcomes.js';
import { deserializeFitScore } from './scoring.js';
import { openTasks } from './tracking.js';
import { parseJson } from './utils.js';

export const LIFECYCLE_ANALYTICS_SCHEMA = 'jobos.lifecycle-analytics.v1';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STAGES = Object.freeze([
  'saved',
  'researching',
  'materials-ready',
  'applied',
  'recruiter-screen',
  'interview',
  'offer',
  'rejected',
  'withdrawn',
  'ghosted',
]);
const RESPONSE_STAGES = new Set(['recruiter-screen', 'interview', 'offer', 'rejected']);
const TERMINAL_STAGES = new Set(['rejected', 'withdrawn', 'ghosted']);

function analyticsError(code, message) {
  return Object.assign(new Error(message), { code, type: 'validation' });
}

function analyticsPeriod(sinceDays, nowDate) {
  const days = Math.max(1, Number(sinceDays || 30));
  if (!Number.isFinite(days)) throw analyticsError('lifecycle_analytics_since_invalid', 'sinceDays must be a finite number.');
  const endMs = nowDate instanceof Date ? nowDate.getTime() : Number.NaN;
  if (!Number.isFinite(endMs)) throw analyticsError('lifecycle_analytics_now_invalid', 'nowDate must be a valid Date.');
  const end = nowDate.toISOString();
  return {
    start: new Date(endMs - days * DAY_MS).toISOString(),
    end,
    sinceDays: days,
    basis: 'observed_status_events_and_immutable_submission_events',
  };
}

function inPeriod(value, period) {
  return value >= period.start && value <= period.end;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

function percent(numerator, denominator) {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : null;
}

function durationHours(start, end) {
  return (Date.parse(end) - Date.parse(start)) / HOUR_MS;
}

function durationSummary(segments, minimumSampleSize) {
  const ordered = [...segments].sort((left, right) => left.hours - right.hours || left.applicationId.localeCompare(right.applicationId));
  const durationsHours = ordered.map(segment => segment.hours);
  const applicationIds = uniqueSorted(ordered.map(segment => segment.applicationId));
  let medianHours = null;
  let p75Hours = null;
  if (durationsHours.length >= minimumSampleSize) {
    const middle = Math.floor(durationsHours.length / 2);
    medianHours = durationsHours.length % 2
      ? durationsHours[middle]
      : (durationsHours[middle - 1] + durationsHours[middle]) / 2;
    p75Hours = durationsHours[Math.ceil(0.75 * durationsHours.length) - 1];
  }
  return {
    sampleCount: durationsHours.length,
    applicationIds,
    durationsHours,
    medianHours,
    p75Hours,
    minimumSampleSize,
  };
}

export function roleFamily(title = '') {
  const normalized = String(title).toLowerCase();
  if (/product|pm\b/.test(normalized)) return 'product';
  if (/talent|recruit|people|hr/.test(normalized)) return 'people-talent';
  if (/learning|education|curriculum|instruction/.test(normalized)) return 'learning-education';
  if (/engineer|developer|software|data/.test(normalized)) return 'technical';
  if (/design|ux|research/.test(normalized)) return 'design-research';
  return 'other';
}

function currentInventory(applications, jobs, nowDate) {
  const staleBefore = new Date(nowDate.getTime() - 14 * DAY_MS).toISOString();
  const byStage = STAGES.map(stage => ({
    stage,
    count: applications.filter(application => application.status === stage).length,
  }));
  const sources = uniqueSorted(applications.map(application => application.source || 'manual'));
  const byStageAndSource = sources.map(source => ({
    source,
    stages: Object.fromEntries(STAGES.map(stage => [
      stage,
      applications.filter(application => (application.source || 'manual') === source && application.status === stage).length,
    ])),
  }));
  return {
    basis: 'current_snapshot',
    jobs: jobs.length,
    applications: applications.length,
    activeApplications: applications.filter(application => ACTIVE_APPLICATION_STATUSES.has(application.status)).length,
    terminalApplications: applications.filter(application => TERMINAL_STAGES.has(application.status)).length,
    staleActive: applications.filter(application => ACTIVE_APPLICATION_STATUSES.has(application.status) && application.updated_at < staleBefore).length,
    byStage,
    byStageAndSource,
    applicationIds: applications.map(application => application.id).sort(),
  };
}

function eventMap(events) {
  const byApplication = new Map();
  for (const event of events) {
    if (!byApplication.has(event.application_id)) byApplication.set(event.application_id, []);
    byApplication.get(event.application_id).push(event);
  }
  return byApplication;
}

function receiptMap(receipts) {
  const byApplication = new Map();
  for (const receipt of receipts) {
    if (!byApplication.has(receipt.application_id)) byApplication.set(receipt.application_id, []);
    byApplication.get(receipt.application_id).push(receipt);
  }
  for (const group of byApplication.values()) {
    group.sort((left, right) => left.submitted_at.localeCompare(right.submitted_at)
      || left.recorded_at.localeCompare(right.recorded_at)
      || left.id.localeCompare(right.id));
  }
  return byApplication;
}

function firstByApplication(events, status, period) {
  const selected = new Map();
  for (const event of events) {
    if (event.to_status !== status || !inPeriod(event.created_at, period) || selected.has(event.application_id)) continue;
    selected.set(event.application_id, event);
  }
  return selected;
}

function submissionAnchor(applicationId, appliedEvent, receiptsByApplication) {
  const receipt = (receiptsByApplication.get(applicationId) || [])[0] || null;
  if (receipt) {
    return {
      occurredAt: receipt.submitted_at,
      eventId: receipt.id,
      eventType: receipt.type,
      eventOrderId: null,
    };
  }
  if (!appliedEvent) return null;
  return {
    occurredAt: appliedEvent.created_at,
    eventId: appliedEvent.id,
    eventType: 'application_status_changed',
    eventOrderId: appliedEvent.id,
  };
}

function laterEvents(events, anchor) {
  if (!anchor) return [];
  return events.filter(event => event.created_at > anchor.occurredAt
    || (anchor.eventOrderId && event.created_at === anchor.occurredAt && event.id > anchor.eventOrderId));
}

function cohortObservation(application, appliedEvent, receiptsByApplication, eventsByApplication) {
  const anchor = submissionAnchor(application.id, appliedEvent, receiptsByApplication);
  const later = laterEvents(eventsByApplication.get(application.id) || [], anchor);
  const firstResponse = later.find(event => RESPONSE_STAGES.has(event.to_status)) || null;
  return {
    application,
    anchor,
    firstResponse,
    response: Boolean(firstResponse),
    interview: later.some(event => event.to_status === 'interview'),
    offer: later.some(event => event.to_status === 'offer'),
  };
}

function descriptiveGroups(cohort, key, label) {
  const groups = new Map();
  for (const observation of cohort) {
    const value = String(key(observation.application) || 'unknown');
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(observation);
  }
  return [...groups.entries()]
    .map(([value, observations]) => {
      const applicationIds = observations.map(observation => observation.application.id).sort();
      const responses = observations.filter(observation => observation.response).length;
      const interviews = observations.filter(observation => observation.interview).length;
      const offers = observations.filter(observation => observation.offer).length;
      return {
        [label]: value,
        applications: observations.length,
        responses,
        interviews,
        offers,
        responseRate: percent(responses, observations.length),
        interviewRate: percent(interviews, observations.length),
        offerRate: percent(offers, observations.length),
        applicationIds,
        interpretation: 'descriptive_observed_association_only_no_causal_claim',
      };
    })
    .sort((left, right) => right.applications - left.applications || String(left[label]).localeCompare(String(right[label])));
}

function strongestGroup(groups, label) {
  return [...groups].sort((left, right) => right.offers - left.offers
    || right.interviews - left.interviews
    || right.responses - left.responses
    || right.applications - left.applications
    || String(left[label]).localeCompare(String(right[label])))[0];
}

function recommendation(category, action, evidence, numerator, denominator, period, caution) {
  return {
    category,
    action,
    evidence,
    sample: { numerator, denominator, period },
    caution,
  };
}

function comparativeRecommendation(category, groups, label, minimumSampleSize, period) {
  const eligible = groups.filter(group => group.applications >= minimumSampleSize);
  if (eligible.length < 2) {
    return recommendation(
      category,
      `Collect observed applied-cohort outcomes until at least two ${category === 'source' ? 'source' : 'role-family'} groups each have ${minimumSampleSize} applications.`,
      { summary: `${eligible.length} eligible comparison group(s).`, groups },
      eligible.length,
      2,
      period,
      'Insufficient sample for a comparative recommendation; counts remain visible and descriptive only.',
    );
  }
  const strongest = strongestGroup(eligible, label);
  const dimension = strongest[label];
  return recommendation(
    category,
    `Run a fixed next five-role review batch comparing ${dimension} with the current mix.`,
    {
      summary: `${dimension} is the descriptively strongest eligible observed ${category === 'source' ? 'source' : 'role family'} in this period.`,
      comparedGroups: eligible,
    },
    strongest.interviews,
    eligible.reduce((sum, group) => sum + group.applications, 0),
    period,
    'This is a descriptive observed comparison only; it does not establish that the group caused outcomes.',
  );
}

function scoreRecommendation(scoreObservations, appliedDenominator, minimumSampleSize, period) {
  const count = scoreObservations.observations.length;
  if (count < minimumSampleSize) {
    return recommendation(
      'score',
      `Collect at least ${minimumSampleSize} applied-cohort applications with valid current W04 scores before requesting calibration.`,
      scoreObservations,
      count,
      appliedDenominator,
      period,
      'Insufficient sample. Current scores are not historical event snapshots and W06 does not alter score math.',
    );
  }
  return recommendation(
    'score',
    `Ask W04 to calibrate these exact ${count} current-score observations before changing any threshold or formula.`,
    scoreObservations,
    count,
    appliedDenominator,
    period,
    'Current scores are descriptive current values, not score-at-application snapshots; W06 creates no bands and changes no formula.',
  );
}

function proofRecommendation(proofObservations, appliedDenominator, period) {
  const first = proofObservations.recommendations[0] || null;
  if (!first) {
    return recommendation(
      'proof',
      'Continue recording source-backed resume coverage so recurring unsupported requirements can be reviewed.',
      { recurringUnsupported: [] },
      0,
      appliedDenominator,
      period,
      'Add or verify proof only if true; otherwise preserve the gap and narrow targeting.',
    );
  }
  return recommendation(
    'proof',
    first.action,
    { recurringUnsupported: proofObservations.recurringUnsupported },
    first.count,
    proofObservations.artifactSampleSize,
    period,
    first.action,
  );
}

function followUpRecommendation(s, profileId, inventory, period, nowDate) {
  const actionRows = openTasks(s, {
    profileId,
    actionKind: 'application_next_action',
  }).filter(row => row.profile_id === profileId && row.action_kind === 'application_next_action');
  const actions = actionRows.map(row => lifecycleTaskView(row, { nowDate }));
  const dueActions = actions.filter(action => action.state === 'overdue' || action.state === 'urgent');
  const manualActions = dueActions.filter(action => action.scheduleSource === 'manual');
  const evidence = {
    overdueOrUrgentActionIds: dueActions.map(action => action.id).sort(),
    manuallyRescheduledActionIds: manualActions.map(action => action.id).sort(),
  };
  if (!dueActions.length) {
    return recommendation(
      'follow_up',
      'Keep current application actions dated and resolve them as their policy dates arrive.',
      evidence,
      0,
      inventory.activeApplications,
      period,
      'These are operational reminders, not evidence that follow-up changes employer outcomes.',
    );
  }
  return recommendation(
    'follow_up',
    'Resolve or manually reschedule the profile’s overdue or urgent application actions.',
    evidence,
    dueActions.length,
    inventory.activeApplications,
    period,
    'Manual rescheduling changes the reminder date only; it does not reinterpret observed outcomes.',
  );
}

export function resumeFeedback(s, profileId, { minimumSampleSize = 10, minimumBandSize = 3 } = {}) {
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [profileId])) throw Error(`Unknown profile: ${profileId}`);
  const rows = all(s, `SELECT a.id AS artifact_id,a.job_id,ard.coverage_json,app.status AS application_status
    FROM artifacts a
    JOIN artifact_resume_documents ard ON ard.artifact_id=a.id
    LEFT JOIN applications app ON app.job_id=a.job_id AND app.profile_id=a.profile_id
    WHERE a.profile_id=? AND a.type='resume'
      AND a.revision=(SELECT MAX(a2.revision) FROM artifacts a2 WHERE a2.series_key=a.series_key)
    ORDER BY a.job_id,a.id`, [profileId]);
  const unsupported = new Map();
  const observedStatuses = new Set(['recruiter-screen', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn']);
  const positiveStatuses = new Set(['recruiter-screen', 'interview', 'offer']);
  const bands = new Map([['low', []], ['medium', []], ['high', []]]);
  for (const row of rows) {
    const coverage = parseJson(row.coverage_json, {});
    for (const item of coverage.unsupported || []) {
      const requirement = item.requirement || {};
      const key = String(requirement.sourceText || item.requirementId || '').trim().toLowerCase();
      if (!key) continue;
      if (!unsupported.has(key)) unsupported.set(key, { sourceText: requirement.sourceText, category: requirement.category || 'unknown', priority: requirement.priority || 'must_have', occurrences: [] });
      unsupported.get(key).occurrences.push({ jobId: row.job_id, artifactId: row.artifact_id, requirementId: item.requirementId, proofPointIds: [], sourceEntryIds: [] });
    }
    const ratio = Number(coverage.summary?.coverageRatio || 0);
    const band = ratio < 0.34 ? 'low' : ratio < 0.67 ? 'medium' : 'high';
    if (observedStatuses.has(row.application_status)) bands.get(band).push({ jobId: row.job_id, artifactId: row.artifact_id, applicationStatus: row.application_status, positiveOutcome: positiveStatuses.has(row.application_status), coverageRatio: ratio });
  }
  const recurringUnsupported = [...unsupported.values()]
    .map(item => ({ ...item, count: item.occurrences.length }))
    .sort((left, right) => right.count - left.count || left.sourceText.localeCompare(right.sourceText));
  const bandSummaries = [...bands.entries()].map(([band, samples]) => ({ band, sampleSize: samples.length, positiveOutcomes: samples.filter(sample => sample.positiveOutcome).length, positiveOutcomeRate: samples.length ? samples.filter(sample => sample.positiveOutcome).length / samples.length : null, samples }));
  const observedSampleSize = bandSummaries.reduce((total, band) => total + band.sampleSize, 0);
  const comparableBands = bandSummaries.filter(band => band.sampleSize >= minimumBandSize);
  const comparisonAvailable = observedSampleSize >= minimumSampleSize && comparableBands.length >= 2;
  const recommendations = recurringUnsupported.slice(0, 10).map(item => ({
    type: 'proof_or_targeting_improvement',
    requirement: item.sourceText,
    count: item.count,
    action: `If this experience is true, add or verify a proof point for "${item.sourceText}". Otherwise, preserve it as a gap and reconsider roles where it is required.`,
    sources: item.occurrences,
  }));
  return {
    schemaVersion: 1,
    profileId,
    artifactSampleSize: rows.length,
    observedOutcomeSampleSize: observedSampleSize,
    recurringUnsupported,
    outcomeComparison: {
      available: comparisonAvailable,
      minimumSampleSize,
      minimumBandSize,
      bands: bandSummaries,
      uncertainty: comparisonAvailable
        ? 'Observed association only; coverage does not establish causation.'
        : `Insufficient data: need at least ${minimumSampleSize} observed outcomes and two coverage bands with at least ${minimumBandSize} samples each.`,
      causalClaim: false,
    },
    recommendations,
    generatedClaims: [],
    policy: {
      createsResumeClaims: false,
      modifiesProofs: false,
      externalSideEffects: 'none',
    },
  };
}

export function lifecycleAnalytics(s, {
  profileId,
  sinceDays = 30,
  nowDate = new Date(),
  minimumSampleSize = 5,
} = {}) {
  const owner = String(profileId || '').trim();
  if (!owner) throw analyticsError('lifecycle_analytics_profile_required', 'profileId is required.');
  if (!one(s, 'SELECT id FROM profiles WHERE id=?', [owner])) {
    throw analyticsError('lifecycle_analytics_profile_unknown', `Unknown profile: ${owner}.`);
  }
  const threshold = Math.max(1, Math.trunc(Number(minimumSampleSize || 5)));
  if (!Number.isFinite(threshold)) throw analyticsError('lifecycle_analytics_sample_invalid', 'minimumSampleSize must be finite.');
  const period = analyticsPeriod(sinceDays, nowDate);
  const applications = all(s, `SELECT applications.*,jobs.title,jobs.company,jobs.source,jobs.fit_score,jobs.score_json
    FROM applications JOIN jobs ON jobs.id=applications.job_id
    WHERE applications.profile_id=? ORDER BY applications.id`, [owner]);
  const jobs = all(s, 'SELECT id FROM jobs WHERE profile_id=? ORDER BY id', [owner]);
  const inventory = currentInventory(applications, jobs, nowDate);
  const events = all(s, `SELECT status_changes.* FROM status_changes
    WHERE profile_id=? AND created_at<=?
    ORDER BY application_id,created_at,id`, [owner, period.end]);
  const receipts = all(s, `SELECT application_receipts.* FROM application_receipts
    JOIN applications ON applications.id=application_receipts.application_id
    WHERE applications.profile_id=?
      AND application_receipts.type IN ('user_attestation','adapter_receipt')
      AND application_receipts.submitted_at<=?
    ORDER BY application_receipts.application_id,application_receipts.submitted_at,application_receipts.recorded_at,application_receipts.id`, [owner, period.end]);
  const eventsByApplication = eventMap(events);
  const receiptsByApplication = receiptMap(receipts);
  const periodEvents = events.filter(event => inPeriod(event.created_at, period));
  const applicationsWithObservedEvents = uniqueSorted(periodEvents.map(event => event.application_id));
  const appliedEvents = firstByApplication(events, 'applied', period);
  const applicationById = new Map(applications.map(application => [application.id, application]));
  const appliedCohort = [...appliedEvents.entries()]
    .map(([applicationId, appliedEvent]) => cohortObservation(applicationById.get(applicationId), appliedEvent, receiptsByApplication, eventsByApplication))
    .filter(observation => observation.application);

  const receiptCohortIds = receipts.filter(receipt => inPeriod(receipt.submitted_at, period)).map(receipt => receipt.application_id);
  const compatibilityIds = uniqueSorted([...appliedEvents.keys(), ...receiptCohortIds]);
  const compatibilityCohort = compatibilityIds
    .map(applicationId => cohortObservation(applicationById.get(applicationId), appliedEvents.get(applicationId) || null, receiptsByApplication, eventsByApplication))
    .filter(observation => observation.application && observation.anchor);

  const completedSegments = [];
  const openSegments = [];
  const legacyApplicationIds = [];
  for (const application of applications) {
    const history = eventsByApplication.get(application.id) || [];
    for (let index = 0; index < history.length - 1; index += 1) {
      const entry = history[index];
      const exit = history[index + 1];
      if (!inPeriod(exit.created_at, period)) continue;
      completedSegments.push({
        applicationId: application.id,
        stage: entry.to_status,
        enteredAt: entry.created_at,
        exitedAt: exit.created_at,
        entryEventId: entry.id,
        exitEventId: exit.id,
        hours: durationHours(entry.created_at, exit.created_at),
      });
    }
    const latest = history.at(-1);
    if (ACTIVE_APPLICATION_STATUSES.has(application.status)) {
      if (!latest || latest.to_status !== application.status) {
        legacyApplicationIds.push(application.id);
      } else {
        openSegments.push({
          applicationId: application.id,
          stage: latest.to_status,
          enteredAt: latest.created_at,
          entryEventId: latest.id,
          censoredAt: period.end,
          observedHours: Math.max(0, durationHours(latest.created_at, period.end)),
        });
      }
    }
  }
  const dwellStages = uniqueSorted([...completedSegments.map(segment => segment.stage), ...openSegments.map(segment => segment.stage)]);
  const stageDwell = {
    basis: 'consecutive_observed_status_events_exit_in_period_open_segments_censored',
    completedSegments,
    openSegments,
    summary: durationSummary(completedSegments, threshold),
    byStage: dwellStages.map(stage => ({
      stage,
      ...durationSummary(completedSegments.filter(segment => segment.stage === stage), threshold),
      openCount: openSegments.filter(segment => segment.stage === stage).length,
      openApplicationIds: uniqueSorted(openSegments.filter(segment => segment.stage === stage).map(segment => segment.applicationId)),
    })),
  };

  const responseSegments = appliedCohort.filter(observation => observation.firstResponse).map(observation => ({
    applicationId: observation.application.id,
    stage: observation.firstResponse.to_status,
    startedAt: observation.anchor.occurredAt,
    respondedAt: observation.firstResponse.created_at,
    sourceEventId: observation.anchor.eventId,
    responseEventId: observation.firstResponse.id,
    hours: durationHours(observation.anchor.occurredAt, observation.firstResponse.created_at),
  }));
  const responseSummary = durationSummary(responseSegments, threshold);
  const censoredResponseIds = appliedCohort.filter(observation => !observation.firstResponse).map(observation => observation.application.id).sort();
  const timeToResponse = {
    basis: 'earliest_immutable_submission_when_present_otherwise_observed_applied_transition',
    ...responseSummary,
    observations: responseSegments,
    censoredCount: censoredResponseIds.length,
    censoredApplicationIds: censoredResponseIds,
  };

  function outcome(statuses) {
    const applicationIds = uniqueSorted(periodEvents.filter(event => statuses.has(event.to_status)).map(event => event.application_id));
    return { count: applicationIds.length, applicationIds };
  }
  const outcomes = {
    basis: 'unique_applications_reaching_observed_status_in_period',
    response: outcome(RESPONSE_STAGES),
    interview: outcome(new Set(['interview'])),
    offer: outcome(new Set(['offer'])),
    rejected: outcome(new Set(['rejected'])),
    withdrawn: outcome(new Set(['withdrawn'])),
    ghosted: outcome(new Set(['ghosted'])),
  };
  const terminalOutcomeIds = uniqueSorted([
    ...outcomes.rejected.applicationIds,
    ...outcomes.withdrawn.applicationIds,
    ...outcomes.ghosted.applicationIds,
  ]);
  const responseIds = appliedCohort.filter(observation => observation.response).map(observation => observation.application.id).sort();
  const interviewIds = appliedCohort.filter(observation => observation.interview).map(observation => observation.application.id).sort();
  const offerIds = appliedCohort.filter(observation => observation.offer).map(observation => observation.application.id).sort();
  const stageReached = STAGES.map(stage => outcome(new Set([stage])))
    .map((value, index) => ({ stage: STAGES[index], count: value.count, applicationIds: value.applicationIds }))
    .filter(value => value.count);
  const observedFunnel = {
    basis: 'observed_status_events_only',
    applicationsWithObservedEvents: applicationsWithObservedEvents.length,
    applied: appliedCohort.length,
    responses: responseIds.length,
    interviews: interviewIds.length,
    offers: offerIds.length,
    applicationIds: {
      observed: applicationsWithObservedEvents,
      applied: appliedCohort.map(observation => observation.application.id).sort(),
      responses: responseIds,
      interviews: interviewIds,
      offers: offerIds,
    },
    stageReached,
  };

  const bySource = descriptiveGroups(compatibilityCohort, application => application.source || 'manual', 'source');
  const byRoleFamily = descriptiveGroups(compatibilityCohort, application => roleFamily(application.title), 'roleFamily');
  const scoreRows = appliedCohort.map(observation => {
    const application = observation.application;
    const score = deserializeFitScore(parseJson(application.score_json, null), {
      persistedOverall: application.fit_score,
      jobId: application.job_id,
      profileId: application.profile_id,
    });
    if (score?.contract !== 'jobos.fit-score.v1' || score.scoreStatus !== 'scored' || !Number.isFinite(Number(score.overall))) return null;
    return {
      applicationId: application.id,
      jobId: application.job_id,
      score: Number(score.overall),
      scoreStatus: score.scoreStatus,
      contract: score.contract,
    };
  }).filter(Boolean).sort((left, right) => left.applicationId.localeCompare(right.applicationId));
  const scoreObservations = {
    basis: 'current_score_not_event_snapshot',
    observations: scoreRows,
    validCurrentScores: scoreRows.length,
    appliedCohort: appliedCohort.length,
    missingHistoricalSnapshots: appliedCohort.length,
    policy: 'w04_calibration_input_only_no_bands_thresholds_or_formula_changes',
  };
  const proofObservations = resumeFeedback(s, owner);
  const outreachOutcomes = summarizeOutreachOutcomes(s, {
    profileId: owner,
    sinceDays: period.sinceDays,
    nowDate,
    minimumSampleSize: threshold,
  });
  if (outreachOutcomes.schema !== 'jobos.outreach-outcome-summary.v1') {
    throw Error(`Unexpected outreach summary schema: ${outreachOutcomes.schema}`);
  }

  const denominators = {
    applicationsWithObservedEvents: applicationsWithObservedEvents.length,
    appliedCohort: appliedCohort.length,
    observedResponses: responseIds.length,
    completedDwellSegments: completedSegments.length,
    openDwellSegments: openSegments.length,
    terminalOutcomes: terminalOutcomeIds.length,
    sentOutreachThreads: outreachOutcomes.denominators.sentThreads,
    observedOutreachThreads: outreachOutcomes.denominators.observedThreads,
  };
  const warnings = [];
  const lowDwellStages = stageDwell.byStage.filter(stage => stage.sampleCount > 0 && stage.sampleCount < threshold).map(stage => stage.stage);
  if (responseSegments.length < threshold || lowDwellStages.length || appliedCohort.length < threshold) {
    warnings.push({
      code: 'insufficient_sample',
      message: `Samples below ${threshold} retain raw counts and durations; median and p75 remain null.`,
      evidence: {
        appliedCohort: appliedCohort.length,
        responseSamples: responseSegments.length,
        lowDwellStages,
      },
    });
  }
  if (openSegments.length) {
    warnings.push({
      code: 'open_dwell_censored',
      message: `${openSegments.length} latest active stage segment(s) are open/censored and excluded from duration percentiles.`,
      applicationIds: uniqueSorted(openSegments.map(segment => segment.applicationId)),
    });
  }
  if (legacyApplicationIds.length) {
    warnings.push({
      code: 'legacy_unobserved_stage',
      message: 'Current application stages without a matching latest observed status event remain inventory only.',
      applicationIds: legacyApplicationIds.sort(),
    });
  }
  if (scoreRows.length) {
    warnings.push({
      code: 'current_score_not_event_snapshot',
      message: 'Current valid W04 scores are descriptive observations, not historical score-at-application snapshots.',
      applicationIds: scoreRows.map(row => row.applicationId),
    });
  }

  const recommendations = [
    comparativeRecommendation('source', bySource, 'source', threshold, period),
    comparativeRecommendation('targeting', byRoleFamily, 'roleFamily', threshold, period),
    scoreRecommendation(scoreObservations, appliedCohort.length, threshold, period),
    proofRecommendation(proofObservations, appliedCohort.length, period),
    followUpRecommendation(s, owner, inventory, period, nowDate),
  ];
  const handoffs = {
    w04: {
      schema: 'jobos.lifecycle-analytics.v1',
      policy: 'descriptive_observed_aggregates_only_no_score_formula',
      fields: ['period', 'denominators', 'observedFunnel', 'stageDwell', 'timeToResponse', 'outcomes', 'scoreObservations'],
    },
    w07: {
      inputSchema: 'jobos.lifecycle-event-input.v1',
      acceptedEventTypes: ['interview_debrief_recorded'],
      required: ['profileId', 'applicationId', 'eventId', 'occurredAt', 'stage'],
      policy: 'debrief_content_remains_w07_owned',
    },
    w08: {
      schema: 'jobos.lifecycle-observation-list.v1',
      observationSchema: 'jobos.lifecycle-observation.v1',
      policy: 'attributed_observations_only_no_preference_interpretation',
    },
  };

  return {
    schema: LIFECYCLE_ANALYTICS_SCHEMA,
    profileId: owner,
    period,
    currentInventory: inventory,
    denominators,
    observedFunnel,
    stageDwell,
    timeToResponse,
    outcomes,
    bySource,
    byRoleFamily,
    scoreObservations,
    proofObservations,
    outreachOutcomes,
    recommendations,
    warnings,
    handoffs,
  };
}

export function renderLifecycleAnalyticsMarkdown(result) {
  const denominatorLines = Object.entries(result.denominators)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join('\n');
  const warningLines = result.warnings.length
    ? result.warnings.map(warning => `- ${warning.code}: ${warning.message}`).join('\n')
    : '- None.';
  const recommendationLines = result.recommendations.length
    ? result.recommendations.map(recommendation => `- ${recommendation.category}: ${recommendation.action}\n  Caution: ${recommendation.caution}`).join('\n')
    : '- None.';
  return `# Lifecycle analytics

- Profile: ${result.profileId}
- Period: ${result.period.start} to ${result.period.end} (${result.period.sinceDays} days)
- Basis: ${result.period.basis}

## Current inventory

- Basis: ${result.currentInventory.basis}
- Jobs: ${result.currentInventory.jobs}
- Applications: ${result.currentInventory.applications}
- Active applications: ${result.currentInventory.activeApplications}
- Terminal applications: ${result.currentInventory.terminalApplications}
- Stale active applications: ${result.currentInventory.staleActive}

## Observed funnel

- Basis: ${result.observedFunnel.basis}
- Applications with observed events: ${result.observedFunnel.applicationsWithObservedEvents}
- Applied: ${result.observedFunnel.applied}
- Responses: ${result.observedFunnel.responses}
- Interviews: ${result.observedFunnel.interviews}
- Offers: ${result.observedFunnel.offers}

## Denominators

${denominatorLines}

## Recommendations

${recommendationLines}

## Warnings

${warningLines}
`;
}
