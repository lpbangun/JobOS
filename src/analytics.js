import path from 'node:path';
import { one, all, run, save, audit } from './db.js';
import { now, id, parseJson } from './utils.js';
import { writeMd } from './workspace.js';
import { openTasks } from './tracking.js';
import { deserializeLiveness } from './discovery/liveness.js';
import { listSearches, listWatchlist, discoveryRuns, reviewQueue } from './discovery.js';
import { listOutreachThreads, outreachDue } from './outreach.js';
import { listContactPoints } from './research/contacts.js';
import { listAutomations, listRuns } from './scheduler/store.js';
import { renderOutreachOutcomeSummaryMarkdown } from './outreach-outcomes.js';
import { compareFitDecisions, deserializeFitScore, qualifiesForHighFit } from './scoring.js';
import { getPostingLiveness } from './jobs.js';
import { lifecycleTaskView } from './lifecycle.js';
import { lifecycleAnalytics } from './lifecycle-analytics.js';

export function state(s, { profileId = null } = {}) {
  const taskScope = profileId ? { profileId } : { global: true };
  return {
    profiles: all(s, 'SELECT id,name,preferences_json,created_at,updated_at FROM profiles ORDER BY created_at'),
    jobs: all(s, 'SELECT jobs.*, applications.status AS application_status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id ORDER BY jobs.created_at DESC').map(x => ({ ...x, url: String(x.url || '').startsWith('jobos:text:') ? '' : x.url, score: deserializeFitScore(parseJson(x.score_json, null), { persistedOverall: x.fit_score, jobId: x.id, profileId: x.profile_id }), requirements: parseJson(x.requirements_json, []), liveness: deserializeLiveness(x), postingLiveness: getPostingLiveness(x) })),
    applications: all(s, 'SELECT applications.*, jobs.title, jobs.company FROM applications JOIN jobs ON jobs.id=applications.job_id ORDER BY applications.updated_at DESC'),
    statusChanges: all(s, 'SELECT * FROM status_changes ORDER BY created_at DESC LIMIT 100'),
    artifacts: all(s, 'SELECT id,job_id,profile_id,type,path,title,warnings_json,approval_status,created_at FROM artifacts ORDER BY created_at DESC').map(a => ({ ...a, warnings: parseJson(a.warnings_json, []) })),
    tasks: openTasks(s, taskScope).filter(task => profileId ? task.profile_id === profileId : task.profile_id == null),
    companies: all(s, 'SELECT * FROM companies ORDER BY name'),
    stakeholders: all(s, 'SELECT * FROM stakeholders ORDER BY updated_at DESC'),
    sourceObservations: all(s, 'SELECT * FROM source_observations ORDER BY fetched_at DESC LIMIT 100').map(x => ({ ...x, metadata: parseJson(x.metadata_json, {}) })),
    personCandidates: all(s, 'SELECT * FROM person_candidates ORDER BY updated_at DESC'),
    contactPoints: listContactPoints(s),
    emailPatterns: all(s, 'SELECT * FROM email_patterns ORDER BY updated_at DESC'),
    outreachPlans: all(s, 'SELECT * FROM outreach_plans ORDER BY created_at DESC').map(x => ({ ...x, reasoning: parseJson(x.reasoning_json, {}), warnings: parseJson(x.warnings_json, []) })),
    outreachThreads: listOutreachThreads(s),
    outreachDue: outreachDue(s),
    searches: listSearches(s),
    watchlist: listWatchlist(s),
    discoveryRuns: discoveryRuns(s),
    reviewQueue: reviewQueue(s),
    audit: all(s, 'SELECT id,action,entity_type,entity_id,payload_json,external_side_effect,created_at FROM audit_log ORDER BY created_at DESC LIMIT 50').map(a => ({ ...a, payload: parseJson(a.payload_json, {}) })),
    automations: listAutomations(s),
    automationRuns: listRuns(s, { limit: 25 }),
    policy: { externalApply: 'user_configured', externalSend: 'user_configured', autoApply: 'disabled', autoSend: 'disabled' }
  };
}

function fitSummary(fit) {
  if (!fit) return 'unscored';
  if (fit.contract === 'legacy_unversioned') return fit.overall == null ? 'legacy fit unknown' : `legacy ${fit.overall}/100`;
  if (fit.overall == null) return 'fit unknown';
  return `${fit.overall}/100${fit.scoreStatus === 'review_required' ? ' (review required)' : ''}`;
}


function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

export function funnel(s, profileId, days = 30, { nowDate = new Date(), minimumSampleSize = 5 } = {}) {
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!prof) throw Error(`Unknown profile: ${profileId}`);
  const lifecycle = lifecycleAnalytics(s, {
    profileId,
    sinceDays: days,
    nowDate,
    minimumSampleSize,
  });
  const observed = lifecycle.observedFunnel;
  const inventory = lifecycle.currentInventory;
  const insights = [
    ...lifecycle.recommendations.map(item => item.action),
    ...lifecycle.warnings.map(warning => warning.message),
  ];
  return {
    profileId,
    profileName: prof.name,
    sinceDays: lifecycle.period.sinceDays,
    cutoff: lifecycle.period.start,
    totals: {
      jobs: inventory.jobs,
      applications: inventory.applications,
      applied: observed.applied,
      responses: observed.responses,
      interviews: observed.interviews,
      offers: observed.offers,
      staleActive: inventory.staleActive,
    },
    conversion: (() => {
      const applyRateAmongApplicationsWithObservedEvents = pct(observed.applied, observed.applicationsWithObservedEvents);
      return {
        applyRateAmongApplicationsWithObservedEvents,
        applyRateFromImportedJobs: applyRateAmongApplicationsWithObservedEvents,
        responseRateFromApplied: pct(observed.responses, observed.applied),
        interviewRateFromApplied: pct(observed.interviews, observed.applied),
        offerRateFromInterview: pct(observed.offers, observed.interviews),
      };
    })(),
    conversionAliases: {
      applyRateFromImportedJobs: 'applyRateAmongApplicationsWithObservedEvents',
    },
    byStage: inventory.byStage,
    stageReached: observed.stageReached,
    bySource: lifecycle.bySource,
    byRoleFamily: lifecycle.byRoleFamily,
    byStageAndSource: inventory.byStageAndSource,
    insights,
    basis: {
      totals: 'mixed_labeled_inventory_and_observed_events',
      conversion: 'observed_events_only',
      byStage: 'current_snapshot',
      stageReached: 'observed_status_events',
      bySource: 'observed_applied_cohort',
      byRoleFamily: 'observed_applied_cohort',
    },
    lifecycle,
  };
}

function table(rows, columns) {
  if (!rows.length) return '- No data.';
  return rows.map(row => `- ${columns.map(([label, key]) => `${label}: ${row[key]}`).join('; ')}`).join('\n');
}

export function renderFunnelMarkdown(metrics) {
  const lifecycle = metrics.lifecycle;
  const reached = metrics.stageReached?.length
    ? metrics.stageReached.map(item => `- ${item.stage}: ${item.count}`).join('\n')
    : '- No observed stage entries in this period.';
  const warnings = lifecycle.warnings.length
    ? lifecycle.warnings.map(warning => `- ${warning.code}: ${warning.message}`).join('\n')
    : '- None.';
  const dwell = lifecycle.stageDwell.byStage.length
    ? lifecycle.stageDwell.byStage.map(stage => `- ${stage.stage}: ${stage.sampleCount} completed, ${stage.openCount} open/censored; median ${stage.medianHours ?? 'insufficient sample'} hours; p75 ${stage.p75Hours ?? 'insufficient sample'} hours`).join('\n')
    : '- No observed dwell segments.';
  return `# Funnel analytics — ${metrics.profileName}

Period: ${lifecycle.period.start} through ${lifecycle.period.end}
Basis: observed status events and immutable submission events. Current inventory is labeled separately and is not treated as velocity.

## Current inventory
- Imported jobs: ${metrics.totals.jobs}
- Applications tracked: ${metrics.totals.applications}
- Stale active applications: ${metrics.totals.staleActive}

### Current stage snapshot
${table(metrics.byStage, [['Stage', 'stage'], ['Applications', 'count']])}

## Observed funnel
- Applied cohort: ${metrics.totals.applied}
- Employer responses: ${metrics.totals.responses}
- Interviews observed: ${metrics.totals.interviews}
- Offers observed: ${metrics.totals.offers}

### Observed conversion
- Apply rate among applications with observed events: ${metrics.conversion.applyRateAmongApplicationsWithObservedEvents ?? 'n/a'}%
- Response rate from observed applied cohort: ${metrics.conversion.responseRateFromApplied ?? 'n/a'}%
- Interview rate from observed applied cohort: ${metrics.conversion.interviewRateFromApplied ?? 'n/a'}%
- Offer rate from observed interviews: ${metrics.conversion.offerRateFromInterview ?? 'n/a'}%

## Denominators
- Applications with observed events: ${lifecycle.denominators.applicationsWithObservedEvents}
- Applied cohort: ${lifecycle.denominators.appliedCohort}
- Observed responses: ${lifecycle.denominators.observedResponses}
- Completed dwell segments: ${lifecycle.denominators.completedDwellSegments}
- Open/censored dwell segments: ${lifecycle.denominators.openDwellSegments}
- Terminal outcomes: ${lifecycle.denominators.terminalOutcomes}
- Sent outreach threads: ${lifecycle.denominators.sentOutreachThreads}
- Observed outreach threads: ${lifecycle.denominators.observedOutreachThreads}

## Stage dwell
${dwell}

## Observed stages reached
${reached}

## Source groups — descriptive observed applied cohort
${table(metrics.bySource, [['Source', 'source'], ['Applications', 'applications'], ['Responses', 'responses'], ['Interviews', 'interviews'], ['Offers', 'offers']])}

## Role-family groups — descriptive observed applied cohort
${table(metrics.byRoleFamily, [['Role family', 'roleFamily'], ['Applications', 'applications'], ['Responses', 'responses'], ['Interviews', 'interviews'], ['Offers', 'offers']])}

## Warnings
${warnings}`;
}

export function weekly(s, pid, { recordRun = true, nowDate = new Date() } = {}) {
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (!prof) throw Error(`Unknown profile: ${pid}`);
  const metrics = funnel(s, pid, 30, { nowDate });
  const outreachOutcomes = metrics.lifecycle.outreachOutcomes;
  metrics.outreachOutcomes = outreachOutcomes;
  const jobs = all(s, 'SELECT * FROM jobs WHERE profile_id=?', [pid]).map(job => ({
    ...job,
    jobId: job.id,
    fit: deserializeFitScore(parseJson(job.score_json, null), { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id }),
    postingLiveness: getPostingLiveness(job)
  })).sort(compareFitDecisions);
  const tasks = openTasks(s, { profileId: pid }).filter(task => task.profile_id === pid);
  const top = jobs.slice(0, 5).map(job => `- ${job.title} at ${job.company}: ${fitSummary(job.fit)} (${job.id})`).join('\n') || '- No jobs imported.';
  const taskLines = tasks.slice(0, 10).map(task => {
    if (task.action_kind !== 'application_next_action') return `- ${task.title} (${task.priority}, ${task.due_at || 'no due date'})`;
    const action = lifecycleTaskView(task, { nowDate });
    return `- ${action.title} (${action.state}, due ${action.dueAt}; ${action.actionCode}; ${action.scheduleSource})`;
  }).join('\n') || '- No open tasks.';
  const currentActionLines = tasks
    .filter(task => task.action_kind === 'application_next_action')
    .map(task => lifecycleTaskView(task, { nowDate }))
    .map(action => `- ${action.actionCode}: ${action.title} (${action.state}, due ${action.dueAt}; ${action.scheduleSource})`)
    .join('\n') || '- No current application actions.';
  const recommendationLines = metrics.lifecycle.recommendations
    .map(item => `- ${item.category}: ${item.action} Caution: ${item.caution}`)
    .join('\n') || '- None.';
  const cutoff = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleRuns = all(s, `SELECT id,job_id,scope,finished_at FROM research_runs WHERE profile_id=? AND status IN ('succeeded','partial') AND finished_at<? ORDER BY finished_at ASC LIMIT 3`, [pid, cutoff]);
  const staleRunLines = staleRuns.map(r => `- Run ${r.id} (${r.scope}) finished ${r.finished_at}. Run \`jobos research runs resume ${r.id}\` to refresh.`).join('\n') || '';
  const highFitNoRun = all(s, `SELECT j.* FROM jobs j LEFT JOIN research_runs rr ON rr.job_id=j.id AND rr.profile_id=? AND rr.scope='job' WHERE j.profile_id=? AND j.high_fit=1 AND COALESCE(j.liveness_status,'uncertain')<>'expired' AND rr.id IS NULL ORDER BY j.fit_score DESC,j.id`, [pid, pid])
    .map(job => ({
      jobId: job.id,
      job,
      fit: deserializeFitScore(parseJson(job.score_json, null), { persistedOverall: job.fit_score, jobId: job.id, profileId: job.profile_id }),
      postingLiveness: getPostingLiveness(job)
    }))
    .filter(({ fit }) => qualifiesForHighFit(fit, 0))
    .sort(compareFitDecisions)
    .slice(0, 5);
  const highFitLines = highFitNoRun.map(({ job, fit }) => `- ${job.title} at ${job.company} (${fit.overall}/100). Run \`jobos research people --scope job --job ${job.id} --profile ${pid} --depth standard\` to start.`).join('\n') || '';
  const networkIntent = parseJson(prof.preferences_json, {}).networkIntent;
  const networkSetupStatus = networkIntent?.completedAt ? 'complete' : 'not started or incomplete';
  const networkSetupLine = networkSetupStatus === 'complete' ? '' : '- Network setup is unfinished. Run \`jobos profile network-intent --profile <id> --file <json>\` to configure intent and import connections.';
  const followupDue = all(s, `SELECT id,title,due_at FROM tasks
    WHERE profile_id=? AND status='open' AND due_at IS NOT NULL AND due_at<=?
    ORDER BY due_at,id LIMIT 5`, [pid, nowDate.toISOString()]);
  const followupLines = followupDue.map(t => `- Task "${t.title}" (${t.id}) is overdue as of ${t.due_at}.`).join('\n') || '';
  const researchRecs = [staleRunLines, highFitLines, networkSetupLine, followupLines].filter(Boolean).join('\n') || '- None.';
  const generatedAt = nowDate.toISOString();
  const content = `# Weekly JobOS review — ${prof.name}

Generated: ${generatedAt}

## Funnel analytics
${renderFunnelMarkdown(metrics).replace(/^# Funnel analytics[^\n]*\n\n/, '')}

${renderOutreachOutcomeSummaryMarkdown(outreachOutcomes)}

## Top jobs
${top}

## Due / open tasks
${taskLines}

## Current application actions
${currentActionLines}

## Research recommendations (next actions, not auto-launched)
${researchRecs}

## Generated recommendations
${recommendationLines}

## Automation policy
This review is an internal descriptive summary. It did not submit applications, run research, send outreach, or mutate W06 next-action policy.`;
  const rel = path.join('exports', `weekly-review-${pid}-${generatedAt.slice(0, 10)}.md`);
  writeMd(path.join(s.p.ws, rel), content);
  const rid = id('run', `weekly-review:${pid}:${generatedAt}`);
  if (recordRun) {
    run(s, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,action_id,trigger_type,started_at,finished_at,duration_ms,counts_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [rid, 'weekly-review', JSON.stringify({ profileId: pid }), JSON.stringify({ path: rel, metrics }), 'succeeded', 'none', generatedAt, 'weekly_retrospective', 'manual', generatedAt, generatedAt, 0, JSON.stringify({ reviews: 1 })]);
    audit(s, 'review.weekly.created', 'automation_run', rid, { profileId: pid, path: rel });
  }
  save(s);
  return { runId: rid, path: rel, content, metrics };
}


export { resumeFeedback } from './lifecycle-analytics.js';
