import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, all } from '../src/db.js';
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
  assert.match(tui.state.status, /rejected · redraft next: jobos tailor cover-letter/);
});

test('review, log, network, documents, answers, discovery, system, and profile surfaces render real state', async t => {
  const { store, profile, jobs } = await seededWorkspace(t);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobs[0].id, agentState: 'ready', catalog: [{ name: 'Hermes ACP', available: true, protocol: 'acp-v1', role: 'primary' }] };
  const expectations = {
    review: /draft_needs_human_review/,
    log: /job\.scored|artifact/,
    network: /No research run yet/,
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
  assert.match(screen, /s sources · \? system · b build-network · : command · Q quit/);
  assert.equal(screen.split('\n').length, 24);
});

test('model exposes network setup state, affiliation counts, and safe xAI display', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  const model = buildTuiModel(store, { profileId: profile.id });
  assert.ok(model.networkSetup, 'model.networkSetup is present');
  assert.equal(model.networkSetup.status, 'not_started', 'status is not_started without completed intent');
  assert.ok('affiliations' in model.networkSetup, 'affiliation counts present');
  assert.ok('importedConnectionCount' in model.networkSetup, 'imported connection count present');
  assert.equal(model.networkSetup.latestProfileRun, null, 'no profile run yet');
  assert.match(model.networkSetup.xaiState, /^(off|available|misconfigured)$/, 'xai state is a known value');
  assert.doesNotMatch(JSON.stringify(model.networkSetup), /XAI_API_KEY|xai_key/i, 'xai state never leaks the key');
});
test('b key opens build-network overlay without auto-run, default is save-only, scope is profile when no job selected', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = null;
  assert.equal(tui.state.overlay, null, 'no overlay initially');
  tui.onKeypress('b', { name: 'b' });
  assert.equal(tui.state.overlay, 'build-network', 'b opens build-network overlay');
  assert.equal(tui.state.busy, null, 'no auto-run triggered');
  const rendered = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(rendered, /Proposed scope: profile/, 'proposes profile scope without selected job');
  assert.match(rendered, /Save only/, 'save only is visible');
  assert.match(rendered, /Save and build/, 'save and build is visible');
  assert.doesNotMatch(rendered, /XAI_API_KEY|xai_key/i, 'no api key leak');
  assert.match(rendered, /xAI/, 'xAI state is shown');
});

test('build-network overlay proposes job scope with selected job', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobs[0].id;
  tui.model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id });
  tui.onKeypress('b', { name: 'b' });
  assert.equal(tui.state.overlay, 'build-network');
  const rendered = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(rendered, /Proposed scope: job/, 'proposes job scope with selected job');
});

test('existing navigation and overlays remain functional after build-network addition', async t => {
  const { store, profile, jobs } = await seededWorkspace(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = jobs[0].id;
  assert.equal(tui.state.agentOn, true, 'agent on by default');
  tui.openOverlay('review');
  assert.equal(tui.state.overlay, 'review');
  tui.closeTransient();
  assert.equal(tui.state.overlay, null);
  tui.onKeypress('n', { name: 'n' });
  assert.equal(tui.state.overlay, 'network', 'n still opens network');
  tui.closeTransient();
  tui.onKeypress('l', { name: 'l' });
  assert.equal(tui.state.overlay, 'log', 'l still opens log');
  tui.closeTransient();
  tui.onKeypress('r', { name: 'r' });
  assert.equal(tui.state.overlay, 'review', 'r still opens review');
  tui.closeTransient();
  tui.onKeypress('s', { name: 's' });
  assert.equal(tui.state.overlay, 'discovery', 's still opens discovery');
  tui.closeTransient();
  tui.onKeypress('v', { name: 'v' });
  assert.equal(tui.state.overlay, 'profile', 'v still opens profile');
  tui.closeTransient();
  const orderedJobs = tui.filtered();
  tui.state.selectedJobId = orderedJobs[0].id;
  tui.moveSelection(1);
  assert.equal(tui.state.selectedJobId, orderedJobs[1].id, 'navigation j/k still works');
  tui.state.busy = 'agent';
  tui.moveSelection(0);
  assert.equal(tui.state.busy, 'agent', 'busy state preserved during navigation');
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


function readIntent(store, profileId) {
  const row = all(store, 'SELECT preferences_json FROM profiles WHERE id=?', [profileId])[0];
  return JSON.parse(row.preferences_json || '{}').networkIntent || {};
}

function affiliationRows(store, profileId) {
  return all(store, 'SELECT type,organization,role_or_program,status,source FROM profile_affiliations WHERE profile_id=? ORDER BY type,organization', [profileId]);
}

function runCount(store, profileId) {
  return Number(all(store, 'SELECT COUNT(*) AS count FROM research_runs WHERE profile_id=?', [profileId])[0].count || 0);
}

test('build-network editor: editing a list field and toggling a source persists with completedAt', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = null;
  tui.onKeypress('b', { name: 'b' });
  assert.equal(tui.state.overlay, 'build-network');
  assert.ok(tui.state.networkDraft, 'draft seeded on open');

  // Move to target companies field and enter edit mode
  const items = renderTui(tui.model, tui.state, { width: 120, height: 40, color: false });
  assert.match(items, /Target companies/);
  // Find the targetCompanies item index
  const findIdx = (key) => {
    const list = tui.model.networkSetup;
    // buildNetworkItems order: status, schools, employers, communities, targetRoles, targetCompanies, ...
    const order = ['status', 'schools', 'employers', 'communities', 'targetRoles', 'targetCompanies', 'personas', 'relTypes', 'exclusions', 'sourcePublic', 'sourceLinkedin', 'sourceXai', 'connCount', 'latestRun', '_sep', 'saveOnly', 'saveBuild'];
    return order.indexOf(key);
  };
  tui.state.overlayIndex = findIdx('targetCompanies');
  // Enter edit mode
  tui.onOverlayKey('\r', { name: 'return' });
  assert.equal(tui.state.mode, 'build-network-field', 'entered field edit mode');
  // Type a value
  for (const ch of 'Acme Learning, EduCo') tui.onInputKey(ch, { name: ch });
  // Commit with Enter
  tui.onInputKey('\r', { name: 'return' });
  assert.equal(tui.state.mode, 'normal', 'edit mode exited after commit');
  assert.equal(tui.state.networkDraft.targetCompanies, 'Acme Learning, EduCo', 'draft updated with typed value');

  // Toggle LinkedIn source
  tui.state.overlayIndex = findIdx('sourceLinkedin');
  tui.onOverlayKey('\r', { name: 'return' });
  assert.equal(tui.state.networkDraft.sourceLinkedin, true, 'linkedin toggle flipped on');

  // Move to Save only and save
  tui.state.overlayIndex = findIdx('saveOnly');
  await tui.buildNetworkSaveOnly();
  assert.equal(tui.state.overlay, null, 'overlay closed after save');
  const intent = readIntent(store, profile.id);
  assert.equal(intent.version, 1, 'persisted intent has version 1');
  assert.ok(intent.completedAt, 'persisted intent has completedAt');
  assert.deepEqual(intent.targetCompanies, ['Acme Learning', 'EduCo'], 'target companies persisted and deduped');
  assert.equal(intent.allowedSources.linkedinImport, true, 'linkedin toggle persisted');
  assert.equal(runCount(store, profile.id), 0, 'Save only does not create a research run');
});

test('build-network editor: affiliation fields are confirmed and replace existing affiliations on save', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  // Seed a suggested affiliation so we can confirm replacement
  const { setNetworkIntent } = await import('../src/profiles.js');
  setNetworkIntent(store, { profileId: profile.id, intent: { version: 1, allowedSources: { publicWeb: true } }, affiliations: [{ type: 'school', organization: 'Old University', status: 'suggested' }] });
  assert.equal(affiliationRows(store, profile.id).length, 1, 'suggested affiliation seeded');

  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.onKeypress('b', { name: 'b' });
  const findIdx = (key) => ['status', 'schools', 'employers', 'communities', 'targetRoles', 'targetCompanies', 'personas', 'relTypes', 'exclusions', 'sourcePublic', 'sourceLinkedin', 'sourceXai', 'connCount', 'latestRun', '_sep', 'saveOnly', 'saveBuild'].indexOf(key);
  // Edit schools field
  tui.state.overlayIndex = findIdx('schools');
  tui.onOverlayKey('\r', { name: 'return' });
  // Clear the seeded value (edit mode pre-fills with current), then type new schools
  const seeded = tui.state.input;
  for (let i = 0; i < seeded.length; i++) tui.onInputKey('\b', { name: 'backspace' });
  for (const ch of 'Stanford (MBA), MIT') tui.onInputKey(ch, { name: ch });
  tui.onInputKey('\r', { name: 'return' });

  // Save
  tui.state.overlayIndex = findIdx('saveOnly');
  await tui.buildNetworkSaveOnly();
  const rows = affiliationRows(store, profile.id);
  assert.equal(rows.length, 2, 'old suggested affiliation replaced by two confirmed schools');
  assert.ok(rows.every(r => r.status === 'confirmed'), 'all affiliations confirmed');
  assert.ok(rows.some(r => r.organization === 'Stanford' && r.role_or_program === 'MBA'), 'role/program shorthand parsed');
  assert.ok(rows.some(r => r.organization === 'MIT'), 'plain organization parsed');
});

test('build-network editor: Enter on Save only does not create a run; explicit Save and build creates the proposed-scope run', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  // No selected job → profile scope
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = null;
  tui.onKeypress('b', { name: 'b' });
  const findIdx = (key) => ['status', 'schools', 'employers', 'communities', 'targetRoles', 'targetCompanies', 'personas', 'relTypes', 'exclusions', 'sourcePublic', 'sourceLinkedin', 'sourceXai', 'connCount', 'latestRun', '_sep', 'saveOnly', 'saveBuild'].indexOf(key);
  // Set target companies so profile scope is valid (requires target companies for public_web)
  tui.state.overlayIndex = findIdx('targetCompanies');
  tui.onOverlayKey('\r', { name: 'return' });
  for (const ch of 'Acme Learning') tui.onInputKey(ch, { name: ch });
  tui.onInputKey('\r', { name: 'return' });
  // Ensure only local_network source (no public_web) so the offline run succeeds without network
  tui.state.overlayIndex = findIdx('sourcePublic');
  tui.onOverlayKey('\r', { name: 'return' }); // turn public web off
  assert.equal(tui.state.networkDraft.sourcePublic, false);

  // Enter on Save only
  tui.state.overlayIndex = findIdx('saveOnly');
  tui.onOverlayKey('\r', { name: 'return' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(runCount(store, profile.id), 0, 'Save only created no run');

  // Reopen and Save and build with profile scope (no selected job)
  // Save only refreshed the model which reset selectedJobId to the first job; force null again.
  tui.state.selectedJobId = null;
  tui.onKeypress('b', { name: 'b' });
  // re-seed target companies and source state since draft was cleared
  tui.state.overlayIndex = findIdx('targetCompanies');
  tui.onOverlayKey('\r', { name: 'return' });
  for (const ch of 'Acme Learning') tui.onInputKey(ch, { name: ch });
  tui.onInputKey('\r', { name: 'return' });
  tui.state.overlayIndex = findIdx('sourcePublic');
  tui.onOverlayKey('\r', { name: 'return' }); // off
  // b triggers Save and build
  tui.onOverlayKey('b', { name: 'b' });
  // Poll until the async run completes (busy clears)
  for (let i = 0; i < 100 && tui.state.busy; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(tui.state.busy, null, 'save and build completed');
  assert.equal(runCount(store, profile.id), 1, 'Save and build created one run');
  const run = all(store, 'SELECT scope,status FROM research_runs WHERE profile_id=? ORDER BY created_at DESC LIMIT 1', [profile.id])[0];
  assert.equal(run.scope, 'profile', 'run scope is profile with no selected job');
  assert.ok(['succeeded', 'partial', 'failed', 'cancelled'].includes(run.status), `run reached a terminal state (${run.status})`);

  // Now with a selected job → job scope
  tui.state.selectedJobId = jobs[0].id;
  tui.refresh({ disk: false });
  tui.onKeypress('b', { name: 'b' });
  tui.state.overlayIndex = findIdx('sourcePublic');
  tui.onOverlayKey('\r', { name: 'return' }); // off
  tui.onOverlayKey('b', { name: 'b' });
  for (let i = 0; i < 100 && tui.state.busy; i++) await new Promise(r => setTimeout(r, 50));
  assert.equal(tui.state.busy, null, 'job-scope save and build completed');
  const runs = all(store, 'SELECT scope FROM research_runs WHERE profile_id=? ORDER BY created_at DESC LIMIT 1', [profile.id]);
  assert.equal(runs[0].scope, 'job', 'run scope is job with selected job');
});

test('build-network editor: no key appears in rendered output', async t => {
  const { store, profile } = await seededWorkspace(t, { jobs: 1, draft: false });
  process.env.XAI_API_KEY = 'test-fake-key-not-real';
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.onKeypress('b', { name: 'b' });
  const rendered = renderTui(tui.model, tui.state, { width: 120, height: 40, color: false });
  assert.doesNotMatch(rendered, /test-fake-key-not-real/, 'api key never rendered');
  assert.doesNotMatch(rendered, /XAI_API_KEY/i, 'env var name never rendered');
  assert.match(rendered, /xAI/, 'xAI state shown without key');
  delete process.env.XAI_API_KEY;
});
