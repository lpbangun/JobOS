import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, one, all } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { llmConfig } from '../src/llm.js';
import {
  JobosTui,
  renderTui,
  SETUP_STEP_LABELS,
  RESUME_SOURCE_CHOICES,
  JOB_SOURCE_CHOICES
} from '../src/tui.js';
import { SLASH_CATALOG } from '../src/tui/model.js';

const AS_OF = '2026-08-02T12:00:00.000Z';

test('--agent off remains deterministic degraded mode instead of naming a batch agent', () => {
  const config = llmConfig({ JOBOS_AGENT: 'off' });
  assert.equal(config.configured, false);
  assert.equal(config.degradedMode, true);
  assert.notEqual(config.provider, 'agent');
});

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-setup-navigation-'));
}

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 36;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function emptyTui() {
  const store = await openStore({ workspace: workspace() });
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false });
  tui.refresh();
  return { store, tui };
}

function screenOf(tui, width = 120, height = 36) {
  return renderTui(tui.model, tui.state, { width, height, color: false }).split('\n').join('\n');
}

function enter(tui) {
  tui.handleKey('', { name: 'return' });
}

const esc = () => tui => tui.handleKey('', { escape: true });

function typeText(tui, text) {
  tui.handleKey(text, { name: 'paste' });
}

// Resume text that parses with a verified identity and produces two
// achievement-style claims for proof review.
const RESUME_TEXT = [
  'Alex Chen',
  'alex@example.com',
  '+1 555 0100',
  '',
  '# Experience',
  'Senior Engineer | Acme Corp | Remote',
  '- Built a distributed scheduler that handles one million events daily',
  '- Led the migration of the deployment pipeline to cut release time in half'
].join('\n');

const JOB_TEXT = [
  'Title: Senior Product Manager',
  'Company: Acme Learning',
  'Location: Remote',
  '',
  'Lead educator discovery and launch a learning platform.',
  'Coordinate product and engineering teams to ship reliable workflows.',
  '',
  '## Requirements',
  '- Lead the migration of the deployment pipeline to cut release time in half',
  '- Coordinate product and engineering teams to ship reliable customer workflows',
  '- Preferred: experience with user research'
].join('\n');

test('SETUP-01 welcome is first-run chrome and continues into guided setup; Skip invents nothing', async t => {
  const { store, tui } = await emptyTui();
  assert.equal(tui.state.overlay, null, 'welcome is derived, not stored');
  assert.equal(tui.model.empty.noProfile, true);
  const welcome = screenOf(tui);
  assert.match(welcome, /welcome to jobos/i, 'welcome overlay renders on first run');
  assert.match(welcome, /Start guided setup/, 'welcome offers guided setup');
  assert.match(welcome, /Skip for now/, 'welcome offers skip');

  // Skip / Esc must not invent a profile, proofs, jobs, or contacts.
  esc()(tui);
  assert.equal(tui.state.welcomeDismissed, true);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM profiles').n, 0);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM proof_points').n, 0);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM jobs').n, 0);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM contact_points').n, 0);
  assert.equal(tui.model.empty.noProfile, true);

  // Enter continues into guided setup.
  const tui2 = (await emptyTui()).tui;
  tui2.handleKey('', { name: 'return' });
  assert.equal(tui2.state.overlay, 'setup', 'Enter on welcome opens guided setup');
  assert.equal(tui2.state.welcomeDismissed, true);
});

test('SETUP-02 step ids and labels match SETUP_STEP_LABELS and the onboarding projection', async t => {
  const { tui } = await emptyTui();
  const required = tui.model.onboarding.steps.filter(step => step.required).map(step => step.id);
  assert.deepEqual(required, ['workspace', 'profile', 'resume', 'proofs', 'intake', 'decision', 'materials']);
  const optional = tui.model.onboarding.steps.filter(step => !step.required).map(step => step.id);
  assert.deepEqual(optional, ['source', 'calibration', 'provider', 'browser', 'network']);
  for (const step of tui.model.onboarding.steps) {
    assert.equal(SETUP_STEP_LABELS[step.id], {
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
    }[step.id], `label for ${step.id}`);
  }
  tui.openOverlay('setup');
  const screen = screenOf(tui);
  assert.match(screen, /SET UP JOBOS — \d\/7 ESSENTIAL/, 'setup header counts essential steps with the current copy');
  assert.doesNotMatch(screen, /JOBOS ·/, 'the retired JOBOS · header token is never painted');
  assert.match(screen, /About you/, 'profile label renders');
  assert.match(screen, /Validate experience highlights/, 'proofs label renders');
  assert.match(screen, /Job discovery/, 'optional source label renders');
  assert.match(screen, /AI assistant/, 'optional provider label renders');
});

test('SETUP-03 the profile step creates the real profile and advances to resume', async t => {
  const { store, tui } = await emptyTui();
  tui.handleKey('', { name: 'return' }); // welcome -> setup
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'profile', 'setup starts on About you');
  enter(tui);
  assert.equal(tui.state.setupMode, 'profile-name', 'Enter opens name capture');
  typeText(tui, 'Alex Chen');
  enter(tui);
  const profile = one(store, 'SELECT * FROM profiles WHERE name=?', ['Alex Chen']);
  assert.ok(profile, 'the profile row is persisted');
  assert.equal(tui.model.profileId, profile.id, 'the created profile becomes the workspace profile');
  const profileStep = tui.model.onboarding.steps.find(step => step.id === 'profile');
  assert.equal(profileStep.status, 'complete', 'About you completes after creation');
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'resume', 'focus auto-advances to the resume step');
});

test('SETUP-04 the resume-source picker stays an overlay under setup with the locked choices', async t => {
  const { tui } = await emptyTui();
  tui.handleKey('', { name: 'return' });
  enter(tui); // profile name capture is skipped: drive the resume step directly
  tui.state.setupMode = null;
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-resume-source', 'Enter on resume opens the source chooser overlay');
  const screen = screenOf(tui);
  for (const choice of RESUME_SOURCE_CHOICES) {
    assert.match(screen, new RegExp(choice.label), `choice ${choice.id} renders`);
  }
  tui.handleKey('', { escape: true });
  assert.equal(tui.state.overlay, 'setup', 'Esc returns to setup');
});

test('SETUP-05 resume paste imports the canonical revision and lands in proof review', async t => {
  const { store, tui } = await emptyTui();
  const profile = createProfile(store, 'Alex Chen').profile;
  tui.refresh();
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  enter(tui);
  enter(tui); // first source choice: paste
  assert.equal(tui.state.setupMode, 'resume-paste', 'paste is the first source choice');
  typeText(tui, RESUME_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tui.state.overlay, 'setup-proof-review', 'paste import lands in proof review');
  const revision = one(store, 'SELECT * FROM profile_resume_revisions WHERE profile_id=? AND is_current=1', [profile.id]);
  assert.ok(revision, 'a canonical current resume revision is persisted');
  assert.ok(revision.document_json.includes('Alex Chen'), 'the revision stores the parsed identity');
  const staged = tui.state.setupProofRows;
  assert.ok(staged.length >= 2, 'imported claims are staged for human review');
  assert.ok(all(store, 'SELECT * FROM proof_points WHERE profile_id=?', [profile.id]).length >= 2, 'proof candidates persist in SQLite');
});

test('SETUP-06 proof review verifies, adds, and drops through the real proof lifecycle', async t => {
  const { store, tui } = await emptyTui();
  const profile = createProfile(store, 'Alex Chen').profile;
  tui.refresh();
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  enter(tui);
  enter(tui);
  typeText(tui, RESUME_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tui.state.overlay, 'setup-proof-review');

  // v verifies the highlighted claim.
  tui.handleKey('v', { name: 'v' });
  const verifiedCount = one(store, "SELECT COUNT(*) AS n FROM proof_points WHERE profile_id=? AND verification_status='verified'", [profile.id]).n;
  assert.ok(verifiedCount >= 1, 'verify persists verification_status=verified');

  // a adds a claim in the user's own words.
  tui.handleKey('a', { name: 'a' });
  assert.equal(tui.state.setupMode, 'proof-add');
  typeText(tui, 'Led quarterly planning');
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(one(store, "SELECT * FROM proof_points WHERE profile_id=? AND summary='Led quarterly planning'", [profile.id]), 'added claim persists');

  // d drops a claim with a reason (move the cursor onto the added claim first).
  const addedIndex = tui.state.setupProofRows.findIndex(row => row.summary === 'Led quarterly planning');
  assert.ok(addedIndex >= 0, 'the added claim is in the review list');
  tui.state.overlayIndex = addedIndex;
  tui.handleKey('d', { name: 'd' });
  assert.equal(tui.state.setupMode, 'proof-drop');
  typeText(tui, 'Not representative');
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(one(store, "SELECT status,retirement_reason FROM proof_points WHERE summary='Led quarterly planning'").status, 'retired');

  // Esc returns to setup and advances toward intake.
  tui.handleKey('', { escape: true });
  assert.equal(tui.state.overlay, 'setup');
  const proofsStep = tui.model.onboarding.steps.find(step => step.id === 'proofs');
  assert.equal(proofsStep.status, 'complete', 'one verified active proof completes the step');
});

test('SETUP-07 the job-source picker and paste import persist the listing', async t => {
  const { store, tui } = await emptyTui();
  const profile = createProfile(store, 'Alex Chen').profile;
  tui.refresh();
  const intakeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'intake');
  tui.state.overlayIndex = intakeIndex;
  enter(tui);
  assert.equal(tui.state.overlay, 'setup-job-source', 'Enter on intake opens the job-source overlay');
  const screen = screenOf(tui);
  for (const choice of JOB_SOURCE_CHOICES) {
    assert.match(screen, new RegExp(choice.label), `job choice ${choice.id} renders`);
  }
  enter(tui); // first choice: paste a job description
  assert.equal(tui.state.setupMode, 'job-paste');
  typeText(tui, JOB_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 80));
  const job = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND title=?', [profile.id, 'Senior Product Manager']);
  assert.ok(job, 'the listing is persisted');
  assert.equal(tui.state.overlay, 'setup', 'import returns to setup');
  const intakeStep = tui.model.onboarding.steps.find(step => step.id === 'intake');
  assert.equal(intakeStep.status, 'complete', 'intake completes with a saved listing');
});

test('SETUP-08 decision scores the imported job and materials create real files', async t => {
  const { store, tui } = await emptyTui();
  const profile = createProfile(store, 'Alex Chen').profile;
  tui.refresh();
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  enter(tui);
  enter(tui);
  typeText(tui, RESUME_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 60));
  tui.handleKey('v', { name: 'v' });
  tui.handleKey('', { escape: true }); // leave proof review back onto setup
  const intakeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'intake');
  tui.state.overlayIndex = intakeIndex;
  enter(tui);
  enter(tui);
  typeText(tui, JOB_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 80));

  const decisionIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'decision');
  tui.state.overlayIndex = decisionIndex;
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 250));
  const job = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND title=?', [profile.id, 'Senior Product Manager']);
  assert.ok(job.fit_score !== null || job.score_json, 'the fit decision is persisted');
  assert.match(tui.state.status, /Fit scored/, 'the score lands in the status line');

  const materialsIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'materials');
  tui.state.overlayIndex = materialsIndex;
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.match(tui.state.status, /Application drafts created/, 'materials creates the drafts');
  assert.ok(one(store, "SELECT * FROM artifacts WHERE job_id=? AND type='resume'", [job.id]), 'a resume artifact persists');
  const questionsPath = path.join(store.p.ws, 'jobs', job.id, 'artifacts', 'application-questions.md');
  assert.equal(existsSync(questionsPath), true, 'questions.md is written to the workspace');
});

test('SETUP-09 optional steps configure real state: source, network intent, provider off copy', async t => {
  const { store, tui } = await emptyTui();
  const profile = createProfile(store, 'Alex Chen').profile;
  tui.refresh();

  const sourceIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'source');
  tui.state.overlayIndex = sourceIndex;
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(one(store, 'SELECT * FROM saved_searches WHERE profile_id=?', [profile.id]), 'the sample offline search is saved');

  const networkIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'network');
  tui.state.overlayIndex = networkIndex;
  enter(tui);
  assert.equal(tui.state.setupMode, 'network-intent');
  typeText(tui, 'Acme Learning, EduCo');
  enter(tui);
  const prefs = JSON.parse(one(store, 'SELECT preferences_json FROM profiles WHERE id=?', [profile.id]).preferences_json);
  assert.ok(prefs.networkIntent?.completedAt, 'network intent persists with a completion timestamp');
  assert.deepEqual(prefs.networkIntent.targetCompanies, ['Acme Learning', 'EduCo']);

  const providerIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'provider');
  tui.state.overlayIndex = providerIndex;
  enter(tui);
  assert.match(tui.state.status, /Assistant is off/, 'provider step reports the assistant off truthfully with --agent off');
});

test('SETUP-10 setup navigation and Escape are zero-write', async t => {
  const { store, tui } = await emptyTui();
  tui.openOverlay('setup');
  const dbPath = path.join(store.root, '.jobos', 'jobos.sqlite');
  const before = readFileSync(dbPath);
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'upArrow' });
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { escape: true });
  assert.equal(tui.state.overlay, null, 'Esc returns to the board');
  assert.deepEqual(readFileSync(dbPath), before, 'pure navigation writes nothing');
});

test('SETUP-11 unsupported resume paths keep the input and show guidance', async t => {
  const { tui } = await emptyTui();
  const profile = createProfile(tui.store, 'Alex Chen').profile;
  tui.refresh();
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  enter(tui);
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'downArrow' });
  enter(tui); // third choice: enter a file path
  assert.equal(tui.state.setupMode, 'resume-path');
  typeText(tui, path.join(workspace(), 'resume.rtf'));
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(tui.state.setupMode, 'resume-path', 'invalid path keeps the path input open');
  assert.match(tui.state.error, /not supported/i, 'unsupported format guidance is shown');
});

test('SETUP-12 the full required journey completes end-to-end and every step persists', async t => {
  const { store, tui } = await emptyTui();
  const stepId = () => tui.model.onboarding.steps[tui.state.overlayIndex]?.id;
  const stepTo = id => {
    const index = tui.model.onboarding.steps.findIndex(step => step.id === id);
    assert.ok(index >= 0, `step ${id} exists`);
    tui.state.overlayIndex = index;
  };

  tui.handleKey('', { name: 'return' }); // welcome -> setup
  stepTo('profile');
  enter(tui);
  typeText(tui, 'Alex Chen');
  enter(tui);

  stepTo('resume');
  enter(tui);
  enter(tui);
  typeText(tui, RESUME_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(tui.state.overlay, 'setup-proof-review');
  tui.handleKey('v', { name: 'v' });
  tui.handleKey('', { escape: true }); // leave proof review back onto setup

  stepTo('intake');
  enter(tui);
  enter(tui);
  typeText(tui, JOB_TEXT);
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 80));

  stepTo('decision');
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 250));
  const job = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND title=?', [tui.model.profileId, 'Senior Product Manager']);
  assert.ok(job, 'the job is persisted');

  stepTo('materials');
  enter(tui);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.match(tui.state.status, /Application drafts created/);

  // Approve the exact draft in the Files overlay to finish materials.
  tui.openOverlay('files');
  await tui.approveSelectedArtifact();
  await new Promise(resolve => setTimeout(resolve, 60));
  const materials = tui.model.onboarding.steps.find(step => step.id === 'materials');
  assert.equal(materials.status, 'complete', 'materials completes after human approval');
  assert.equal(tui.model.onboarding.completedRequired, 7, 'all seven essential steps complete');
  assert.equal(tui.model.onboarding.state, 'complete');
});

test('SETUP-13 /setup reopens guided setup from anywhere and no profile switcher exists', async t => {
  const { tui } = await emptyTui();
  const profile = createProfile(tui.store, 'Alex Chen').profile;
  const second = createProfile(tui.store, 'Other Profile').profile;
  tui.refresh();
  assert.equal(tui.model.profileId, profile.id, 'the first profile is the workspace profile');
  tui.runSlash('setup');
  assert.equal(tui.state.overlay, 'setup', '/setup opens guided setup');
  const screen = screenOf(tui);
  assert.doesNotMatch(screen, /profile-switch|switch profile/i, 'no profile-switcher chrome');
  assert.equal(tui.model.onboarding.profileId, profile.id, 'one person, one profile in the TUI');
  assert.ok(second, 'the CLI may still hold other profiles');
});
