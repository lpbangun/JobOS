import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore } from '../src/db.js';
import { createProfile, verifyProof, listProofs } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { score } from '../src/scoring.js';
import { runPursuit } from '../src/workflows.js';
import { ensureSampleOfflineSearch, runSavedSearch, sampleOfflineDiscoveryFixturePath } from '../src/discovery.js';
import { connectAgentClient } from '../src/agent-setup.js';
import { buildTuiModel } from '../src/tui-model.js';
import { fitLabel, JobosTui, renderTui, defaultTuiState } from '../src/tui.js';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-top4-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function output(width = 140, height = 42) {
  return {
    columns: width,
    rows: height,
    isTTY: false,
    writes: [],
    write(chunk) { this.writes.push(String(chunk)); },
    on() {},
    off() {}
  };
}

test('fitLabel never says unscored/unknown when a score contract exists without overall', () => {
  assert.equal(fitLabel(null), 'unscored');
  assert.match(fitLabel({
    contract: 'jobos.fit-score.v1',
    overall: null,
    scoreStatus: 'insufficient_evidence',
    evidenceCoverage: 60
  }), /low evidence · 60%/);
  assert.doesNotMatch(fitLabel({
    contract: 'jobos.fit-score.v1',
    overall: null,
    scoreStatus: 'insufficient_evidence',
    evidenceCoverage: 60
  }), /unscored|unknown/);
  assert.match(fitLabel({
    contract: 'jobos.fit-score.v1',
    overall: 74,
    scoreStatus: 'scored',
    evidenceCoverage: 80
  }), /74\/100/);
});

test('dashboard FIT chip shows low evidence after score with overall=null', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, readFileSync(path.join(process.cwd(), 'samples/resume-proof-points.md'), 'utf8'));
  // Import via profile create path is heavy; score after job import with proofs verified if any.
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, readFileSync(path.join(process.cwd(), 'samples/job-description.md'), 'utf8'));
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  const fit = await score(store, job.id, profile.id);
  assert.equal(fit.contract, 'jobos.fit-score.v1');
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
  const text = renderTui(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false }, {
    width: 140, height: 42, color: false
  });
  assert.match(text, /FIT low evidence/i);
  assert.doesNotMatch(text, /FIT unscored|FIT unknown/);
});

test('opening docs after external CLI-like disk write reloads artifacts', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, readFileSync(path.join(process.cwd(), 'samples/job-description.md'), 'utf8'));
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  const tui = new JobosTui(store, { connectAgent: false, stdout: output(), now: () => new Date('2026-08-06T12:00:00.000Z') });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });

  // Simulate another process writing pursue artifacts into the same DB file.
  const writer = await openStore({ workspace: root });
  await runPursuit(writer, { jobId: job.id, profileId: profile.id });
  // Without disk reload, in-memory store is stale.
  tui.openDocuments();
  const screen = tui.lastScreen || renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(screen, /Tailored resume|Cover letter|YOUR DOCUMENTS/i);
  assert.doesNotMatch(screen, /No documents for this job/);
});

test('sample offline discovery fixture imports jobs without network', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  const fixture = sampleOfflineDiscoveryFixturePath();
  assert.ok(fixture.endsWith('discovery-greenhouse.json'));
  const seeded = ensureSampleOfflineSearch(store, { profileId: profile.id });
  assert.equal(seeded.created, true);
  assert.equal(seeded.config.fixture, fixture);
  const again = ensureSampleOfflineSearch(store, { profileId: profile.id });
  assert.equal(again.created, false);
  const result = await runSavedSearch(store, seeded.id);
  assert.ok(result.status === 'succeeded' || result.status === 'partial', JSON.stringify(result));
  assert.ok(Number(result.counts?.imported || 0) >= 1, `expected imports, got ${JSON.stringify(result.counts)}`);
  // At least one job should now exist for the profile.
  const model = buildTuiModel(store, { profileId: profile.id });
  assert.ok(model.jobs.length >= 1, 'fixture import should create jobs');
  assert.ok(model.discovery.searches.length >= 1);
});

test('priority strip offers build-network when artifacts exist and paths are empty', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, readFileSync(path.join(process.cwd(), 'samples/job-description.md'), 'utf8'));
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  await runPursuit(store, { jobId: job.id, profileId: profile.id });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
  const networkCard = model.priority.find(item => item.actionId === 'build_network' || item.target === 'build-network');
  assert.ok(networkCard, `expected build-network priority card, got ${JSON.stringify(model.priority)}`);
  assert.match(networkCard.text, /Build network \(b\)/);
});

test('agents connect hermes pipes Y for noninteractive tool enable', async t => {
  const root = workspace(t);
  const state = path.join(root, 'registration.txt');
  const stdinLog = path.join(root, 'stdin.txt');
  const executable = path.join(root, 'hermes');
  writeFileSync(executable, `#!/bin/sh
if [ "$1" = "mcp" ] && [ "$2" = "test" ]; then
  if [ -f "$FAKE_AGENT_STATE" ]; then
    printf 'Testing jobos...\\n  ✓ Connected (1ms)\\n  ✓ Tools discovered: 2\\n'
    exit 0
  fi
  printf '✗ Server jobos not found in config.\\n'
  exit 0
fi
if [ "$1" = "mcp" ] && [ "$2" = "add" ]; then
  # Read enable prompt answer from stdin (JobOS should send Y)
  if [ -t 0 ]; then
    printf 'Enable all tools? [Y/n]: '
  fi
  IFS= read -r answer || true
  printf '%s\\n' "$answer" > "$FAKE_STDIN_LOG"
  if [ "$answer" != "Y" ] && [ "$answer" != "y" ]; then
    printf 'Cancelled.\\n'
    exit 1
  fi
  printf '%s\\n' "$@" > "$FAKE_AGENT_STATE"
  printf "✓ Saved 'jobos'\\n"
  exit 0
fi
printf 'hermes 1.0\\n'
`, 'utf8');
  chmodSync(executable, 0o755);
  const env = {
    ...process.env,
    PATH: root,
    FAKE_AGENT_STATE: state,
    FAKE_STDIN_LOG: stdinLog
  };
  const result = await connectAgentClient('hermes', {
    workspace: root,
    cliPath: path.resolve('src/cli.js'),
    env,
    timeoutMs: 5_000
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.changed, true);
  assert.equal(result.verification.ok, true);
  assert.equal(readFileSync(stdinLog, 'utf8').trim(), 'Y');
});
