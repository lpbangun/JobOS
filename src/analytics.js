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

export function state(s) {
  return {
    profiles: all(s, 'SELECT id,name,preferences_json,created_at,updated_at FROM profiles ORDER BY created_at'),
    jobs: all(s, 'SELECT jobs.*, applications.status AS application_status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id ORDER BY jobs.created_at DESC').map(x => ({ ...x, url: String(x.url || '').startsWith('jobos:text:') ? '' : x.url, score: parseJson(x.score_json, null), requirements: parseJson(x.requirements_json, []), liveness: deserializeLiveness(x) })),
    applications: all(s, 'SELECT applications.*, jobs.title, jobs.company FROM applications JOIN jobs ON jobs.id=applications.job_id ORDER BY applications.updated_at DESC'),
    statusChanges: all(s, 'SELECT * FROM status_changes ORDER BY created_at DESC LIMIT 100'),
    artifacts: all(s, 'SELECT id,job_id,profile_id,type,path,title,warnings_json,approval_status,created_at FROM artifacts ORDER BY created_at DESC').map(a => ({ ...a, warnings: parseJson(a.warnings_json, []) })),
    tasks: openTasks(s),
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

function sinceCutoff(days) {
  const n = Number(days || 30);
  const d = new Date(Date.now() - Math.max(1, n) * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function roleFamily(title = '') {
  const t = title.toLowerCase();
  if (/product|pm\b/.test(t)) return 'product';
  if (/talent|recruit|people|hr/.test(t)) return 'people-talent';
  if (/learning|education|curriculum|instruction/.test(t)) return 'learning-education';
  if (/engineer|developer|software|data/.test(t)) return 'technical';
  if (/design|ux|research/.test(t)) return 'design-research';
  return 'other';
}

function groupCount(rows, keyFn) {
  const out = new Map();
  for (const row of rows) {
    const key = keyFn(row) || 'unknown';
    out.set(key, (out.get(key) || 0) + 1);
  }
  return [...out.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([key, count]) => ({ key, count }));
}

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : 0;
}

export function funnel(s, profileId, days = 30) {
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!prof) throw Error(`Unknown profile: ${profileId}`);
  const cutoff = sinceCutoff(days);
  const apps = all(s, `SELECT applications.*, jobs.title, jobs.company, jobs.source, jobs.fit_score, jobs.created_at AS job_created_at
    FROM applications JOIN jobs ON jobs.id=applications.job_id
    WHERE applications.profile_id=? AND (applications.created_at>=? OR applications.id IN (SELECT application_id FROM status_changes WHERE profile_id=? AND created_at>=?))
    ORDER BY applications.updated_at DESC`, [profileId, cutoff, profileId, cutoff]);
  const changes = all(s, `SELECT status_changes.*, jobs.title, jobs.company, jobs.source
    FROM status_changes JOIN jobs ON jobs.id=status_changes.job_id
    WHERE status_changes.profile_id=? AND status_changes.created_at>=?
    ORDER BY status_changes.created_at`, [profileId, cutoff]);
  const jobs = all(s, `SELECT DISTINCT jobs.* FROM jobs
    LEFT JOIN applications ON applications.job_id=jobs.id
    WHERE jobs.profile_id=? AND (jobs.created_at>=? OR applications.id IN (SELECT application_id FROM status_changes WHERE profile_id=? AND created_at>=?))
    ORDER BY jobs.created_at DESC`, [profileId, cutoff, profileId, cutoff]);
  const stageOrder = ['saved', 'researching', 'materials-ready', 'applied', 'recruiter-screen', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'];
  const byStage = stageOrder.map(stage => ({ stage, count: apps.filter(a => a.status === stage).length })).filter(x => x.count || stageOrder.includes(x.stage));
  const reached = (stages) => new Set(changes.filter(c => stages.includes(c.to_status)).map(c => c.application_id));
  const appliedIds = reached(['applied', 'recruiter-screen', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']);
  const interviewIds = reached(['interview', 'offer']);
  const offerIds = reached(['offer']);
  const responseIds = reached(['recruiter-screen', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted']);
  for (const app of apps) {
    if (['applied', 'recruiter-screen', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'].includes(app.status)) appliedIds.add(app.id);
    if (['interview', 'offer'].includes(app.status)) interviewIds.add(app.id);
    if (app.status === 'offer') offerIds.add(app.id);
    if (['recruiter-screen', 'interview', 'offer', 'rejected', 'withdrawn', 'ghosted'].includes(app.status)) responseIds.add(app.id);
  }
  const applied = appliedIds.size;
  const interviews = interviewIds.size;
  const responses = responseIds.size;
  const bySource = groupCount(apps, a => a.source || 'manual').map(x => ({ source: x.key, applications: x.count, interviews: apps.filter(a => (a.source || 'manual') === x.key && interviewIds.has(a.id)).length }));
  const byRoleFamily = groupCount(apps, a => roleFamily(a.title)).map(x => ({ roleFamily: x.key, applications: x.count, interviews: apps.filter(a => roleFamily(a.title) === x.key && interviewIds.has(a.id)).length }));
  const byStageAndSource = bySource.map(src => ({ source: src.source, stages: stageOrder.reduce((acc, st) => ({ ...acc, [st]: apps.filter(a => (a.source || 'manual') === src.source && a.status === st).length }), {}) }));
  const stageReached = stageOrder.map(stage => ({ stage, count: reached([stage]).size })).filter(x => x.count);
  const staleCutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const stale = all(s, `SELECT COUNT(*) AS count FROM applications
    WHERE profile_id=? AND status IN ('saved','researching','materials-ready','applied','recruiter-screen','interview') AND updated_at<?`, [profileId, staleCutoff])[0]?.count || 0;
  const insights = [];
  if (!apps.length) insights.push('No applications in this window yet; import jobs and create application records to build a funnel.');
  else {
    const topSource = bySource[0];
    if (topSource) insights.push(`${topSource.source} is the largest source in this window with ${topSource.applications} application(s).`);
    if (applied && interviews === 0) insights.push('Applications are not yet converting to interviews; review fit scoring, company targeting, and outreach before increasing volume.');
    if (interviews > 0) insights.push(`Interview conversion is ${pct(interviews, applied || apps.length)}%; inspect the role families and sources that produced those interviews.`);
    const stuck = byStage.find(x => ['saved', 'researching', 'materials-ready'].includes(x.stage) && x.count > 0);
    if (stuck) insights.push(`${stuck.count} application(s) are still in ${stuck.stage}; choose the next action and use an explicitly configured external tool if one is needed.`);
    if (stale) insights.push(`${stale} active application(s) have not moved in 14+ days; schedule follow-up, prep for the next touchpoint, or mark them withdrawn/ghosted.`);
  }
  return {
    profileId,
    profileName: prof.name,
    sinceDays: Number(days || 30),
    cutoff,
    totals: { jobs: jobs.length, applications: apps.length, applied, responses, interviews, offers: offerIds.size || apps.filter(a => a.status === 'offer').length, staleActive: stale },
    conversion: { applyRateFromImportedJobs: pct(applied, jobs.length), responseRateFromApplied: pct(responses, applied), interviewRateFromApplied: pct(interviews, applied), offerRateFromInterview: pct((offerIds.size || apps.filter(a => a.status === 'offer').length), interviews) },
    byStage,
    stageReached,
    bySource,
    byRoleFamily,
    byStageAndSource,
    insights
  };
}

function table(rows, columns) {
  if (!rows.length) return '- No data.';
  return rows.map(row => `- ${columns.map(([label, key]) => `${label}: ${row[key]}`).join('; ')}`).join('\n');
}

export function renderFunnelMarkdown(metrics) {
  const reached = metrics.stageReached?.length ? metrics.stageReached.map(x => `- ${x.stage}: ${x.count}`).join('\n') : '- No stage history recorded in this window.';
  return `# Funnel analytics — ${metrics.profileName}\n\nWindow: last ${metrics.sinceDays} days (since ${metrics.cutoff})\n\n## Totals\n- Imported jobs: ${metrics.totals.jobs}\n- Applications tracked: ${metrics.totals.applications}\n- Applied / submitted manually: ${metrics.totals.applied}\n- Responses or terminal outcomes: ${metrics.totals.responses}\n- Interviews reached: ${metrics.totals.interviews}\n- Offers reached: ${metrics.totals.offers}\n- Stale active applications: ${metrics.totals.staleActive}\n\n## Conversion\n- Apply rate from imported jobs: ${metrics.conversion.applyRateFromImportedJobs}%\n- Response rate from applied: ${metrics.conversion.responseRateFromApplied}%\n- Interview rate from applied: ${metrics.conversion.interviewRateFromApplied}%\n- Offer rate from interviews: ${metrics.conversion.offerRateFromInterview}%\n\n## Current stage counts\n${metrics.byStage.map(x => `- ${x.stage}: ${x.count}`).join('\n')}\n\n## Stages reached from status history\n${reached}\n\n## By source\n${table(metrics.bySource, [['source', 'source'], ['applications', 'applications'], ['interviews', 'interviews']])}\n\n## By role family\n${table(metrics.byRoleFamily, [['role family', 'roleFamily'], ['applications', 'applications'], ['interviews', 'interviews']])}\n\n## Insights\n${metrics.insights.map(x => `- ${x}`).join('\n')}\n\n## Human gate\nAnalytics summarize internal state only. JobOS did not submit applications, send outreach, or modify external accounts.\n`;
}

export function weekly(s, pid, { recordRun = true } = {}) {
  const prof = one(s, 'SELECT * FROM profiles WHERE id=?', [pid]);
  if (!prof) throw Error(`Unknown profile: ${pid}`);
  const metrics = funnel(s, pid, 30);
  const jobs = all(s, 'SELECT * FROM jobs WHERE profile_id=? ORDER BY fit_score DESC,created_at DESC', [pid]);
  const tasks = openTasks(s);
  const top = jobs.slice(0, 5).map(x => `- ${x.title} at ${x.company}: ${x.fit_score ?? 'unscored'}/100 (${x.id})`).join('\n') || '- No jobs imported.';
  const taskLines = tasks.slice(0, 10).map(t => `- ${t.title} (${t.priority}, ${t.due_at || 'no due date'})`).join('\n') || '- No open tasks.';
  // Research recommendations
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const staleRuns = all(s, `SELECT id,job_id,scope,finished_at FROM research_runs WHERE profile_id=? AND status IN ('succeeded','partial') AND finished_at<? ORDER BY finished_at ASC LIMIT 3`, [pid, cutoff]);
  const staleRunLines = staleRuns.map(r => `- Run ${r.id} (${r.scope}) finished ${r.finished_at}. Run \`jobos research runs resume ${r.id}\` to refresh.`).join('\n') || '';
  const highFitNoRun = all(s, `SELECT j.id,j.title,j.company,j.fit_score FROM jobs j LEFT JOIN research_runs rr ON rr.job_id=j.id AND rr.profile_id=? AND rr.scope='job' WHERE j.profile_id=? AND j.high_fit=1 AND COALESCE(j.liveness_status,'uncertain')<>'expired' AND rr.id IS NULL ORDER BY j.fit_score DESC LIMIT 5`, [pid, pid]);
  const highFitLines = highFitNoRun.map(j => `- ${j.title} at ${j.company} (${j.fit_score ?? 'unscored'}/100). Run \`jobos research people --scope job --job ${j.id} --profile ${pid} --depth standard\` to start.`).join('\n') || '';
  const networkIntent = parseJson(prof.preferences_json, {}).networkIntent;
  const networkSetupStatus = networkIntent?.completedAt ? 'complete' : 'not started or incomplete';
  const networkSetupLine = networkSetupStatus === 'complete' ? '' : '- Network setup is unfinished. Run \`jobos profile network-intent --profile <id> --file <json>\` to configure intent and import connections.';
  const followupDue = all(s, `SELECT id,title,due_at FROM tasks WHERE status='open' AND due_at IS NOT NULL AND due_at<=? LIMIT 5`, [now()]);
  const followupLines = followupDue.map(t => `- Task "${t.title}" (${t.id}) is overdue as of ${t.due_at}.`).join('\n') || '';
  const researchRecs = [staleRunLines, highFitLines, networkSetupLine, followupLines].filter(Boolean).join('\n') || '- None.';
  const content = `# Weekly JobOS review — ${prof.name}\n\nGenerated: ${now()}\n\n## Funnel analytics\n${renderFunnelMarkdown(metrics).replace(/^# Funnel analytics[^\n]*\n\n/, '')}\n\n## Top jobs\n${top}\n\n## Due / open tasks\n${taskLines}\n\n## Research recommendations (next actions, not auto-launched)\n${researchRecs}\n\n## Recommended experiments\n- Double down on sources or role families that generate interviews, not just imports.\n- Move stalled saved/researching roles either to materials-ready or withdrawn to keep the board honest.\n- Add proof points for recurring requirements that appear in high-fit jobs but not in tailored artifacts.\n\n## Automation policy\nThis review is an internal summary. It did not submit applications, run start research, or send outreach.\n`;
  const rel = path.join('exports', `weekly-review-${pid}-${new Date().toISOString().slice(0, 10)}.md`);
  writeMd(path.join(s.p.ws, rel), content);
  const rid = id('run', `weekly-review:${pid}:${now()}`);
  if (recordRun) {
    const at = now();
    run(s, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,action_id,trigger_type,started_at,finished_at,duration_ms,counts_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [rid, 'weekly-review', JSON.stringify({ profileId: pid }), JSON.stringify({ path: rel, metrics }), 'succeeded', 'none', at, 'weekly_retrospective', 'manual', at, at, 0, JSON.stringify({ reviews: 1 })]);
    audit(s, 'review.weekly.created', 'automation_run', rid, { profileId: pid, path: rel });
  }
  save(s);
  return { runId: rid, path: rel, content, metrics };
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
    sources: item.occurrences
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
      causalClaim: false
    },
    recommendations,
    generatedClaims: [],
    policy: {
      createsResumeClaims: false,
      modifiesProofs: false,
      externalSideEffects: 'none'
    }
  };
}
