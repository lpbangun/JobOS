import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/db.js';
import { createProfile, addProof, verifyProof } from '../src/profiles.js';
import { importText, updateJobStatus } from '../src/jobs.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';

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

test('W09-RECOVERY-01 and W09-JOURNEY-05 TUI auto-opens only for no profile and g opens setup', async () => {
  const { JobosTui, TUI_KEYMAP, TUI_HANDLED_KEYS } = await import('../src/tui.js');
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const emptyStore = await openStore({ workspace: root() });
  const emptyTui = new JobosTui(emptyStore, { stdout: output, connectAgent: false, now: () => new Date(AS_OF) });
  assert.equal(emptyTui.state.overlay, 'setup');

  const populatedStore = await openStore({ workspace: root() });
  createProfile(populatedStore, 'Alpha');
  const tui = new JobosTui(populatedStore, { stdout: output, connectAgent: false, now: () => new Date(AS_OF) });
  assert.equal(tui.state.overlay, null);
  tui.onKeypress('g', { name: 'g' });
  assert.equal(tui.state.overlay, 'setup');
  assert.deepEqual(TUI_KEYMAP.global.find(([key]) => key === 'g'), ['g', 'setup']);
  assert.ok(TUI_HANDLED_KEYS.global.includes('g'));
});

test('W09-RECOVERY-05 setup navigation, recompute, and Escape are zero-write', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const workspace = root();
  const s = await openStore({ workspace });
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  const before = readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite'));
  assert.equal(tui.state.overlayIndex, 1, 'setup starts on the first actionable blocker');
  tui.onKeypress('j', { name: 'j' });
  assert.equal(tui.state.overlayIndex, 2);
  tui.onKeypress('r', { name: 'r' });
  assert.equal(tui.state.overlay, 'setup');
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, null);
  assert.deepEqual(readFileSync(path.join(workspace, '.jobos', 'jobos.sqlite')), before);
});

test('W09-JOURNEY-02 TUI canonical form advances only after success and retains invalid correction input', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const s = await openStore({ workspace: root() });
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  assert.equal(tui.state.overlayIndex, 1, 'profile is the first actionable step');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'setup-profile');
  tui.state.input = 'Guided Profile';
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'profile').status, 'complete');
  assert.equal(tui.model.onboarding.nextAction.id, 'import_resume');
  assert.equal(tui.state.overlayIndex, 2);
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup-resume-source');
  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'setup-resume-path');
  tui.state.input = '/definitely/missing/resume.json';
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'setup-resume-path');
  assert.equal(tui.state.input, '/definitely/missing/resume.json');
  assert.match(tui.state.status, /ENOENT|no such file/i);
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'resume').status, 'blocked');
});

test('W09-JOURNEY-04/05 and W09-RECOVERY-01 setup profile selection survives close and reopen', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const s = await openStore({ workspace: root() });
  createProfile(s, 'Alpha');
  const beta = createProfile(s, 'Beta').profile.id;
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  tui.state.overlayIndex = 1;
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup-profile-picker');
  tui.state.overlayIndex = tui.model.profiles.findIndex(profile => profile.id === beta);
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup');
  assert.equal(tui.state.setupProfileId, beta);
  assert.equal(tui.model.onboarding.profileId, beta);
  const nextAction = tui.model.onboarding.nextAction;
  tui.onKeypress('', { name: 'escape' });
  tui.onKeypress('g', { name: 'g' });
  assert.equal(tui.model.onboarding.profileId, beta);
  assert.deepEqual(tui.model.onboarding.nextAction, nextAction);
  assert.equal(tui.state.profileId, beta);
});

test('W09-JOURNEY-04 in-setup job picker selects explicitly and keeps setup open', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Beta').profile.id;
  localJob(s, profileId, 'first');
  const second = localJob(s, profileId, 'second');
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, profileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  tui.state.overlayIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'decision');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup-job-picker');
  tui.state.overlayIndex = tui.model.jobs.findIndex(job => job.id === second.id);
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup');
  assert.equal(tui.state.setupJobId, second.id);
  assert.equal(tui.model.onboarding.jobId, second.id);
});

test('W09-CALIBRATION-01/02 guided feedback previews before confirm and derive stays explicit', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  const job = localJob(s, profileId, 'calibration');
  updateJobStatus(s, job.id, 'saved');
  const preferencesBefore = s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]);
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, profileId, selectedJobId: job.id, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  tui.state.overlayIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'calibration');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'setup-calibration');
  tui.state.input = JSON.stringify({ jobId: job.id, decision: 'save', reasonCodes: ['role_fit'], signals: [], publicExplanation: 'Strong role fit.', privateNote: 'private calibration note' });
  tui.onKeypress('', { name: 'return' });
  await tick();
  assert.equal(tui.state.pendingConfirm?.kind, 'setup-calibration-feedback');
  assert.match(tui.state.status, /Preview/);
  assert.equal(Number(s.db.exec('SELECT COUNT(*) AS count FROM career_memory_observations')[0].values[0][0]), 0);
  tui.onKeypress('y', { name: 'y' });
  await tick();
  assert.equal(Number(s.db.exec('SELECT COUNT(*) AS count FROM career_memory_observations')[0].values[0][0]), 1);
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'calibration').actions[0].id, 'derive_calibration');
  tui.openSetupAction(tui.model.onboarding.steps.find(step => step.id === 'calibration'));
  assert.equal(tui.state.pendingConfirm?.kind, 'setup-calibration-derive');
  tui.onKeypress('y', { name: 'y' });
  await tick();
  assert.deepEqual(s.db.exec('SELECT preferences_json FROM profiles WHERE id=?', [profileId]), preferencesBefore);
});

test('W09-CALIBRATION-03/04 and W09-TRUST-04/05 trusted boundaries remain W08-owned', async () => {
  const s = await openStore({ workspace: root() });
  const alpha = createProfile(s, 'Alpha').profile.id;
  const beta = createProfile(s, 'Beta').profile.id;
  const job = localJob(s, alpha, 'owned');
  const feedback = { schema: 'jobos.job-feedback-input.v1', decision: 'save', reasonCodes: ['role_fit'], signals: [], publicExplanation: '', privateNote: '', referenceId: 'w09-boundary', occurredAt: AS_OF };
  await assert.rejects(callDomainTool(s, 'record_job_feedback', { profileId: beta, jobId: job.id, feedback }, { source: 'tui' }), /belong|profile/i);
  await assert.rejects(callDomainTool(s, 'record_job_feedback', { profileId: alpha, jobId: job.id, feedback }, { source: 'mcp' }), error => error.code === 'human_memory_input_required');
  assert.equal(DOMAIN_TOOLS.some(tool => /setup|onboarding/.test(tool.name)), false);
});

test('W09-JOURNEY-03 materials completion matrix does not alias ready-for-review', async () => {
  const { isOnboardingMaterialsComplete } = await import('../src/onboarding.js');
  assert.equal(isOnboardingMaterialsComplete({ status: 'ready-for-review', localApprovalComplete: false }), false);
  for (const status of ['materials-ready', 'form-ready', 'form-blocked']) assert.equal(isOnboardingMaterialsComplete({ status }), true, status);
  assert.equal(isOnboardingMaterialsComplete({ status: 'blocked', materialsStatus: 'approved' }), true);
  assert.equal(isOnboardingMaterialsComplete({ status: 'blocked', localApprovalComplete: true }), true);
});

test('W09-RESUME-02 proof recovery exposes verify, replace, retire, and add routes', async () => {
  const { buildOnboardingStatus } = await import('../src/onboarding.js');
  const s = await openStore({ workspace: root() });
  const profileId = createProfile(s, 'Alpha').profile.id;
  const proof = addProof(s, profileId, 'Needs review', 'Source', []);
  s.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [proof.id]);
  const proofStep = buildOnboardingStatus(s, { profileId, asOf: AS_OF }).steps.find(item => item.id === 'proofs');
  assert.deepEqual(proofStep.actions.map(action => action.id), ['verify_proof', 'replace_proof', 'retire_proof', 'add_proof']);
});

test('W09-RESUME-02 setup executes each proof recovery route through canonical lifecycle state', async () => {
  const { JobosTui } = await import('../src/tui.js');
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const proofStepIndex = tui => tui.model.onboarding.steps.findIndex(step => step.id === 'proofs');
  const openRoute = (tui, routeIndex) => {
    tui.state.overlayIndex = proofStepIndex(tui);
    tui.onKeypress('', { name: 'return' });
    assert.equal(tui.state.overlay, 'setup-action-picker');
    tui.state.overlayIndex = routeIndex;
    tui.onKeypress('', { name: 'return' });
  };

  const verifyStore = await openStore({ workspace: root() });
  const verifyProfileId = createProfile(verifyStore, 'Verify').profile.id;
  const verifyOriginal = addProof(verifyStore, verifyProfileId, 'Needs verification', 'source', []);
  verifyStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [verifyOriginal.id]);
  const verifyTui = new JobosTui(verifyStore, { stdout: output, connectAgent: false, profileId: verifyProfileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  openRoute(verifyTui, 0);
  assert.equal(verifyTui.state.pendingConfirm?.kind, 'setup-proof-verify');
  verifyTui.onKeypress('y', { name: 'y' });
  assert.equal(verifyStore.db.exec('SELECT verification_status FROM proof_points WHERE id=?', [verifyOriginal.id])[0].values[0][0], 'verified');

  const replaceStore = await openStore({ workspace: root() });
  const replaceProfileId = createProfile(replaceStore, 'Replace').profile.id;
  const replaceOriginal = addProof(replaceStore, replaceProfileId, 'Incorrect claim', 'source', []);
  replaceStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [replaceOriginal.id]);
  const replaceTui = new JobosTui(replaceStore, { stdout: output, connectAgent: false, profileId: replaceProfileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  openRoute(replaceTui, 1);
  assert.equal(replaceTui.state.mode, 'setup-proof');
  replaceTui.state.input = 'Corrected claim | corrected source';
  replaceTui.onKeypress('', { name: 'return' });
  const replacement = replaceStore.db.exec('SELECT summary,evidence,status,verification_status,supersedes_proof_point_id FROM proof_points WHERE profile_id=? AND id<>?', [replaceProfileId, replaceOriginal.id])[0].values[0];
  assert.deepEqual(replacement, ['Corrected claim', 'corrected source', 'active', 'verified', replaceOriginal.id]);
  assert.deepEqual(replaceStore.db.exec('SELECT status,retirement_reason FROM proof_points WHERE id=?', [replaceOriginal.id])[0].values[0], ['retired', 'superseded']);

  const retireStore = await openStore({ workspace: root() });
  const retireProfileId = createProfile(retireStore, 'Retire').profile.id;
  const retireOriginal = addProof(retireStore, retireProfileId, 'Withdraw claim', 'source', []);
  retireStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [retireOriginal.id]);
  const retireTui = new JobosTui(retireStore, { stdout: output, connectAgent: false, profileId: retireProfileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  openRoute(retireTui, 2);
  assert.equal(retireTui.state.mode, 'setup-proof');
  retireTui.state.input = 'Source is no longer reliable';
  retireTui.onKeypress('', { name: 'return' });
  assert.deepEqual(retireStore.db.exec('SELECT status,retirement_reason FROM proof_points WHERE id=?', [retireOriginal.id])[0].values[0], ['retired', 'Source is no longer reliable']);

  const addStore = await openStore({ workspace: root() });
  const addProfileId = createProfile(addStore, 'Add').profile.id;
  const addOriginal = addProof(addStore, addProfileId, 'Existing claim', 'source', []);
  addStore.db.run("UPDATE proof_points SET verification_status='unverified' WHERE id=?", [addOriginal.id]);
  const addTui = new JobosTui(addStore, { stdout: output, connectAgent: false, profileId: addProfileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  openRoute(addTui, 3);
  assert.equal(addTui.state.mode, 'setup-proof');
  addTui.state.input = 'New claim | new source';
  addTui.onKeypress('', { name: 'return' });
  assert.deepEqual(addStore.db.exec('SELECT summary,evidence,status,verification_status FROM proof_points WHERE profile_id=? AND summary=?', [addProfileId, 'New claim'])[0].values[0], ['New claim', 'new source', 'active', 'verified']);
});

test('W09-CALIBRATION-03 setup review mediates explicit accept and reject over eligible inactive proposals', async () => {
  const { JobosTui } = await import('../src/tui.js');
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
  const output = { columns: 120, rows: 36, isTTY: false, write() {}, on() {}, off() {} };
  const tui = new JobosTui(s, { stdout: output, connectAgent: false, profileId, initialOverlay: 'setup', now: () => new Date(AS_OF) });
  const calibration = tui.model.onboarding.steps.find(step => step.id === 'calibration');
  assert.equal(calibration.actions[0].id, 'review_calibration');
  tui.openSetupAction(calibration);
  assert.equal(tui.state.overlay, 'memory');
  assert.equal(tui.state.memoryView, 'proposals');
  assert.ok(tui.model.memory.proposals.length >= 2);
  const [accepted, rejected] = tui.model.memory.proposals;
  tui.executeMemoryCommand(`accept ${accepted.id}`);
  assert.equal(tui.state.pendingConfirm?.kind, 'setup-memory-transition');
  tui.onKeypress('y', { name: 'y' });
  tui.executeMemoryCommand(`reject ${rejected.id} | not representative`);
  assert.equal(tui.state.pendingConfirm?.kind, 'setup-memory-transition');
  tui.onKeypress('y', { name: 'y' });
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
