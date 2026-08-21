import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { openStore, all, one } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { buildTuiModel } from '../src/tui-model.js';
import { AcpClient, jobosMcpServer, readPersistedAcpSession, writePersistedAcpSession } from '../src/acp.js';
import { seedMcpDemo } from '../scripts/seed-mcp-demo.js';
import { defaultTuiState, JobosTui, renderTui, TUI_DOMAIN_ACTIONS } from '../src/tui.js';
import { callDomainTool, profileAgentContext, selectedJobContext } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';
import { runMcpDemo } from '../scripts/mcp-demo.js';
import { createArtifact } from '../src/artifacts.js';
import { createCompleteResumeFixture } from './fixtures/resume.js';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-tui-acp-'));
}

async function seededWorkspace(t, { jobs = 1, draft = true } = {}) {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  const proof = addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio case study', ['product', 'educator'], ['30%']);
  createCompleteResumeFixture(store, profile, proof);
  const imported = [];
  for (let index = 0; index < jobs; index++) {
    const file = path.join(root, `job-${index}.md`);
    writeFileSync(file, `Title: Product Manager ${index + 1}\nCompany: Learning Co ${index + 1}\nLocation: Remote\n\n## Requirements\n- Must lead educator discovery and launch a learning platform that improves activation.`);
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

function makeTui(store, profileId, jobId, options = {}) {
  const tui = new JobosTui(store, { ...streams(), profileId, selectedJobId: jobId, connectAgent: false, ...options });
  tui.refresh();
  return tui;
}

test('ACP-01 the assistant is off by default with --agent off and chat stays local', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const tui = makeTui(store, profile.id, jobs[0].id, { connectAgent: false });
  tui.state.jobTab = 'chat';
  await tui.sendChat('job', 'Hello, summarize this listing.');
  const log = tui.state.chat[`job:${jobs[0].id}`] || [];
  assert.equal(log.length, 1, 'only the user message is stored');
  assert.equal(log[0].kind, 'you');
  assert.equal(log[0].text, 'Hello, summarize this listing.');
  assert.equal(tui.state.agentState, 'off');
  assert.match(tui.state.status, /assistant off · your message stays local/);
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /Assistant is off/, 'the composer banner states the assistant is off');
  assert.doesNotMatch(screen, /Hermes.*ready/, 'no invented assistant readiness');
});

test('ACP-02 a missing ACP backend says unavailable and invents no reply or facts', async t => {
  const { root, store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const tui = new JobosTui(store, {
    ...streams(),
    profileId: profile.id,
    selectedJobId: jobs[0].id,
    connectAgent: true,
    agentCommand: '__jobos_missing_acp_binary__'
  });
  await tui.start();
  assert.equal(tui.state.agentState, 'unavailable');
  assert.match(tui.state.status, /ACP backend not found/);
  await tui.sendChat('job', 'Are we applying today?');
  const log = tui.state.chat[`job:${jobs[0].id}`] || [];
  assert.equal(log.length, 1, 'no fabricated assistant reply');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM application_receipts').n, 0, 'no fabricated submission receipts');
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM contact_points").n, 0, 'no fabricated contacts');
  assert.equal(tui.model.selected.contacts.length, 0, 'no invented people');
});

test('ACP-03 a real client streams only agent_message events into chat, never a fabricated reply', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, selectedJobId: jobs[0].id, connectAgent: true, color: false });
  tui.refresh();
  let handler = null;
  let receivedContext = null;
  tui.client = {
    state: 'ready',
    on(event, fn) { if (event === 'event') handler = fn; },
    off() {},
    async prompt(_text, options) {
      receivedContext = options.context;
      // A real AcpClient streams assistant text as events during the turn.
      if (handler) handler({ type: 'agent_message', text: 'Streamed assistant reply' });
      return { stopReason: 'end_turn' };
    }
  };
  await tui.sendChat('job', 'What should I ask the recruiter?');
  const log = tui.state.chat[`job:${jobs[0].id}`] || [];
  assert.equal(log.length, 2, 'the streamed reply is appended after the user message');
  assert.equal(log[1].kind, 'assistant');
  assert.equal(log[1].text, 'Streamed assistant reply', 'only the streamed agent message is appended');
  assert.ok(receivedContext, 'the agent turn received real context');
  assert.equal(receivedContext.jobId || receivedContext.job?.id, jobs[0].id, 'job chat receives the selected-job context');
});

test('ACP-03b without agent events and without a text result there is no assistant message at all', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, selectedJobId: jobs[0].id, connectAgent: true, color: false });
  tui.refresh();
  tui.client = {
    state: 'ready',
    on() {},
    off() {},
    async prompt() { return { stopReason: 'end_turn' }; }
  };
  await tui.sendChat('job', 'Anything?');
  const log = tui.state.chat[`job:${jobs[0].id}`] || [];
  assert.equal(log.length, 1, 'empty agent output produces no assistant message');
  assert.equal(log[0].kind, 'you');
});

test('ACP-04 chat is scoped per job and workspace so the whole search never leaks into a listing', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 2, draft: false });
  const tui = makeTui(store, profile.id, jobs[0].id);
  await tui.sendChat('job', 'job-a question');
  await tui.sendChat('workspace', 'workspace question');
  const jobLog = tui.state.chat[`job:${jobs[0].id}`] || [];
  const wsLog = tui.state.chat.workspace || [];
  assert.equal(jobLog.length, 1);
  assert.equal(wsLog.length, 1);
  assert.equal(jobLog[0].text, 'job-a question');
  assert.equal(wsLog[0].text, 'workspace question');
  assert.ok(!tui.state.chat[`job:${jobs[1].id}`], 'the other job has no chat log');
});

test('ACP-05 TUI domain actions stay in the agent door and human-only tools stay out', async t => {
  const externalTools = new Set(mcpToolNames());
  for (const tool of Object.values(TUI_DOMAIN_ACTIONS)) assert.ok(externalTools.has(tool), `${tool} is missing from external MCP`);
  for (const tool of ['list_jobs', 'get_job_context', 'review_queue', 'discovery_health']) assert.ok(externalTools.has(tool));
  for (const tool of ['approve_artifact', 'reject_artifact', 'create_application_packet', 'attest_application_submitted', 'answers_add', 'approve_contact', 'network_contact_record', 'mark_outreach_sent']) {
    assert.equal(externalTools.has(tool), false, `${tool} must not be advertised to agents`);
  }
});

test('ACP-06 first-run and no-job states are honest, actionable, and do not invent content', async t => {
  const root = workspace();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  let model = buildTuiModel(store, { at: '2026-07-15T12:00:00.000Z' });
  assert.equal(model.empty.noProfile, true);
  let tui = new JobosTui(store, { ...streams(), connectAgent: false, color: false });
  tui.refresh();
  let screen = renderTui(tui.model, tui.state, { width: 120, height: 34, color: false });
  assert.match(screen, /welcome to jobos/i, 'welcome is the first-run surface');
  assert.doesNotMatch(screen, /Example Learning|Acme|Harbor Schools|Contoso Careers Lab|Lumen Labs/, 'no invented jobs or companies');
  assert.doesNotMatch(screen, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');

  const profile = createProfile(store, 'PM EdTech').profile;
  model = buildTuiModel(store, { profileId: profile.id });
  assert.equal(model.empty.noJobs, true);
  tui = new JobosTui(store, { ...streams(), profileId: profile.id, connectAgent: false, color: false });
  tui.refresh();
  tui.state.welcomeDismissed = true; // profile exists: the board is the surface, welcome was first-run
  screen = renderTui(tui.model, tui.state, { width: 120, height: 34, color: false });
  assert.match(screen, /No jobs yet/, 'the empty pipeline says so');
  assert.match(screen, /Add to Jobs from New/, 'the empty pipeline points at the New rail');
  tui.state.leftMode = 'new';
  screen = renderTui(tui.model, tui.state, { width: 120, height: 34, color: false });
  assert.match(screen, /daily/, 'the New rail points at discovery');
});

test('ACP-07 external apply and send are user-configured, default off', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const tui = makeTui(store, profile.id, jobs[0].id);
  assert.equal(tui.model.policy.autoApply, 'disabled');
  assert.equal(tui.model.policy.autoSend, 'disabled');
  const selected = tui.model.selected;
  assert.ok(selected.policy);
  assert.equal(selected.policy.externalApply, 'user_configured_default_off');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.doesNotMatch(screen, /submitted successfully|applied on your behalf/, 'no external submit claim');
});

test('ACP-08 compact terminals keep the frame bounded and the shell reachable', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: jobs[0].id });
  const state = { ...defaultTuiState(), profileId: profile.id, selectedJobId: jobs[0].id };
  const dashboard = renderTui(model, state, { width: 60, height: 24, color: false });
  const lines = dashboard.split('\n');
  assert.ok(lines.length > 0 && lines.length <= 24, 'compact frame stays inside the height');
  assert.ok(lines.every(line => !line.includes('\u0000')), 'no control-data leak');
  assert.match(dashboard, /JobOS/, 'wordmark remains');
  assert.match(dashboard, /Tab/, 'Tab hint remains');
  assert.doesNotMatch(dashboard, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome at compact size');
});

test('ACP-09 profile context is secret-safe and the workspace turn receives it', async t => {
  const { store, profile, proof, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const profileContext = profileAgentContext(store, profile.id);
  assert.equal(profileContext.profile.name, 'PM EdTech');
  assert.equal(profileContext.resumeUpload.revision, 1);
  assert.deepEqual(profileContext.resumeUpload.experience, [{
    title: 'Product Manager', employer: 'Learning Studio', startDate: '2021-01', endDate: 'Present'
  }]);
  assert.deepEqual(profileContext.resumeUpload.skills, ['Product discovery']);
  assert.equal(profileContext.verifiedProofs[0].id, proof.id);
  assert.equal(profileContext.privacy.rawResumeTextIncluded, false);
  assert.doesNotMatch(JSON.stringify(profileContext), /candidate@example\.com|555 555 0100/);

  const jobContext = selectedJobContext(store, jobs[0].id, profile.id);
  assert.equal(jobContext.resumeUpload.id, profileContext.resumeUpload.id);
  assert.equal(jobContext.verifiedProofs[0].id, proof.id);

  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, selectedJobId: jobs[0].id, connectAgent: true, color: false });
  tui.refresh();
  let received = null;
  tui.client = {
    state: 'ready',
    on() {},
    off() {},
    async prompt(_text, options) {
      received = options.context;
      return { text: 'ok' };
    }
  };
  await tui.sendChat('workspace', 'What experience did I upload?');
  assert.ok(received, 'the workspace turn received profile context');
  assert.equal(received.resumeUpload.id, profileContext.resumeUpload.id);
  assert.equal(received.verifiedProofs[0].id, proof.id);
});

test('ACP-11 Esc while an ACP turn is working cancels once, quarantines, and discards the late update', async t => {
  const { store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const io = streams();
  const tui = makeTui(store, profile.id, jobs[0].id, { connectAgent: false });
  tui.state.overlay = null;
  tui.state.jobTab = 'chat';
  tui.state.working = true;
  tui.state.agentState = 'working';
  tui.state.status = 'working · job assistant';

  // Detached real AcpClient (fake-acp path): session id set, notify stubbed
  // to record, no child spawned. Esc must drive cancel() -> session/cancel +
  // quarantine, and a late onMessage update must become discarded_update.
  const client = new AcpClient({ root: store.root, command: '__acp11_no_spawn__' });
  client.sessionId = 'b14-live-turn';
  client.state = 'working';
  const notifications = [];
  const events = [];
  client.notify = (method, params) => { notifications.push({ method, params }); return true; };
  client.on('event', event => events.push(event));
  tui.client = client;

  tui.handleKey('', { name: 'escape', escape: true });

  assert.equal(notifications.length, 1, 'Esc while working calls client.cancel exactly once');
  assert.deepEqual(notifications, [{ method: 'session/cancel', params: { sessionId: 'b14-live-turn' } }]);
  assert.equal(client.quarantinedSessionId, 'b14-live-turn', 'cancelled session is quarantined');
  assert.equal(client.quarantineReason, 'cancelled', 'quarantine reason is cancelled');
  assert.equal(tui.state.working, false, 'pane leaves working state after in-pane cancel');
  assert.ok(['ready', 'off'].includes(tui.state.agentState), `pane agent state must be ready/off, got ${tui.state.agentState}`);
  assert.match(tui.state.status, /cancelled|quarantined/i, 'status reports the honest cancel outcome');

  // Late session/update from the quarantined turn is discarded at the client
  // boundary: emitted as discarded_update, never as assistant text.
  client.onMessage({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'b14-live-turn',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE UPDATE MUST BE DISCARDED' } }
    }
  });
  const discarded = events.filter(event => event?.type === 'discarded_update');
  assert.equal(discarded.length, 1, 'a late update from the quarantined session emits discarded_update');
  assert.equal(discarded[0].sessionId, 'b14-live-turn');
  assert.equal(events.some(event => event?.type === 'agent_message' && /LATE UPDATE/.test(event.text || '')), false, 'late agent text never reaches the pane');
  assert.ok(!tui.state.chat?.[`job:${jobs[0].id}`], 'no assistant text reached the chat log');
});

test('ACP-12 env-gated live Hermes cancel returns the pane to ready and quarantines (JOBOS_LIVE_ACP=1 only)', { skip: process.env.JOBOS_LIVE_ACP !== '1' }, async t => {
  // Real Hermes ACP guest path, gated behind JOBOS_LIVE_ACP=1 so the default
  // suite never depends on a live backend. Connects, starts a slow prompt,
  // cancels mid-turn, and asserts the client quarantined + pane is clean.
  const { root, store, profile, jobs } = await seededWorkspace(t, { jobs: 1, draft: false });
  const tui = makeTui(store, profile.id, jobs[0].id, { connectAgent: true });
  tui.state.overlay = null;
  tui.state.jobTab = 'chat';
  const client = await tui.ensureAgent();
  assert.ok(client, 'live ACP client connected');
  assert.ok(client.sessionId, `live ACP session id present: ${client.sessionId}`);

  const promptPromise = client.prompt('Write a one-paragraph note about this listing and pause there.', {
    context: tui.agentContext('job'),
    timeoutMs: 120000
  });
  await new Promise(resolve => setTimeout(resolve, 1500));
  tui.state.working = true;
  tui.state.agentState = 'working';
  const cancelled = tui.cancelInFlightPrompt();
  assert.equal(cancelled, true, 'in-pane cancel accepted the live turn');
  assert.equal(client.quarantinedSessionId, client.sessionId, 'live cancelled session is quarantined');
  assert.equal(client.quarantineReason, 'cancelled');
  assert.equal(tui.state.working, false, 'pane left working');
  assert.ok(['ready', 'off'].includes(tui.state.agentState));
  try {
    await promptPromise;
  } catch {}
  assert.equal(client.quarantinedSessionId, client.sessionId, 'quarantine survives the prompt settling');
});

test('ACP-13 env-gated real Hermes ACP session resume across launches (JOBOS_LIVE_ACP=1 only)', { skip: process.env.JOBOS_LIVE_ACP !== '1' }, async t => {
  // Real Hermes ACP guest path, gated behind JOBOS_LIVE_ACP=1 so the default
  // suite never depends on a live backend. Connect -> prompt with an opaque
  // nonce -> stop -> reconnect using the persisted session id
  // (readPersistedAcpSession / writePersistedAcpSession) -> the same id is
  // reused and the resumed turn recalls the prior nonce. Mirrors the frozen
  // B15 harness; never fabricated.
  const HERMES = '/home/logani/.local/bin/hermes';
  const root = workspace();
  let first = null;
  let second = null;
  t.after(async () => {
    const settle = client => Promise.race([client.stop().catch(() => {}), new Promise(resolve => setTimeout(resolve, 3_000))]);
    if (first) await settle(first);
    if (second) await settle(second);
    rmSync(root, { recursive: true, force: true });
  });

  const seeded = await seedMcpDemo(root);
  const mcpServers = [jobosMcpServer(seeded.workspace, { allowAgentAttestation: false })];
  const nonce = `ACP13-${randomUUID()}`;

  first = new AcpClient({ root: seeded.workspace, command: HERMES, args: ['acp'], requestTimeoutMs: 45_000, promptTimeoutMs: 90_000 });
  await first.connect({ mcpServers });
  const firstSessionId = first.sessionId;
  assert.ok(firstSessionId, 'first launch returned no ACP session id');
  const firstTurn = await first.prompt(
    `Remember this exact opaque nonce for the next turn in this same conversation: ${nonce}. Reply only ACK. Do not call tools.`,
    { timeoutMs: 90_000 }
  );
  assert.equal(firstTurn?.stopReason, 'end_turn', `first turn stop reason was ${firstTurn?.stopReason || 'missing'}`);
  await writePersistedAcpSession(seeded.workspace, seeded.profileId, firstSessionId);
  const persisted = await readPersistedAcpSession(seeded.workspace, seeded.profileId);
  assert.equal(persisted, firstSessionId, 'readPersistedAcpSession did not return the first launch session');
  const onDisk = JSON.parse(readFileSync(path.join(seeded.workspace, '.jobos', 'acp-sessions.json'), 'utf8'));
  assert.equal(onDisk.sessions[`hermes-acp:${seeded.profileId}`]?.sessionId, firstSessionId, 'persisted session file does not contain the first launch id');
  await first.stop();
  first = null;

  const resumedText = [];
  second = new AcpClient({ root: seeded.workspace, command: HERMES, args: ['acp'], requestTimeoutMs: 45_000, promptTimeoutMs: 90_000 });
  second.on('event', event => {
    if (event.type === 'agent_message' && event.text) resumedText.push(String(event.text));
  });
  await second.connect({ mcpServers, sessionId: persisted });
  assert.equal(second.sessionId, firstSessionId, 'second launch did not load the persisted ACP session id');
  const secondTurn = await second.prompt(
    'What exact opaque nonce did I ask you to remember in the immediately prior turn? Reply with the nonce only. Do not call tools.',
    { timeoutMs: 90_000 }
  );
  assert.equal(secondTurn?.stopReason, 'end_turn', `resumed turn stop reason was ${secondTurn?.stopReason || 'missing'}`);
  const reply = resumedText.join('');
  assert.ok(reply.includes(nonce), `resumed session did not retain prior conversation context; reply was ${JSON.stringify(reply)}`);
});

test('ACP-10 the external MCP demo initializes, persists state, and exits cleanly', async t => {
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
