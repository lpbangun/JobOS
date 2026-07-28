import fs from 'node:fs';
import path from 'node:path';
import { all, one, run } from '../db.js';
import { weekly } from '../analytics.js';
import { id, now, parseJson, slug } from '../utils.js';
import { writeMd } from '../workspace.js';
import { getPostingLiveness, syncJob } from '../jobs.js';
import { createArtifact } from '../artifacts.js';
import { compareFitDecisions, deserializeFitScore, qualifiesForHighFit } from '../scoring.js';
import {
  ACTIVE_APPLICATION_STATUSES,
  LIFECYCLE_EVENT_INPUT_SCHEMA,
  reconcileApplicationNextAction,
} from '../lifecycle.js';

const suppressedFollowupStatuses = new Set(['interview', 'offer', 'rejected', 'withdrawn', 'ghosted']);

function today(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function endOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(23, 59, 59, 999);
  return d.toISOString();
}

function profilesFor(s, profileId) {
  if (profileId) {
    const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
    if (!profile) throw Error(`Unknown profile: ${profileId}`);
    return [profile];
  }
  return all(s, 'SELECT * FROM profiles ORDER BY created_at');
}

function insertArtifact(s, { jobId = null, profileId = null, type, rel, title, content, evidence = [], warnings = [] }) {
  const taskId = evidence.find(item => item && typeof item === 'object' && item.taskId)?.taskId;
  return createArtifact(s, {
    jobId,
    profileId,
    type,
    path: rel,
    title,
    content,
    evidence,
    warnings,
    series: { kind: type, taskId, producerId: taskId || rel },
    dedupePath: true
  }, { persist: false });
}

async function dailyDiscovery(s, automation) {
  try {
    const mod = await import('../discovery.js');
    const fn = mod.runAllSearches || mod.runAll || mod.runAllDiscovery || mod.default;
    if (typeof fn === 'function') {
      const result = await fn(s, { profileId: automation.profileId, config: automation.config, trigger: 'schedule', actionId: 'daily_discovery' });
      const runs = Array.isArray(result?.runs) ? result.runs : [];
      const totals = runs.reduce((acc, r) => {
        acc.jobsImported += Number(r?.counts?.imported || 0);
        acc.jobsScored += Number(r?.counts?.scored ?? ((r?.counts?.imported || 0) + (r?.counts?.deduped || 0)));
        acc.highFit += Number(r?.counts?.highFit || 0);
        return acc;
      }, { jobsImported: 0, jobsScored: 0, highFit: 0 });
      return {
        outputs: { discovery: result },
        counts: totals,
        derivedStatus: ['succeeded', 'partial', 'failed'].includes(result?.status) ? result.status : 'succeeded'
      };
    }
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
  }
  return {
    outputs: { skipped: true, reason: 'Discovery module is not present in this workspace; daily_discovery is registered as a pluggable scheduler action.' },
    counts: { jobsImported: 0, jobsScored: 0 }
  };
}

function followupWatch(s, automation, { nowDate = new Date() } = {}) {
  const cutoff = nowDate.toISOString();
  const params = [cutoff];
  const profileClause = automation.profileId ? 'AND tasks.profile_id=?' : '';
  if (automation.profileId) params.push(automation.profileId);
  const rows = all(s, `SELECT tasks.*, jobs.title AS job_title, jobs.company AS job_company,
      applications.status AS application_status
    FROM tasks
    LEFT JOIN jobs ON jobs.id=tasks.job_id
    LEFT JOIN applications ON applications.id=tasks.application_id OR applications.job_id=tasks.job_id
    WHERE tasks.status='open'
      AND (tasks.due_at IS NULL OR tasks.due_at<=?)
      ${profileClause}
      AND (lower(tasks.type) LIKE '%follow%' OR lower(tasks.title) LIKE '%follow%' OR lower(tasks.description) LIKE '%follow%')
    ORDER BY tasks.due_at IS NULL, tasks.due_at, tasks.created_at`, params);
  const outputs = [];
  let drafted = 0, suppressed = 0;
  for (const task of rows) {
    if (suppressedFollowupStatuses.has(task.application_status)) {
      suppressed++;
      outputs.push({ taskId: task.id, suppressed: true, reason: `application status is ${task.application_status}` });
      continue;
    }
    const day = today(nowDate);
    const rel = task.job_id
      ? path.join('jobs', task.job_id, 'artifacts', `followup-${task.id}-${day}.md`)
      : path.join('exports', `followup-${task.id}-${day}.md`);
    const title = task.job_title ? `Follow-up draft for ${task.job_title}` : `Follow-up draft: ${task.title}`;
    const content = `# ${title}

**Approval status:** Draft only — not sent.
**Related task:** ${task.title} (${task.id})
**Due:** ${task.due_at || 'No due date'}

## Draft message
Hi,

I wanted to follow up thoughtfully on the item below and keep the next step easy to evaluate:

${task.description || task.title}

If it is useful, I can provide more context or adjust timing.

Thanks,

## Human gate
- JobOS created this follow-up draft only.
- It did not send email, LinkedIn messages, or contact anyone.
- Review the relationship context and application status before using this in an external tool.
`;
    const artifact = insertArtifact(s, {
      jobId: task.job_id || null,
      profileId: task.profile_id || null,
      type: 'followup',
      rel,
      title,
      content,
      evidence: [{ taskId: task.id, dueAt: task.due_at, applicationId: task.application_id || null }],
      warnings: ['Draft only — not sent. Human approval is required before any external outreach.']
    });
    if (artifact.created) drafted++;
    outputs.push({ taskId: task.id, artifactId: artifact.id, path: artifact.path, approvalStatus: artifact.approvalStatus });
  }
  return { outputs: { followups: outputs }, counts: { dueTasks: rows.length, drafted, suppressed } };
}

function staleApplicationCheck(s, automation, { nowDate = new Date() } = {}) {
  const days = Number(automation.config?.stale_days || automation.config?.staleDays || 14);
  const cutoff = new Date(nowDate.getTime() - Math.max(1, days) * 24 * 60 * 60 * 1000).toISOString();
  const statuses = [...ACTIVE_APPLICATION_STATUSES];
  const params = [...statuses];
  const profileClause = automation.profileId ? 'AND applications.profile_id=?' : '';
  if (automation.profileId) params.push(automation.profileId);
  const apps = all(s, `SELECT applications.*, jobs.title, jobs.company
    FROM applications JOIN jobs ON jobs.id=applications.job_id
    WHERE applications.status IN (${statuses.map(() => '?').join(',')})
      ${profileClause}
    ORDER BY applications.updated_at`, params);
  const reconciled = [];
  for (const app of apps) {
    const latestStatus = one(s, `SELECT id,created_at FROM status_changes
      WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT 1`, [app.id]);
    const lastStatus = latestStatus?.created_at || app.updated_at || app.created_at;
    const lastTask = one(s, 'SELECT MAX(updated_at) AS at FROM tasks WHERE application_id=? AND profile_id=?', [app.id, app.profile_id])?.at || null;
    const lastActivity = [lastStatus, lastTask, app.updated_at, app.created_at].filter(Boolean).sort().at(-1);
    if (lastActivity && lastActivity > cutoff) continue;
    const action = reconcileApplicationNextAction(s, {
      applicationId: app.id,
      trigger: {
        schema: LIFECYCLE_EVENT_INPUT_SCHEMA,
        profileId: app.profile_id,
        applicationId: app.id,
        eventId: latestStatus?.id || app.id,
        eventType: latestStatus ? 'application_status_changed' : 'application_created',
        occurredAt: latestStatus?.created_at || app.updated_at || app.created_at,
      },
      nowDate,
    });
    if (!action) continue;
    reconciled.push({ applicationId: app.id, taskId: action.id, lastActivity });
    syncJob(s, app.job_id);
  }
  return {
    outputs: { staleApplications: reconciled, cutoff },
    counts: { checked: apps.length, reviewTasksCreated: 0, reconciled: reconciled.length },
  };
}

function weeklyRetrospective(s, automation) {
  const profiles = profilesFor(s, automation.profileId);
  const reviews = profiles.map(profile => {
    const review = weekly(s, profile.id, { recordRun: false });
    return { profileId: profile.id, path: review.path };
  });
  return { outputs: { reviews }, counts: { reviews: reviews.length } };
}

function morningPriorityBrief(s, automation, { nowDate = new Date() } = {}) {
  const profiles = profilesFor(s, automation.profileId);
  const day = today(nowDate);
  const dueBy = endOfUtcDay(nowDate);
  const briefs = [];
  for (const profile of profiles) {
    const tasks = all(s, `SELECT tasks.*, jobs.title AS job_title, jobs.company AS job_company
      FROM tasks LEFT JOIN jobs ON jobs.id=tasks.job_id
      WHERE tasks.status='open' AND tasks.profile_id=? AND (tasks.due_at IS NULL OR tasks.due_at<=?)
      ORDER BY tasks.due_at IS NULL, tasks.due_at, tasks.priority DESC, tasks.created_at LIMIT 12`, [profile.id, dueBy]);
    const jobs = all(s, `SELECT jobs.*, applications.status AS application_status
      FROM jobs LEFT JOIN applications ON applications.job_id=jobs.id
      WHERE jobs.profile_id=? AND jobs.high_fit=1
        AND COALESCE(jobs.liveness_status,'uncertain')<>'expired' AND (applications.status IS NULL OR applications.status IN ('saved','researching','materials-ready'))
      ORDER BY jobs.created_at DESC`, [profile.id])
      .map(job => ({
        ...job,
        jobId: job.id,
        fit: deserializeFitScore(parseJson(job.score_json, null), {
          persistedOverall: job.fit_score,
          jobId: job.id,
          profileId: job.profile_id
        }),
        postingLiveness: getPostingLiveness(job)
      }))
      .filter(job => qualifiesForHighFit(job.fit, 0))
      .sort(compareFitDecisions)
      .slice(0, 8);
    const interviews = all(s, `SELECT applications.*, jobs.title, jobs.company
      FROM applications JOIN jobs ON jobs.id=applications.job_id
      WHERE applications.profile_id=? AND applications.status='interview'
      ORDER BY applications.updated_at DESC LIMIT 8`, [profile.id]);
    const taskLines = tasks.length ? tasks.map(t => `- ${t.title}${t.due_at ? ` (due ${t.due_at})` : ''}${t.job_title ? ` — ${t.job_title} at ${t.job_company}` : ''}`).join('\n') : '- No due tasks.';
    const jobLines = jobs.length ? jobs.map(job => `- ${job.title} at ${job.company}: ${job.fit.overall}/100 (${job.id})`).join('\n') : '- No high-fit jobs awaiting review.';
    const interviewLines = interviews.length ? interviews.map(i => `- ${i.title} at ${i.company} (${i.id})`).join('\n') : '- No active interview-stage applications.';
    const content = `# Morning priority brief — ${profile.name}

Generated: ${now()}

## Due today / open
${taskLines}

## High-fit review queue
${jobLines}

## Upcoming interviews
${interviewLines}

## Human gate
This brief summarizes local JobOS state only. It did not submit applications, send outreach, scrape private accounts, or perform external actions.
`;
    const rel = path.join('exports', `morning-priority-brief-${profile.id}-${day}.md`);
    writeMd(path.join(s.p.ws, rel), content);
    briefs.push({ profileId: profile.id, path: rel, tasks: tasks.length, highFitJobs: jobs.length, interviews: interviews.length });
  }
  return { outputs: { briefs }, counts: { briefs: briefs.length } };
}

export const actions = {
  daily_discovery: dailyDiscovery,
  followup_watch: followupWatch,
  stale_application_check: staleApplicationCheck,
  weekly_retrospective: weeklyRetrospective,
  morning_priority_brief: morningPriorityBrief
};

export function listActionIds() {
  return Object.keys(actions);
}

export async function runAction(s, automation, options = {}) {
  const action = actions[automation.actionId];
  if (!action) throw Error(`Unknown automation action: ${automation.actionId}`);
  return await action(s, automation, options);
}
