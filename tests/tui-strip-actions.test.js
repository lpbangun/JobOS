import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, one, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { callDomainTool } from '../src/domain-tools.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function seeded(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-strip-actions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio', ['product'], ['30%']);
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\nLead educator discovery and launch a learning platform.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  await callDomainTool(store, 'score_job', { jobId: job.id, profileId: profile.id }, { source: 'tui' });
  return { root, store, profile, job };
}

function makeTui(store, profile, job) {
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });
  return tui;
}

function seedDueTask(store, job) {
  const at = '2026-07-20T09:00:00.000Z';
  run(store, `INSERT INTO tasks (id, job_id, title, type, due_at, priority, status, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['task_followup', job.id, 'Send tailored resume', 'follow_up', at, 'high', 'open', 'test', at, at]);
  save(store);
}

const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

// Gap #7 — strip shape is stable and linked jobs are carried
test('priority strip carries jobId on actionable cards and null on failure', async t => {
  const { store, profile, job } = await seeded(t);
  seedDueTask(store, job);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: '2026-07-21T12:00:00.000Z' });
  assert.deepEqual(model.priority.map(item => item.kind), ['due', 'interview', 'new', 'failure']);
  assert.equal(model.priority[0].jobId, job.id, 'due card carries its job');
  assert.equal(model.priority[3].jobId, null, 'failure card never carries a job');
});

// Gap #7 — Tab cycles strip focus (with wrap) and paints a marker
test('Tab cycles strip focus with wrap and paints the focused card', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  assert.equal(tui.state.stripIndex, 0);
  tui.onKeypress('', { name: 'tab' });
  assert.equal(tui.state.stripIndex, 1);
  assert.match(tui.state.status, /Strip focus: interview/);
  tui.onKeypress('', { name: 'tab' });
  tui.onKeypress('', { name: 'tab' });
  tui.onKeypress('', { name: 'tab' });
  assert.equal(tui.state.stripIndex, 0, 'focus wraps after the last card');
  const screen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.ok(screen.includes('▶'), 'focused card is marked');
});

// Gap #7 — Enter jumps to the focused card's job, even from another filter
test('Enter jumps to the due card job and resets the filter', async t => {
  const { store, profile, job } = await seeded(t);
  seedDueTask(store, job);
  const tui = makeTui(store, profile, job);
  tui.state.filter = 'interview'; // would otherwise hide the job
  tui.state.selectedJobId = null;
  tui.onKeypress('', { name: 'return' }); // strip focus is the due card
  assert.equal(tui.state.selectedJobId, job.id, 'main selection follows the strip job');
  assert.equal(tui.state.filter, 'all', 'filter resets so the job is visible');
  assert.match(tui.state.status, /Strip due · job now selected/);
});

// Gap #7 — cards without a job explain themselves instead of no-op silence
test('Enter on the failure card reports no linked job', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.state.stripIndex = 3; // failure card
  tui.onKeypress('', { name: 'return' });
  assert.match(tui.state.status, /No linked job on the failure card/);
  assert.equal(tui.state.selectedJobId, job.id, 'selection unchanged');
});

// Gap #7 — :due lists tasks and Enter jumps to the selected task's job
test(':due overlay lists due tasks and jumps to the selected one', async t => {
  const { store, profile, job } = await seeded(t);
  seedDueTask(store, job);
  const tui = makeTui(store, profile, job);
  tui.executeCommand('due');
  assert.equal(tui.state.overlay, 'due');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /TASKS \(1\)/);
  assert.match(screen, /Send tailored resume/);
  tui.state.selectedJobId = null;
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, null, 'overlay closes on jump');
  assert.equal(tui.state.selectedJobId, job.id);
  assert.match(tui.state.status, /Due task · job now selected/);
});

// Gap #7 — weekly review reachable from the command bar
test(':weekly writes the local weekly review from the TUI', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.executeCommand('weekly');
  await tick(250);
  assert.match(tui.state.status, /Weekly review written ·/);
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='review.weekly.created'").n, 1);
  assert.ok(readdirSync(path.join(store.p.ws, 'exports')).some(file => file.startsWith('weekly-review-')), 'export file written');
});

// Gap #7 — interview prep reachable from the command bar for an applied job
test(':prep creates an interview prep draft for the selected application', async t => {
  const { store, profile, job } = await seeded(t);
  const env = { agent: process.env.JOBOS_AGENT, provider: process.env.JOBOS_LLM_PROVIDER, key: process.env.JOBOS_LLM_API_KEY };
  process.env.JOBOS_AGENT = '';
  process.env.JOBOS_LLM_PROVIDER = '';
  process.env.JOBOS_LLM_API_KEY = '';
  t.after(() => {
    process.env.JOBOS_AGENT = env.agent;
    process.env.JOBOS_LLM_PROVIDER = env.provider;
    process.env.JOBOS_LLM_API_KEY = env.key;
  });
  const tui = makeTui(store, profile, job);

  // No application yet — honest refusal
  tui.executeCommand('prep');
  await tick(40);
  assert.match(tui.state.status, /No application record for this job/);

  appCreate(store, job.id, 'materials-ready', '');
  tui.refresh({ disk: false });
  tui.executeCommand('prep');
  await tick(300);
  assert.match(tui.state.status, /Interview prep draft created/);
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM artifacts WHERE type='interview_prep'").n, 1, 'prep artifact created for human review');
});
