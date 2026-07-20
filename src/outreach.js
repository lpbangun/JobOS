import path from 'node:path';
import { one, all, run, audit, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd, writeYaml } from './workspace.js';
import { getStakeholder } from './research.js';
import { generateJson, llmConfig } from './llm.js';
import { syncJob } from './jobs.js';
import { contactSummaryForPlan } from './research/contacts.js';
import { createArtifact } from './artifacts.js';

const sentChannels = new Set(['email', 'linkedin', 'other']);
const pausedApplicationStatuses = new Set(['interview', 'offer', 'rejected']);

function profileStyle(profile) {
  const prefs = parseJson(profile.preferences_json, {});
  return prefs.communicationStyle || 'concise, specific, and respectful';
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || String(name || 'there');
}

function cleanSentence(value) {
  return String(value || '').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

function isHttpUrl(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function canonicalUrl(raw) {
  try {
    const url = new URL(raw);
    url.hash = '';
    return url.href.replace(/\/$/, '');
  } catch {
    return String(raw || '').replace(/\/$/, '');
  }
}

function sourceUrl(job) {
  return String(job.url || '').startsWith('jobos:text:') ? '' : job.url || '';
}

function rowToThread(row) {
  return row ? {
    id: row.id,
    artifactId: row.artifact_id,
    jobId: row.job_id || null,
    profileId: row.profile_id || null,
    stakeholderId: row.stakeholder_id || null,
    goal: row.goal,
    channel: row.channel || null,
    status: row.status,
    sentAt: row.sent_at || null,
    nextFollowupAt: row.next_followup_at || null,
    followupTaskId: row.followup_task_id || null,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  } : null;
}

export function listOutreachThreads(s, { jobId = null } = {}) {
  const rows = jobId
    ? all(s, 'SELECT * FROM outreach_threads WHERE job_id=? ORDER BY updated_at DESC', [jobId])
    : all(s, 'SELECT * FROM outreach_threads ORDER BY updated_at DESC');
  return rows.map(rowToThread);
}

function syncOutreachThreads(s, jobId) {
  if (!jobId) return;
  const rows = all(s, `SELECT outreach_threads.*, stakeholders.name AS stakeholder_name, stakeholders.role AS stakeholder_role,
      artifacts.path AS artifact_path, artifacts.approval_status AS approval_status,
      tasks.title AS followup_title, tasks.due_at AS followup_due_at, tasks.status AS followup_status
    FROM outreach_threads
    LEFT JOIN stakeholders ON stakeholders.id=outreach_threads.stakeholder_id
    LEFT JOIN artifacts ON artifacts.id=outreach_threads.artifact_id
    LEFT JOIN tasks ON tasks.id=outreach_threads.followup_task_id
    WHERE outreach_threads.job_id=?
    ORDER BY outreach_threads.updated_at DESC`, [jobId]);
  writeYaml(path.join(s.p.jobs, jobId, 'outreach', 'threads.yaml'), {
    version: 1,
    policy: {
      autoSend: 'disabled',
      externalSend: 'user_configured',
      note: 'This module records drafts, sent status, and follow-up tasks. Delivery occurs only through a separately configured and enabled external tool.'
    },
    threads: rows.map(row => ({
      id: row.id,
      artifactId: row.artifact_id,
      artifactPath: row.artifact_path || '',
      approvalStatus: row.approval_status || '',
      stakeholderId: row.stakeholder_id || '',
      stakeholderName: row.stakeholder_name || '',
      stakeholderRole: row.stakeholder_role || '',
      profileId: row.profile_id || '',
      goal: row.goal,
      channel: row.channel || '',
      status: row.status,
      sentAt: row.sent_at || '',
      nextFollowupAt: row.next_followup_at || '',
      followupTaskId: row.followup_task_id || '',
      followupTitle: row.followup_title || '',
      followupDueAt: row.followup_due_at || '',
      followupStatus: row.followup_status || '',
      notes: row.notes || '',
      updatedAt: row.updated_at
    }))
  });
}

function loadCompanyFacts(s, job) {
  const company = one(s, 'SELECT facts_json FROM companies WHERE id=?', [job.company_id]);
  return parseJson(company?.facts_json, [])
    .filter(fact => cleanSentence(fact.claim || fact.snippet || fact.title) && isHttpUrl(fact.url))
    .slice(0, 5)
    .map((fact, index) => ({
      id: `company_fact:${index}`,
      type: 'company_fact',
      label: fact.title || fact.sourceTitle || fact.url,
      summary: cleanSentence(fact.claim || fact.snippet || fact.title),
      sourceUrl: fact.url,
      confidence: fact.confidence || 'medium'
    }));
}

function loadProofs(s, profile) {
  return all(s, 'SELECT * FROM proof_points WHERE profile_id=? ORDER BY created_at LIMIT 6', [profile.id])
    .filter(proof => cleanSentence(proof.summary))
    .map(proof => ({
      id: proof.id,
      type: 'profile_proof',
      label: proof.id,
      summary: cleanSentence(proof.summary),
      source: proof.evidence || proof.source || 'stored proof point'
    }));
}

function rowToContact(row) {
  return row ? {
    id: row.id,
    type: row.type,
    value: row.value,
    evidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    stakeholderId: row.stakeholder_id || null
  } : null;
}

function evidenceContext(s, { job, profile, stakeholder, contact = null }) {
  const stakeholderSource = stakeholder.links[0] || '';
  const stakeholderEvidence = stakeholderSource ? [{
    id: `stakeholder:${stakeholder.id}`,
    type: 'stakeholder',
    label: `${stakeholder.name} source`,
    summary: cleanSentence(stakeholder.summary || `${stakeholder.name} is listed as ${stakeholder.role}`),
    sourceUrl: stakeholderSource
  }] : [];
  const jobEvidence = sourceUrl(job) ? [{
    id: `job:${job.id}`,
    type: 'job',
    label: `${job.title} job post`,
    summary: cleanSentence(`${job.title} at ${job.company}`),
    sourceUrl: sourceUrl(job)
  }] : [];
  const contactEvidence = contact ? [{
    id: `contact:${contact.id}`,
    type: 'contact_point',
    label: `${contact.type} contact`,
    summary: cleanSentence(`Tier ${contact.evidenceTier} ${contact.type} contact; verification status ${contact.verificationStatus}; confidence ${contact.confidence}`),
    source: contact.value
  }] : [];
  const evidence = [
    ...stakeholderEvidence,
    ...contactEvidence,
    ...loadCompanyFacts(s, job),
    ...jobEvidence,
    ...loadProofs(s, profile)
  ];
  const byId = new Map(evidence.map(item => [item.id, item]));
  const byUrl = new Map(evidence.filter(item => item.sourceUrl).map(item => [canonicalUrl(item.sourceUrl), item]));
  return { evidence, byId, byUrl };
}

function normalizeEvidence(rawItems, ctx) {
  const warnings = [];
  const selected = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const idValue = String(raw?.id || raw?.evidenceId || raw?.proofPointId || raw?.stakeholderId || '').trim();
    const urlValue = String(raw?.sourceUrl || raw?.url || '').trim();
    const typedId = raw?.type === 'stakeholder' && idValue && !idValue.startsWith('stakeholder:') ? `stakeholder:${idValue}` : idValue;
    const item = ctx.byId.get(typedId) || ctx.byUrl.get(canonicalUrl(urlValue));
    if (!item) {
      if (idValue || urlValue) warnings.push(`Dropped unsupported outreach evidence reference: ${idValue || urlValue}.`);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    selected.push(item);
  }
  return { evidence: selected, warnings };
}

function defaultEvidence(ctx) {
  const stakeholder = ctx.evidence.find(item => item.type === 'stakeholder');
  const company = ctx.evidence.find(item => item.type === 'company_fact');
  const proof = ctx.evidence.find(item => item.type === 'profile_proof');
  return [stakeholder, company, proof].filter(Boolean);
}

function evidenceLine(item) {
  const source = item.sourceUrl ? item.sourceUrl : item.source;
  return `- ${item.type}: ${item.summary}${source ? `\n  - Source: ${source}` : ''}`;
}

function renderWarnings(warnings) {
  return warnings.length ? `\n## Warnings\n${warnings.map(w => `- ${w}`).join('\n')}\n` : '';
}

function renderQuality(quality) {
  if (!quality || !Object.keys(quality).length) return '- Deterministic fallback draft; review manually before use.';
  return Object.entries(quality).map(([key, value]) => `- ${key}: ${value}`).join('\n');
}

function renderOutreachContent({ job, profile, stakeholder, goal, subject, message, evidence, warnings, quality, mode }) {
  return `# Outreach draft - ${stakeholder.name}

**Approval status:** Draft only - not sent.
**Goal:** ${goal}
**Related job:** ${job.title} at ${job.company}
**Subject:** ${subject}
**Mode:** ${mode}

## Draft message
${message}

## Evidence used
${evidence.length ? evidence.map(evidenceLine).join('\n') : '- No evidence selected; verify manually before using.'}
${renderWarnings(warnings)}
## Quality check
${renderQuality(quality)}

## Style notes
- Tone target: ${profileStyle(profile)}.
- Keep the final message short, specific, and low-pressure.

## Human gate
- JobOS created this draft only.
- It did not send email, LinkedIn messages, or contact anyone.
- Verify every source and relationship context before copying this into an external tool.
`;
}

function askForGoal(goal) {
  return goal === 'referral'
    ? 'whether there is a thoughtful referral path or another appropriate next step'
    : 'whether you would be open to a short learning conversation';
}

function fallbackDraft({ job, profile, stakeholder, goal, ctx }) {
  const selected = defaultEvidence(ctx);
  const stakeholderFact = selected.find(item => item.type === 'stakeholder');
  const companyFact = selected.find(item => item.type === 'company_fact');
  const proof = selected.find(item => item.type === 'profile_proof');
  const style = profileStyle(profile);
  const warm = /\bwarm|friendly|personal\b/i.test(style);
  const concise = /\bconcise|brief|short\b/i.test(style);
  const subject = `${goal === 'referral' ? 'Referral question' : 'Question'} about ${job.company}'s ${job.title} role`;
  const opener = warm ? 'I hope your week is going well. ' : '';
  const stakeholderLine = stakeholderFact
    ? `I saw that ${stakeholderFact.summary}.`
    : `I found your public source while researching the ${job.title} role.`;
  const companyLine = companyFact ? `I also noted ${companyFact.summary}.` : '';
  const proofLine = proof ? `My relevant background includes: ${proof.summary}.` : 'My background appears relevant to the role, and I am trying to understand the team context before taking any next step.';
  const ask = askForGoal(goal);
  const middle = concise
    ? [stakeholderLine, companyLine, proofLine].filter(Boolean).join(' ')
    : [stakeholderLine, companyLine, proofLine, 'I am trying to keep the conversation specific and useful.'].filter(Boolean).join('\n\n');
  const message = `Hi ${firstName(stakeholder.name)},

${opener}I am exploring the ${job.title} role at ${job.company}. ${middle}

If it is appropriate, I would appreciate ${ask}. I am happy to keep it brief.

Thanks,
${profile.name}`;
  return {
    subject,
    message,
    evidence: selected,
    warnings: ['JOBOS LLM is not configured; used deterministic outreach fallback.'],
    quality: { specificity: 'uses stored stakeholder/company/profile evidence when available', toneMatch: style, lengthDiscipline: 'short draft' },
    mode: 'deterministic-degraded'
  };
}

function outreachPrompt({ job, profile, stakeholder, goal, ctx }) {
  return `Draft human-reviewed outreach. Return JSON with subject, message, evidence array, quality object, and warnings array.

Rules:
- Use only ALLOWED_EVIDENCE for factual claims.
- Every company or stakeholder fact used in the message must appear in evidence with its id or sourceUrl.
- Do not claim that JobOS sent or will send anything.
- Keep message under 150 words.
- Match communicationStyle.
- Ask for the goal without pressure.

JOB:
${JSON.stringify({ id: job.id, title: job.title, company: job.company, location: job.location, description: job.description.slice(0, 1600), url: sourceUrl(job) }, null, 2)}

PROFILE:
${JSON.stringify({ id: profile.id, name: profile.name, communicationStyle: profileStyle(profile) }, null, 2)}

STAKEHOLDER:
${JSON.stringify({ id: stakeholder.id, name: stakeholder.name, role: stakeholder.role, summary: stakeholder.summary, sourceUrl: stakeholder.links[0] || '' }, null, 2)}

GOAL:
${goal}

ALLOWED_EVIDENCE:
${JSON.stringify(ctx.evidence, null, 2)}`;
}

async function llmDraft(input, fallback) {
  const cfg = llmConfig();
  if (!cfg.configured) return fallback;
  const { job, profile, stakeholder, goal, ctx } = input;
  try {
    const result = await generateJson({
      schemaName: 'jobos_outreach_draft',
      system: 'You are JobOS outreach drafting. Draft only. Use only allowed evidence. Never send messages or imply external action.',
      user: outreachPrompt({ job, profile, stakeholder, goal, ctx }),
      temperature: 0.2,
      maxTokens: 1800
    });
    if (!result.ok) throw new Error(result.reason || 'LLM unavailable');
    const subject = cleanSentence(result.json?.subject);
    const message = String(result.json?.message || '').trim();
    if (!subject || message.length < 40) throw new Error('LLM returned an incomplete outreach draft');
    const normalized = normalizeEvidence(result.json?.evidence, ctx);
    const selected = normalized.evidence.length ? normalized.evidence : fallback.evidence;
    const warnings = [
      ...normalized.warnings,
      ...(Array.isArray(result.json?.warnings) ? result.json.warnings.map(String) : [])
    ];
    if (!normalized.evidence.length) warnings.push('LLM omitted valid evidence references; retained deterministic evidence selection.');
    return {
      subject,
      message,
      evidence: selected,
      warnings,
      quality: result.json?.quality && typeof result.json.quality === 'object' ? result.json.quality : {},
      mode: result.config?.provider === 'agent' ? 'agent' : 'llm'
    };
  } catch (e) {
    if (e?.type === 'agent_error') throw e;
    return {
      ...fallback,
      warnings: [`LLM outreach draft failed; used deterministic fallback: ${e.message}`, ...fallback.warnings]
    };
  }
}

function baseWarnings({ stakeholder, app, contact = null }) {
  const warnings = ['Draft only - not sent. Human approval is required before any external outreach.'];
  if (!String(stakeholder.summary || '').trim() || !stakeholder.links[0]) warnings.push('Stakeholder source context is missing; verify relevance manually before using this draft.');
  if (app && pausedApplicationStatuses.has(app.status)) warnings.push(`Application status is ${app.status}; pause outreach unless you intentionally approve this follow-up.`);
  if (contact) {
    const contactPlan = contactSummaryForPlan(contact);
    warnings.push(...contactPlan.warnings);
    warnings.push(`Selected contact channel: ${contactPlan.channel}; path strength: ${contactPlan.pathStrength}.`);
  }
  return warnings;
}

function saveOutreachArtifact(s, { job, profile, stakeholder, goal, content, evidence, warnings, subject, mode }) {
  const rel = path.join('jobs', job.id, 'outreach', `${stakeholder.id}-${goal}.md`);
  let threadId = null;
  const artifact = createArtifact(s, {
    jobId: job.id,
    profileId: profile.id,
    type: 'outreach',
    path: rel,
    title: `Outreach draft to ${stakeholder.name}`,
    content,
    evidence,
    warnings,
    series: { kind: 'outreach', stakeholderId: stakeholder.id, goal },
    auditAction: 'outreach.draft.created',
    auditPayload: { stakeholderId: stakeholder.id, goal, subject, mode },
    mutate: (store, created) => {
      const at = created.createdAt;
      threadId = id('thread', `outreach:${created.id}`);
      run(store, 'INSERT INTO outreach_threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [threadId, created.id, job.id, profile.id, stakeholder.id, goal, '', 'drafted', null, null, null, '', at, at]);
    }
  });
  syncOutreachThreads(s, job.id);
  return { ...artifact, threadId, warnings, subject, mode };
}

function resolvePlanAndContact(s, { jobId, profileId, stakeholderId, goal, planId = null, contactId = null }) {
  let selectedPlan = null;
  if (planId) {
    selectedPlan = one(s, 'SELECT * FROM outreach_plans WHERE id=?', [planId]);
    if (!selectedPlan) throw Error(`Unknown outreach plan: ${planId}`);
    jobId = jobId || selectedPlan.job_id;
    profileId = profileId || selectedPlan.profile_id;
    stakeholderId = stakeholderId || selectedPlan.stakeholder_id;
    contactId = contactId || selectedPlan.contact_point_id;
    goal = goal || selectedPlan.goal;
  }
  const contact = contactId ? rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId])) : null;
  if (contactId && !contact) throw Error(`Unknown contact: ${contactId}`);
  if (contact && !stakeholderId && contact.stakeholderId) stakeholderId = contact.stakeholderId;
  if (contact?.doNotUse) throw Error(`Contact ${contact.id} is suppressed and cannot be used for outreach drafts.`);
  if (contact && ['email', 'generic_inbox'].includes(contact.type) && !contact.humanApproved) {
    throw Error(`Contact ${contact.id} is not human-approved. Approve it before drafting email-channel outreach.`);
  }
  return { jobId, profileId, stakeholderId, goal: goal || 'informational', plan: selectedPlan, contact };
}

export async function draftOutreach(s, { jobId, profileId, stakeholderId, goal = 'informational', planId = null, contactId = null }) {
  const resolved = resolvePlanAndContact(s, { jobId, profileId, stakeholderId, goal, planId, contactId });
  jobId = resolved.jobId;
  profileId = resolved.profileId;
  stakeholderId = resolved.stakeholderId;
  goal = resolved.goal;
  const contact = resolved.contact;
  const safeGoal = slug(goal || 'informational');
  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Error(`Profile ${profileId} is not linked to job ${jobId}`);
  if (!stakeholderId) throw Error('Missing --stakeholder or a selected plan/contact linked to a stakeholder.');
  const stakeholder = getStakeholder(s, stakeholderId);
  if (!stakeholder) throw Error(`Unknown stakeholder: ${stakeholderId}`);
  if (!stakeholder.job_id || stakeholder.job_id !== jobId) throw Error(`Stakeholder ${stakeholderId} is not linked to job ${jobId}`);
  const app = one(s, 'SELECT status FROM applications WHERE job_id=? ORDER BY updated_at DESC LIMIT 1', [jobId]);
  const ctx = evidenceContext(s, { job, profile, stakeholder, contact });
  const fallback = fallbackDraft({ job, profile, stakeholder, goal: safeGoal, ctx });
  const drafted = await llmDraft({ job, profile, stakeholder, goal: safeGoal, ctx }, fallback);
  const warnings = [...baseWarnings({ stakeholder, app, contact }), ...drafted.warnings];
  const content = renderOutreachContent({ job, profile, stakeholder, goal: safeGoal, ...drafted, warnings });
  return saveOutreachArtifact(s, { job, profile, stakeholder, goal: safeGoal, content, evidence: drafted.evidence, warnings, subject: drafted.subject, mode: drafted.mode });
}

export function markOutreachSent(s, { artifactId, channel, notes = '' }) {
  const safeChannel = String(channel || '').toLowerCase();
  if (!sentChannels.has(safeChannel)) throw Error('Missing or invalid --channel; use email, linkedin, or other.');
  const artifact = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!artifact) throw Error(`Unknown artifact: ${artifactId}`);
  const thread = one(s, 'SELECT * FROM outreach_threads WHERE artifact_id=?', [artifactId]);
  if (!thread) throw Error(`No outreach thread found for artifact: ${artifactId}`);
  const at = now();
  run(s, 'UPDATE outreach_threads SET channel=?, status=?, sent_at=?, notes=?, updated_at=? WHERE id=?', [safeChannel, 'sent_by_human', at, notes || thread.notes || '', at, thread.id]);
  if (thread.stakeholder_id) run(s, 'UPDATE stakeholders SET outreach_status=?, updated_at=? WHERE id=?', ['contacted', at, thread.stakeholder_id]);
  audit(s, 'outreach.mark_sent.recorded', 'outreach_thread', thread.id, { jobId: thread.job_id, artifactId, channel: safeChannel, humanSent: true });
  syncOutreachThreads(s, thread.job_id);
  if (thread.job_id) syncJob(s, thread.job_id);
  save(s);
  return { ...rowToThread(one(s, 'SELECT * FROM outreach_threads WHERE id=?', [thread.id])), note: 'Recorded that the human sent outreach; JobOS did not send or contact anyone.' };
}

export function scheduleFollowup(s, { threadId, afterDays }) {
  const days = Number(afterDays);
  if (!Number.isFinite(days) || days < 0) throw Error('Missing or invalid --after <days>');
  const thread = one(s, 'SELECT * FROM outreach_threads WHERE id=?', [threadId]);
  if (!thread) throw Error(`Unknown outreach thread: ${threadId}`);
  const artifact = one(s, 'SELECT * FROM artifacts WHERE id=?', [thread.artifact_id]);
  const stakeholder = thread.stakeholder_id ? one(s, 'SELECT * FROM stakeholders WHERE id=?', [thread.stakeholder_id]) : null;
  const at = now();
  const due = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  const taskId = thread.followup_task_id || id('task', `outreach-followup:${thread.id}:${due}`);
  const title = `Follow up on outreach to ${stakeholder?.name || 'stakeholder'}`;
  const description = `Human-recorded outreach thread ${thread.id}. Draft or review a follow-up for ${artifact?.title || 'the outreach draft'}. JobOS must not send it automatically.`;
  if (thread.followup_task_id && one(s, 'SELECT id FROM tasks WHERE id=?', [thread.followup_task_id])) {
    run(s, 'UPDATE tasks SET title=?, description=?, due_at=?, priority=?, status=?, updated_at=? WHERE id=?', [title, description, due, 'normal', 'open', at, thread.followup_task_id]);
  } else {
    run(s, 'INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [taskId, thread.job_id || null, null, title, description, 'followup', due, 'normal', 'open', 'outreach', at, at]);
  }
  run(s, 'UPDATE outreach_threads SET status=?, next_followup_at=?, followup_task_id=?, updated_at=? WHERE id=?', ['followup_scheduled', due, taskId, at, thread.id]);
  audit(s, 'outreach.followup_scheduled', 'outreach_thread', thread.id, { jobId: thread.job_id, taskId, dueAt: due });
  syncOutreachThreads(s, thread.job_id);
  if (thread.job_id) syncJob(s, thread.job_id);
  save(s);
  return { ...rowToThread(one(s, 'SELECT * FROM outreach_threads WHERE id=?', [thread.id])), taskId, dueAt: due, note: 'Follow-up task created locally; no message was sent.' };
}

export function outreachDue(s, { nowDate = new Date() } = {}) {
  return all(s, `SELECT outreach_threads.*, tasks.title AS task_title, tasks.due_at AS task_due_at, tasks.status AS task_status,
      stakeholders.name AS stakeholder_name, jobs.title AS job_title, jobs.company AS job_company
    FROM outreach_threads
    JOIN tasks ON tasks.id=outreach_threads.followup_task_id
    LEFT JOIN stakeholders ON stakeholders.id=outreach_threads.stakeholder_id
    LEFT JOIN jobs ON jobs.id=outreach_threads.job_id
    WHERE tasks.status='open' AND (tasks.due_at IS NULL OR tasks.due_at<=?)
    ORDER BY tasks.due_at IS NULL, tasks.due_at, tasks.created_at`, [nowDate.toISOString()]).map(row => ({
    threadId: row.id,
    artifactId: row.artifact_id,
    jobId: row.job_id || null,
    jobTitle: row.job_title || '',
    company: row.job_company || '',
    stakeholderId: row.stakeholder_id || null,
    stakeholderName: row.stakeholder_name || '',
    taskId: row.followup_task_id,
    title: row.task_title,
    dueAt: row.task_due_at,
    status: row.task_status,
    channel: row.channel || null,
    sentAt: row.sent_at || null,
    note: 'Due follow-up is a local reminder only; JobOS does not send outreach.'
  }));
}
