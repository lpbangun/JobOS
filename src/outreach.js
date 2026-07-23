import path from 'node:path';
import { one, all, run, audit, save } from './db.js';
import { id, now, parseJson, slug } from './utils.js';
import { writeMd, writeYaml } from './workspace.js';
import { getStakeholder } from './research.js';
import { generateJson, llmConfig } from './llm.js';
import { syncJob } from './jobs.js';
import { contactSummaryForPlan, projectContactConfidenceV2 } from './research/contacts.js';
import { createArtifact } from './artifacts.js';

const sentChannels = new Set(['email', 'linkedin', 'other']);
const pausedApplicationStatuses = new Set(['interview', 'offer', 'rejected']);
const providerRejectionCodes = new Set([
  'provider_unavailable',
  'unsupported_evidence',
  'missing_evidence',
  'strategy_mismatch',
  'prose_mismatch',
  'provider_error',
]);

function providerSelectionRejection(code) {
  return Object.assign(new Error('Provider outreach selection rejected.'), {
    code,
    providerSelectionRejection: true,
  });
}

function providerFallbackWarning(error) {
  const code = error?.providerSelectionRejection && providerRejectionCodes.has(error.code)
    ? error.code
    : 'provider_error';
  return `Provider outreach selection was rejected (${code}); used deterministic fallback.`;
}

function outreachValidationError(code, message) {
  return Object.assign(new Error(message), { code, type: 'validation' });
}
export const STAKEHOLDER_STRATEGIES = Object.freeze({
  recruiter_talent: Object.freeze({
    class: 'recruiter_talent',
    framing: 'Clarify the role process, current team need, and evidence-backed fit without offering peer-style product critique.',
    ask: 'clarify the current team need, hiring process, or the fit signals the team values',
    warning: null
  }),
  hiring_manager: Object.freeze({
    class: 'hiring_manager',
    framing: 'Connect one stored proof to the role and ask about the concrete team problem or priority.',
    ask: 'share which team problem is most important for this role and whether a brief role-specific conversation would be useful',
    warning: null
  }),
  functional_peer: Object.freeze({
    class: 'functional_peer',
    framing: 'Ask a workflow and team-learning question; do not demand a referral or imply hiring authority.',
    ask: 'share one perspective on the team workflow or what the group is learning',
    warning: null
  }),
  executive_founder: Object.freeze({
    class: 'executive_founder',
    framing: 'Use concise mission and problem relevance without presuming operational detail.',
    ask: 'share whether this mission or problem framing is relevant and, if so, the right person for a brief conversation',
    warning: null
  }),
  investor_advisor: Object.freeze({
    class: 'investor_advisor',
    framing: 'Ask an ecosystem-learning or routing question without implying employment authority.',
    ask: 'share an ecosystem perspective or route this question to a more relevant public contact',
    warning: 'This stakeholder may not have employment authority; keep the ask to ecosystem learning or routing.'
  }),
  public_expert: Object.freeze({
    class: 'public_expert',
    framing: 'Ask for public-domain learning or routing without implying employment authority.',
    ask: 'share a public-domain perspective or suggest a more relevant source for learning',
    warning: 'This stakeholder is classified as a public expert, not an employment decision-maker.'
  }),
  unknown: Object.freeze({
    class: 'unknown',
    framing: 'Use a conservative informational ask and explicitly verify that the outreach is relevant.',
    ask: 'confirm whether this informational question is relevant to you or point me to a more appropriate public source',
    warning: 'Stakeholder relevance is unknown; verify relevance before using this draft.'
  })
});

export function classifyStakeholder(stakeholder = {}) {
  const role = String(stakeholder.role || '').trim().toLowerCase();
  if (/recruit|talent|people partner|people operations|\bhr\b/.test(role)) return 'recruiter_talent';
  if (/founder|co-founder|chief|\bceo\b|\bcto\b|\bcpo\b|\bcoo\b|vice president|\bvp\b/.test(role)) return 'executive_founder';
  if (/investor|advisor|venture partner|board member/.test(role)) return 'investor_advisor';
  if (/hiring manager|head of|director|group manager|senior manager|team lead|engineering manager|product lead/.test(role)) return 'hiring_manager';
  if (/product|engineer|engineering|design|research|data|operations|marketing|sales|customer success|program manager/.test(role)) return 'functional_peer';
  if (/professor|academic|journalist|author|analyst|public expert|community leader/.test(role)) return 'public_expert';
  return 'unknown';
}

export function strategyForStakeholder(stakeholder = {}) {
  return STAKEHOLDER_STRATEGIES[classifyStakeholder(stakeholder)];
}

function profileStyle(profile) {
  const prefs = parseJson(profile.preferences_json, {});
  return prefs.communicationStyle || 'concise, specific, and respectful';
}
function profileApproach(profile) {
  const style = profileStyle(profile).toLowerCase();
  if (/\bwarm\b/.test(style)) return 'curiosity-led, relationship-conscious';
  if (/\bdirect\b|\bmetrics\b/.test(style)) return 'execution-focused, decision-oriented';
  if (/\bthoughtful\b|\bcollaborative\b/.test(style)) return 'context-seeking, collaboration-aware';
  return 'concise, evidence-led';
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
    contactPointId: row.contact_point_id || null,
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
      contactPointId: row.contact_point_id || '',
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
  return all(s, `SELECT * FROM proof_points
    WHERE profile_id=? AND status='active' AND verification_status='verified'
    ORDER BY created_at,id LIMIT 6`, [profile.id])
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
    personId: row.person_id || null,
    type: row.type,
    value: row.value,
    evidenceTier: row.evidence_tier,
    rawEvidenceTier: row.evidence_tier,
    verificationStatus: row.verification_status,
    confidence: row.confidence,
    sourceObservationIds: parseJson(row.source_observation_ids_json, []),
    checks: parseJson(row.checks_json, {}),
    humanApproved: Boolean(row.human_approved),
    doNotUse: Boolean(row.do_not_use),
    stakeholderId: row.stakeholder_id || null,
    companyId: row.company_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
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
  const jobEvidence = [{
    id: `job:${job.id}`,
    type: 'job',
    label: `${job.title} job record`,
    summary: cleanSentence(`${job.title} at ${job.company}`),
    ...(sourceUrl(job) ? { sourceUrl: sourceUrl(job) } : { source: `stored job record ${job.id}` })
  }];
  const contactEvidence = contact ? [{
    id: `contact:${contact.id}`,
    type: 'contact_point',
    label: `${contact.type} contact`,
    summary: cleanSentence(`Tier ${contact.evidenceTier} ${contact.type} contact; ${contact.tierReason || contact.verificationStatus}; outreach readiness ${contact.usable ? 'usable' : 'not usable'}`),
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
  let hasUnsupportedReferences = false;
  const selected = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const idValue = String(raw?.id || raw?.evidenceId || raw?.proofPointId || raw?.stakeholderId || '').trim();
    const urlValue = String(raw?.sourceUrl || raw?.url || '').trim();
    const typedId = raw?.type === 'stakeholder' && idValue && !idValue.startsWith('stakeholder:') ? `stakeholder:${idValue}` : idValue;
    const item = ctx.byId.get(typedId) || ctx.byUrl.get(canonicalUrl(urlValue));
    if (!item) {
      if (idValue || urlValue) hasUnsupportedReferences = true;
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    selected.push(item);
  }
  return { evidence: selected, hasUnsupportedReferences };
}

function defaultEvidence(ctx) {
  const job = ctx.evidence.find(item => item.type === 'job');
  const stakeholder = ctx.evidence.find(item => item.type === 'stakeholder');
  const company = ctx.evidence.find(item => item.type === 'company_fact');
  const proof = ctx.evidence.find(item => item.type === 'profile_proof');
  return [job, stakeholder, company, proof].filter(Boolean);
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

function renderOutreachContent({ job, profile, stakeholder, stakeholderClass, strategy, selectedContactPath, goal, subject, message, evidence, warnings, quality, mode }) {
  return `# Outreach draft - ${stakeholder.name}

**Approval status:** Draft only - not sent.
**Goal:** ${goal}
**Related job:** ${job.title} at ${job.company} (${job.id}; company ${job.company_id})
**Stakeholder class / strategy / selected path:** ${stakeholderClass} / ${strategy.class} / ${selectedContactPath.channel}:${selectedContactPath.pathStrength} (${stakeholder.id})
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
- Tone target for ${profile.id}: ${profileStyle(profile)}; approach: ${profileApproach(profile)}.
- Keep the final message short, specific, and low-pressure.

## Human gate
- JobOS created this draft only.
- It did not send email, LinkedIn messages, or contact anyone.
- Verify every source and relationship context before copying this into an external tool.
`;
}

function fallbackDraft({
  job,
  profile,
  stakeholder,
  goal,
  ctx,
  strategy,
  selectedEvidence = null,
  mode = 'deterministic-degraded',
  warnings: additionalWarnings = [],
}) {
  const selected = selectedEvidence?.length ? selectedEvidence : defaultEvidence(ctx);
  const stakeholderFact = selected.find(item => item.type === 'stakeholder');
  const companyFact = selected.find(item => item.type === 'company_fact');
  const proof = selected.find(item => item.type === 'profile_proof');
  const style = profileStyle(profile);
  const warm = /\bwarm|friendly|personal\b/i.test(style);
  const concise = /\bconcise|brief|short\b/i.test(style);
  const subject = `${strategy.class.replace(/_/g, ' ')} question about ${job.company}`;
  const opener = warm ? 'I hope your week is going well. ' : '';
  const stakeholderLine = stakeholderFact ? `I saw that ${stakeholderFact.summary}.` : '';
  const companyLine = companyFact ? `I noted the source-backed company context that ${companyFact.summary}.` : '';
  const proofLine = proof ? `One relevant proof from my background: ${proof.summary}.` : 'I do not have a stored proof selected for this note, so I would keep any background claim out until it is verified.';
  const styleLine = /\bdirect\b|\bmetrics\b/i.test(style)
    ? 'I will keep this brief and focus on source-backed relevance.'
    : /\bthoughtful\b|\bcollaborative\b/i.test(style)
      ? 'I am comparing the role with where I can contribute thoughtfully.'
      : 'I am approaching this with specific, evidence-grounded curiosity.';
  const goalLine = goal === 'referral'
    ? 'I would not presume a referral; my goal is to understand fit and the appropriate routing.'
    : goal === 'informational'
      ? 'My goal is a short learning conversation grounded in public context.'
      : 'My goal is a low-pressure, source-grounded question.';
  const roleLine = {
    recruiter_talent: 'I am trying to understand the current team need, the hiring process, and which fit evidence matters most.',
    hiring_manager: 'I am trying to understand the concrete team problem, role-specific priorities, and where evidence-backed experience could help.',
    functional_peer: 'I am interested in the team workflow and what peers are learning about this work.',
    executive_founder: 'I am keeping this concise and focused on the company mission and the problem this role may help address.',
    investor_advisor: 'I am looking for ecosystem learning or routing, not an employment decision.',
    public_expert: 'I am looking for a public-domain learning perspective or a more relevant source.',
    unknown: 'I am making a conservative informational inquiry and want to verify that this is relevant to you.',
  }[strategy.class];
  const middle = concise
    ? [stakeholderLine, companyLine, proofLine, styleLine, goalLine, roleLine].filter(Boolean).join(' ')
    : [stakeholderLine, companyLine, proofLine, styleLine, goalLine, roleLine].filter(Boolean).join('\n\n');
  const message = `Hi ${firstName(stakeholder.name)},

${opener}I am exploring the ${job.title} role at ${job.company}. ${middle}

If appropriate, would you be open to ${strategy.ask}? I am happy to keep it brief.

Thanks,
${profile.name}`;
  const modeWarning = mode === 'llm-selection'
    ? 'Provider-selected allowed evidence was rendered with deterministic canonical prose; provider-authored prose was not persisted.'
    : 'JOBOS LLM is not configured; used deterministic outreach fallback.';
  return {
    subject,
    message,
    evidence: selected,
    warnings: [...additionalWarnings, modeWarning, ...(strategy.warning ? [strategy.warning] : [])],
    quality: {
      specificity: 'uses only stored job, stakeholder, company, and active verified proof evidence',
      roleStrategy: strategy.class,
      toneMatch: style,
      lengthDiscipline: 'short draft',
      rendering: 'deterministic canonical prose',
    },
    mode,
  };
}

function outreachPrompt({ job, profile, stakeholder, goal, ctx, strategy }) {
  return `Select evidence for a human-reviewed outreach draft. Return JSON with strategyClass and a non-empty evidence array. Do not author subject or message prose.

Rules:
- Select only references present in ALLOWED_EVIDENCE.
- Use the supplied ROLE_STRATEGY class; do not substitute a different-role strategy.
- Do not claim that JobOS sent or will send anything.
- JobOS will render all final prose deterministically from canonical evidence and strategy.

ROLE_STRATEGY:
${JSON.stringify(strategy, null, 2)}

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
  const { job, profile, stakeholder, goal, ctx, strategy } = input;
  try {
    const result = await generateJson({
      schemaName: 'jobos_outreach_draft',
      system: 'You are JobOS outreach evidence selection. Select only allowed evidence. Never send messages or imply external action. Do not author final prose.',
      user: outreachPrompt({ job, profile, stakeholder, goal, ctx, strategy }),
      temperature: 0.2,
      maxTokens: 900,
    });
    if (!result.ok) throw providerSelectionRejection('provider_unavailable');
    const normalized = normalizeEvidence(result.json?.evidence, ctx);
    if (normalized.hasUnsupportedReferences) throw providerSelectionRejection('unsupported_evidence');
    if (!normalized.evidence.length) throw providerSelectionRejection('missing_evidence');
    const strategyClass = String(result.json?.strategyClass || '').trim();
    if (strategyClass !== strategy.class) throw providerSelectionRejection('strategy_mismatch');
    const canonical = fallbackDraft({
      ...input,
      selectedEvidence: normalized.evidence,
      mode: 'llm-selection',
    });
    const providerSubject = cleanSentence(result.json?.subject);
    const providerMessage = String(result.json?.message || '').trim();
    if ((providerSubject && providerSubject !== canonical.subject) || (providerMessage && providerMessage !== canonical.message)) {
      throw providerSelectionRejection('prose_mismatch');
    }
    return canonical;
  } catch (e) {
    return {
      ...fallback,
      warnings: [providerFallbackWarning(e), ...fallback.warnings],
    };
  }
}

function baseWarnings({ stakeholder, strategy, app, contact = null, selectedContactPath }) {
  const warnings = ['Draft only - not sent. Human approval is required before any external outreach.'];
  if (strategy.warning) warnings.push(strategy.warning);
  if (!String(stakeholder.summary || '').trim() || !stakeholder.links[0]) warnings.push('Stakeholder source context is missing; verify relevance manually before using this draft.');
  if (app && pausedApplicationStatuses.has(app.status)) warnings.push(`Application status is ${app.status}; pause outreach unless you intentionally approve this follow-up.`);
  if (contact) {
    warnings.push(...(contact.contactConfidence?.warnings || []));
    warnings.push(`Selected contact channel: ${selectedContactPath.channel}; path strength: ${selectedContactPath.pathStrength}.`);
  }
  return [...new Set(warnings)];
}

function saveOutreachArtifact(s, { job, profile, stakeholder, contact, stakeholderClass, strategy, selectedContactPath, goal, content, evidence, warnings, subject, mode }) {
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
    auditPayload: { stakeholderId: stakeholder.id, contactPointId: contact?.id || null, stakeholderClass, strategy, selectedContactPath, goal, subject, mode },
    mutate: (store, created) => {
      const at = created.createdAt;
      threadId = id('thread', `outreach:${created.id}`);
      run(store, `INSERT INTO outreach_threads
        (id,artifact_id,job_id,profile_id,stakeholder_id,contact_point_id,goal,channel,status,sent_at,next_followup_at,followup_task_id,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [threadId, created.id, job.id, profile.id, stakeholder.id, contact?.id || null, goal, '', 'drafted', null, null, null, '', at, at]);
    }
  });
  syncOutreachThreads(s, job.id);
  return { ...artifact, threadId, warnings, subject, mode, stakeholderClass, strategy, selectedContactPath };
}

function resolvePlanAndContact(s, { jobId, profileId, stakeholderId, goal, planId = null, contactId = null }) {
  const caller = { jobId, profileId, stakeholderId, goal, contactId };
  let selectedPlan = null;
  if (planId) {
    selectedPlan = one(s, 'SELECT * FROM outreach_plans WHERE id=?', [planId]);
    if (!selectedPlan) throw Error(`Unknown outreach plan: ${planId}`);
    const planValues = {
      jobId: selectedPlan.job_id,
      profileId: selectedPlan.profile_id,
      stakeholderId: selectedPlan.stakeholder_id,
      goal: selectedPlan.goal,
      contactId: selectedPlan.contact_point_id,
    };
    for (const field of ['jobId', 'profileId', 'stakeholderId']) {
      if (!planValues[field]) throw Error(`Outreach plan ${planId} is missing required ${field}.`);
      if (caller[field] && caller[field] !== planValues[field]) {
        throw Error(`Outreach plan ${planId} ${field} ${planValues[field]} does not match caller ${field} ${caller[field]}.`);
      }
    }
    if (caller.goal && slug(caller.goal) !== slug(planValues.goal)) {
      throw Error(`Outreach plan ${planId} goal ${planValues.goal} does not match caller goal ${caller.goal}.`);
    }
    if (caller.contactId && caller.contactId !== planValues.contactId) {
      throw Error(`Outreach plan ${planId} contactId ${planValues.contactId || 'none'} does not match caller contactId ${caller.contactId}.`);
    }
    jobId = planValues.jobId;
    profileId = planValues.profileId;
    stakeholderId = planValues.stakeholderId;
    goal = planValues.goal;
    contactId = planValues.contactId || null;
  }
  goal = goal || 'informational';

  const job = one(s, 'SELECT * FROM jobs WHERE id=?', [jobId]);
  if (!job) throw Error(`Unknown job: ${jobId}`);
  const profile = one(s, 'SELECT * FROM profiles WHERE id=?', [profileId]);
  if (!profile) throw Error(`Unknown profile: ${profileId}`);
  if (job.profile_id !== profileId) throw Error(`Profile ${profileId} is not linked to job ${jobId}`);
  if (!stakeholderId) throw Error('Missing --stakeholder or a selected plan/contact linked to a stakeholder.');
  const stakeholder = getStakeholder(s, stakeholderId);
  if (!stakeholder) throw Error(`Unknown stakeholder: ${stakeholderId}`);
  if (!stakeholder.job_id || stakeholder.job_id !== jobId) throw Error(`Stakeholder ${stakeholderId} is not linked to job ${jobId}`);
  if (selectedPlan && (selectedPlan.profile_id !== profile.id
    || selectedPlan.job_id !== job.id
    || selectedPlan.stakeholder_id !== stakeholder.id
    || slug(selectedPlan.goal) !== slug(goal))) {
    throw Error(`Outreach plan ${planId} is not strictly bound to the resolved profile, job, stakeholder, and goal.`);
  }

  const rawContact = contactId ? rowToContact(one(s, 'SELECT * FROM contact_points WHERE id=?', [contactId])) : null;
  if (contactId && !rawContact) throw Error(`Unknown contact: ${contactId}`);
  const contactConfidence = rawContact ? projectContactConfidenceV2(s, rawContact) : null;
  const contact = rawContact ? {
    ...rawContact,
    rawEvidenceTier: rawContact.evidenceTier,
    evidenceTier: contactConfidence.evidenceTier,
    tierReason: contactConfidence.tierReason,
    contactConfidence,
    usable: contactConfidence.usable,
    usabilityReason: contactConfidence.usabilityReason,
    warnings: contactConfidence.warnings,
  } : null;
  if (contact) {
    if (contact.companyId !== job.company_id) {
      throw Error(`Contact ${contact.id} belongs to company ${contact.companyId || 'unknown'}, not job company ${job.company_id}.`);
    }
    if (contact.type === 'generic_inbox') {
      throw outreachValidationError(
        'outreach_person_target_generic_inbox',
        `Generic company inbox ${contact.id} cannot be used in a person-targeted outreach draft.`,
      );
    } else {
      if (contact.stakeholderId && contact.stakeholderId !== stakeholder.id) {
        throw Error(`Contact ${contact.id} is linked to stakeholder ${contact.stakeholderId}, not stakeholder ${stakeholder.id}.`);
      }
      if (contact.personId && contact.personId !== stakeholder.person_id) {
        throw Error(`Contact ${contact.id} is linked to person ${contact.personId}, not stakeholder ${stakeholder.id}'s person.`);
      }
      const directAssociation = Boolean(contact.stakeholderId || contact.personId);
      const profileRouteMatch = contact.type === 'profile_url'
        && stakeholder.links.some(link => canonicalUrl(link) === canonicalUrl(contact.value));
      if (!directAssociation && !profileRouteMatch) {
        throw Error(`Contact ${contact.id} is not associated with stakeholder ${stakeholder.id} or the stakeholder's person.`);
      }
    }
    if (contact.doNotUse) throw Error(`Contact ${contact.id} is suppressed and cannot be used for outreach drafts.`);
    if (['email', 'generic_inbox'].includes(contact.type) && !contact.humanApproved) {
      throw Error(`Contact ${contact.id} is not human-approved. Approve it before drafting email-channel outreach.`);
    }
    if (!contact.usable) {
      throw Error(`Contact ${contact.id} is not outreach-ready: ${contact.usabilityReason}`);
    }
  }
  if (selectedPlan && selectedPlan.contact_point_id !== (contact?.id || null)) {
    throw Error(`Outreach plan ${planId} selected contact does not match the resolved contact.`);
  }
  return { job, profile, stakeholder, goal, plan: selectedPlan, contact };
}

export async function draftOutreach(s, { jobId, profileId, stakeholderId, goal = null, planId = null, contactId = null }) {
  const resolved = resolvePlanAndContact(s, { jobId, profileId, stakeholderId, goal, planId, contactId });
  const { job, profile, stakeholder, contact } = resolved;
  const safeGoal = slug(resolved.goal || 'informational');
  const app = one(s, 'SELECT status FROM applications WHERE job_id=? ORDER BY updated_at DESC LIMIT 1', [job.id]);
  const stakeholderClass = classifyStakeholder(stakeholder);
  const strategy = STAKEHOLDER_STRATEGIES[stakeholderClass];
  const selectedContactPath = contact
    ? contactSummaryForPlan(contact)
    : resolved.plan
      ? { channel: resolved.plan.channel, pathStrength: resolved.plan.path_strength, warnings: parseJson(resolved.plan.warnings_json, []) }
      : { channel: stakeholder.links[0] ? 'public_source_manual' : 'no_contact_selected', pathStrength: stakeholder.links[0] ? 'manual' : 'unknown', warnings: [] };
  const ctx = evidenceContext(s, { job, profile, stakeholder, contact });
  const fallback = fallbackDraft({ job, profile, stakeholder, goal: safeGoal, ctx, strategy });
  const drafted = await llmDraft({ job, profile, stakeholder, goal: safeGoal, ctx, strategy }, fallback);
  const warnings = [...new Set([...baseWarnings({ stakeholder, strategy, app, contact, selectedContactPath }), ...selectedContactPath.warnings, ...drafted.warnings])];
  const content = renderOutreachContent({ job, profile, stakeholder, stakeholderClass, strategy, selectedContactPath, goal: safeGoal, ...drafted, warnings });
  return saveOutreachArtifact(s, { job, profile, stakeholder, contact, stakeholderClass, strategy, selectedContactPath, goal: safeGoal, content, evidence: drafted.evidence, warnings, subject: drafted.subject, mode: drafted.mode });
}

export function markOutreachSent(s, { artifactId, channel, notes = '' }) {
  const safeChannel = String(channel || '').toLowerCase();
  if (!sentChannels.has(safeChannel)) throw Error('Missing or invalid --channel; use email, linkedin, or other.');
  const artifact = one(s, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
  if (!artifact) throw Error(`Unknown artifact: ${artifactId}`);
  const thread = one(s, 'SELECT * FROM outreach_threads WHERE artifact_id=?', [artifactId]);
  if (!thread) throw Error(`No outreach thread found for artifact: ${artifactId}`);
  if (thread.sent_at) {
    const frozenChannel = String(thread.channel || '').toLowerCase();
    if (frozenChannel !== safeChannel) {
      throw outreachValidationError(
        'outreach_sent_channel_mismatch',
        `Outreach thread ${thread.id} was already recorded as sent via ${frozenChannel || 'unknown'}; channel cannot be changed to ${safeChannel}.`,
      );
    }
    return {
      ...rowToThread(thread),
      idempotent: true,
      note: 'Human-sent outreach was already recorded; the original timestamp and channel were preserved. JobOS did not send or contact anyone.',
    };
  }
  const at = now();
  run(s, 'UPDATE outreach_threads SET channel=?, status=?, sent_at=?, notes=?, updated_at=? WHERE id=?', [safeChannel, 'sent_by_human', at, notes || thread.notes || '', at, thread.id]);
  if (thread.stakeholder_id) run(s, 'UPDATE stakeholders SET outreach_status=?, updated_at=? WHERE id=?', ['contacted', at, thread.stakeholder_id]);
  audit(s, 'outreach.mark_sent.recorded', 'outreach_thread', thread.id, { jobId: thread.job_id, artifactId, channel: safeChannel, humanSent: true });
  syncOutreachThreads(s, thread.job_id);
  if (thread.job_id) syncJob(s, thread.job_id);
  save(s);
  return {
    ...rowToThread(one(s, 'SELECT * FROM outreach_threads WHERE id=?', [thread.id])),
    idempotent: false,
    note: 'Recorded that the human sent outreach; JobOS did not send or contact anyone.',
  };
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
    WHERE tasks.status='open' AND tasks.due_at IS NOT NULL AND tasks.due_at<=?
    ORDER BY tasks.due_at, tasks.created_at`, [nowDate.toISOString()]).map(row => ({
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
    note: 'Enriched view of a due outreach follow-up task; this local reminder does not send outreach.'
  }));
}
