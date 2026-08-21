/**
 * Pure derivations over the REAL buildTuiModel projection and the locked TUI
 * state vocabulary. No fixtures, no invented jobs/companies/people, no writes.
 * Everything here is deterministic from (model, state).
 */

import { boardGeometry, contains, networkIntentGeometry, trackerStageGeometry } from './layout.js';

export const ACTIVE_APPLICATION_STATUSES = Object.freeze([
  'saved',
  'researching',
  'materials-ready',
  'applied',
  'recruiter-screen',
  'interview',
  'offer'
]);

/**
 * Direct-select tracker stages (classic.html spike tracker buttons). These are
 * the four quick stage chips with direct keys 1-4 and frozen B11 click targets.
 * Non-mutating: `applied` and `waiting` are reached by attestation only, so
 * selecting them never bypasses packet/attestation gates.
 */
export const TRACKER_DIRECT_STAGES = Object.freeze([
  'saved',
  'researching',
  'applied',
  'waiting'
]);

/**
 * Tracker chip row order: the four direct-select stages first (frozen B11
 * click targets at 140x42), then the remaining product statuses. The four
 * direct stages render on the FIRST chip line at the frozen columns, so the
 * active chips never reorder the modal or its height.
 */
export const TRACKER_CHIP_STAGES = Object.freeze([
  ...TRACKER_DIRECT_STAGES,
  ...ACTIVE_APPLICATION_STATUSES.filter(stage => !TRACKER_DIRECT_STAGES.includes(stage))
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
  ).sort(compareRailOrder);
}

/** Left rail "Jobs" rows: pipeline jobs (application exists, or saved). */
export function jobRows(model) {
  const jobs = model?.jobs || [];
  return jobs.filter(job =>
    job.discoveryStatus !== 'archived' &&
    (Boolean(job.applicationStatus) || job.discoveryStatus === 'saved')
  ).sort(compareRailOrder);
}

export function railRows(model, state) {
  return state?.leftMode === 'new' ? newRows(model) : jobRows(model);
}

/**
 * Left-rail presentation order: oldest first (ascending recency), stable on
 * ties by id. The rail is the chronological pipeline, matching the visualizer
 * where the older listing sits on top; a second painted row is therefore the
 * next-oldest job, not a reordering of domain fit decisions.
 */
function compareRailOrder(left, right) {
  const l = String(left?.updatedAt || '');
  const r = String(right?.updatedAt || '');
  if (l !== r) return l < r ? -1 : 1;
  return String(left?.id || '').localeCompare(String(right?.id || ''));
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

/**
 * Authoritative board selection resolver — single source for header, panes,
 * docs/contacts/readiness and mutations. Preferred ID must be visible in the
 * active rail; otherwise the first visible rail row wins. Never silently
 * falls back to model.jobs[0] when that job is not in the active rail.
 */
export function resolveBoardSelection(model, state, preferredId = null) {
  const rows = railRows(model, state);
  const desired = preferredId ?? state?.selectedJobId ?? null;
  if (desired && rows.some(row => row.id === desired)) {
    const index = rows.findIndex(row => row.id === desired);
    const job = model?.jobs?.find(j => j.id === desired) || rows[index] || null;
    return { rows, selectedJobId: desired, selectedIndex: index, job };
  }
  if (rows.length) {
    const first = rows[0];
    const job = model?.jobs?.find(j => j.id === first.id) || first;
    return { rows, selectedJobId: first.id, selectedIndex: 0, job };
  }
  // Active rail empty — keep the desired job for header/pane continuity if it
  // still exists in the workspace; otherwise no selection.
  if (desired && model?.jobs?.some(j => j.id === desired)) {
    const job = model.jobs.find(j => j.id === desired) || null;
    return { rows, selectedJobId: desired, selectedIndex: 0, job };
  }
  if (model?.jobs?.length) {
    // Preserve a workspace job for continuity rather than dropping to null when
    // the active rail is empty but jobs exist elsewhere (e.g., pipeline job
    // while viewing empty New). This keeps header/docs/tracker coherent.
    const fallback = model.jobs[0];
    return { rows, selectedJobId: fallback.id, selectedIndex: 0, job: fallback };
  }
  return { rows, selectedJobId: null, selectedIndex: 0, job: null };
}

/** Job whose context the main pane shows (model selection is authoritative). */
export function selectedJob(model, state) {
  if (!model) return null;
  return resolveBoardSelection(model, state).job;
}

export function selectedRow(model, state) {
  if (!model) return null;
  return resolveBoardSelection(model, state).job;
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

export const MOUSE_CSI = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])$/;
export const MOUSE_X10 = /^(?:\x1b)?\[M[\x20-\xff]{3}$/;

/**
 * Pure hit-test for the live Classic grid (SGR mouse coordinates are 1-based
 * terminal cells). Returns an action descriptor for the painted cell or null.
 * Rendering and routing receive the same viewport; unknown cells are no-ops
 * and mouse protocol bytes never leak into the composer input.
 *
 * Geometry (derived from the rendered frame at width x height):
 * - row 1: header mode segs right-aligned (Workspace, then Jobs)
 * - row 2: left rail segs (New | Jobs) then pane tabs (Job | People | Chat)
 * - rows 3+: rail rows, two painted lines per row (title, company)
 * - a covering overlay: centered modal, steps start after kicker/title/progress
 * - bottom rows: status bar (height-1), footer (height); composer row height-2
 */
export function hitTestGrid(model, state, col, row, { width = 140, height = 42 } = {}) {
  const c = Math.max(1, Math.floor(Number(col) || 0));
  const r = Math.max(1, Math.floor(Number(row) || 0));
  const viewportWidth = Math.max(1, Math.floor(Number(width) || 140));
  const viewportHeight = Math.max(1, Math.floor(Number(height) || 42));
  if (c > viewportWidth || r > viewportHeight) return null;
  const overlay = effectiveOverlay(model, state);
  if (overlay) return hitTestOverlay(overlay, model, state, c, r, viewportWidth, viewportHeight);
  const geo = boardGeometry({ width: viewportWidth, height: viewportHeight });
  // Header row 1 — right-aligned workspace/jobs segs (clipped to viewport)
  if (r === 1) {
    if (geo.header.workspaceClipped && contains(geo.header.workspaceClipped, c, r)) return { action: 'setHeaderMode', value: 'workspace' };
    if (geo.header.jobsClipped && contains(geo.header.jobsClipped, c, r)) return { action: 'setHeaderMode', value: 'jobs' };
    return null;
  }
  // Workspace mode: board geometry is not painted — gate rail/tab/row hits
  if (state?.headerMode === 'workspace') {
    if (isComposerActive(state) && r === geo.composerRow) {
      // Workspace composer spans the full width
      if (c >= 1 && c <= viewportWidth) return { action: 'submitComposer' };
    }
    return null;
  }
  // Jobs mode — board geometry
  if (geo.mode !== 'split') {
    // Compact: preserve visible rail tabs/rows, suppress only absent detail controls (pane tabs + detail composer)
    // Detail/composer is clipped in compact jobs mode — no submitComposer regardless of jobTab chat.
    if (r === 2) {
      if (geo.rail.tabsClipped.new && contains(geo.rail.tabsClipped.new, c, r)) return { action: 'setLeftMode', value: 'new' };
      if (geo.rail.tabsClipped.jobs && contains(geo.rail.tabsClipped.jobs, c, r)) return { action: 'setLeftMode', value: 'jobs' };
      return null;
    }
    const maxRailBottomCompact = Math.max(0, viewportHeight - 3);
    if (r >= geo.rail.rowsTop && r <= maxRailBottomCompact && geo.rail.rectClipped && c >= geo.rail.rectClipped.left && c <= geo.rail.rectClipped.right) {
      const rows = railRows(model, state);
      const index = Math.floor((r - geo.rail.rowsTop) / geo.rail.rowHeight);
      if (rows[index]) return { action: 'selectRow', index };
      return null;
    }
    // Compact jobs detail/composer is clipped — do not expose submitComposer
    return null;
  }
  if (r === 2) {
    if (geo.rail.tabsClipped.new && contains(geo.rail.tabsClipped.new, c, r)) return { action: 'setLeftMode', value: 'new' };
    if (geo.rail.tabsClipped.jobs && contains(geo.rail.tabsClipped.jobs, c, r)) return { action: 'setLeftMode', value: 'jobs' };
    if (geo.pane.tabsClipped.job && contains(geo.pane.tabsClipped.job, c, r)) return { action: 'setJobTab', value: 'job' };
    if (geo.pane.tabsClipped.people && contains(geo.pane.tabsClipped.people, c, r)) return { action: 'setJobTab', value: 'people' };
    if (geo.pane.tabsClipped.chat && contains(geo.pane.tabsClipped.chat, c, r)) return { action: 'setJobTab', value: 'chat' };
    return null;
  }
  // Rail rows: visible rows only, each two lines high starting at rowsTop
  const maxRailBottom = Math.max(0, viewportHeight - 3);
  if (r >= geo.rail.rowsTop && r <= maxRailBottom && geo.rail.rectClipped && c >= geo.rail.rectClipped.left && c <= geo.rail.rectClipped.right) {
    const rows = railRows(model, state);
    const index = Math.floor((r - geo.rail.rowsTop) / geo.rail.rowHeight);
    if (rows[index]) return { action: 'selectRow', index };
    return null;
  }
  // Composer in jobs mode: only the painted main pane interior is clickable
  if (isComposerActive(state) && r === geo.composerRow && geo.pane.rectClipped && contains(geo.pane.rectClipped, c, r)) {
    return { action: 'submitComposer' };
  }
  return null;
}

function hitTestOverlay(overlay, model, state, c, r, width, height) {
  if (overlay === 'tracker') {
    const geometry = trackerStageGeometry(width, height);
    if (r < geometry.row || r > geometry.rowEnd) return null;
    let chipLeft = geometry.contentLeft;
    for (const stage of TRACKER_DIRECT_STAGES) {
      const start = chipLeft + 1;
      const end = chipLeft + stage.length;
      if (c >= start && c <= end) {
        const rows = trackerRows(model, state);
        const index = rows.findIndex(row => row.label === stage);
        return index >= 0 ? { action: 'setOverlayIndex', index } : null;
      }
      chipLeft += stage.length + 3; // chip text (` ${stage} `) + marginRight
    }
    return null;
  }
  if (overlay === 'network') {
    const geometry = networkIntentGeometry(width, height);
    if (r !== geometry.row) return null;
    if (c < geometry.contentLeft || c >= geometry.contentLeft + geometry.label.length) return null;
    return { action: 'editNetworkIntent' };
  }
  if (overlay !== 'setup') return null;
  const steps = setupStepViews(model);
  const count = Math.max(1, steps.length);
  // Centered modal: kicker(1) + title(1) + progress(1) then 2 rows per step,
  // then detail/buttons/hint. Height = 7 + 2*count matches the rendered frame.
  // While an inline entry line is rendered (profile-name / network-intent
  // modes) the modal grows by 2 rows (margin + caret row) and re-centers one
  // row higher — mirror that so click targets stay aligned with the paint.
  const entryActive = state.setupMode === 'profile-name' || state.setupMode === 'network-intent';
  const bodyTop = 2;
  const bodyHeight = height - 3;
  const modalHeight = 7 + 2 * count + (entryActive ? 2 : 0);
  const modalTop = bodyTop + Math.floor((bodyHeight - modalHeight) / 2);
  const stepStart = modalTop + 4;
  const modalLeft = Math.floor((width - 52) / 2);
  const modalRight = modalLeft + 52;
  if (c < modalLeft || c > modalRight) return null;
  if (r < stepStart || (r - stepStart) % 2 !== 0) return null;
  const index = Math.floor((r - stepStart) / 2);
  if (index >= count) return null;
  return { action: 'setOverlayIndex', index };
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
  // Direct-select 'waiting' chip (spike stage). Non-mutating: never persisted
  // as an application status; it gives the frozen 1-4 / click range a target
  // without bypassing the packet/attestation gates that own post-apply state.
  rows.push({
    kind: 'status',
    id: 'status:waiting',
    label: 'waiting',
    current: current === 'waiting',
    settable: false
  });
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
