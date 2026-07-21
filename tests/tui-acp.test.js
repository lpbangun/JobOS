import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { buildTuiModel } from '../src/tui-model.js';
import { defaultTuiState, JobosTui, renderTui, TUI_DOMAIN_ACTIONS } from '../src/tui.js';
import { callDomainTool } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';
import { runMcpDemo } from '../scripts/mcp-demo.js';
import { createArtifact } from '../src/artifacts.js';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-tui-test-'));
}

async function seededWorkspace(t, { jobs = 2, draft = true } = {}) {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  const proof = addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio case study', ['product', 'educator'], ['30%']);
  const imported = [];
  for (let index = 0; index < jobs; index++) {
    const file = path.join(root, `job-${index}.md`);
    writeFileSync(file, `Title: Product Manager ${index + 1}\nCompany: Learning Co ${index + 1}\nLocation: Remote\n\nLead educator discovery and launch a learning platform. Own product activation and cross-functional delivery.`);
    imported.push(importText(store, { profileId: profile.id, filePath: file }).job);
  }
  await callDomainTool(store, 'score_job', { jobId: imported[0].id, profileId: profile.id }, { source: 'tui' });
  if (draft) await tailor(store, imported[0].id, profile.id, 'resume');
  return { root, store, profile, proof, jobs: imported };
}

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

test('locked 011 snapshot is data-bound and keeps authoritative list/detail/agent orientation', async t => {
  const { store, profile, proof, jobs } = await seededWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id, at: '2026-07-15T12:00:00.000Z' });
  const state = { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobs[0].id, agentState: 'ready', sessionId: 'session-123' };
  const screen = renderTui(model, state, { width: 150, height: 46, color: false });

  assert.match(screen, /JOBOS · PM EdTech/);
  assert.match(screen, /DUE/);
  assert.match(screen, /INTERVIEW/);
  assert.match(screen, /NEW/);
  assert.match(screen, /FAILURE/);
  assert.match(screen, /JOBS · today/);
  assert.match(screen, /SELECTED JOB/);
  assert.match(screen, /AGENT/);
  assert.match(screen, /Hermes ACP · ready/);
  assert.match(screen, /Product Manager 1/);
  assert.match(screen, new RegExp(proof.id));
  assert.match(screen, /resume · draft_needs_human_review/);
  assert.match(screen, /side-effects:off/);
  assert.match(screen, /p pursue · z score · n network · o docs · q answers · i agent/);
});

test('agent is default-on, Escape does not hide it, overlays stay overlays, and navigation remains live while a turn is busy', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  assert.equal(tui.state.agentOn, true);
  assert.equal(tui.closeTransient(), false);
  assert.equal(tui.state.agentOn, true);

  tui.openOverlay('review');
  assert.equal(tui.state.overlay, 'review');
  assert.equal(tui.state.agentOn, true);
  tui.closeTransient();
  assert.equal(tui.state.overlay, null);

  tui.state.filter = 'all';
  const orderedJobs = tui.filtered();
  tui.state.selectedJobId = orderedJobs[0].id;
  tui.state.busy = 'agent';
  tui.moveSelection(1);
  assert.equal(tui.state.selectedJobId, orderedJobs[1].id);
  assert.equal(tui.state.busy, 'agent');
  tui.onKeypress('a', { name: 'a' });
  assert.equal(tui.state.agentOn, false);
  tui.onKeypress('a', { name: 'a' });
  assert.equal(tui.state.agentOn, true);
});

test('review queue opens the exact artifact revision, shows local readiness policy, and keeps document diff cancellable', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1 });
  const first = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id }).selected.docs[0];
  const revision = createArtifact(store, {
    jobId: jobs[0].id,
    profileId: profile.id,
    type: 'resume',
    path: `jobs/${jobs[0].id}/artifacts/resume-tailored.md`,
    title: 'Tailored resume revision',
    content: 'Revised proof-grounded resume content.',
    evidence: [{ proofPointId: 'proof-current' }],
    warnings: ['Review every claim before use.'],
    seriesKey: first.seriesKey
  });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });

  tui.openOverlay('review');
  const queuedIndex = tui.model.review.findIndex(item => item.id === revision.id);
  assert.ok(queuedIndex >= 0);
  tui.state.overlayIndex = queuedIndex;
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'docs');
  assert.equal(tui.state.selectedArtifactId, revision.id);
  assert.equal(tui.selectedDocument().id, revision.id);

  let screen = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(screen, new RegExp(`hash ${revision.contentHash}`));
  assert.match(screen, /history r1 .*r2/);
  assert.match(screen, /evidence/);
  assert.match(screen, /warning Review every claim/);
  tui.onKeypress('D', { name: 'd', shift: true });
  screen = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(screen, /DIFF r1 → r2/);
  tui.onKeypress('D', { name: 'd', shift: true });
  assert.equal(tui.state.docsDiff, false);

  const selected = tui.model.selected;
  assert.match(renderTui(tui.model, { ...tui.state, overlay: null }, { width: 150, height: 46, color: false }), /READINESS/);
  assert.ok(selected.policy);
  assert.equal(selected.policy.externalApply, 'user_configured_default_off');
});

test('document approval and rejection confirm locally, refresh review state, and retain Escape cancellation', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1 });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  const first = tui.model.review[0];
  tui.openOverlay('review');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.selectedDocument().id, first.id);

  tui.onKeypress('A', { name: 'a', shift: true });
  assert.equal(tui.state.mode, 'approve-confirm');
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'docs');
  assert.equal(tui.state.mode, 'normal');
  tui.onKeypress('A', { name: 'a', shift: true });
  tui.onKeypress('y', { name: 'y' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tui.model.selected.docs.find(item => item.id === first.id).approvalStatus, 'approved');
  assert.equal(tui.model.review.some(item => item.id === first.id), false);
  assert.equal(tui.model.selected.job.applicationStatus, null);

  const rejected = createArtifact(store, {
    jobId: jobs[0].id,
    profileId: profile.id,
    type: 'cover_letter',
    path: `jobs/${jobs[0].id}/artifacts/cover-letter.md`,
    title: 'Cover letter',
    content: 'Draft cover letter.',
    evidence: [],
    warnings: []
  });
  tui.refresh({ disk: false });
  tui.openDocuments(rejected.id);
  tui.onKeypress('X', { name: 'x', shift: true });
  assert.equal(tui.state.mode, 'reject-note');
  for (const char of 'Missing evidence') tui.onKeypress(char, { name: char.toLowerCase() });
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'reject-confirm');
  tui.onKeypress('y', { name: 'y' });
  await new Promise(resolve => setImmediate(resolve));
  const rejectedDoc = tui.model.selected.docs.find(item => item.id === rejected.id);
  assert.equal(rejectedDoc.approvalStatus, 'rejected');
  assert.equal(rejectedDoc.reviewNote, 'Missing evidence');
  assert.equal(tui.model.review.some(item => item.id === rejected.id), false);
  assert.match(tui.state.status, /queue, readiness, and audit log refreshed/);
});

test('review, log, network, documents, answers, discovery, system, and profile surfaces render real state', async t => {
  const { store, profile, jobs } = await seededWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobs[0].id, agentState: 'ready', catalog: [{ name: 'Hermes ACP', available: true, protocol: 'acp-v1', role: 'primary' }] };
  const expectations = {
    review: /draft_needs_human_review/,
    log: /job\.scored|artifact/,
    network: /No ranked warm path|strength/,
    docs: /resume|Tailored/,
    answers: /verified reusable answers/,
    discovery: /No discovery searches configured|last/,
    system: /Hermes ACP · available · acp-v1/,
    profile: /PM EdTech/
  };
  for (const [overlay, expected] of Object.entries(expectations)) {
    const screen = renderTui(model, { ...base, overlay }, { width: 120, height: 38, color: false });
    assert.match(screen, expected, `${overlay} overlay did not expose expected state`);
    assert.match(screen, /A:ready|agent:ready/, `${overlay} replaced the shell header`);
  }
});

test('TUI refresh observes an agent-side database mutation and shared capabilities remain in the external MCP door', async t => {
  const { root, store, profile, jobs } = await seededWorkspace(t, { draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobs[1].id;
  assert.equal(tui.model.jobs.find(job => job.id === jobs[1].id).fitScore, null);

  const agentStore = await openStore({ workspace: root });
  await callDomainTool(agentStore, 'score_job', { jobId: jobs[1].id, profileId: profile.id }, { source: 'acp' });
  tui.refresh();
  assert.equal(typeof tui.model.jobs.find(job => job.id === jobs[1].id).fitScore, 'number');

  const externalTools = new Set(mcpToolNames());
  for (const tool of Object.values(TUI_DOMAIN_ACTIONS)) assert.ok(externalTools.has(tool), `${tool} is missing from external MCP`);
  for (const tool of ['list_jobs', 'get_job_context', 'review_queue', 'discovery_health']) assert.ok(externalTools.has(tool));
});

test('first-run and no-job states are honest, actionable, and do not invent content', async t => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  let model = buildTuiModel(store, { at: '2026-07-15T12:00:00.000Z' });
  assert.equal(model.empty.noProfile, true);
  let screen = renderTui(model, { ...defaultTuiState(), agentState: 'unavailable', status: 'ACP unavailable: executable missing · press c to retry' }, { width: 120, height: 34, color: false });
  assert.match(screen, /No profile yet/);
  assert.match(screen, /jobos profile create/);
  assert.match(screen, /ACP unavailable/);
  assert.doesNotMatch(screen, /Example Learning|Acme/);

  const profile = createProfile(store, 'PM EdTech').profile;
  model = buildTuiModel(store, { profileId: profile.id });
  assert.equal(model.empty.noJobs, true);
  screen = renderTui(model, { ...defaultTuiState(), profileId: profile.id, agentState: 'offline' }, { width: 120, height: 34, color: false });
  assert.match(screen, /No jobs yet/);
  assert.match(screen, /Workspace healthy and empty/);
  assert.match(screen, /daily discovery/);
});

test('narrow terminals keep safety state, controls, and all three product panes reachable', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id });
  const screen = renderTui(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobs[0].id, agentState: 'ready' }, { width: 60, height: 24, color: false });
  assert.match(screen, /FX:OFF/);
  assert.match(screen, /JOBS · today/);
  assert.match(screen, /SELECTED JOB/);
  assert.match(screen, /AGENT/);
  assert.match(screen, /s sources · \? system · : command · Q quit/);
  assert.equal(screen.split('\n').length, 24);
});

test('external MCP demo initializes, calls shared tools, persists state, and exits cleanly', async t => {
  const { root, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const transcript = path.join(root, 'mcp-demo.jsonl');
  const result = await runMcpDemo({
    workspace: root,
    profileId: profile.id,
    jobId: jobs[0].id,
    output: transcript
  });
  assert.equal(result.ok, true);
  assert.equal(result.server.name, 'jobos');
  assert.ok(result.toolCount >= 5);
  assert.deepEqual(result.calledTools, ['score_job', 'get_job_context']);
  assert.equal(result.scoreAuditDelta, 1);
  assert.equal(result.fitAfter.overall, result.fitBefore.overall);
  assert.deepEqual(result.exit, { code: 0, signal: null });
});

test('documented Q quit restores and pauses terminal input', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  io.stdin.isTTY = true;
  io.stdout.isTTY = true;
  const rawModes = [];
  io.stdin.setRawMode = value => rawModes.push(value);
  let paused = false;
  const pause = io.stdin.pause.bind(io.stdin);
  io.stdin.pause = () => {
    paused = true;
    return pause();
  };
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  const running = tui.start();
  io.stdin.emit('keypress', 'Q', { name: 'q', shift: true });
  await running;
  assert.equal(tui.stopped, true);
  assert.equal(paused, true);
  assert.deepEqual(rawModes, [true, false]);
});
