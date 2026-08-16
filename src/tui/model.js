/**
 * Pure derivations over the REAL buildTuiModel projection and the locked TUI
 * state vocabulary. No fixtures, no invented jobs/companies/people, no writes.
 * Everything here is deterministic from (model, state).
 */

export const ACTIVE_APPLICATION_STATUSES = Object.freeze([
  'saved',
  'researching',
  'materials-ready',
  'applied',
  'recruiter-screen',
  'interview',
  'offer'
]);

/** Friendly labels for onboarding step ids (locked IA copy). */
export const SETUP_STEP_LABELS = Object.freeze({
  workspace: 'Workspace ready',
  profile: 'About you',
  resume: 'Your resume',
  proofs: 'Validate experience highlights',
  intake: 'Add a job you like',
  decision: 'Check the fit',
  materials: 'Application drafts',
  source: 'Job discovery',
  calibration: 'Your preferences',
  provider: 'AI assistant',
  browser: 'Web applications',
  network: 'Connections'
});

export const SETUP_SUB_OVERLAYS = Object.freeze({
  resume: 'setup-resume-source',
  proofs: 'setup-proof-review',
  intake: 'setup-job-source'
});

/** Locked slash catalog (IA: menu sits above the prompt, filters as you type). */
export const SLASH_CATALOG = Object.freeze([
  { id: 'create-files', label: '/create-files', hint: 'Draft resume + questions from proofs' },
  { id: 'find-people', label: '/find-people', hint: 'Stage people for this job or profile' },
  { id: 'network', label: '/network', hint: 'Network · profile graph' },
  { id: 'tracker', label: '/tracker', hint: 'This-job status / packet / attest' },
  { id: 'review', label: '/review', hint: 'This morning · due + NEXT UP' },
  { id: 'daily', label: '/daily', hint: 'New roles on the left' },
  { id: 'chat', label: '/chat', hint: 'Chat this job' },
  { id: 'jobs', label: '/jobs', hint: 'Back to the board' },
  { id: 'workspace', label: '/workspace', hint: 'Workspace · the whole search' },
  { id: 'memory', label: '/memory', hint: 'Career memory overlay' },
  { id: 'setup', label: '/setup', hint: 'Guided setup · 7 essential steps' }
]);

/** Real resume-source choices (same copy the old setup presented). */
export const RESUME_SOURCE_CHOICES = Object.freeze([
  { id: 'paste', label: 'Paste resume text', detail: 'Best for copying from any document.' },
  { id: 'browse', label: 'Browse this computer', detail: 'Choose PDF, DOCX, TXT, Markdown, JSON, or YAML.' },
  { id: 'path', label: 'Enter a file path', detail: 'Use a full or relative path.' }
]);

/** Real job-source choices (same copy the old setup presented). */
export const JOB_SOURCE_CHOICES = Object.freeze([
  { id: 'paste', label: 'Paste a job description', detail: 'Copy the complete posting text.' },
  { id: 'url', label: 'Import a job URL', detail: 'JobOS fetches the page you choose.' },
  { id: 'browse', label: 'Browse this computer', detail: 'Choose a TXT or Markdown file.' },
  { id: 'path', label: 'Enter a file path', detail: 'Use a full or relative path.' }
]);

/** User-facing FIT chip. Never says "unscored/unknown" when a score contract exists. */
export function fitLabel(fit) {
  if (!fit) return 'unscored';
  if (fit.contract === 'legacy_unversioned') {
    return fit.overall == null ? 'legacy unknown' : `legacy ${fit.overall}/100`;
  }
  const status = String(fit.scoreStatus || '').trim();
  const coverage = Number.isFinite(Number(fit.evidenceCoverage)) ? Number(fit.evidenceCoverage) : null;
  if (fit.overall == null) {
    if (status === 'insufficient_evidence') {
      return coverage == null ? 'low evidence' : `low evidence · ${coverage}%`;
    }
    if (status === 'review_required') {
      return coverage == null ? 'review needed' : `review · ${coverage}%`;
    }
    if (status) return status.replaceAll('_', ' ');
    // Contract present but no overall yet — still not "unscored".
    return coverage == null ? 'scored · no overall' : `scored · ${coverage}% cov`;
  }
  const base = `${fit.overall}/100`;
  if (status === 'review_required') return `${base} review`;
  if (status === 'insufficient_evidence') return `${base} low evidence`;
  return base;
}

/** Left rail "New" rows: discovery/imported jobs not yet in the pipeline. */
export function newRows(model) {
  const jobs = model?.jobs || [];
  return jobs.filter(job =>
    !job.applicationStatus &&
    job.discoveryStatus !== 'archived' &&
    ['new', 'imported'].includes(job.discoveryStatus)
  );
}

/** Left rail "Jobs" rows: pipeline jobs (application exists, or saved). */
export function jobRows(model) {
  const jobs = model?.jobs || [];
  return jobs.filter(job =>
    job.discoveryStatus !== 'archived' &&
    (Boolean(job.applicationStatus) || job.discoveryStatus === 'saved')
  );
}

export function railRows(model, state) {
  return state?.leftMode === 'new' ? newRows(model) : jobRows(model);
}

/** job ids with a current draft awaiting human review (model.review is that queue). */
export function reviewPendingJobIds(model) {
  return new Set((model?.review || []).map(item => item.jobId).filter(Boolean));
}

/**
 * Action chip for a rail row, derived from real per-job signals.
 * Precedence follows the pipeline: draft review (pipeline jobs only), missing
 * files, missing listing contacts, then overdue follow-up. Null means no
 * action is pending. New-rail rows never claim "Needs review" — review is a
 * pipeline concept; a raw draft with no outreach path reads "Find people".
 */
export function actionChip(model, job) {
  if (!job) return null;
  const pipeline = Boolean(job.applicationStatus) || job.discoveryStatus === 'saved';
  if (pipeline && reviewPendingJobIds(model).has(job.id)) return 'Needs review';
  const signals = job.signals || {};
  if (!Number(signals.artifacts || 0)) return 'Create files';
  const noContacts = Number.isFinite(Number(signals.contacts))
    ? Number(signals.contacts) === 0
    : (!signals.path || signals.path === 'none');
  if (noContacts) return 'Find people';
  const next = job.next;
  if (next && ['followup', 'application_next_action'].includes(next.actionKind)) return 'Due follow-up';
  return null;
}

export function stageLabel(job) {
  if (!job) return '';
  return job.applicationStatus || job.discoveryStatus || '';
}

/** Job whose context the main pane shows (model selection is authoritative). */
export function selectedJob(model, state) {
  if (!model) return null;
  if (state?.selectedJobId && model.jobs?.some(job => job.id === state.selectedJobId)) {
    return model.jobs.find(job => job.id === state.selectedJobId);
  }
  return model.jobs?.[0] || null;
}

export function selectedRow(model, state) {
  const rows = railRows(model, state);
  return rows[state?.selectedIndex] || rows[0] || null;
}

export function isEmptyModel(model) {
  return Boolean(model?.empty && (model.empty.noProfile || model.empty.noJobs));
}

/** Welcome is first-run identity setup; a selected profile uses the honest
 * empty board instead of replaying welcome merely because it has no jobs. */
export function effectiveOverlay(model, state) {
  if (state?.overlay) return state.overlay;
  if (model?.empty?.noProfile && !state?.welcomeDismissed) return 'welcome';
  return null;
}

/** Composer exists only for workspace, or jobs with jobTab chat. */
export function isComposerActive(state) {
  return state?.headerMode === 'workspace' || (state?.headerMode === 'jobs' && state?.jobTab === 'chat');
}

export function formatClock(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function clockText(model, state) {
  return state?.clock || formatClock(model?.generatedAt);
}

/** Header company context: current listing only (visualizer data-context). */
export function companyContext(model, state) {
  if (state?.headerMode === 'workspace') return '';
  const job = selectedJob(model, state);
  return job?.company || '';
}

export function statusLine(model, state) {
  if (state?.headerMode === 'workspace') return 'Workspace';
  const job = selectedJob(model, state);
  const base = state?.status || 'Ready · local workspace';
  return job?.company ? `${base} · ${job.company}` : base;
}

export function setupStepViews(model) {
  const steps = model?.onboarding?.steps || [];
  const requiredIndex = new Map();
  let requiredSeen = 0;
  for (const step of steps) {
    if (step.required) {
      requiredSeen += 1;
      requiredIndex.set(step.id, requiredSeen);
    }
  }
  return steps.map(step => ({
    id: step.id,
    label: SETUP_STEP_LABELS[step.id] || String(step.id || 'Step').replace(/[_-]+/g, ' '),
    required: Boolean(step.required),
    status: step.status,
    summary: step.summary || '',
    actions: step.actions || [],
    pos: step.required ? String(requiredIndex.get(step.id)) : 'later',
    evidence: step.evidence || {}
  }));
}

export function completedRequiredCount(model) {
  const steps = model?.onboarding?.steps || [];
  return steps.filter(step => step.required && step.status === 'complete').length;
}

export function slashHits(query) {
  const q = String(query || '').replace(/^\//, '').toLowerCase();
  if (!q) return SLASH_CATALOG;
  return SLASH_CATALOG.filter(item =>
    item.label.toLowerCase().includes(q) ||
    item.hint.toLowerCase().includes(q)
  );
}

export function chatKey(scope, jobId) {
  return scope === 'workspace' ? 'workspace' : `job:${jobId || ''}`;
}

export function chatLog(state, scope, jobId) {
  return state?.chat?.[chatKey(scope, jobId)] || [];
}

/** Real docs for the selected job (artifactDocs projection). */
export function selectedDocs(model) {
  return model?.selected?.docs || [];
}

/** Real people for the selected job's People tab. */
export function selectedContacts(model) {
  return model?.selected?.contacts || [];
}

/**
 * People-review overlay rows (Workspace /find-people queue). Real rows only:
 * profile people (opportunities, personId), this-job contacts (contactId), and
 * this-job person candidates (candidateId). Contacts that are already approved
 * or suppressed and candidates that are promoted/suppressed leave the queue —
 * their choices are persisted, so the queue drains as the user keeps/skips.
 */
export function peopleReviewRows(model, state) {
  const rows = [];
  const seen = new Set();
  for (const opportunity of model?.networkSetup?.opportunities?.opportunities || []) {
    if (!opportunity?.personId || seen.has(`person:${opportunity.personId}`)) continue;
    seen.add(`person:${opportunity.personId}`);
    rows.push({
      kind: 'person',
      id: opportunity.personId,
      personId: opportunity.personId,
      name: opportunity.name || 'Unknown person',
      detail: [
        opportunity.channel ? `path ${opportunity.channel}` : null,
        opportunity.warmth ? `warmth ${opportunity.warmth}` : null,
        opportunity.daysSinceContact != null ? `${opportunity.daysSinceContact}d` : null
      ].filter(Boolean).join(' · ') || 'profile person',
      approved: true,
      suppressed: false
    });
  }
  for (const contact of selectedContacts(model)) {
    if (contact.approved || contact.suppressed) continue;
    if (seen.has(`contact:${contact.id}`)) continue;
    seen.add(`contact:${contact.id}`);
    rows.push({
      kind: 'contact',
      id: contact.id,
      contactId: contact.id,
      name: contact.name || 'Unknown contact',
      detail: [contact.role, contact.type, contact.approved ? 'approved' : 'not approved'].filter(Boolean).join(' · ') || 'contact',
      approved: false,
      suppressed: false
    });
  }
  for (const candidate of model?.selected?.candidates || []) {
    if (candidate.status === 'suppressed' || candidate.status === 'promoted') continue;
    if (seen.has(`candidate:${candidate.id}`)) continue;
    seen.add(`candidate:${candidate.id}`);
    rows.push({
      kind: 'candidate',
      id: candidate.id,
      candidateId: candidate.id,
      personId: candidate.personId || null,
      name: candidate.name || 'Unknown candidate',
      detail: [candidate.role, candidate.status || 'candidate', candidate.relevance].filter(Boolean).join(' · ') || 'candidate',
      approved: false,
      suppressed: false
    });
  }
  return rows;
}

/**
 * Network overlay people: stored relationships (graph edges), ranked
 * opportunities, and — when the user queried the real graph — its person
 * targets. Deduplicated by personId so one person opens one connection.
 */
export function networkPeople(model, state) {
  const people = [];
  const seen = new Set();
  for (const relationship of model?.networkSetup?.health?.relationships || []) {
    if (!relationship?.personId || seen.has(relationship.personId)) continue;
    seen.add(relationship.personId);
    people.push({
      kind: 'relationship',
      personId: relationship.personId,
      name: relationship.name || 'Person',
      warmth: relationship.warmth || 'unknown',
      detail: `relationship${relationship.daysSinceContact != null ? ` · ${relationship.daysSinceContact}d` : ''}`
    });
  }
  for (const opportunity of model?.networkSetup?.opportunities?.opportunities || []) {
    if (!opportunity?.personId || seen.has(opportunity.personId)) continue;
    seen.add(opportunity.personId);
    people.push({
      kind: 'opportunity',
      personId: opportunity.personId,
      name: opportunity.name || 'Person',
      warmth: opportunity.warmth || 'unknown',
      detail: `opportunity · ${opportunity.channel || 'no path'}${opportunity.daysSinceContact != null ? ` · ${opportunity.daysSinceContact}d` : ''}`,
      direct: Boolean(opportunity.direct),
      hops: opportunity.hops
    });
  }
  for (const path of state?.networkGraph?.paths || []) {
    const target = path?.target;
    if (!target || target.type !== 'person' || !target.id || seen.has(target.id)) continue;
    seen.add(target.id);
    people.push({
      kind: 'graph',
      personId: target.id,
      name: target.name || target.id,
      warmth: path.warmth || 'unknown',
      detail: `graph · ${path.hops || 0} hop${path.hops === 1 ? '' : 's'} · ${path.pathStrength || 'path'}`
    });
  }
  return people;
}

/** The single person the Connection overlay renders. */
export function connectionPerson(model, state) {
  if (state?.connectionSource === 'network') {
    const people = networkPeople(model, state);
    return people[state?.connectionIndex || 0] || people[0] || null;
  }
  const contacts = selectedContacts(model);
  return contacts[state?.connectionIndex || 0] || contacts[0] || null;
}

/** Outreach drafts for the selected job (exact artifact ids) — mark-sent targets. */
export function outreachDraftRows(model, state) {
  return (selectedDocs(model) || [])
    .filter(doc => doc.type === 'outreach')
    .map(doc => ({
      id: doc.id,
      label: doc.title || `Outreach · ${doc.id}`,
      detail: `revision ${doc.revision || '?'} · ${doc.approvalStatus || 'draft_needs_human_review'}`
    }));
}

/** Selected memory proposal under the overlay cursor. */
export function selectedMemoryProposal(model, state) {
  const proposals = model?.memory?.proposals || [];
  return proposals[state?.overlayIndex || 0] || proposals[0] || null;
}

export function fitText(job) {
  return job?.fit ? fitLabel(job.fit) : null;
}

/**
 * Files overlay rows: the exact current revision of every artifact series for
 * the selected job, the locked resume.md series (a pending row until a real
 * draft exists — never an approve/reject target), plus the real questions
 * output (questions.md). The questions output is a persisted workspace
 * artifact (prepareApplicationQuestions writes jobs/<job>/artifacts/
 * application-questions.md) without an artifacts row, so it renders as a
 * reference copy, never an approve/reject target.
 */
export function filesRows(model, state) {
  const docs = selectedDocs(model);
  const bySeries = new Map();
  for (const doc of docs) {
    const key = doc.seriesKey || `${doc.type}:${doc.path}`;
    const prior = bySeries.get(key);
    if (!prior || Number(doc.revision || 0) > Number(prior.revision || 0)) bySeries.set(key, doc);
  }
  const rows = [...bySeries.values()].map(doc => ({
    kind: 'artifact',
    id: doc.id,
    label: doc.type === 'resume' ? 'resume.md'
      : doc.type === 'cover_letter' ? 'cover-letter.md'
        : (doc.title || doc.type || 'draft'),
    title: doc.title || doc.type || 'draft',
    doc
  }));
  if (!rows.some(row => row.doc?.type === 'resume')) {
    // The locked Files surface always names resume.md; until a real draft
    // exists it is a pending row with no approve/reject target.
    rows.unshift({
      kind: 'missing',
      id: 'resume',
      label: 'resume.md',
      title: 'Tailored resume',
      detail: 'no draft yet · /create-files drafts it',
      doc: null
    });
  }
  rows.push({
    kind: 'questions',
    id: 'questions',
    label: 'questions.md',
    title: 'Application questions',
    detail: 'from the posting · restricted answers stay gated',
    hasText: Boolean(state?.questionsText)
  });
  return rows;
}

/** The Files overlay row under the cursor. */
export function selectedFileRow(model, state) {
  const rows = filesRows(model, state);
  return rows[state?.overlayIndex || 0] || rows[0] || null;
}

/**
 * Tracker overlay rows: every canonical application stage (display) plus the
 * freeze/attest actions. Only pre-apply stages are directly settable — applied
 * and later come from packet attestation, never a manual fake state.
 */
export function trackerRows(model, state) {
  const job = selectedJob(model, state);
  const readiness = model?.selected?.readiness || {};
  const packet = readiness.packet || {};
  const current = job?.applicationStatus || job?.discoveryStatus || '';
  const rows = ACTIVE_APPLICATION_STATUSES.map(status => ({
    kind: 'status',
    id: `status:${status}`,
    label: status,
    current: status === current,
    settable: ['saved', 'researching', 'materials-ready'].includes(status)
  }));
  rows.push({
    kind: 'action',
    id: 'freeze-packet',
    label: 'Freeze packet',
    detail: packet.currentPacketId ? `packet ${packet.currency}` : 'no packet',
    disabled: false
  });
  rows.push({
    kind: 'action',
    id: 'attest-submitted',
    label: 'Attest submitted',
    detail: packet.attestable ? 'eligible' : (packet.receiptState || 'needs current packet'),
    disabled: !packet.attestable
  });
  return rows;
}

/** Review overlay rows: due tasks + pending drafts + the weekly action. */
export function reviewRows(model, state) {
  const rows = [];
  for (const task of model?.dueTasks || []) {
    rows.push({
      kind: 'due',
      id: `due:${task.id}`,
      label: task.title || 'Task',
      detail: `due · ${task.dueText || (task.dueAt || '').slice(0, 10)}`,
      jobId: task.jobId || null
    });
  }
  for (const draft of model?.review || []) {
    rows.push({
      kind: 'draft',
      id: `draft:${draft.id}`,
      label: draft.title || draft.type || 'draft',
      detail: `draft · ${draft.company || ''}`,
      jobId: draft.jobId || null
    });
  }
  const weekly = state?.weekly || null;
  rows.push({
    kind: 'weekly',
    id: 'weekly-review',
    label: weekly ? 'Weekly review · refresh' : 'Run weekly review',
    detail: weekly ? `wrote ${weekly.path || 'weekly review'}` : 'w',
    jobId: null
  });
  return rows;
}
