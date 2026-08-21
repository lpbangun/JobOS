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
import { createArtifact } from '../src/artifacts.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';
import { newRows, jobRows, reviewRows } from '../src/tui/model.js';

const AS_OF = '2026-07-21T12:00:00.000Z';

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
  const tui = new JobosTui(store, { ...streams(), profileId: profile.id, selectedJobId: job.id, connectAgent: false, color: false });
  tui.refresh();
  return tui;
}

function seedDueTask(store, profile, job) {
  const at = '2026-07-20T09:00:00.000Z';
  run(store, `INSERT INTO tasks (id, job_id, title, type, due_at, priority, status, created_by, created_at, updated_at, profile_id, action_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'task_followup', job.id, 'Send tailored resume', 'followup', at, 'high', 'open', 'outreach', at, at, profile.id, 'general'
  ]);
  save(store);
}

const tick = (ms = 150) => new Promise(resolve => setTimeout(resolve, ms));

test('RAIL-01 New and Jobs are distinct rails and Add to Jobs moves a row New -> Jobs', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.state.leftMode = 'new';
  const model = tui.model;
  assert.ok(newRows(model).some(row => row.id === job.id), 'imported listing is on the New rail');
  assert.equal(jobRows(model).some(row => row.id === job.id), false, 'no application yet -> not on the Jobs rail');

  const screen = renderTui(model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /Add to Jobs/, 'New rows offer Add to Jobs');
  assert.doesNotMatch(screen, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');

  await tui.addToJobs(job.id);
  const application = one(store, 'SELECT * FROM applications WHERE job_id=?', [job.id]);
  assert.ok(application, 'Add to Jobs creates a real application row');
  assert.equal(application.status, 'saved');
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='application.created' AND entity_id=?", [application.id]).n, 1);
  assert.equal(tui.state.leftMode, 'jobs', 'rail switches to Jobs after adding');
  assert.match(tui.state.status, /Added to Jobs/);
  assert.ok(jobRows(tui.model).some(row => row.id === job.id), 'the row is now on the Jobs rail');
  assert.equal(newRows(tui.model).some(row => row.id === job.id), false, 'the row left the New rail');
});

test('RAIL-02 Enter on a New row adds it to Jobs and Enter on a Jobs row opens the tracker', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.state.leftMode = 'new';
  tui.handleKey('', { name: 'return' });
  await tick(200);
  assert.ok(one(store, 'SELECT id FROM applications WHERE job_id=?', [job.id]), 'Enter on New adds the row to Jobs');
  assert.equal(tui.state.leftMode, 'jobs');

  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'tracker', 'Enter on a Jobs row opens the tracker overlay');
});

test('RAIL-03 /daily focuses New and /jobs returns to the board', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.runSlash('daily');
  assert.equal(tui.state.leftMode, 'new', '/daily focuses the New rail');
  assert.match(tui.state.status, /New/, 'daily names the New inbox');
  tui.runSlash('jobs');
  assert.equal(tui.state.headerMode, 'jobs', '/jobs returns to the board');
  assert.equal(tui.state.jobTab, 'job', '/jobs resets to the Job pane');
  tui.runSlash('workspace');
  assert.equal(tui.state.headerMode, 'workspace', '/workspace opens Workspace chat');
  tui.runSlash('chat');
  assert.equal(tui.state.jobTab, 'chat', '/chat opens this-job Chat');
  assert.equal(tui.state.input, '', '/chat leaves an empty, ready composer so bare Enter runs no slash action');
});

test('RAIL-04 /review is the morning brief: real due tasks and pending drafts, no updates inbox', async t => {
  const { store, profile, job } = await seeded(t);
  appCreate(store, job.id, 'saved', '', { at: AS_OF });
  run(store, `INSERT INTO tasks (id, job_id, title, type, due_at, priority, status, created_by, created_at, updated_at, profile_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    'due-outreach', job.id, 'Follow up with recruiter', 'followup', '2026-07-20T10:00:00.000Z', 'high', 'open', 'outreach', '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profile.id
  ]);
  // A reminder dated after the current real time: the live TUI projection must
  // keep it out of the due brief the same way the fixed-AS_OF model does.
  const futureReminder = new Date(Date.now() + 30 * 86_400_000).toISOString();
  run(store, `INSERT INTO tasks (id, job_id, title, type, due_at, priority, status, created_by, created_at, updated_at, profile_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [
    'future-reminder', job.id, 'Future reminder', 'followup', futureReminder, 'normal', 'open', 'outreach', '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profile.id
  ]);
  run(store, `INSERT INTO tasks (id, title, type, priority, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, ['global-task', 'Global task', 'review', 'normal', 'open', 'system', '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z']);
  // The raw task inserts are in-memory until persisted; createArtifact runs a
  // guardedWrite that reloads the authoritative store, so persist them through
  // a real save first or the due brief would project an empty set.
  save(store);
  const artifact = createArtifact(store, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: `jobs/${job.id}/artifacts/resume.md`,
    title: 'Tailored resume',
    content: 'Draft resume.',
    evidence: [],
    warnings: []
  });
  save(store);
  const tui = makeTui(store, profile, job);
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
  assert.deepEqual(model.dueTasks.map(task => task.id), ['due-outreach'], 'due tasks are the real due set');
  assert.equal(model.dueTasks.some(task => task.id === 'global-task'), false, 'global tasks stay out of the profile brief');
  assert.equal(model.dueTasks.some(task => task.id === 'future-reminder'), false, 'future reminders stay out of the due brief');
  assert.ok(model.review.some(item => item.id === artifact.id), 'pending drafts are in the review queue');

  tui.runSlash('review');
  assert.equal(tui.state.overlay, 'review');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /THIS MORNING/, 'review is the morning-brief overlay');
  assert.match(screen, /Follow up with recruiter/, 'the due task is listed once');
  assert.match(screen, /Tailored resume/, 'the pending draft is listed');
  assert.doesNotMatch(screen, /Future reminder|Global task/, 'future and global tasks never enter the brief');
  assert.doesNotMatch(screen, /UPDATES/, 'the brief is not an Updates inbox pane');
});

test('RAIL-05 Enter on a brief draft opens the exact Files revision and a due row opens the tracker', async t => {
  const { store, profile, job } = await seeded(t);
  appCreate(store, job.id, 'saved', '', { at: AS_OF });
  const artifact = createArtifact(store, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: `jobs/${job.id}/artifacts/resume.md`,
    title: 'Tailored resume',
    content: 'Draft resume.',
    evidence: [],
    warnings: []
  });
  save(store);
  const tui = makeTui(store, profile, job);
  tui.runSlash('review');
  const rows = reviewRows(tui.model, tui.state);
  const draftIndex = rows.findIndex(row => row.kind === 'draft' && row.id === `draft:${artifact.id}`);
  assert.ok(draftIndex >= 0, 'the draft row is in the brief');
  tui.state.overlayIndex = draftIndex;
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'files', 'Enter on a draft opens the Files overlay for that job');
  const filesText = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(filesText, /resume\.md/, 'the exact draft revision is the review target');
});

test('RAIL-06 weekly review runs from the brief and writes the local export', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  tui.runSlash('review');
  tui.handleKey('w', { name: 'w' });
  await tick(250);
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='review.weekly.created'").n, 1);
  assert.ok(readdirSync(path.join(store.p.ws, 'exports')).some(file => file.startsWith('weekly-review-')), 'export file written');
  assert.ok(tui.state.weekly, 'the brief holds the weekly readout');
  assert.match(tui.state.status, /Weekly review written/);
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /WEEKLY READOUT/, 'weekly readout renders in the brief');
});

test('RAIL-07 the recommended action drives the brief NEXT UP line', async t => {
  const { store, profile, job } = await seeded(t);
  appCreate(store, job.id, 'saved', '', { at: AS_OF });
  seedDueTask(store, profile, job);
  const tui = makeTui(store, profile, job);
  tui.runSlash('review');
  const text = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(text, /NEXT UP/, 'the brief leads with the recommended action');
  assert.ok(tui.model.recommendedAction, 'the model names a single recommended action');
});
