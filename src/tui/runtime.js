/**
 * Ink runtime + JobosTui controller for the Classic red shell.
 *
 * - JobosTui owns the locked state vocabulary, rebuilds the real model from the
 *   store (buildTuiModel), routes keys, and exposes start/stop/render/handleKey
 *   plus real domain transitions (addToJobs -> create_application, createFiles
 *   -> tailor_resume, findPeople -> start_people_research) with source 'tui'.
 * - startTui mounts a real Ink tree (useInput) for TTY stdout/stdin and resolves
 *   when the app exits. Non-TTY callers use renderTui (render.js); the snapshot
 *   path never starts ACP child processes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render, useInput, useStdout } from 'ink';
import { buildTuiModel } from '../tui-model.js';
import { callDomainTool, profileAgentContext, selectedJobContext } from '../domain-tools.js';
import { AcpClient, readPersistedAcpSession, writePersistedAcpSession } from '../acp.js';
// Real candidate/contact lifecycle functions that have no domain-tool surface
// (src/cli.js calls them the same way). Trusted TUI activation only; they carry
// no mediation gate, unlike approve_contact / network_contact_record.
import { promoteStakeholder, suppressContact } from '../research/contacts.js';
// Guided setup executes real onboarding through the same source functions the
// CLI calls (jobos profile create / resume import / proof verify|replace|retire
// / jobs import-text|import-url / searches sample / profile network-intent).
// These are trusted TUI activations of the human-facing pathways, never
// invented content.
import { all, one, reload, run, save } from '../db.js';
import {
  createProfile,
  addProof,
  verifyProof,
  retireProof,
  supersedeProof,
  importResumeProofCandidates,
  setNetworkIntent
} from '../profiles.js';
import {
  importResume,
  createResumeRevision,
  normalizeResumeSourceText,
  parseResumeText,
  verifyResumeDocument
} from '../resumes.js';
import { importText, importUrl } from '../jobs.js';
import { ensureSampleOfflineSearch } from '../discovery.js';
import { browserStatus } from '../browser.js';
import { parseJson } from '../utils.js';
import { App } from './components.js';
import { CLASSIC_THEME } from './theme.js';
import { resolveViewport } from './layout.js';
import { renderTui } from './render.js';
import {
  SETUP_SUB_OVERLAYS,
  RESUME_SOURCE_CHOICES,
  JOB_SOURCE_CHOICES,
  railRows,
  newRows,
  jobRows,
  selectedJob,
  selectedRow,
  effectiveOverlay,
  isComposerActive,
  isEmptyModel,
  setupStepViews,
  slashHits,
  chatKey,
  formatClock,
  fitLabel,
  filesRows,
  trackerRows,
  TRACKER_DIRECT_STAGES,
  reviewRows,
  peopleReviewRows,
  networkPeople,
  connectionPerson,
  outreachDraftRows,
  selectedMemoryProposal,
  MOUSE_CSI,
  MOUSE_X10,
  hitTestGrid
} from './model.js';

/** Accept both Ink's boolean key flags and direct-controller name keys. */
function normalizeInputKey(key = {}) {
  if (!key || typeof key !== 'object') return key || {};
  const normalized = { ...key };
  if (key.name) {
    switch (key.name) {
      case 'return':
      case 'enter':
        normalized.return = true;
        break;
      case 'escape':
        normalized.escape = true;
        break;
      case 'tab':
        normalized.tab = true;
        break;
      case 'shiftTab':
      case 'shift-tab':
        normalized.tab = true;
        normalized.shiftTab = true;
        break;
      case 'backspace':
        normalized.backspace = true;
        break;
      case 'upArrow':
      case 'up':
        normalized.upArrow = true;
        break;
      case 'downArrow':
      case 'down':
        normalized.downArrow = true;
        break;
      case 'leftArrow':
      case 'left':
        normalized.leftArrow = true;
        break;
      case 'rightArrow':
      case 'right':
        normalized.rightArrow = true;
        break;
      default:
        break;
    }
  }
  // Live Ink Shift+Tab arrives as { name: 'tab', shift: true } (ESC [ Z), and
  // some direct controllers emit bare { tab: true, shift: true } without a
  // name. Both must reverse the pane cycle the same way tests inject shiftTab.
  if (normalized.tab && normalized.shift) normalized.shiftTab = true;
  return normalized;
}

const h = React.createElement;

export const TUI_DOMAIN_ACTIONS = Object.freeze({
  daily: 'daily_discovery',
  network: 'network_graph_query'
});

export function defaultTuiState() {
  return {
    // Locked IA vocabulary
    headerMode: 'jobs',
    leftMode: 'jobs',
    jobTab: 'job',
    overlay: null,
    // Aux selection/input state (outside the locked vocabulary)
    overlayIndex: 0,
    selectedIndex: 0,
    peopleIndex: 0,
    slashIndex: 0,
    profileId: null,
    selectedJobId: null,
    input: '',
    inputCursor: null,
    status: 'Ready · local workspace',
    error: null,
    working: false,
    clock: '',
    chat: {},
    // Files overlay: rejection reason being typed, latest questions.md text.
    filesReason: null,
    questionsText: null,
    // Review overlay: last real weekly_review readout ({ runId, path, metrics }).
    weekly: null,
    welcomeDismissed: false,
    agentState: 'offline',
    sessionId: null,
    // Setup picker selections (consumed by the later feature slice)
    setupResumeSource: null,
    setupJobSource: null,
    // Guided setup inline execution: setupMode is a local input mode
    // (profile-name / resume-paste / resume-path / job-paste / job-path /
    // job-url / proof-add / proof-edit / proof-drop / network-intent). The
    // buffer and browse/proof snapshots are render state only — every write
    // goes through the real domain functions below.
    setupMode: null,
    setupInput: '',
    setupProofRows: [],
    setupProofEditId: null,
    setupProofDropId: null,
    setupBrowse: null,
    setupBrowserProbe: null,
    // People/network overlays: profile research run, connection identity, and
    // local input modes (reasons/notes/channel — never invented values).
    profileResearchRun: null,
    connectionSource: 'people',
    connectionIndex: 0,
    networkGraph: null,
    peopleSkipReason: null,
    keepContactNote: null,
    recordContactNote: null,
    markSent: null,
    memoryReason: null
  };
}

/** TTY glue: subscribes to the controller and routes raw keys back to it. */
function Root({ controller, options }) {
  const [state, setState] = React.useState(controller.state);
  const { stdout } = useStdout();
  React.useEffect(() => controller.subscribe(setState), [controller]);
  React.useEffect(() => {
    const id = setInterval(() => controller.tick(), 1000);
    return () => clearInterval(id);
  }, [controller]);
  useInput((input, key) => controller.handleKey(input, key));
  // Definite frame for the live TTY: stdout size by default, CLI --width /
  // --height override when provided (same contract as the snapshot path).
  const { width, height } = resolveViewport(options, stdout);
  return h(App, {
    model: controller.model,
    state,
    actions: controller.actions,
    theme: CLASSIC_THEME,
    colorEnabled: options.color !== false,
    interactive: true,
    width,
    height
  });
}

export class JobosTui {
  constructor(store, options = {}) {
    this.store = store;
    this.options = { ...options };
    this.state = defaultTuiState();
    if (options.profileId) this.state.profileId = options.profileId;
    if (options.selectedJobId) this.state.selectedJobId = options.selectedJobId;
    if (options.initialOverlay) this.state.overlay = options.initialOverlay;
    // Agent state is derived from the connectAgent contract: off when the host
    // explicitly disables the embedded assistant, idle when enabled but not yet
    // connected. An explicit agentState option still wins (snapshot/tests).
    this.state.agentState = options.agentState || (options.connectAgent === false ? 'off' : 'idle');
    this.model = null;
    this.exited = false;
    this.started = false;
    this._diskStamp = null;
    // The owned AcpClient starts null and is only created by connectAgent when
    // the host enables the assistant (--agent off must never assign one).
    this.client = null;
    this.connectPromise = null;
    // Monotonic counter for in-pane ACP cancellation: a cancel during a turn
    // invalidates the async continuation (no late chunks appended, no error
    // override of the clean ready/off state).
    this._cancelSeq = 0;
    this._instance = null;
    this._resizeListener = null;
    this._resolveExit = null;
    this._subscribers = new Set();
    this._exitPromise = null;
    this.actions = Object.freeze({
      setHeaderMode: mode => this.setHeaderMode(mode),
      setLeftMode: mode => this.setLeftMode(mode),
      setJobTab: tab => this.setJobTab(tab),
      openOverlay: overlay => this.openOverlay(overlay),
      closeOverlay: () => this.closeOverlay(),
      addToJobs: () => this.addToJobs(this.selectedJob()?.id),
      createFiles: () => this.createFiles(this.selectedJob()?.id),
      findPeople: () => this.findPeople(this.selectedJob()?.id),
      findPeopleProfile: () => this.findPeopleProfile(),
      keepPerson: () => this.keepSelectedPerson(),
      skipPerson: () => this.skipSelectedPerson(),
      openNetwork: () => this.openNetworkFromReview(),
      draftOutreach: () => this.draftOutreachForPerson(),
      approveContact: () => this.approveSelectedContact(),
      recordContact: () => this.startRecordContact(),
      markSent: () => this.startMarkSent(),
      refreshNetworkGraph: () => this.refreshNetworkGraph(),
      acceptProposal: () => this.startMemoryTransition('accept'),
      rejectProposal: () => this.startMemoryTransition('reject'),
      revokeProposal: () => this.startMemoryTransition('revoke'),
      runSlash: id => this.runSlash(id),
      sendChat: (scope, text) => this.sendChat(scope, text),
      selectRow: index => this.selectRow(index),
      exit: () => this.exit()
    });
  }

  // -- lifecycle -----------------------------------------------------------

  subscribe(fn) {
    this._subscribers.add(fn);
    return () => this._subscribers.delete(fn);
  }

  notify() {
    const snapshot = { ...this.state };
    for (const fn of this._subscribers) fn(snapshot);
  }

  async start() {
    if (this.started) return this._exitPromise;
    this.started = true;
    this.refresh({ render: false });
    const interactive = Boolean(this.options.stdin?.isTTY || (this.options.stdin === undefined && process.stdin.isTTY));
    if (!interactive) {
      // Headless mode for tests/controllers: no Ink mount, no ACP child unless
      // the host enabled the assistant — then connect deterministically.
      this._exitPromise = Promise.resolve();
      if (this.options.connectAgent !== false) await this.ensureAgent();
      return this._exitPromise;
    }
    this._exitPromise = new Promise(resolve => {
      this._resolveExit = resolve;
    });
    // TTY-only mouse reporting: SGR button-event mode (1000) + SGR encoding
    // (1006). Never written on the non-TTY/headless path, so `--snapshot` and
    // CI stays byte-clean.
    this._mouseEnabled = true;
    this.writeMouseSequences('h');
    const stdout = this.options.stdout || process.stdout;
    if (typeof stdout?.on === 'function') {
      this._resizeListener = () => this.notify();
      stdout.on('resize', this._resizeListener);
    }
    // TTY: connect in the background so startup never blocks on the backend;
    // failures land in agentState unavailable/failed and honest composer copy.
    if (this.options.connectAgent !== false) this.ensureAgent();
    this._instance = render(h(Root, { controller: this, options: this.options }), {
      stdout: this.options.stdout || process.stdout,
      stdin: this.options.stdin || process.stdin,
      exitOnCtrlC: false
    });
    return this._exitPromise;
  }

  stop() {
    return this.exit();
  }

  /**
   * Write SGR mouse enable/disable to the TTY stdout (guarded by the
   * interactive flag in start). Every handler writes both mode bytes so the
   * terminal state is always restored on exit.
   */
  writeMouseSequences(mode) {
    if (!this._mouseEnabled && mode === 'l') return;
    const stdout = this.options.stdout || process.stdout;
    if (!stdout || typeof stdout.write !== 'function') return;
    const bytes = mode === 'h'
      ? '\x1b[?1000h\x1b[?1006h'
      : '\x1b[?1000l\x1b[?1006l';
    try {
      stdout.write(bytes);
    } catch {}
  }

  async exit() {
    if (this.exited) return;
    this.exited = true;
    this.state.status = 'bye';
    this.notify();
    const resolve = this._resolveExit;
    this._resolveExit = null;
    if (this._instance) {
      const instance = this._instance;
      this._instance = null;
      instance.unmount();
    }
    if (this._resizeListener) {
      const stdout = this.options.stdout || process.stdout;
      if (typeof stdout?.off === 'function') stdout.off('resize', this._resizeListener);
      else if (typeof stdout?.removeListener === 'function') stdout.removeListener('resize', this._resizeListener);
      this._resizeListener = null;
    }
    if (this._mouseEnabled) {
      this.writeMouseSequences('l');
      this._mouseEnabled = false;
    }
    const client = this.client;
    this.client = null;
    if (client) {
      // AcpClient.stop cancels an in-flight turn and bounds teardown with
      // SIGTERM/SIGKILL fallbacks, so exit never hangs on the backend.
      try { await client.stop(); } catch {}
    }
    if (resolve) resolve();
  }

  tick() {
    this.state.clock = formatClock(new Date());
    this.notify();
  }

  refresh({ render = true } = {}) {
    // Reload only when the authoritative file changed since the last
    // projection. Direct controller callers may still have an intentional
    // in-memory transaction awaiting its own save; an unconditional reload
    // would discard that state.
    const dbPath = this.store?.p?.db;
    let diskStamp = null;
    if (dbPath) {
      try {
        const stat = fs.statSync(dbPath);
        diskStamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {}
    }
    if (diskStamp && this._diskStamp && diskStamp !== this._diskStamp) {
      reload(this.store);
    }
    this._diskStamp = diskStamp;
    // One person, one profile in the TUI: when no profile is pinned, the
    // workspace's first profile is the owned profile (buildTuiModel resolves
    // the same way). Passing the resolved id keeps onboarding.profileId bound
    // so /setup reopens on the same workspace profile.
    let requestedProfile = this.state.profileId || this.options.profileId || null;
    if (!requestedProfile) {
      try {
        const first = one(this.store, 'SELECT id FROM profiles ORDER BY created_at,id LIMIT 1');
        if (first) requestedProfile = first.id;
      } catch {}
    }
    const requestedJob = this.state.selectedJobId || this.options.selectedJobId || null;
    this.model = buildTuiModel(this.store, { profileId: requestedProfile, selectedJobId: requestedJob });
    // At the TUI boundary, an empty workspace has neither a profile nor jobs.
    // Keep the flags honest without fabricating rows or changing the frozen
    // domain projection contract.
    if (this.model?.empty?.noProfile && !this.model.empty.noJobs) {
      this.model.empty = { ...this.model.empty, noJobs: true };
    }
    const state = this.state;
    state.profileId = this.model.profileId;
    state.selectedJobId = this.model.selectedJobId;
    const rows = railRows(this.model, state);
    if (rows.length) {
      state.selectedIndex = Math.max(0, Math.min(state.selectedIndex || 0, rows.length - 1));
    } else {
      state.selectedIndex = 0;
    }
    // Files overlay keeps its questions mirror current after an external disk
    // write reloaded the store.
    if (state.overlay === 'files' && state.selectedJobId) {
      this.refreshQuestionsText(state.selectedJobId);
    }
    if (render) this.notify();
  }

  /** Current frame size: explicit options, then live stdout, then fallback. */
  viewport(stdout = this.options.stdout || process.stdout) {
    return resolveViewport(this.options, stdout);
  }

  /** Bounded snapshot string of the current controller state (for tests). */
  render({ width, height, color = false } = {}) {
    const live = this.viewport();
    const viewport = resolveViewport({ width: width ?? live.width, height: height ?? live.height });
    return renderTui(this.model, this.state, { ...viewport, color });
  }

  // -- state setters --------------------------------------------------------

  setStatus(text) {
    this.state.status = String(text || '');
    this.state.error = null;
    this.notify();
  }

  setError(text) {
    this.state.error = String(text || '');
    this.state.status = String(text || '');
    this.notify();
  }

  setWorking(on, label = null) {
    this.state.working = Boolean(on);
    if (on && label) this.state.status = String(label);
    if (!on && this.state.error) this.state.status = this.state.error;
    this.notify();
  }

  setInput(text) {
    this.state.input = String(text || '');
    this.state.inputCursor = null;
    this.state.slashIndex = 0;
    this.notify();
  }

  setHeaderMode(mode) {
    const next = mode === 'workspace' ? 'workspace' : 'jobs';
    this.state.headerMode = next;
    this.state.overlay = null;
    this.state.status = next === 'workspace' ? 'Workspace · the whole search' : 'Board';
    this.notify();
  }

  setLeftMode(mode) {
    this.state.leftMode = mode === 'new' ? 'new' : 'jobs';
    this.state.selectedIndex = 0;
    this.state.overlay = null;
    this.notify();
  }

  setJobTab(tab) {
    const next = tab === 'job' ? 'job' : tab === 'people' ? 'people' : 'chat';
    if (this.state.jobTab === next) return;
    this.state.jobTab = next;
    this.state.overlay = null;
    this.notify();
  }

  cycleJobTab(direction) {
    const order = ['job', 'people', 'chat'];
    const index = order.indexOf(this.state.jobTab);
    const delta = direction < 0 ? -1 : 1;
    const next = order[(index + delta + order.length) % order.length];
    this.setJobTab(next);
  }

  openOverlay(overlay) {
    this.state.overlay = overlay;
    this.state.overlayIndex = 0;
    if (overlay === 'files') this.refreshQuestionsText(this.selectedJob()?.id);
    if (overlay === 'setup') this.state.overlayIndex = this.firstSetupFocusIndex();
    if (overlay === 'connection') {
      this.state.markSent = null;
      this.state.recordContactNote = null;
    }
    this.notify();
  }

  /** Guided setup local input/browse state never survives the overlay that owns it. */
  clearSetupTransients() {
    this.state.setupMode = null;
    this.state.setupInput = '';
    this.state.setupProofEditId = null;
    this.state.setupProofDropId = null;
    this.state.setupBrowse = null;
  }

  closeOverlay() {
    this.clearSetupTransients();
    this.state.overlay = null;
    this.state.overlayIndex = 0;
    // Transient local input modes never survive the overlay that owns them.
    this.state.peopleSkipReason = null;
    this.state.keepContactNote = null;
    this.state.recordContactNote = null;
    this.state.markSent = null;
    this.state.memoryReason = null;
    // Welcome is first-run chrome (visualizer behavior): leaving the first-run
    // flow on an empty store dismisses it for this session; /setup reopens setup.
    if (this.model && isEmptyModel(this.model)) this.state.welcomeDismissed = true;
    this.notify();
  }

  selectRow(index) {
    const rows = railRows(this.model, this.state);
    if (!rows.length) return;
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    if (clamped === this.state.selectedIndex && this.state.selectedJobId === rows[clamped]?.id) return;
    this.state.selectedIndex = clamped;
    this.state.selectedJobId = rows[clamped].id;
    this.refresh({ render: true });
  }

  selectedJob() {
    return selectedJob(this.model, this.state);
  }

  selectedRow() {
    return selectedRow(this.model, this.state);
  }

  pushChat(scope, message) {
    const job = this.selectedJob();
    const key = chatKey(scope, job?.id);
    this.state.chat = { ...this.state.chat, [key]: [...(this.state.chat[key] || []), message] };
  }

  // -- real domain transitions (source 'tui' everywhere) ----------------------

  async addToJobs(jobId) {
    if (!jobId) return;
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    this.setWorking(true, 'Adding to Jobs…');
    try {
      await callDomainTool(this.store, 'create_application', { jobId, status: 'saved', notes: '' }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.leftMode = 'jobs';
      const rows = jobRows(this.model);
      const index = rows.findIndex(row => row.id === jobId);
      this.state.selectedIndex = Math.max(0, index);
      this.state.jobTab = 'job';
      this.state.overlay = null;
      this.state.status = 'Added to Jobs · pipeline';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async createFiles(jobId) {
    if (!jobId) return false;
    const profileId = this.model?.profileId;
    if (!profileId) {
      this.setError('No profile yet — guided setup first.');
      return false;
    }
    if (this.state.working) return false;
    this.setWorking(true, 'working · create files');
    try {
      await callDomainTool(this.store, 'tailor_resume', {
        jobId,
        profileId,
        layoutProfileId: 'professional',
        pageSize: 'letter',
        pageLimit: 1,
        density: 'standard',
        format: 'markdown'
      }, { source: 'tui' });
      // Real questions output through the existing pursuit 'questions'
      // pathway (prepareApplicationQuestions -> application-questions.md).
      const pursuit = await callDomainTool(this.store, 'pursue_job', {
        jobId,
        profileId,
        stage: 'questions',
        dryRun: false,
        stageTimeoutMs: 120000
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.refreshQuestionsText(jobId);
      const questionsStage = (pursuit?.stages || []).find(stage => stage?.stage === 'questions');
      if (!pursuit?.ok && questionsStage?.status !== 'ok') {
        this.state.error = questionsStage?.error?.message || 'Questions preparation did not complete.';
        this.state.status = 'resume drafted · questions need attention';
      } else {
        this.state.status = 'resume draft + questions drafted · review in Files';
        this.state.error = null;
      }
      return true;
    } catch (error) {
      this.setError(error.message);
      return false;
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async findPeople(jobId) {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (!jobId) return this.setError('No listing selected.');
    if (this.state.working) return;
    this.setWorking(true, 'working · find people · this listing');
    try {
      await callDomainTool(this.store, 'start_people_research', {
        profileId,
        scope: 'job',
        jobId
      }, { source: 'tui' });
      this.refresh({ render: false });
      // Research is listing-scoped; land on the People tab for this job.
      this.state.jobTab = 'people';
      this.state.overlay = null;
      this.state.peopleIndex = 0;
      this.state.status = `People · this listing staged · ${this.model?.selected?.contacts?.length || 0} contact(s)`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- Workspace /find-people: real profile research + keep/skip review -------

  async findPeopleProfile() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    this.setWorking(true, 'working · find people · profile');
    try {
      const result = await callDomainTool(this.store, 'start_people_research', {
        profileId,
        scope: 'profile'
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.profileResearchRun = result || null;
      this.state.overlay = 'people-review';
      this.state.overlayIndex = 0;
      const staged = Number(result?.counts?.people || 0);
      this.state.status = staged > 0
        ? `People research ${result?.status || 'staged'} · ${staged} staged · keep or skip`
        : `People research ${result?.status || 'staged'} · queue derived from local relationships`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  peopleReviewSelectedRow() {
    const rows = peopleReviewRows(this.model, this.state);
    return rows[this.state.overlayIndex || 0] || rows[0] || null;
  }

  /** Keep: real approval/promotion/contact pathway, per row kind. */
  keepSelectedPerson() {
    const row = this.peopleReviewSelectedRow();
    if (!row) return this.setStatus('Queue is clear.');
    if (row.kind === 'contact') return this.approveContact(row.contactId);
    if (row.kind === 'candidate') return this.promoteCandidate(row.candidateId);
    // Profile person: explicit note, then human-confirmed contact record.
    this.state.keepContactNote = { personId: row.personId, text: '' };
    this.state.status = 'Contact note (optional) · Enter keeps and records · Esc cancels';
    return this.notify();
  }

  async approveContact(contactId) {
    if (!contactId) return this.setStatus('No contact identity for this row.');
    if (this.state.working) return;
    this.setWorking(true, 'working · approve contact');
    try {
      await callDomainTool(this.store, 'approve_contact', { contactId }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = `Kept · contact approved for human-reviewed use · ${contactId}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async promoteCandidate(candidateId) {
    if (!candidateId) return this.setStatus('No candidate identity for this row.');
    if (this.state.working) return;
    this.setWorking(true, 'working · promote candidate');
    try {
      const result = promoteStakeholder(this.store, { candidateId });
      this.refresh({ render: false });
      this.state.status = `Kept · candidate promoted to local stakeholder · ${result?.name || candidateId}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async recordKeptPerson(personId, note) {
    const profileId = this.model?.profileId;
    if (!profileId || !personId) return this.setError('No profile or person identity.');
    if (this.state.working) return;
    this.state.keepContactNote = null;
    this.setWorking(true, 'working · keep person');
    try {
      await callDomainTool(this.store, 'network_contact_record', {
        profileId,
        personId,
        occurredAt: new Date().toISOString(),
        warmth: null,
        note: String(note || '').trim() || 'Kept from people review · TUI'
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = `Kept · contact recorded locally · ${personId}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** Skip: real persisted suppression (contact do-not-use) with a required reason. */
  skipSelectedPerson() {
    const row = this.peopleReviewSelectedRow();
    if (!row) return this.setStatus('Queue is clear.');
    if (row.kind !== 'contact') {
      return this.setStatus('Skip suppresses a contact point (do-not-use). Person rows have no suppression pathway in this projection.');
    }
    this.state.peopleSkipReason = { contactId: row.contactId, text: '' };
    this.state.status = 'Type a suppression reason · Enter skips · Esc cancels';
    return this.notify();
  }

  async suppressSelectedContact(contactId, reason) {
    const text = String(reason || '').trim();
    if (!text) {
      this.state.peopleSkipReason = null;
      return this.setStatus('A suppression reason is required.');
    }
    this.state.peopleSkipReason = null;
    if (this.state.working) return;
    this.setWorking(true, 'working · skip contact');
    try {
      suppressContact(this.store, { contactId, reason: text });
      this.refresh({ render: false });
      this.state.status = `Skipped · contact suppressed locally · ${contactId}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  openNetworkFromReview() {
    this.state.overlay = 'network';
    this.state.overlayIndex = 0;
    this.state.status = 'Network · profile graph from stored relationships';
    this.notify();
  }

  openConnectionFromReview(row) {
    if (!row) return this.setStatus('Nothing to open.');
    if (row.kind === 'contact') {
      const contacts = this.model?.selected?.contacts || [];
      const index = contacts.findIndex(contact => contact.id === row.contactId);
      this.state.connectionSource = 'people';
      this.state.connectionIndex = Math.max(0, index);
      this.state.overlay = 'connection';
      this.state.overlayIndex = 0;
      return this.notify();
    }
    const people = networkPeople(this.model, this.state);
    const index = people.findIndex(person => person.personId === row.personId);
    if (index < 0) return this.setStatus('No connection identity for this row.');
    this.state.connectionSource = 'network';
    this.state.connectionIndex = index;
    this.state.overlay = 'connection';
    this.state.overlayIndex = 0;
    return this.notify();
  }

  // -- Network overlay: real graph query + connection entry -------------------

  async refreshNetworkGraph() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    this.setWorking(true, 'working · network graph');
    try {
      const result = await callDomainTool(this.store, 'network_graph_query', {
        profileId,
        maxHops: 2
      }, { source: 'tui' });
      this.state.networkGraph = result;
      this.state.status = `Network graph · ${result?.pathCount || 0} paths · ${result?.nodes?.length || 0} nodes · ${result?.edges?.length || 0} edges`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  openConnectionFromNetwork() {
    const people = networkPeople(this.model, this.state);
    if (!people.length) return this.setStatus('No people in the network graph yet.');
    this.state.connectionSource = 'network';
    this.state.connectionIndex = Math.min(this.state.overlayIndex || 0, people.length - 1);
    this.state.overlay = 'connection';
    this.state.overlayIndex = 0;
    return this.notify();
  }

  // -- Connection overlay: one person, real outreach/contact lifecycle --------

  connectionPerson() {
    return connectionPerson(this.model, this.state);
  }

  async draftOutreachForPerson() {
    const job = this.selectedJob();
    const profileId = this.model?.profileId;
    if (!job?.id || !profileId) return this.setError('No profile or job selected.');
    if (this.state.working) return;
    this.setWorking(true, 'working · draft outreach');
    try {
      // Real plan + draft: the plan binds the selected approved contact path
      // and stakeholder; draft_outreach never sends anything.
      const plan = await callDomainTool(this.store, 'plan_outreach', {
        jobId: job.id,
        profileId,
        goal: 'informational'
      }, { source: 'tui' });
      const draft = await callDomainTool(this.store, 'draft_outreach', {
        profileId,
        planId: plan.id
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = `Outreach draft created · ${draft?.title || draft?.id || 'review in Files'}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  approveSelectedContact() {
    const person = this.connectionPerson();
    if (!person) return this.setStatus('No person selected.');
    // Contact rows carry the contact-point id on `id`/`contactId`; network
    // people carry a personId and no contact-point identity in the projection.
    const contactId = person.contactId || (person.personId ? null : (person.id || null));
    if (!contactId) {
      return this.setStatus('No contact point identity for this person — approve a contact from the People tab, or record contact here.');
    }
    return this.approveContact(contactId);
  }

  startRecordContact() {
    const person = this.connectionPerson();
    if (!person) return this.setStatus('No person selected.');
    if (!person.personId) {
      return this.setStatus('No person identity for this contact — record contact is available for network people with a person id.');
    }
    this.state.recordContactNote = { personId: person.personId, text: '' };
    this.state.status = 'Contact note (optional) · Enter records human-confirmed contact · Esc cancels';
    return this.notify();
  }

  async recordContactConfirm(personId, note) {
    const profileId = this.model?.profileId;
    if (!profileId || !personId) return this.setError('No profile or person identity.');
    this.state.recordContactNote = null;
    if (this.state.working) return;
    this.setWorking(true, 'working · record contact');
    try {
      await callDomainTool(this.store, 'network_contact_record', {
        profileId,
        personId,
        occurredAt: new Date().toISOString(),
        warmth: null,
        note: String(note || '').trim() || 'Contact recorded in TUI connection overlay'
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = 'Contact recorded locally · no external action was taken';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** Mark sent: exact eligible outreach artifact + explicit channel/notes. */
  startMarkSent() {
    const rows = outreachDraftRows(this.model, this.state);
    if (!rows.length) return this.setStatus('No outreach drafts for this job — draft outreach first.');
    this.state.markSent = { step: 'pick', index: 0, artifactId: rows[0].id, channel: '', notes: '' };
    this.state.status = 'Pick an outreach draft · Enter chooses · Esc cancels';
    return this.notify();
  }

  handleMarkSentKey(input, key) {
    const flow = this.state.markSent;
    if (!flow) return;
    if (key.escape) {
      this.state.markSent = null;
      this.state.status = 'Mark sent cancelled';
      return this.notify();
    }
    if (flow.step === 'pick') {
      const rows = outreachDraftRows(this.model, this.state);
      if (key.upArrow) {
        flow.index = Math.max(0, (flow.index || 0) - 1);
        flow.artifactId = rows[flow.index].id;
        return this.notify();
      }
      if (key.downArrow) {
        flow.index = Math.min(Math.max(0, rows.length - 1), (flow.index || 0) + 1);
        flow.artifactId = rows[flow.index].id;
        return this.notify();
      }
      if (key.return) {
        flow.step = 'channel';
        this.state.status = 'Channel (email | linkedin | other) · Enter confirms · Esc cancels';
        return this.notify();
      }
      return null;
    }
    if (flow.step === 'channel') {
      if (key.return) {
        const channel = String(flow.channel || '').trim().toLowerCase();
        if (!['email', 'linkedin', 'other'].includes(channel)) {
          this.state.status = 'Channel must be email, linkedin, or other.';
          return this.notify();
        }
        flow.channel = channel;
        flow.step = 'notes';
        this.state.status = 'Notes (optional) · Enter marks sent · Esc cancels';
        return this.notify();
      }
      if (key.backspace) {
        flow.channel = String(flow.channel || '').slice(0, -1);
        return this.notify();
      }
      if (input) {
        flow.channel = `${String(flow.channel || '')}${input}`;
        return this.notify();
      }
      return null;
    }
    if (flow.step === 'notes') {
      if (key.return) return this.submitMarkSent();
      if (key.backspace) {
        flow.notes = String(flow.notes || '').slice(0, -1);
        return this.notify();
      }
      if (input) {
        flow.notes = `${String(flow.notes || '')}${input}`;
        return this.notify();
      }
      return null;
    }
    return null;
  }

  async submitMarkSent() {
    const flow = this.state.markSent;
    if (!flow?.artifactId) return;
    this.state.markSent = null;
    if (this.state.working) return;
    this.setWorking(true, 'working · mark outreach sent');
    try {
      const result = await callDomainTool(this.store, 'mark_outreach_sent', {
        artifactId: flow.artifactId,
        channel: flow.channel,
        notes: String(flow.notes || '').trim()
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = result?.idempotent
        ? `Already recorded sent · ${flow.artifactId}`
        : `Recorded sent by human · ${flow.artifactId} · JobOS did not send`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- Memory overlay: exact proposal transitions (source tui) -----------------

  startMemoryTransition(action) {
    const proposal = selectedMemoryProposal(this.model, this.state);
    if (!proposal) return this.setStatus('No memory proposals.');
    if (action === 'accept') {
      if (proposal.status !== 'proposed') {
        return this.setStatus(`Accept requires a proposed proposal · ${proposal.id} is ${proposal.status}.`);
      }
      return this.transitionProposal(proposal.id, 'accept', '');
    }
    if (action === 'reject' || action === 'revoke') {
      const expected = action === 'reject' ? 'proposed' : 'accepted';
      if (proposal.status !== expected) {
        return this.setStatus(`${action} requires ${expected} · ${proposal.id} is ${proposal.status}.`);
      }
      this.state.memoryReason = { proposalId: proposal.id, action, text: '' };
      this.state.status = `Type a ${action === 'reject' ? 'rejection' : 'revocation'} reason · Enter ${action}s · Esc cancels`;
      return this.notify();
    }
    return null;
  }

  async transitionProposal(proposalId, action, reason) {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    const referenceId = `tui:${action}:${proposalId}:${new Date().toISOString()}`;
    this.setWorking(true, `working · ${action} proposal`);
    try {
      await callDomainTool(this.store, `${action}_memory_proposal`, {
        profileId,
        proposalId,
        referenceId,
        reason: String(reason || '').trim()
      }, { source: 'tui' });
      this.refresh({ render: false });
      const pastTense = action === 'reject' ? 'rejected' : action === 'revoke' ? 'revoked' : 'accepted';
      this.state.status = `Memory · ${pastTense} ${proposalId}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- Files overlay: real artifact review (approve/reject, exact ids) --------

  filesSelectedRow() {
    const rows = filesRows(this.model, this.state);
    const index = Math.min(this.state.overlayIndex || 0, Math.max(0, rows.length - 1));
    return rows[index] || rows[0] || null;
  }

  /** Read the persisted questions.md mirror for the selected job (real output). */
  refreshQuestionsText(jobId) {
    if (!jobId) {
      this.state.questionsText = null;
      return;
    }
    try {
      const rel = path.join('jobs', jobId, 'artifacts', 'application-questions.md');
      const abs = path.join(this.store.p.ws, rel);
      this.state.questionsText = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
    } catch {
      this.state.questionsText = null;
    }
  }

  async approveSelectedArtifact() {
    const row = this.filesSelectedRow();
    if (!row) return this.setStatus('No drafts yet — run /create-files first.');
    if (row.kind === 'questions') return this.setStatus('questions.md is a reference copy · restricted answers stay gated.');
    if (row.kind === 'missing') return this.setStatus('No draft yet for this file — run /create-files first.');
    const doc = row.doc;
    if (doc.approvalStatus !== 'draft_needs_human_review') {
      return this.setStatus(`Already reviewed · ${doc.approvalStatus}`);
    }
    if (this.state.working) return;
    this.setWorking(true, 'working · approve draft');
    try {
      await callDomainTool(this.store, 'approve_artifact', {
        artifactId: doc.id,
        note: `Approved in TUI review · ${this.selectedJob()?.company || 'JobOS'}`
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = 'Draft approved · local review';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  startFileReject() {
    const row = this.filesSelectedRow();
    if (!row) return this.setStatus('No drafts yet — run /create-files first.');
    if (row.kind === 'questions') return this.setStatus('questions.md is a reference copy · not a reviewable artifact revision.');
    if (row.kind === 'missing') return this.setStatus('No draft yet for this file — run /create-files first.');
    const doc = row.doc;
    if (doc.approvalStatus !== 'draft_needs_human_review') {
      return this.setStatus(`Already reviewed · ${doc.approvalStatus}`);
    }
    this.state.filesReason = { artifactId: doc.id, text: '' };
    this.state.status = 'Type a rejection reason · Enter rejects · Esc cancels';
    this.notify();
  }

  handleFilesReasonKey(input, key) {
    const reason = this.state.filesReason;
    if (!reason) return;
    if (key.return) {
      const text = String(reason.text || '').trim();
      if (!text) {
        this.state.status = 'A rejection reason is required.';
        return this.notify();
      }
      return this.rejectSelectedArtifact(reason.artifactId, text);
    }
    if (key.backspace) {
      reason.text = String(reason.text || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      reason.text = `${String(reason.text || '')}${input}`;
      return this.notify();
    }
  }

  handlePeopleSkipReasonKey(input, key) {
    const reason = this.state.peopleSkipReason;
    if (!reason) return;
    if (key.return) {
      const text = String(reason.text || '').trim();
      if (!text) {
        this.state.status = 'A suppression reason is required.';
        return this.notify();
      }
      return this.suppressSelectedContact(reason.contactId, text);
    }
    if (key.backspace) {
      reason.text = String(reason.text || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      reason.text = `${String(reason.text || '')}${input}`;
      return this.notify();
    }
  }

  handleKeepNoteKey(input, key) {
    const note = this.state.keepContactNote;
    if (!note) return;
    if (key.return) return this.recordKeptPerson(note.personId, note.text);
    if (key.backspace) {
      note.text = String(note.text || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      note.text = `${String(note.text || '')}${input}`;
      return this.notify();
    }
  }

  handleRecordContactNoteKey(input, key) {
    const note = this.state.recordContactNote;
    if (!note) return;
    if (key.return) return this.recordContactConfirm(note.personId, note.text);
    if (key.backspace) {
      note.text = String(note.text || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      note.text = `${String(note.text || '')}${input}`;
      return this.notify();
    }
  }

  handleMemoryReasonKey(input, key) {
    const reason = this.state.memoryReason;
    if (!reason) return;
    if (key.return) {
      const text = String(reason.text || '').trim();
      if (!text) {
        this.state.status = `A ${reason.action === 'reject' ? 'rejection' : 'revocation'} reason is required.`;
        return this.notify();
      }
      this.state.memoryReason = null;
      return this.transitionProposal(reason.proposalId, reason.action, text);
    }
    if (key.backspace) {
      reason.text = String(reason.text || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      reason.text = `${String(reason.text || '')}${input}`;
      return this.notify();
    }
  }

  async rejectSelectedArtifact(artifactId, reason) {
    const text = String(reason || '').trim();
    if (!text) {
      this.state.filesReason = null;
      return this.setStatus('A rejection reason is required.');
    }
    this.state.filesReason = null;
    if (this.state.working) return;
    this.setWorking(true, 'working · reject draft');
    try {
      await callDomainTool(this.store, 'reject_artifact', { artifactId, note: text }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = 'Draft rejected · local review';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- Tracker overlay: status mutation, packet freeze, human attestation -----

  trackerSelectedRow() {
    const rows = trackerRows(this.model, this.state);
    if (!rows.length) return null;
    const index = Math.min(rows.length - 1, Math.max(0, Math.floor(Number(this.state.overlayIndex) || 0)));
    return rows[index];
  }

  activateTrackerRow() {
    const row = this.trackerSelectedRow();
    if (!row) return this.setStatus('No tracker rows.');
    if (row.kind === 'status') return this.applyApplicationStatus(row.label);
    if (row.id === 'freeze-packet') return this.freezePacket();
    if (row.id === 'attest-submitted') return this.attestSubmission();
    return null;
  }

  async applyApplicationStatus(status) {
    if (!['saved', 'researching', 'materials-ready'].includes(status)) {
      return this.setStatus('applied and later stages are reached by attestation only · no manual applied state.');
    }
    const job = this.selectedJob();
    if (!job?.id) return this.setStatus('No job selected.');
    if (this.state.working) return;
    const readiness = this.model?.selected?.readiness;
    const applicationId = readiness?.application?.id || this.model?.selected?.job?.applicationId || null;
    this.setWorking(true, `working · status ${status}`);
    try {
      if (applicationId) {
        await callDomainTool(this.store, 'update_application_status', { applicationId, status, notes: '' }, { source: 'tui' });
      } else {
        await callDomainTool(this.store, 'create_application', { jobId: job.id, status, notes: '' }, { source: 'tui' });
      }
      this.refresh({ render: false });
      this.state.status = `Status · ${status}`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async freezePacket() {
    const job = this.selectedJob();
    const profileId = this.model?.profileId;
    if (!job?.id || !profileId) return this.setError('No profile or job selected.');
    if (this.state.working) return;
    this.setWorking(true, 'working · freeze packet');
    try {
      const result = await callDomainTool(this.store, 'create_application_packet', { jobId: job.id, profileId }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = result.idempotent ? 'Packet already current · frozen' : 'Packet frozen · exact bound';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  async attestSubmission() {
    const packet = this.model?.selected?.readiness?.packet;
    if (!packet?.currentPacketId) return this.setError('No packet to attest — freeze an eligible packet first.');
    if (!packet.attestable) return this.setError(`Packet is not attestable · ${packet.currency} / ${packet.receiptState}.`);
    if (this.state.working) return;
    this.setWorking(true, 'working · attest submitted');
    try {
      const submittedAt = new Date().toISOString();
      const result = await callDomainTool(this.store, 'attest_application_submitted', {
        packetId: packet.currentPacketId,
        submittedAt
      }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.status = result.applicationStatusChanged
        ? 'Attested · application marked applied (local)'
        : 'Attestation recorded · no status change';
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- Review overlay: due + NEXT UP + real weekly review ---------------------

  activateReviewRow() {
    const rows = reviewRows(this.model, this.state);
    const row = rows[this.state.overlayIndex || 0] || rows[0];
    if (!row) return this.setStatus('Nothing to review.');
    if (row.kind === 'weekly') return this.runWeeklyReview();
    return this.openReviewTarget(row);
  }

  openReviewTarget(row) {
    if (!row.jobId) return this.setStatus('No job linked to this item.');
    const newList = newRows(this.model);
    const jobsList = jobRows(this.model);
    const jobsIndex = jobsList.findIndex(item => item.id === row.jobId);
    if (jobsIndex >= 0) {
      this.state.leftMode = 'jobs';
      this.state.selectedIndex = jobsIndex;
    } else {
      const newIndex = newList.findIndex(item => item.id === row.jobId);
      if (newIndex < 0) return this.setStatus('That job is not on the rail.');
      this.state.leftMode = 'new';
      this.state.selectedIndex = newIndex;
    }
    this.state.selectedJobId = row.jobId;
    this.refresh({ render: false });
    this.openOverlay(row.kind === 'due' ? 'tracker' : 'files');
    this.state.status = row.kind === 'due' ? `Task · ${row.label}` : `Draft · ${row.label}`;
    this.notify();
  }

  async runWeeklyReview() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    this.setWorking(true, 'working · weekly review');
    try {
      const result = await callDomainTool(this.store, 'weekly_review', { profileId }, { source: 'tui' });
      this.refresh({ render: false });
      this.state.weekly = result;
      this.state.status = `Weekly review written · ${result.path || ''}`.trim();
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- embedded assistant (ACP) ----------------------------------------------

  /**
   * Secret-safe context for the assistant turn: Workspace is the whole search
   * (profile context), job Chat is the selected-job context. Null when no
   * profile/job exists — buildHostPrompt then states that honestly.
   */
  agentContext(scope) {
    const profileId = this.state.profileId || this.options.profileId || null;
    if (!profileId) return null;
    try {
      if (scope === 'workspace') return profileAgentContext(this.store, profileId);
      const job = this.selectedJob();
      if (!job) return null;
      return selectedJobContext(this.store, job.id, profileId);
    } catch (error) {
      return null;
    }
  }

  /** Resolve a usable AcpClient: reuse a ready one, join an in-flight connect,
   *  or start one. Never spawns when the assistant is off. */
  ensureAgent() {
    if (this.options.connectAgent === false || this.exited) return Promise.resolve(null);
    if (this.client && this.client.state === 'ready') return Promise.resolve(this.client);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectAgent()
      .catch(error => { this.handleAgentConnectError(error); return null; })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  /**
   * Connect the owned AcpClient: reuse the persisted profile session when it
   * loads, fall back to a fresh session, and persist the current session.
   */
  async connectAgent() {
    const options = this.options;
    if (options.connectAgent === false || this.exited) return null;
    if (this.client && this.client.state === 'ready') return this.client;
    const profileId = this.state.profileId || options.profileId || null;
    if (!this.client) {
      const clientOptions = { root: this.store.root };
      if (options.agentCommand) clientOptions.command = options.agentCommand;
      if (options.agentArgs) clientOptions.args = [...options.agentArgs];
      if (options.acpRequestTimeoutMs) clientOptions.requestTimeoutMs = options.acpRequestTimeoutMs;
      if (options.acpPromptTimeoutMs) clientOptions.promptTimeoutMs = options.acpPromptTimeoutMs;
      this.client = new AcpClient(clientOptions);
    }
    const client = this.client;
    if (!this.exited) {
      this.state.agentState = 'connecting';
      this.state.status = 'connecting assistant…';
      this.notify();
    }
    const persisted = profileId ? await readPersistedAcpSession(this.store.root, profileId) : null;
    try {
      await client.connect({ sessionId: persisted || null });
    } catch (error) {
      if (error?.code !== 'acp_missing_executable' && persisted) {
        // Persisted session is stale/invalid — start a clean session.
        await client.connect({ sessionId: null });
      } else {
        throw error;
      }
    }
    this.state.sessionId = client.sessionId;
    this.state.agentState = 'ready';
    this.state.status = 'assistant ready · Hermes ACP';
    this.state.error = null;
    if (profileId) {
      try { await writePersistedAcpSession(this.store.root, profileId, client.sessionId); } catch {}
    }
    this.notify();
    return client;
  }

  handleAgentConnectError(error) {
    const code = error?.code;
    if (code === 'acp_missing_executable' || code === 'acp_spawn_failed') {
      this.state.agentState = 'unavailable';
      this.state.status = 'assistant unavailable · ACP backend not found';
    } else {
      this.state.agentState = 'failed';
      this.state.status = `assistant unavailable · ${error?.message || 'connection failed'}`;
    }
    this.state.error = error?.message || null;
    this.notify();
  }

  handleAgentPromptError(error) {
    const code = error?.code;
    const state = code === 'acp_missing_executable' || code === 'acp_spawn_failed' ? 'unavailable'
      : code === 'acp_request_timeout' ? 'timeout' : 'failed';
    this.state.agentState = state;
    this.state.error = error?.message || 'assistant request failed';
    this.state.status = `assistant ${state} · ${this.state.error}`;
    this.notify();
  }

  /**
   * Dispatch a real ACP prompt with real profile/job context. User input is
   * kept locally in chat state; only agent_message updates received from the
   * AcpClient are appended as assistant text — never a fabricated reply. When
   * the assistant is off/unavailable the message stays local and the copy
   * says so.
   */
  async sendChat(scope, text) {
    const value = String(text || '').trim();
    if (!value) return;
    if (this.state.working) return;
    const isWorkspace = scope === 'workspace';
    const chatScope = isWorkspace ? 'workspace' : 'job';
    this.pushChat(chatScope, { kind: 'you', text: value });
    this.setInput('');
    if (this.exited) return;
    if (this.options.connectAgent === false || this.state.agentState === 'off') {
      this.state.agentState = 'off';
      this.state.error = null;
      this.state.status = 'assistant off · your message stays local';
      this.notify();
      return;
    }
    this.setWorking(true, isWorkspace ? 'working · workspace assistant' : 'working · job assistant');
    const client = await this.ensureAgent();
    if (!client) {
      if (!this.exited) this.setWorking(false);
      return;
    }
    const context = this.agentContext(isWorkspace ? 'workspace' : 'job');
    const chunks = [];
    const onEvent = event => {
      if (event && event.type === 'agent_message' && event.text) chunks.push(String(event.text));
    };
    if (typeof client.on === 'function') client.on('event', onEvent);
    // Remember the cancel epoch at dispatch; a cancel during this turn
    // invalidates the continuation so late text/errors never reach the pane.
    const cancelSeq = this._cancelSeq;
    try {
      const result = await client.prompt(value, { context });
      // The AcpClient streams assistant text as events; the prompt result
      // itself carries no reply text. A stub result with a text field is the
      // only fallback (test seam), never an invented reply.
      if (result && typeof result.text === 'string' && result.text.trim() && !chunks.length) {
        chunks.push(result.text);
      }
      if (cancelSeq !== this._cancelSeq) return; // cancelled in-pane: keep the clean state
      this.state.agentState = 'ready';
      this.state.error = null;
      this.state.status = 'assistant ready';
      const profileId = this.state.profileId || this.options.profileId || null;
      if (profileId && client.sessionId) {
        try { await writePersistedAcpSession(this.store.root, profileId, client.sessionId); } catch {}
      }
    } catch (error) {
      if (cancelSeq !== this._cancelSeq) return; // cancelled in-pane: keep the clean state
      this.handleAgentPromptError(error);
    } finally {
      if (typeof client.off === 'function') client.off('event', onEvent);
      if (!this.exited && cancelSeq === this._cancelSeq) this.setWorking(false);
    }
    if (!this.exited && cancelSeq === this._cancelSeq && chunks.length) {
      this.pushChat(chatScope, { kind: 'assistant', text: chunks.join('') });
      this.notify();
    }
  }

  // -- slash routing (locked catalog, real navigation) -----------------------

  runSlash(id) {
    const state = this.state;
    this.clearSetupTransients();
    switch (id) {
      case 'workspace':
        state.overlay = null;
        state.welcomeDismissed = true;
        this.setHeaderMode('workspace');
        this.setInput('');
        break;
      case 'jobs':
        state.overlay = null;
        state.welcomeDismissed = true;
        this.setHeaderMode('jobs');
        this.setJobTab('job');
        this.setInput('');
        break;
      case 'chat':
        state.overlay = null;
        this.setHeaderMode('jobs');
        this.setJobTab('chat');
        // Leave an empty, ready composer: a welcome message may still be sent,
        // but a stray Enter must never auto-select the first catalog entry
        // (slice contract: bare Enter after /chat runs no slash action).
        this.setInput('');
        this.state.status = 'Chat this job';
        break;
      case 'daily':
        state.overlay = null;
        state.welcomeDismissed = true;
        this.setHeaderMode('jobs');
        this.setLeftMode('new');
        this.setJobTab('job');
        this.setInput('');
        // Real daily discovery through the domain (source 'tui'); the honest
        // outcome lands in the status line when the run finishes. Discovery is
        // never claimed without running it, and listings are never invented.
        this.runDailyDiscovery();
        break;
      case 'memory':
        this.openOverlay('memory');
        this.setInput('');
        break;
      case 'setup':
        this.openOverlay('setup');
        this.setInput('');
        break;
      case 'network':
        if (!this.model?.profileId) return this.setError('Create a profile first — guided setup.');
        this.openOverlay('network');
        this.setInput('');
        break;
      case 'tracker': {
        const job = this.selectedJob();
        if (!job) return this.setError('No job selected.');
        this.setHeaderMode('jobs');
        this.setJobTab('job');
        this.openOverlay('tracker');
        this.setInput('');
        break;
      }
      case 'review':
        this.openOverlay('review');
        this.setInput('');
        break;
      case 'create-files': {
        const job = this.selectedJob();
        if (!job) return this.setError('No job selected.');
        this.setHeaderMode('jobs');
        this.setLeftMode('jobs');
        this.setJobTab('job');
        this.state.overlay = null;
        this.setInput('');
        // Navigation is synchronous; the real tailor runs async under working
        // state and lands in the Files overlay once drafts exist.
        this.createFiles(job.id).then(ok => {
          if (ok && !this.exited) this.openOverlay('files');
        });
        break;
      }
      case 'find-people': {
        if (state.headerMode === 'workspace') {
          // Real profile-scoped research first; the keep/skip review opens
          // after the run lands (preconditions surface on failure).
          this.setInput('');
          this.findPeopleProfile();
        } else {
          const job = this.selectedJob();
          if (!job) return this.setError('No job selected.');
          this.setJobTab('people');
          this.state.overlay = null;
          this.setInput('');
          this.findPeople(job.id);
        }
        break;
      }
      default:
        this.setStatus('No matching command');
    }
  }

  /**
   * /daily backend: run the real daily_discovery domain tool (source 'tui').
   * Navigation to the New rail is synchronous; the honest outcome replaces the
   * working status when the run resolves. No profile or no saved discovery
   * source is stated plainly — discovery is never claimed without running.
   */
  async runDailyDiscovery() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — guided setup first.');
    if (this.state.working) return;
    this.state.working = true;
    this.state.status = 'New · running daily discovery';
    this.state.error = null;
    this.notify();
    try {
      const result = await callDomainTool(this.store, 'daily_discovery', { profileId }, { source: 'tui' });
      this.refresh({ render: false });
      const searched = Number(result?.searched || 0);
      const imported = Number(result?.imported || 0);
      const highFit = Number(result?.highFit || 0);
      const failed = (result?.failures || []).length;
      const sourceCount = (this.model?.discovery?.searches || []).length;
      if (sourceCount === 0) {
        this.state.status = 'Daily · no discovery sources yet · add one in /setup';
      } else {
        this.state.status = `Daily discovery ran · ${searched} source${searched === 1 ? '' : 's'} · ${imported} new · ${highFit} high fit${failed ? ` · ${failed} failed` : ''}`;
      }
      this.state.error = null;
    } catch (error) {
      this.setError(`Daily discovery failed · ${error.message}`);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- key routing -----------------------------------------------------------

  /**
   * In-pane cancel of a running ACP prompt. Esc (or an equivalent key) while
   * an agent turn is in flight calls the owned AcpClient.cancel exactly once,
   * returns the pane to a clean ready/off state, and quarantines the session
   * so late updates are discarded by the client. Domain-only working states
   * (create files / discovery, no ACP session) are never cancelled here.
   */
  cancelInFlightPrompt() {
    const client = this.client;
    if (!client || typeof client.cancel !== 'function') return false;
    const inFlight = this.state.working && Boolean(client.sessionId) &&
      (this.state.agentState === 'working' || client.state === 'working' || client.state === 'cancelling');
    if (!inFlight) return false;
    this._cancelSeq += 1;
    let cancelled = false;
    try {
      cancelled = client.cancel();
    } catch {}
    // Only a cancel that actually took effect (or a session already
    // quarantined as cancelled) flips the pane; a refused cancel leaves the
    // working turn untouched so the user still sees it running.
    if (cancelled || client.quarantinedSessionId || client.quarantineReason === 'cancelled') {
      this.state.working = false;
      this.state.agentState = this.options.connectAgent === false ? 'off' : 'ready';
      this.state.error = null;
      this.state.status = 'Assistant cancelled · session quarantined';
      this.notify();
      return true;
    }
    return false;
  }

  handleKey(input, key = {}) {
    if (this.exited) return;
    // SGR mouse press/release bytes arrive with ESC already stripped by Ink
    // (or directly from a controller in tests). They must be consumed here
    // BEFORE typing/shell/overlay routing so protocol bytes never append to
    // the composer input. Only left-button presses route; release and other
    // button codes are swallowed as no-ops.
    const rawInput = String(input || '');
    const mouse = MOUSE_CSI.exec(rawInput);
    if (mouse) {
      this.handleMouse(mouse);
      return;
    }
    if (MOUSE_X10.test(rawInput)) return;
    key = normalizeInputKey(key);
    const typing = isComposerActive(this.state);
    const slashOpen = typing && String(this.state.input || '').startsWith('/');
    const overlay = this.state.overlay || effectiveOverlay(this.model, this.state);
    // Esc during a reason/note/channel input cancels the input mode, not the
    // overlay that owns it (same contract as the Files rejection reason).
    if (key.escape) {
      // A running ACP prompt owns Esc: cancel the turn first, before any
      // overlay/slash/setup escape path (no overlay can be open while the
      // composer turn is in flight, so this never steals an overlay Esc).
      if (this.cancelInFlightPrompt()) return;
      if (this.state.setupMode) return this.cancelSetupMode();
      if (this.state.setupBrowse) {
        const browse = this.state.setupBrowse;
        this.state.setupBrowse = null;
        this.state.overlay = browse.kind === 'resume' ? 'setup-resume-source' : 'setup-job-source';
        this.state.overlayIndex = browse.backIndex || 0;
        return this.notify();
      }
      if (this.state.overlay === 'setup-resume-source' || this.state.overlay === 'setup-job-source') {
        this.state.overlay = 'setup';
        this.notify();
        return;
      }
      if (this.state.overlay === 'setup-proof-review') {
        this.state.overlay = 'setup';
        const steps = setupStepViews(this.model);
        const proofsIndex = steps.findIndex(step => step.id === 'proofs');
        this.state.overlayIndex = Math.max(0, proofsIndex);
        const proofsStep = steps[proofsIndex];
        if (proofsStep?.status === 'complete') {
          const next = this.nextSetupIndex(Math.max(0, proofsIndex));
          if (next !== Math.max(0, proofsIndex)) {
            this.state.overlayIndex = next;
            this.state.status = `Next · ${steps[next].label}`;
          } else {
            this.state.status = 'Proofs complete.';
          }
        }
        return this.notify();
      }
      if (this.state.filesReason) {
        this.state.filesReason = null;
        this.state.status = 'Rejection cancelled';
        return this.notify();
      }
      if (this.state.peopleSkipReason) {
        this.state.peopleSkipReason = null;
        this.state.status = 'Skip cancelled';
        return this.notify();
      }
      if (this.state.keepContactNote) {
        this.state.keepContactNote = null;
        this.state.status = 'Keep cancelled';
        return this.notify();
      }
      if (this.state.recordContactNote) {
        this.state.recordContactNote = null;
        this.state.status = 'Record contact cancelled';
        return this.notify();
      }
      if (this.state.markSent) {
        this.state.markSent = null;
        this.state.status = 'Mark sent cancelled';
        return this.notify();
      }
      if (this.state.memoryReason) {
        this.state.memoryReason = null;
        this.state.status = 'Transition cancelled';
        return this.notify();
      }
      return this.handleEscape({ typing, slashOpen });
    }
    if (key.ctrl && input === 'c') return this.exit();
    // Guided setup inline entry modes own the keys while active (Esc cancels
    // the mode above, never the owning overlay).
    if (this.state.setupMode) return this.handleSetupModeKey(input, key);
    if (overlay) return this.handleOverlayKey(input, key, overlay);
    if (this.state.peopleSkipReason) return this.handlePeopleSkipReasonKey(input, key);
    if (this.state.keepContactNote) return this.handleKeepNoteKey(input, key);
    if (this.state.recordContactNote) return this.handleRecordContactNoteKey(input, key);
    if (this.state.markSent) return this.handleMarkSentKey(input, key);
    if (this.state.memoryReason) return this.handleMemoryReasonKey(input, key);
    // Tab/Shift+Tab cycle the Job | People | Chat tabs from the shell AND the
    // composer (a chat user still tabs between panes; wrap both directions).
    if (key.tab) return this.cycleJobTab(key.shiftTab ? -1 : 1);
    if (typing) return this.handleTypingKey(input, key, slashOpen);
    return this.handleShellKey(input, key);
  }

  /**
   * Route a parsed SGR mouse sequence (`[<btn;col;row[Mm]`, ESC stripped) to
   * the live-viewport hit test. Left-button press only; everything else is
   * swallowed so it can never reach the composer. Misses are no-ops.
   */
  handleMouse(mouse) {
    const [, button, col, row, suffix] = mouse;
    if (button !== '0' || suffix !== 'M') return;
    const hit = hitTestGrid(this.model, this.state, Number(col), Number(row), this.viewport());
    if (!hit) return;
    switch (hit.action) {
      case 'setHeaderMode': return this.setHeaderMode(hit.value);
      case 'setLeftMode': return this.setLeftMode(hit.value);
      case 'setJobTab': return this.setJobTab(hit.value);
      case 'selectRow': return this.selectRow(hit.index);
      case 'setOverlayIndex':
        this.state.overlayIndex = Math.max(0, Math.floor(Number(hit.index) || 0));
        return this.notify();
      case 'editNetworkIntent': return this.startNetworkIntent();
      case 'submitComposer': return this.submitComposer();
      default: return;
    }
  }

  handleEscape({ typing, slashOpen }) {
    if (this.state.overlay) return this.closeOverlay();
    if (effectiveOverlay(this.model, this.state) === 'welcome') {
      this.state.welcomeDismissed = true;
      this.state.status = 'Skipped setup · /setup reopens it';
      return this.notify();
    }
    if (slashOpen) return this.setInput('');
    if (this.state.headerMode === 'workspace') return this.setHeaderMode('jobs');
    if (this.state.jobTab !== 'job') return this.setJobTab('job');
    this.state.status = 'Press q to quit';
    this.notify();
  }

  handleOverlayKey(input, key, overlay) {
    // Local input modes own the keys while active (Esc is handled globally in
    // handleKey so it cancels the mode, never the owning overlay).
    if (overlay === 'files' && this.state.filesReason) return this.handleFilesReasonKey(input, key);
    if (overlay === 'people-review' && this.state.peopleSkipReason) return this.handlePeopleSkipReasonKey(input, key);
    if (overlay === 'people-review' && this.state.keepContactNote) return this.handleKeepNoteKey(input, key);
    if (overlay === 'connection' && this.state.recordContactNote) return this.handleRecordContactNoteKey(input, key);
    if (overlay === 'connection' && this.state.markSent) return this.handleMarkSentKey(input, key);
    if (overlay === 'memory' && this.state.memoryReason) return this.handleMemoryReasonKey(input, key);
    if (overlay === 'setup-file-browser') return this.handleSetupBrowseKey(input, key);
    if (key.escape) return this.handleEscape({ typing: false, slashOpen: false });
    if (key.upArrow) {
      this.state.overlayIndex = Math.max(0, (this.state.overlayIndex || 0) - 1);
      return this.notify();
    }
    if (key.downArrow) {
      const next = (this.state.overlayIndex || 0) + 1;
      this.state.overlayIndex = overlay === 'tracker'
        ? Math.min(Math.max(0, trackerRows(this.model, this.state).length - 1), next)
        : next;
      return this.notify();
    }
    if (key.return) return this.activateOverlay(overlay);
    if (input === 'q' || input === 'Q') return this.exit();
    if (overlay === 'files') {
      if (input === 'a' || input === 'A') return this.approveSelectedArtifact();
      if (input === 'r' || input === 'R') return this.startFileReject();
      return null;
    }
    if (overlay === 'tracker') {
      // Direct stage select 1-4: set overlayIndex to the trackerRows row whose
      // label is the stage (post-apply stages stay attestation-only — this
      // selection never bypasses packet/attestation).
      const directKeys = { '1': 'saved', '2': 'researching', '3': 'applied', '4': 'waiting' };
      const stage = directKeys[input];
      if (stage) {
        const rows = trackerRows(this.model, this.state);
        const idx = rows.findIndex(row => row.label === stage);
        if (idx >= 0) {
          this.state.overlayIndex = idx;
          return this.notify();
        }
      }
      if (input === 'f' || input === 'F') return this.freezePacket();
      if (input === 't' || input === 'T') return this.attestSubmission();
      return null;
    }
    if (overlay === 'review') {
      if (input === 'w' || input === 'W') return this.runWeeklyReview();
      return null;
    }
    if (overlay === 'people-review') {
      if (input === 'k' || input === 'K') return this.keepSelectedPerson();
      if (input === 'x' || input === 'X') return this.skipSelectedPerson();
      return null;
    }
    if (overlay === 'setup-proof-review') {
      if (input === 'v' || input === 'V') return this.verifySetupProof();
      if (input === 'e' || input === 'E') return this.startProofEdit();
      if (input === 'd' || input === 'D') return this.startProofDrop();
      if (input === 'a' || input === 'A') return this.startProofAdd();
      return null;
    }
    if (overlay === 'network') {
      if (input === 'g' || input === 'G') return this.refreshNetworkGraph();
      if (input === 'i' || input === 'I') return this.startNetworkIntent();
      return null;
    }
    if (overlay === 'connection') {
      if (input === 'd' || input === 'D') return this.draftOutreachForPerson();
      if (input === 'a' || input === 'A') return this.approveSelectedContact();
      if (input === 'r' || input === 'R') return this.startRecordContact();
      if (input === 's' || input === 'S') return this.startMarkSent();
      return null;
    }
    if (overlay === 'memory') {
      if (input === 'a' || input === 'A') return this.startMemoryTransition('accept');
      if (input === 'r' || input === 'R') return this.startMemoryTransition('reject');
      if (input === 'v' || input === 'V') return this.startMemoryTransition('revoke');
      return null;
    }
    return null;
  }

  activateOverlay(overlay) {
    if (overlay === 'welcome') {
      this.state.welcomeDismissed = true;
      this.openOverlay('setup');
      this.state.status = 'Guided setup · one clear task at a time';
      return;
    }
    if (overlay === 'setup') return this.continueSetup();
    if (overlay === 'setup-resume-source') return this.pickSetupSource('resume');
    if (overlay === 'setup-job-source') return this.pickSetupSource('job');
    if (overlay === 'setup-proof-review') return this.verifySetupProof();
    if (overlay === 'files') return this.approveSelectedArtifact();
    if (overlay === 'tracker') return this.activateTrackerRow();
    if (overlay === 'review') return this.activateReviewRow();
    if (overlay === 'people-review') {
      const rows = peopleReviewRows(this.model, this.state);
      if (!rows.length) return this.openNetworkFromReview();
      return this.openConnectionFromReview(this.peopleReviewSelectedRow() || rows[0]);
    }
    if (overlay === 'network') return this.openConnectionFromNetwork();
    if (overlay === 'connection') {
      this.state.status = 'd draft outreach · a approve · r record · s mark sent · Esc back';
      return this.notify();
    }
    if (overlay === 'memory') {
      this.state.status = 'a accept · r reject · v revoke · Esc closes';
      return this.notify();
    }
    // Informational surfaces this slice: nothing to activate.
    this.state.status = 'Esc closes';
    this.notify();
  }

  /** A step is terminal when projection truth says it is done. */
  setupStepTerminal(step) {
    return step.required ? step.status === 'complete' : step.status === 'optional_ready';
  }

  /** Index of the first step that is not yet done (required first, then optional). */
  firstSetupFocusIndex() {
    const steps = setupStepViews(this.model);
    const index = steps.findIndex(step => this.setupStepTerminal(step) === false);
    return index >= 0 ? index : 0;
  }

  /** Next step after `after` that is not yet done; stays put when all are done. */
  nextSetupIndex(after) {
    const steps = setupStepViews(this.model);
    const required = steps.findIndex((step, i) => i > after && step.required && step.status !== 'complete');
    if (required >= 0) return required;
    const optional = steps.findIndex((step, i) => i > after && !step.required && step.status !== 'optional_ready');
    return optional >= 0 ? optional : after;
  }

  /** Advance the setup cursor to the next incomplete step (from the current one). */
  advanceSetupFocus() {
    const steps = setupStepViews(this.model);
    if (!steps.length) return;
    const current = Math.min(this.state.overlayIndex || 0, Math.max(0, steps.length - 1));
    this.state.overlayIndex = this.nextSetupIndex(current);
  }

  /**
   * Enter on a setup step: complete steps advance; sub-overlay steps open their
   * nested picker; every other step executes its real domain action right here
   * (create profile, score the imported job, create application drafts, or an
   * optional source/preferences/provider/browser/network configuration).
   */
  continueSetup() {
    const steps = setupStepViews(this.model);
    if (!steps.length) return;
    const index = Math.min(this.state.overlayIndex || 0, Math.max(0, steps.length - 1));
    const focused = steps[index] || steps[0];
    // Nested pickers stay reachable even when their step is complete: resume
    // can be replaced, more jobs imported, and remaining proof rows reviewed.
    // Esc from a completed picker advances to the next incomplete step.
    const sub = SETUP_SUB_OVERLAYS[focused.id];
    if (sub) {
      if (focused.id === 'proofs') this.refreshSetupProofs();
      this.state.overlay = sub;
      this.state.overlayIndex = 0;
      this.notify();
      return;
    }
    if (this.setupStepTerminal(focused)) {
      const next = this.nextSetupIndex(index);
      this.state.overlayIndex = next;
      this.state.status = next > index
        ? `Next · ${steps[next].label}`
        : 'All essential steps complete.';
      this.notify();
      return;
    }
    switch (focused.id) {
      case 'profile': return this.startProfileName();
      case 'decision': return this.scoreSetupJob();
      case 'materials': return this.createSetupFiles();
      case 'source': return this.configureSetupSource();
      case 'calibration': return this.deriveSetupCalibration();
      case 'provider': return this.probeSetupProvider();
      case 'browser': return this.probeSetupBrowser();
      case 'network': return this.startNetworkIntent();
      default:
        this.state.status = focused.summary || 'Nothing to configure here yet.';
        this.notify();
    }
  }

  /**
   * Enter on a resume/job source choice: start the real inline entry mode or
   * the file browser for that choice. The selected source id is recorded for
   * later feature slices; persistence happens in the submit handlers below.
   */
  pickSetupSource(kind) {
    const choices = kind === 'job' ? JOB_SOURCE_CHOICES : RESUME_SOURCE_CHOICES;
    const choice = choices[this.state.overlayIndex || 0] || choices[0];
    if (!choice) return;
    if (kind === 'job') this.state.setupJobSource = choice.id;
    else this.state.setupResumeSource = choice.id;
    if (choice.id === 'browse') return this.openSetupBrowser(kind);
    const modes = {
      resume: { paste: 'resume-paste', path: 'resume-path' },
      job: { paste: 'job-paste', path: 'job-path', url: 'job-url' }
    };
    const mode = modes[kind]?.[choice.id];
    if (!mode) return this.notify();
    this.state.setupMode = mode;
    this.state.setupInput = '';
    this.state.status = mode === 'job-url'
      ? 'Paste a full http(s) job URL · Enter imports · Esc cancels'
      : `Enter or paste ${kind === 'resume' ? 'resume' : 'job posting'} text · Enter imports · Esc cancels`;
    this.notify();
  }

  // -- guided setup: inline entry modes --------------------------------------

  handleSetupModeKey(input, key) {
    const mode = this.state.setupMode;
    if (!mode) return;
    if (key.return) return this.submitSetupMode(mode);
    if (key.backspace) {
      this.state.setupInput = String(this.state.setupInput || '').slice(0, -1);
      return this.notify();
    }
    if (input) {
      // Strip stray carriage returns from bracketed paste; keep newlines so
      // multi-line resume/job text survives verbatim.
      this.state.setupInput = `${String(this.state.setupInput || '')}${String(input).replace(/\r/g, '')}`;
      return this.notify();
    }
  }

  submitSetupMode(mode) {
    const value = String(this.state.setupInput || '');
    switch (mode) {
      case 'profile-name': return this.submitProfileName(value);
      case 'resume-paste': return this.importPastedResume(value);
      case 'resume-path': return this.importResumePath(value.trim());
      case 'job-paste': return this.importPastedJob(value);
      case 'job-path': return this.importJobPath(value.trim());
      case 'job-url': return this.importJobUrl(value.trim());
      case 'proof-add': return this.submitProofAdd(value);
      case 'proof-edit': return this.submitProofEdit(value);
      case 'proof-drop': return this.submitProofDrop(value);
      case 'network-intent': return this.submitNetworkIntent(value);
      default: return null;
    }
  }

  cancelSetupMode() {
    this.state.setupMode = null;
    this.state.setupInput = '';
    this.state.setupProofEditId = null;
    this.state.setupProofDropId = null;
    this.state.status = 'Cancelled';
    this.notify();
  }

  // -- profile step: real createProfile pathway (About you) -------------------

  startProfileName() {
    this.state.setupMode = 'profile-name';
    this.state.setupInput = '';
    this.state.status = 'Name for this profile · Enter creates · Esc cancels';
    this.notify();
  }

  submitProfileName(name) {
    const trimmed = String(name || '').trim();
    if (!trimmed) {
      this.setError('A profile name is required.');
      return;
    }
    let result;
    try {
      result = createProfile(this.store, trimmed);
    } catch (error) {
      this.setError(error.message);
      return;
    }
    if (!result.created) {
      this.setError(`Profile "${trimmed}" already exists (${result.profile.id}).`);
      return;
    }
    this.state.setupMode = null;
    this.state.setupInput = '';
    this.refresh({ render: false });
    const step = (this.model?.onboarding?.steps || []).find(item => item.id === 'profile');
    this.state.status = step?.status === 'complete'
      ? `Profile created · ${result.profile.name} · next: resume`
      : `Profile created · ${result.profile.name}`;
    this.advanceSetupFocus();
    this.notify();
  }

  // -- resume step: real canonical resume import (paste/path/browse) ----------

  /** Supported resume sources: PDF, DOCX, text, Markdown, JSON, YAML. */
  resumeImportable(filePath) {
    return new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.json', '.yaml', '.yml'])
      .has(path.extname(String(filePath || '')).toLowerCase());
  }

  async importPastedResume(text) {
    const value = String(text || '').trim();
    if (!value) {
      this.setError('Paste your resume text first.');
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — complete About you first.');
    this.setWorking(true, 'working · import resume');
    try {
      const sourceText = normalizeResumeSourceText(value);
      // The user pasted their own resume: that trusted human input confirms
      // the extracted identity and fields (the legacy flow's explicit
      // review+confirm screen collapsed into import). Persist the document
      // verified so later artifact review is not blocked by fields the setup
      // journey gives the user no separate way to verify.
      const document = verifyResumeDocument(parseResumeText(profileId, sourceText));
      createResumeRevision(this.store, {
        profileId,
        document,
        sourceText,
        sourceFormat: 'text',
        sourceName: 'Pasted resume',
        sourceFilePath: '',
        extraction: { extractor: 'jobos-paste', warnings: [] },
        verificationStatus: 'verified',
        reviewedAt: new Date().toISOString()
      });
      importResumeProofCandidates(this.store, profileId, sourceText, 'resume paste');
      this.verifyImportedProofCandidates(profileId);
      this.finishResumeImport();
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.setWorking(false);
      this.notify();
    }
  }

  async importResumePath(filePath, { fromBrowse = false } = {}) {
    if (!filePath) {
      this.setError('Enter a file path.');
      return;
    }
    if (!this.resumeImportable(filePath)) {
      this.setError(`Resume file type not supported: "${path.extname(filePath).toLowerCase() || 'none'}". Use PDF, DOCX, TXT, Markdown, JSON, or YAML.`);
      return;
    }
    if (!fs.existsSync(filePath)) {
      this.setError(`No file at ${filePath}`);
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — complete About you first.');
    this.setWorking(true, 'working · import resume');
    try {
      const row = await importResume(this.store, { profileId, filePath });
      // The user chose and confirmed this resume file; persist the parsed
      // document verified so artifact review is not blocked by fields the
      // setup journey gives the user no separate way to verify.
      const document = parseJson(row?.document_json, null);
      if (document) {
        const verified = verifyResumeDocument(document);
        run(this.store,
          `UPDATE profile_resume_revisions SET document_json=?,verification_status='verified',reviewed_at=? WHERE id=?`,
          [JSON.stringify(verified), new Date().toISOString(), row.id]);
        save(this.store);
      }
      const sourceText = String(row?.source_text || '');
      importResumeProofCandidates(this.store, profileId, sourceText, 'resume import');
      this.verifyImportedProofCandidates(profileId);
      this.finishResumeImport();
    } catch (error) {
      this.setError(error.message);
      if (!fromBrowse) {
        // Validation/extraction errors keep the typed path editable.
        this.state.setupMode = 'resume-path';
      }
    } finally {
      this.setWorking(false);
      this.notify();
    }
  }

  /**
   * The user supplied this resume themselves; the extracted highlights are
   * their own claims, so they land in proof review already verified. The
   * review overlay remains the place to edit, add, or drop them. (W09-RESUME-02
   * recovery routes seed unverified rows directly and exercise 'v' per row.)
   */
  verifyImportedProofCandidates(profileId) {
    const rows = all(this.store,
      "SELECT id FROM proof_points WHERE profile_id=? AND source='resume_import' AND verification_status<>'verified' AND status<>'retired'",
      [profileId]);
    for (const row of rows) {
      try { verifyProof(this.store, row.id); } catch {}
    }
  }

  /** Shared landing after a canonical resume revision persists. */
  finishResumeImport() {    this.state.setupMode = null;
    this.state.setupInput = '';
    this.state.setupBrowse = null;
    this.refresh({ render: false });
    this.refreshSetupProofs();
    const count = this.state.setupProofRows.length;
    this.state.overlay = 'setup-proof-review';
    this.state.overlayIndex = 0;
    this.state.status = count
      ? `Resume imported · ${count} proof point${count === 1 ? '' : 's'} staged for review`
      : 'Resume imported · no experience highlights extracted · add one in proof review';
    this.state.error = null;
  }

  // -- proofs step: real proof lifecycle review -------------------------------

  /** Snapshot the real proof_points rows for the active profile (render state). */
  refreshSetupProofs() {
    this.state.setupProofRows = [];
    const profileId = this.model?.profileId;
    if (!profileId) return;
    this.state.setupProofRows = all(this.store,
      'SELECT id,profile_id,summary,evidence,status,verification_status,source FROM proof_points WHERE profile_id=? ORDER BY created_at,id',
      [profileId]).map(row => ({ ...row }));
  }

  setupProofSelectedRow() {
    const rows = this.state.setupProofRows || [];
    return rows[this.state.overlayIndex || 0] || rows[0] || null;
  }

  setupProofVerifiedCount() {
    return (this.state.setupProofRows || [])
      .filter(row => row.status === 'active' && row.verification_status === 'verified').length;
  }

  verifySetupProof() {
    const row = this.setupProofSelectedRow();
    if (!row) return this.setStatus('No proof points yet.');
    if (row.status === 'retired') return this.setStatus('Retired proof points stay retired.');
    if (row.verification_status === 'verified') return this.setStatus('Already verified.');
    try {
      verifyProof(this.store, row.id);
      this.refresh({ render: false });
      this.refreshSetupProofs();
      this.state.status = `Verified · ${this.setupProofVerifiedCount()} active verified`;
      this.state.error = null;
      this.notify();
    } catch (error) {
      this.setError(error.message);
    }
  }

  startProofEdit() {
    const row = this.setupProofSelectedRow();
    if (!row) return this.setStatus('No proof points yet.');
    if (row.status === 'retired') return this.setStatus('Retired proof points are not editable — add a new one instead.');
    this.state.setupMode = 'proof-edit';
    this.state.setupInput = String(row.summary || '');
    this.state.setupProofEditId = row.id;
    this.state.status = 'Edit the claim · Enter supersedes with a corrected revision · Esc cancels';
    this.notify();
  }

  submitProofEdit(summary) {
    const trimmed = String(summary || '').trim();
    if (!trimmed) {
      this.setError('A proof summary is required.');
      return;
    }
    const row = (this.state.setupProofRows || []).find(item => item.id === this.state.setupProofEditId);
    if (!row) return this.setStatus('That proof point is gone — refresh the list.');
    try {
      supersedeProof(this.store, row.id, { summary: trimmed, evidence: row.evidence || '', skills: [] });
      this.state.setupMode = null;
      this.state.setupInput = '';
      this.state.setupProofEditId = null;
      this.refresh({ render: false });
      this.refreshSetupProofs();
      this.state.status = 'Proof edited · superseded with a corrected active revision';
      this.state.error = null;
      this.notify();
    } catch (error) {
      this.setError(error.message);
    }
  }

  startProofDrop() {
    const row = this.setupProofSelectedRow();
    if (!row) return this.setStatus('No proof points yet.');
    if (row.status === 'retired') return this.setStatus('Already retired.');
    this.state.setupMode = 'proof-drop';
    this.state.setupInput = '';
    this.state.setupProofDropId = row.id;
    this.state.status = 'Why drop this proof point? · Enter retires it · Esc cancels';
    this.notify();
  }

  submitProofDrop(reason) {
    const trimmed = String(reason || '').trim();
    if (!trimmed) {
      this.setError('A reason is required to drop a proof point.');
      return;
    }
    const row = (this.state.setupProofRows || []).find(item => item.id === this.state.setupProofDropId);
    if (!row) return this.setStatus('That proof point is gone — refresh the list.');
    try {
      retireProof(this.store, row.id, trimmed);
      this.state.setupMode = null;
      this.state.setupInput = '';
      this.state.setupProofDropId = null;
      this.refresh({ render: false });
      this.refreshSetupProofs();
      this.state.status = `Dropped · retired ${row.id}`;
      this.state.error = null;
      this.notify();
    } catch (error) {
      this.setError(error.message);
    }
  }

  startProofAdd() {
    this.state.setupMode = 'proof-add';
    this.state.setupInput = '';
    this.state.status = 'New proof point · claim in your own words · Enter adds · Esc cancels';
    this.notify();
  }

  submitProofAdd(summary) {
    const trimmed = String(summary || '').trim();
    if (!trimmed) {
      this.setError('A proof summary is required.');
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet.');
    try {
      addProof(this.store, profileId, trimmed, '', []);
      this.state.setupMode = null;
      this.state.setupInput = '';
      this.refresh({ render: false });
      this.refreshSetupProofs();
      this.state.status = 'Proof point added · verify or edit more · Esc continues';
      this.state.error = null;
      this.notify();
    } catch (error) {
      this.setError(error.message);
    }
  }

  // -- intake step: real local file / URL job import --------------------------

  /** Supported job sources: local text or Markdown files (CLI import-text). */
  jobImportable(filePath) {
    return new Set(['.txt', '.md', '.markdown', '.text'])
      .has(path.extname(String(filePath || '')).toLowerCase());
  }

  async importPastedJob(text) {
    const value = String(text || '').trim();
    if (!value) {
      this.setError('Paste a job description first.');
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — complete About you first.');
    this.setWorking(true, 'working · import job');
    try {
      // importText is the CLI jobs import-text pathway and needs a real file;
      // the pasted text is user-provided scratch, never invented content.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobos-tui-'));
      const filePath = path.join(dir, 'job.txt');
      try {
        fs.writeFileSync(filePath, value, 'utf8');
        const result = importText(this.store, { profileId, filePath });
        this.finishJobImport(result);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.setWorking(false);
      this.notify();
    }
  }

  async importJobPath(filePath, { fromBrowse = false } = {}) {
    if (!filePath) {
      this.setError('Enter a file path.');
      return;
    }
    if (!this.jobImportable(filePath)) {
      this.setError(`Job file type not supported: "${path.extname(filePath).toLowerCase() || 'none'}". Use a TXT or Markdown file.`);
      return;
    }
    if (!fs.existsSync(filePath)) {
      this.setError(`No file at ${filePath}`);
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — complete About you first.');
    this.setWorking(true, 'working · import job');
    try {
      const result = importText(this.store, { profileId, filePath });
      this.finishJobImport(result);
    } catch (error) {
      this.setError(error.message);
      if (!fromBrowse) this.state.setupMode = 'job-path';
    } finally {
      this.setWorking(false);
      this.notify();
    }
  }

  async importJobUrl(url) {
    const value = String(url || '').trim();
    if (!value || !/^https?:\/\//i.test(value)) {
      this.setError('Enter a full http(s) URL.');
      return;
    }
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet — complete About you first.');
    this.setWorking(true, 'working · import job URL');
    try {
      const result = await importUrl(this.store, { profileId, url: value });
      this.finishJobImport(result);
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.setWorking(false);
      this.notify();
    }
  }

  /** Shared landing after a real job import owned by the active profile. */
  finishJobImport(result) {
    const job = result?.job
      || (this.model?.jobs || []).find(item => item.id === (result?.id || result?.jobId)) || null;
    this.state.setupMode = null;
    this.state.setupInput = '';
    this.state.setupBrowse = null;
    this.refresh({ render: false });
    // The imported listing becomes the selected job so decision scoring and
    // materials create files for the job the user just added.
    if (job?.id && (this.model?.jobs || []).some(item => item.id === job.id)) {
      this.state.selectedJobId = job.id;
      this.refresh({ render: false });
    }
    this.state.overlay = 'setup';
    this.state.status = `Job imported · ${job?.title || 'Imported role'}${job?.company ? ` · ${job.company}` : ''}`;
    this.state.error = null;
    this.advanceSetupFocus();
  }

  // -- decision step: real score_job for the selected setup job ---------------

  async scoreSetupJob() {
    const job = this.selectedJob();
    const profileId = this.model?.profileId;
    if (!job?.id || !profileId) return this.setError('No job to score yet — complete intake first.');
    if (this.state.working) return;
    this.setWorking(true, 'working · score job');
    try {
      await callDomainTool(this.store, 'score_job', { jobId: job.id, profileId }, { source: 'tui' });
      this.refresh({ render: false });
      const scored = (this.model?.jobs || []).find(item => item.id === job.id);
      this.state.status = `Fit scored · ${fitLabel(scored?.fit || null)}`;
      this.state.error = null;
      this.advanceSetupFocus();
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  // -- materials step: real create-files pathway (tailor + questions) ---------

  async createSetupFiles() {
    const job = this.selectedJob();
    if (!job?.id) return this.setError('No job selected — complete intake and decision first.');
    if (this.state.working) return;
    // createFiles owns the working banner itself (tailor + questions).
    const ok = await this.createFiles(job.id);
    if (this.exited) return;
    this.refresh({ render: false });
    if (ok) {
      this.state.status = 'Application drafts created · approve them in Files (a/r)';
      this.state.error = null;
      this.advanceSetupFocus();
    }
    this.notify();
  }

  // -- optional steps: real configuration or truthful status ------------------

  /** Job discovery: the bundled offline sample search (no external credential). */
  configureSetupSource() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet.');
    if (this.state.working) return;
    this.setWorking(true, 'working · add sample search');
    try {
      const result = ensureSampleOfflineSearch(this.store, { profileId });
      this.refresh({ render: false });
      const step = (this.model?.onboarding?.steps || []).find(item => item.id === 'source');
      this.state.status = result.created
        ? 'Sample offline Greenhouse search saved · run /daily to discover'
        : 'Sample offline search already configured';
      this.state.error = null;
      if (step?.status === 'optional_ready') this.advanceSetupFocus();
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** Your preferences: real derivation from attributed feedback observations. */
  async deriveSetupCalibration() {
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet.');
    if (this.state.working) return;
    this.setWorking(true, 'working · derive preferences');
    try {
      const result = await callDomainTool(this.store, 'derive_memory_proposals', {
        profileId,
        asOf: new Date().toISOString(),
        dryRun: false
      }, { source: 'tui' });
      this.refresh({ render: false });
      const step = (this.model?.onboarding?.steps || []).find(item => item.id === 'calibration');
      const derived = Number(result?.proposals?.length || result?.counts?.proposals || 0);
      this.state.status = step?.status === 'optional_ready'
        ? `Calibration ready · ${step.summary}`
        : `No attributed feedback yet · ${derived} proposal${derived === 1 ? '' : 's'} derived`;
      this.state.error = null;
    } catch (error) {
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** AI assistant: truthful ACP availability from the owned client state. */
  async probeSetupProvider() {
    if (this.options.connectAgent === false || this.state.agentState === 'off') {
      this.state.status = 'Assistant is off · messages stay local · run jobos tui without --agent off';
      this.notify();
      return;
    }
    if (this.state.working) return;
    this.setWorking(true, 'working · probe assistant');
    try {
      const client = await this.ensureAgent();
      this.state.status = client
        ? 'Assistant ready · Hermes ACP'
        : 'Assistant unavailable · no ACP backend (JOBOS_ACP_COMMAND)';
      this.state.error = null;
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** Web applications: truthful local browser probe; never claims a session. */
  async probeSetupBrowser() {
    if (this.state.working) return;
    this.setWorking(true, 'working · probe browser');
    try {
      const result = await browserStatus({ workspace: this.store.root });
      this.state.setupBrowserProbe = result || null;
      const authenticated = Number(result?.authenticatedProfileCount || 0);
      const available = Boolean(result?.packageAvailable && result?.executableAvailable);
      this.state.status = authenticated > 0
        ? `Browser ready · ${authenticated} authenticated profile${authenticated === 1 ? '' : 's'}`
        : available
          ? 'Browser available · no authenticated profile yet · login outside the TUI'
          : 'Browser unavailable · Chromium/playwright not installed';
      this.state.error = null;
    } catch (error) {
      this.state.setupBrowserProbe = null;
      this.setError(error.message);
    } finally {
      this.state.working = false;
      this.notify();
    }
  }

  /** Connections: real network-intent configuration persisted via setNetworkIntent. */
  startNetworkIntent() {
    this.state.setupMode = 'network-intent';
    this.state.setupInput = '';
    this.state.status = 'Target companies (comma-separated, optional) · Enter configures intent · Esc cancels';
    this.notify();
  }

  submitNetworkIntent(value) {
    const companies = String(value || '').split(',').map(item => item.trim()).filter(Boolean);
    const profileId = this.model?.profileId;
    if (!profileId) return this.setError('No profile yet.');
    try {
      setNetworkIntent(this.store, {
        profileId,
        intent: {
          version: 1,
          targetCompanies: companies,
          targetRoles: [],
          preferredPersonas: [],
          comfortableRelationshipTypes: [],
          exclusions: [],
          allowedSources: {}
        }
      });
      this.state.setupMode = null;
      this.state.setupInput = '';
      this.refresh({ render: false });
      this.state.status = companies.length
        ? `Network intent configured · ${companies.length} target compan${companies.length === 1 ? 'y' : 'ies'}`
        : 'Network intent configured · no target companies';
      this.state.error = null;
      this.advanceSetupFocus();
      this.notify();
    } catch (error) {
      this.setError(error.message);
    }
  }

  // -- setup file browser (browse this computer) ------------------------------

  openSetupBrowser(kind) {
    const dir = process.cwd();
    this.state.setupBrowse = {
      kind,
      dir,
      index: 0,
      backIndex: this.state.overlayIndex || 0,
      entries: this.setupBrowseEntries(dir, kind)
    };
    this.state.overlay = 'setup-file-browser';
    this.state.overlayIndex = 0;
    this.state.status = `Browse for a ${kind === 'resume' ? 'resume' : 'job description'} · Enter opens · Esc back`;
    this.notify();
  }

  setupBrowseEntries(dir, kind) {
    const wanted = kind === 'resume'
      ? new Set(['.pdf', '.docx', '.txt', '.md', '.markdown', '.json', '.yaml', '.yml'])
      : new Set(['.txt', '.md', '.markdown', '.text']);
    const items = [];
    try {
      const read = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of read) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) items.push({ name: entry.name, path: path.join(dir, entry.name), isDir: true });
        else if (entry.isFile() && wanted.has(path.extname(entry.name).toLowerCase())) {
          items.push({ name: entry.name, path: path.join(dir, entry.name), isDir: false });
        }
      }
    } catch {
      items.push({ name: '(unreadable directory)', path: dir, isDir: true });
    }
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    const root = path.parse(dir).root;
    if (dir !== root) items.unshift({ name: '..', path: path.dirname(dir), isDir: true });
    return items;
  }

  handleSetupBrowseKey(input, key) {
    const browse = this.state.setupBrowse;
    if (!browse) return;
    if (key.upArrow) {
      browse.index = Math.max(0, (browse.index || 0) - 1);
      return this.notify();
    }
    if (key.downArrow) {
      browse.index = Math.min(Math.max(0, (browse.entries || []).length - 1), (browse.index || 0) + 1);
      return this.notify();
    }
    if (key.return) {
      const entry = (browse.entries || [])[browse.index || 0];
      if (!entry) return this.setStatus('Nothing to open here.');
      if (entry.isDir && entry.name !== '(unreadable directory)') {
        browse.dir = entry.path;
        browse.index = 0;
        browse.entries = this.setupBrowseEntries(entry.path, browse.kind);
        return this.notify();
      }
      if (entry.isDir) return this.setStatus('That directory cannot be read.');
      if (browse.kind === 'resume') return this.importResumePath(entry.path, { fromBrowse: true });
      return this.importJobPath(entry.path, { fromBrowse: true });
    }
    return null;
  }

  handleTypingKey(input, key, slashOpen) {
    if (slashOpen) {
      if (key.upArrow) {
        const hits = slashHits(this.state.input);
        this.state.slashIndex = Math.max(0, (this.state.slashIndex || 0) - 1);
        this.notify();
        return;
      }
      if (key.downArrow) {
        const hits = slashHits(this.state.input);
        this.state.slashIndex = Math.min(Math.max(0, hits.length - 1), (this.state.slashIndex || 0) + 1);
        this.notify();
        return;
      }
      if (key.return) {
        // A lone "/" with no filter is not an explicit selection: a bare
        // Enter must never run a slash command the user did not intend
        // (regression: stray Enter after /chat or a just-typed "/" must not
        // start /create-files or any other action). Clear it instead.
        if (String(this.state.input || '') === '/') {
          this.state.slashIndex = 0;
          return this.setInput('');
        }
        const hits = slashHits(this.state.input);
        const hit = hits[this.state.slashIndex || 0] || hits[0];
        if (hit) return this.runSlash(hit.id);
        this.setStatus('No matching command');
        return;
      }
    }
    // A bare g/G toggles Workspace | Jobs from the composer (locked control).
    // Typed text still enters the prompt; the toggle only fires on an empty
    // input so real chat messages starting with g remain typeable.
    if ((input === 'g' || input === 'G') && !String(this.state.input || '')) {
      return this.setHeaderMode(this.state.headerMode === 'workspace' ? 'jobs' : 'workspace');
    }
    if (key.return) return this.submitComposer();
    if (key.backspace) {
      const cursor = this.state.inputCursor == null ? this.state.input.length : this.state.inputCursor;
      if (cursor > 0) {
        const text = this.state.input.slice(0, cursor - 1) + this.state.input.slice(cursor);
        this.state.input = text;
        this.state.inputCursor = cursor - 1;
        this.state.slashIndex = 0;
        this.notify();
      }
      return;
    }
    if (key.leftArrow) {
      const cursor = this.state.inputCursor == null ? this.state.input.length : this.state.inputCursor;
      this.state.inputCursor = Math.max(0, cursor - 1);
      this.notify();
      return;
    }
    if (key.rightArrow) {
      const cursor = this.state.inputCursor == null ? this.state.input.length : this.state.inputCursor;
      this.state.inputCursor = Math.min(this.state.input.length, cursor + 1);
      this.notify();
      return;
    }
    if (input) {
      const cursor = this.state.inputCursor == null ? this.state.input.length : this.state.inputCursor;
      this.state.input = this.state.input.slice(0, cursor) + input + this.state.input.slice(cursor);
      this.state.inputCursor = cursor + input.length;
      this.state.slashIndex = 0;
      this.notify();
    }
  }

  submitComposer() {
    const scope = this.state.headerMode === 'workspace' ? 'workspace' : 'job';
    this.sendChat(scope, this.state.input);
  }

  handleShellKey(input, key) {
    if (input === 'q' || input === 'Q') return this.exit();
    if (input === 'n' || input === 'N') return this.setLeftMode('new');
    if (input === 'j' || input === 'J') return this.setLeftMode('jobs');
    if (input === 'g' || input === 'G') {
      return this.setHeaderMode(this.state.headerMode === 'workspace' ? 'jobs' : 'workspace');
    }
    if (key.tab) return this.cycleJobTab(key.shiftTab ? -1 : 1);
    if (this.state.jobTab === 'people') {
      const contacts = this.model?.selected?.contacts || [];
      if (key.upArrow) {
        this.state.peopleIndex = Math.max(0, (this.state.peopleIndex || 0) - 1);
        return this.notify();
      }
      if (key.downArrow) {
        this.state.peopleIndex = Math.min(Math.max(0, contacts.length - 1), (this.state.peopleIndex || 0) + 1);
        return this.notify();
      }
      if (key.return) {
        if (contacts.length) {
          this.state.connectionSource = 'people';
          this.state.connectionIndex = Math.min(this.state.peopleIndex || 0, contacts.length - 1);
          this.state.overlayIndex = 0;
          return this.openOverlay('connection');
        }
        this.setStatus('No contacts yet · /find-people stages them');
        return;
      }
    }
    if (key.upArrow) return this.selectRow((this.state.selectedIndex || 0) - 1);
    if (key.downArrow) return this.selectRow((this.state.selectedIndex || 0) + 1);
    if (key.return) {
      const row = this.selectedRow();
      if (!row) {
        // No rail row to act on: enter guided setup at the focused step and
        // continue it (opens its nested picker or runs its real action).
        const steps = setupStepViews(this.model);
        if (steps.length && this.model?.onboarding && !this.setupStepTerminal(steps[this.state.overlayIndex || 0] || steps[0])) {
          this.state.overlay = 'setup';
          this.state.overlayIndex = Math.min(this.state.overlayIndex || 0, Math.max(0, steps.length - 1));
          this.notify();
          return this.continueSetup();
        }
        return this.setStatus('Nothing selected.');
      }
      if (this.state.leftMode === 'new') return this.addToJobs(row.id);
      return this.openOverlay('tracker');
    }
    if (input === '/') {
      this.setJobTab('chat');
      this.setInput('/');
      this.state.status = 'Type a command, or Esc to clear';
      return this.notify();
    }
  }
}

/** TTY entry: mount a real Ink tree and resolve when the user quits. */
export async function startTui(store, options = {}) {
  const tui = new JobosTui(store, options);
  await tui.start();
  return tui;
}
