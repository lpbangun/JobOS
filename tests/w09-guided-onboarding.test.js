import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/db.js';
import { createProfile, addProof, verifyProof } from '../src/profiles.js';
import { importText, updateJobStatus } from '../src/jobs.js';
import { callDomainTool } from '../src/domain-tools.js';
import { JobosTui } from '../src/tui.js';
import { SLASH_CATALOG } from '../src/tui/model.js';

const AS_OF = '2026-07-26T12:00:00.000Z';
const requiredIds = ['workspace', 'profile', 'resume', 'proofs', 'intake', 'decision', 'materials'];

function root() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-w09-'));
}

function cli(workspace, args, env = {}) {
  return spawnSync(process.execPath, ['src/cli.js', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, JOBOS_HOME: workspace, JOBOS_SEARCH_PROVIDER: 'none', JOBOS_ACP_COMMAND: '__missing__', ...env }
  });
}

function localJob(s, profileId, suffix) {
  const file = path.join(s.root, `${suffix}.txt`);
  writeFileSync(file, `Title: ${suffix} Product Manager\nCompany: Example ${suffix}\nBuild local-first education software.`);
  return importText(s, { profileId, filePath: file }).job;
}

function comparableJob(s, profileId, suffix) {
  const file = path.join(s.root, `comparable-${suffix}.txt`);
  writeFileSync(file, `Title: Product Manager\nCompany: Example ${suffix}\nLocation: Boston, MA\nIndustry: Education technology`);
  return importText(s, { profileId, filePath: file }).job;
}

function streams() {
  const stdout = { columns: 120, rows: 36, isTTY: false, writes: [], write(chunk) { this.writes.push(String(chunk)); }, on() {}, off() {} };
  const stdin = { columns: 120, rows: 36, isTTY: false, on() {}, off() {} };
  return { stdout, stdin };
}

function makeTui(store, options = {}) {
  const tui = new JobosTui(store, { ...streams(), connectAgent: false, now: () => new Date(AS_OF), ...options });
  tui.refresh();
  return tui;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('W09-JOURNEY-01 clean workspace has frozen steps and profile blocker', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const status = buildOnboardingStatus(s, { asOf: AS_OF });
  assert.equal(status.schema, 'jobos.onboarding-status.v1');
  assert.deepEqual(status.steps.filter(step => step.required).map(step => step.id), requiredIds);
  assert.equal(status.nextAction.id, 'create_profile');
  assert.equal(status.completedRequired, 1);
  assert.equal(status.totalRequired, 7);
  assert.equal(status.policy.projectionPersisted, false);
  assert.equal(status.policy.cloudKeyRequired, false);
});

test('W09-JOURNEY-04 profile ambiguity and ownership never select silently', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const a = createProfile(s, 'Alpha').profile.id;
  const b = createProfile(s, 'Beta').profile.id;
  const ambiguous = buildOnboardingStatus(s, { asOf: AS_OF });
  assert.equal(ambiguous.profileId, null);
  assert.equal(ambiguous.steps[1].status, 'blocked');
  assert.deepEqual(ambiguous.steps[1].evidence.profileIds, [a, b].sort());
  assert.throws(() => buildOnboardingStatus(s, { profileId: 'missing', asOf: AS_OF }), error => error.code === 'unknown_profile');
});

test('W09-RESUME-01..03 canonical resume and verified proof gates recompute without checkpoints', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  const missing = buildOnboardingStatus(s, { profileId, asOf: AS_OF });
  assert.equal(missing.steps.find(step => step.id === 'resume').blockers[0].code, 'resume_source_missing');
  const proof = addProof(s, profileId, 'Evidence', 'Source', []);
  // Imported/unverified proof must not complete setup.
  s.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [proof.id]);
  let projected = buildOnboardingStatus(s, { profileId, asOf: AS_OF });
  assert.equal(projected.steps.find(step => step.id === 'proofs').status, 'blocked');
  verifyProof(s, proof.id);
  projected = buildOnboardingStatus(s, { profileId, asOf: AS_OF });
  assert.equal(projected.steps.find(step => step.id === 'proofs').status, 'complete');
  assert.equal(s.db.exec("SELECT name FROM sqlite_master WHERE name LIKE '%onboarding%' OR name LIKE '%setup%'")[0], undefined);
});

test('W09-TRUST-03 and W09-TRUST-04 fixed projections are deterministic and zero-write', async () => {
  const { buildOnboardingStatus, nextOnboardingAction } = await import('../src/onboarding.js');
  const workspace = root();
  const s = await openStore({ workspace });
  createProfile(s, 'Alpha');
  const before = readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite'));
  const first = buildOnboardingStatus(s, { asOf: AS_OF });
  const second = buildOnboardingStatus(s, { asOf: AS_OF });
  assert.deepEqual(first, second);
  assert.deepEqual(nextOnboardingAction(first), first.nextAction);
  assert.deepEqual(readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite')), before);
  assert.equal(first.policy.preferencesMutatedByCalibration, false);
  assert.equal(first.policy.externalSideEffects, 'none');
});

test('W09-JOURNEY-05 setup CLI status and next use frozen JSON grammar', () => {
  const workspace = root();
  const statusRun = cli(workspace, ['setup', 'status', '--json']);
  assert.equal(statusRun.status, 0, statusRun.stderr);
  const status = JSON.parse(statusRun.stdout);
  const direct = cli(workspace, ['setup', '--json']);
  assert.equal(direct.status, 0, direct.stderr);
  assert.deepEqual(JSON.parse(direct.stdout).steps, status.steps);
  const nextRun = cli(workspace, ['setup', 'next', '--json']);
  assert.equal(nextRun.status, 0, nextRun.stderr);
  assert.deepEqual(Object.keys(JSON.parse(nextRun.stdout)), ['schema', 'profileId', 'jobId', 'state', 'nextAction', 'policy']);
});

test('W09-TRUST-02 injected capability failures are optional, typed, and redacted', async () => {
  const { inspectOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const status = await inspectOnboardingStatus(s, {
    asOf: AS_OF,
    includeCapabilities: true,
    agentProbe: async () => { throw new Error('token=secret-value'); },
    browserProbe: async () => ({ available: false, packageAvailable: false, executableAvailable: false, stateRoot: '/private/path' })
  });
  assert.equal(status.steps.find(step => step.id === 'provider').status, 'misconfigured');
  assert.equal(status.steps.find(step => step.id === 'browser').status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(status), /secret-value|private\/path/);
});

test('W09-RECOVERY-01 and W09-JOURNEY-05 TUI shows welcome only for no profile and /setup opens guided setup', async () => {
  const emptyStore = await openStore({ workspace: root() });
  const emptyTui = makeTui(emptyStore);
  assert.equal(emptyTui.state.overlay, null, 'welcome is derived');
  assert.equal(emptyTui.model.empty.noProfile, true);
  emptyTui.handleKey('', { name: 'return' });
  assert.equal(emptyTui.state.overlay, 'setup', 'Enter on welcome opens guided setup');

  const populatedStore = await openStore({ workspace: root() });
  createProfile(populatedStore, 'Alpha');
  const tui = makeTui(populatedStore);
  assert.equal(tui.state.overlay, null, 'a populated workspace opens the board');
  tui.runSlash('setup');
  assert.equal(tui.state.overlay, 'setup', '/setup opens guided setup');
  assert.equal(SLASH_CATALOG.some(item => item.id === 'setup'), true, 'setup is a locked slash command');
});

test('W09-RECOVERY-05 setup navigation, recompute, and Escape are zero-write', async () => {
  const workspace = root();
  const s = await openStore({ workspace });
  const tui = makeTui(s, { initialOverlay: 'setup' });
  const before = readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite'));
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'upArrow' });
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'escape' });
  assert.equal(tui.state.overlay, null);
  assert.deepEqual(readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite')), before);
});

test('W09-JOURNEY-02 TUI canonical form advances only after success and retains invalid correction input', async () => {
  const s = await openStore({ workspace: root() });
  const tui = makeTui(s, { initialOverlay: 'setup' });
  // About you: Enter opens name capture; submit succeeds and advances.
  const profileIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'profile');
  tui.state.overlayIndex = profileIndex;
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.setupMode, 'profile-name', 'profile step opens name capture');
  tui.handleKey('Guided Profile', { name: 'paste' });
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'profile').status, 'complete');
  assert.equal(tui.model.onboarding.nextAction.id, 'import_resume');

  // Resume: an invalid path keeps the input and the step stays blocked.
  const resumeIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui.state.overlayIndex = resumeIndex;
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup-resume-source');
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.setupMode, 'resume-path');
  tui.handleKey('/definitely/missing/resume.json', { name: 'paste' });
  tui.handleKey('', { name: 'return' });
  await tick();
  assert.equal(tui.state.setupMode, 'resume-path');
  assert.equal(tui.state.setupInput, '/definitely/missing/resume.json', 'invalid input is retained');
  assert.match(tui.state.status, /no file|ENOENT/i);
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'resume').status, 'blocked');
});

test('W09-RECOVERY-01 one person, one profile in the TUI; reopen keeps the workspace profile', async () => {
  const s = await openStore({ workspace: root() });
  createProfile(s, 'Alpha');
  const beta = createProfile(s, 'Beta').profile.id;
  const tui = makeTui(s, { initialOverlay: 'setup' });
  assert.equal(tui.model.profileId, tui.model.profiles[0].id, 'the TUI owns one profile');
  assert.equal(tui.model.profiles.some(profile => profile.id === beta), true, 'other profiles remain CLI-owned');
  const nextAction = tui.model.onboarding.nextAction;
  tui.handleKey('', { name: 'escape' });
  tui.runSlash('setup');
  assert.equal(tui.model.onboarding.profileId, tui.model.profiles[0].id, 'reopening keeps the same profile');
  assert.deepEqual(tui.model.onboarding.nextAction, nextAction);
  assert.equal(tui.state.profileId, tui.model.profiles[0].id);
});

test('W09-JOURNEY-04 the setup decision step scores the imported listing explicitly', async () => {
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Beta').profile.id;
  const job = localJob(s, profileId, 'first');
  const tui = makeTui(s, { profileId, initialOverlay: 'setup' });
  const decisionIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'decision');
  tui.state.overlayIndex = decisionIndex;
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 300));
  const scored = tui.model.jobs.find(item => item.id === job.id);
  assert.ok(scored?.fit?.contract === 'jobos.fit-score.v1', 'the explicit score persists for the setup listing');
  assert.match(tui.state.status, /Fit scored/);
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'decision').status, 'complete');
});

test('W09-CALIBRATION-01/02 derive stays explicit and never mutates preferences', async () => {
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  const job = localJob(s, profileId, 'calibration');
  updateJobStatus(s, job.id, 'saved');
  const preferencesBefore = s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]);
  const tui = makeTui(s, { profileId, selectedJobId: job.id, initialOverlay: 'setup' });
  const calibration = tui.model.onboarding.steps.find(step => step.id === 'calibration');
  assert.ok(['record_calibration', 'derive_calibration', 'review_calibration'].includes(calibration.actions[0]?.id), 'the calibration step lists a real action');
  const calibrationIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'calibration');
  tui.state.overlayIndex = calibrationIndex;
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.match(tui.state.status, /proposal|feedback|preferences/i, 'the derive step reports its real outcome');
  assert.deepEqual(s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]), preferencesBefore, 'derive never mutates preferences_json');
});

test('W09-RESUME-02 proof recovery routes execute through the setup proof overlay', async () => {
  const proofStepIndex = tui => tui.model.onboarding.steps.findIndex(step => step.id === 'proofs');
  const openProofs = tui => {
    tui.state.overlayIndex = proofStepIndex(tui);
    tui.handleKey('', { name: 'return' });
    assert.equal(tui.state.overlay, 'setup-proof-review');
  };

  // v verifies the highlighted claim.
  const verifyStore = await openStore({ workspace: root() });
  const verifyProfileId = createProfile(verifyStore, 'Verify').profile.id;
  const verifyOriginal = addProof(verifyStore, verifyProfileId, 'Needs verification', 'source', []);
  verifyStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [verifyOriginal.id]);
  const verifyTui = makeTui(verifyStore, { profileId: verifyProfileId, initialOverlay: 'setup' });
  openProofs(verifyTui);
  verifyTui.handleKey('v', { name: 'v' });
  assert.equal(verifyStore.db.exec('SELECT verification_status FROM proof_points WHERE id=?', [verifyOriginal.id])[0].values[0][0], 'verified');

  // e supersedes (replaces) the highlighted claim.
  const replaceStore = await openStore({ workspace: root() });
  const replaceProfileId = createProfile(replaceStore, 'Replace').profile.id;
  const replaceOriginal = addProof(replaceStore, replaceProfileId, 'Incorrect claim', 'source', []);
  replaceStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [replaceOriginal.id]);
  const replaceTui = makeTui(replaceStore, { profileId: replaceProfileId, initialOverlay: 'setup' });
  openProofs(replaceTui);
  replaceTui.handleKey('e', { name: 'e' });
  assert.equal(replaceTui.state.setupMode, 'proof-edit');
  replaceTui.state.setupInput = ''; // edit mode pre-fills the current claim; replace it
  replaceTui.handleKey('Corrected claim', { name: 'paste' });
  replaceTui.handleKey('', { name: 'return' });
  const replacement = replaceStore.db.exec('SELECT summary,evidence,status,verification_status,supersedes_proof_point_id FROM proof_points WHERE profile_id=? AND id<>?', [replaceProfileId, replaceOriginal.id])[0].values[0];
  assert.deepEqual(replacement, ['Corrected claim', 'source', 'active', 'verified', replaceOriginal.id]);
  assert.deepEqual(replaceStore.db.exec('SELECT status,retirement_reason FROM proof_points WHERE id=?', [replaceOriginal.id])[0].values[0], ['retired', 'superseded']);

  // d retires the highlighted claim with a reason.
  const retireStore = await openStore({ workspace: root() });
  const retireProfileId = createProfile(retireStore, 'Retire').profile.id;
  const retireOriginal = addProof(retireStore, retireProfileId, 'Withdraw claim', 'source', []);
  retireStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [retireOriginal.id]);
  const retireTui = makeTui(retireStore, { profileId: retireProfileId, initialOverlay: 'setup' });
  openProofs(retireTui);
  retireTui.handleKey('d', { name: 'd' });
  assert.equal(retireTui.state.setupMode, 'proof-drop');
  retireTui.handleKey('Source is no longer reliable', { name: 'paste' });
  retireTui.handleKey('', { name: 'return' });
  assert.deepEqual(retireStore.db.exec('SELECT status,retirement_reason FROM proof_points WHERE id=?', [retireOriginal.id])[0].values[0], ['retired', 'Source is no longer reliable']);

  // a adds a claim in the user's own words: only the human summary is entered,
  // so no evidence is invented — the row stores an empty evidence string.
  const addStore = await openStore({ workspace: root() });
  const addProfileId = createProfile(addStore, 'Add').profile.id;
  const addOriginal = addProof(addStore, addProfileId, 'Existing claim', 'source', []);
  addStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [addOriginal.id]);
  const addTui = makeTui(addStore, { profileId: addProfileId, initialOverlay: 'setup' });
  openProofs(addTui);
  addTui.handleKey('a', { name: 'a' });
  assert.equal(addTui.state.setupMode, 'proof-add');
  addTui.handleKey('New claim', { name: 'paste' });
  addTui.handleKey('', { name: 'return' });
  assert.deepEqual(addStore.db.exec('SELECT summary,evidence,status,verification_status FROM proof_points WHERE profile_id=? AND summary=?', [addProfileId, 'New claim'])[0].values[0], ['New claim', '', 'active', 'verified']);
});

test('W09-CALIBRATION-03 setup review mediates explicit accept and reject over eligible inactive proposals', async () => {
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  for (let index = 0; index < 3; index += 1) {
    const job = comparableJob(s, profileId, String(index));
    updateJobStatus(s, job.id, 'saved');
    await callDomainTool(s, 'record_job_feedback', {
      profileId, jobId: job.id,
      feedback: {
        schema: 'jobos.job-feedback-input.v1', decision: 'save', reasonCodes: ['role_fit', 'location'],
        signals: [
          { field: 'role_family', polarity: 'prefer', value: 'Product Manager', match: 'exact' },
          { field: 'location', polarity: 'prefer', value: 'Boston, MA', match: 'exact' }
        ],
        publicExplanation: '', privateNote: '', referenceId: `w09-guided-${index}`,
        occurredAt: `2026-07-${20 + index}T12:00:00.000Z`
      }
    }, { source: 'tui' });
  }
  await callDomainTool(s, 'derive_memory_proposals', { profileId, asOf: AS_OF, dryRun: false }, { source: 'tui' });
  const preferencesBefore = s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]);
  const tui = makeTui(s, { profileId, initialOverlay: 'setup' });
  const calibration = tui.model.onboarding.steps.find(step => step.id === 'calibration');
  assert.equal(calibration.actions[0].id, 'review_calibration');
  tui.runSlash('memory');
  assert.equal(tui.state.overlay, 'memory');
  assert.ok(tui.model.memory.proposals.length >= 2, 'inactive proposals are eligible for review');
  const [accepted, rejected] = tui.model.memory.proposals;
  tui.state.overlayIndex = tui.model.memory.proposals.findIndex(item => item.id === accepted.id);
  tui.handleKey('a', { name: 'a' });
  await new Promise(resolve => setTimeout(resolve, 80));
  tui.state.overlayIndex = tui.model.memory.proposals.findIndex(item => item.id === rejected.id);
  tui.handleKey('r', { name: 'r' });
  tui.handleKey('not representative', { name: 'paste' });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(tui.model.memory.proposals.find(item => item.id === accepted.id).status, 'accepted');
  assert.equal(tui.model.memory.proposals.find(item => item.id === rejected.id).status, 'rejected');
  assert.deepEqual(s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]), preferencesBefore);
});

test('W09-RECOVERY-03 expired blocks and uncertain current score remains visibly warned', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  const job = localJob(s, profileId, 'recovery');
  s.db.run("UPDATE jobs SET liveness_status='expired' WHERE id=?", [job.id]);
  let status = buildOnboardingStatus(s, { profileId, jobId: job.id, asOf: AS_OF });
  assert.equal(status.steps.find(step => step.id === 'decision').blockers[0].code, 'posting_expired');
  assert.ok(status.recovery.some(item => item.code === 'posting_expired'));
  s.db.run("UPDATE jobs SET liveness_status='uncertain',fit_score=75,score_json=? WHERE id=?", [JSON.stringify({ contract: 'jobos.fit-score.v1', jobId: job.id, profileId }), job.id]);
  status = buildOnboardingStatus(s, { profileId, jobId: job.id, asOf: AS_OF });
  const decision = status.steps.find(step => step.id === 'decision');
  assert.equal(decision.status, 'complete');
  assert.equal(decision.evidence.uncertaintyWarning, true);
});

test('W09-TRUST-01 keyless local intake does not require provider, browser, network, or calibration', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Offline').profile.id;
  const job = localJob(s, profileId, 'offline');
  const status = buildOnboardingStatus(s, { profileId, jobId: job.id, asOf: AS_OF });
  assert.equal(status.steps.find(step => step.id === 'intake').status, 'complete');
  assert.equal(status.policy.cloudKeyRequired, false);
  assert.equal(status.policy.providerRequired, false);
  assert.equal(status.policy.browserRequired, false);
  assert.equal(status.policy.calibrationRequired, false);
});
