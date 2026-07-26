import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore } from '../src/db.js';
import { createProfile, addProof, verifyProof } from '../src/profiles.js';

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
