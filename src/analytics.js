import path from 'node:path';
import { one, all, run, save, audit } from './db.js';
import { now, id, parseJson } from './utils.js';
import { writeMd } from './workspace.js';
import { due } from './tracking.js';
import { listAutomations, listRuns } from './scheduler/store.js';
import { discoveryRuns, listSearches, listWatchlist, reviewQueue } from './discovery.js';
import { listOutreachThreads, outreachDue } from './outreach.js';

export function state(s) {
  return {
    profiles: all(s, 'SELECT id,name,preferences_json,created_at,updated_at FROM profiles ORDER BY created_at'),
    jobs: all(s, 'SELECT jobs.*, applications.status AS application_status FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id ORDER BY jobs.created_at DESC').map(x => ({ ...x, url: String(x.url || '').startsWith('jobos:text:') ? '' : x.url, score: parseJson(x.score_json, null), requirements: parseJson(x.requirements_json, []) })),
    applications: all(s, 'SELECT applications.*, jobs.title, jobs.company FROM applications JOIN jobs ON jobs.id=applications.job_id ORDER BY applications.updated_at DESC'),
    statusChanges: all(s, 'SELECT * FROM status_changes ORDER BY created_at DESC LIMIT 100'),
    artifacts: all(s, 'SELECT id,job_id,profile_id,type,path,title,warnings_json,approval_status,created_at FROM artifacts ORDER BY created_at DESC').map(a => ({ ...a, warnings: parseJson(a.warnings_json, []) })),
    tasks: due(s),
    companies: all(s, 'SELECT * FROM companies ORDER BY name'),
    stakeholders: all(s, 'SELECT * FROM stakeholders ORDER BY updated_at DESC'),
    outreachThreads: listOutreachThreads(s),
    outreachDue: outreachDue(s),
    searches: listSearches(s),
    watchlist: listWatchlist(s),
    discoveryRuns: discoveryRuns(s),
    reviewQueue: reviewQueue(s),
    audit: all(s, 'SELECT id,action,entity_type,entity_id,payload_json,external_side_effect,created_at FROM audit_log ORDER BY created_at DESC LIMIT 50').map(a => ({ ...a, payload: parseJson(a.payload_json, {}) })),
    automations: listAutomations(s),
    automationRuns: listRuns(s, { limit: 25 }),
    policy: { externalApply: 'human_approval_required', externalSend: 'human_approval_required', autoApply: 'disabled', autoSend: 'disabled' }
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
    if (stuck) insights.push(`${stuck.count} application(s) are still in ${stuck.stage}; choose the next human-gated action for each.`);
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
  const tasks = due(s);
  const top = jobs.slice(0, 5).map(x => `- ${x.title} at ${x.company}: ${x.fit_score ?? 'unscored'}/100 (${x.id})`).join('\n') || '- No jobs imported.';
  const taskLines = tasks.slice(0, 10).map(t => `- ${t.title} (${t.priority}, ${t.due_at || 'no due date'})`).join('\n') || '- No open tasks.';
  const content = `# Weekly JobOS review — ${prof.name}\n\nGenerated: ${now()}\n\n## Funnel analytics\n${renderFunnelMarkdown(metrics).replace(/^# Funnel analytics[^\n]*\n\n/, '')}\n\n## Top jobs\n${top}\n\n## Due / open tasks\n${taskLines}\n\n## Recommended experiments\n- Double down on sources or role families that generate interviews, not just imports.\n- Move stalled saved/researching roles either to materials-ready or withdrawn to keep the board honest.\n- Add proof points for recurring requirements that appear in high-fit jobs but not in tailored artifacts.\n\n## Automation policy\nThis review is an internal summary. It did not submit applications or send outreach.\n`;
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
