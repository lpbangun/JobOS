import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, run } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText, updateJobStatus } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { listJobSummaries, selectedJobContext } from '../src/domain-tools.js';
import { buildTuiModel } from '../src/tui-model.js';

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-status-semantics-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Status Test').profile;
  const importJob = (name, company) => {
    const file = path.join(root, `${name}.md`);
    writeFileSync(file, `Title: ${name}\nCompany: ${company}\n\nLocal test role.`);
    return importText(store, { profileId: profile.id, filePath: file }).job;
  };
  return { store, profile, importJob };
}

test('job summaries expose both status namespaces and support explicit filters', async t => {
  const { store, profile, importJob } = await fixture(t);
  const discoverySaved = importJob('Discovery Saved', 'One Co');
  const applicationSaved = importJob('Application Saved', 'Two Co');
  const researching = importJob('Researching', 'Three Co');
  updateJobStatus(store, discoverySaved.id, 'saved');
  appCreate(store, applicationSaved.id, 'saved');
  appCreate(store, researching.id, 'researching');

  const summaries = listJobSummaries(store, { profileId: profile.id });
  const discoverySummary = summaries.find(item => item.id === discoverySaved.id);
  assert.equal(discoverySummary.discoveryStatus, 'saved');
  assert.equal('status' in discoverySummary, false, 'generic status is not exposed');
  assert.equal(discoverySummary.applicationStatus, null);

  assert.deepEqual(
    listJobSummaries(store, { discoveryStatus: 'saved' }).map(item => item.id),
    [discoverySaved.id]
  );
  assert.deepEqual(
    listJobSummaries(store, { applicationStatus: 'saved' }).map(item => item.id),
    [applicationSaved.id]
  );
  assert.deepEqual(
    listJobSummaries(store, { discoveryStatus: 'imported', applicationStatus: 'researching' }).map(item => item.id),
    [researching.id],
    'explicit filters compose without namespace ambiguity'
  );
});

test('selected context and TUI stage expose status provenance without creating applications', async t => {
  const { store, profile, importJob } = await fixture(t);
  const triageOnly = importJob('Triage Only', 'Triage Co');
  updateJobStatus(store, triageOnly.id, 'saved');

  const context = selectedJobContext(store, triageOnly.id, profile.id);
  assert.equal(context.job.discoveryStatus, 'saved');
  assert.equal('status' in context.job, false);
  assert.equal(context.job.applicationStatus, null);

  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: triageOnly.id });
  const row = model.jobs.find(item => item.id === triageOnly.id);
  assert.equal(row.stage, 'saved');
  assert.equal(row.stageSource, 'discovery');
  assert.equal(model.selected.job.stage, 'saved');
  assert.equal(model.selected.job.stageSource, 'discovery');
  assert.equal(model.counts.open, 1);

  appCreate(store, triageOnly.id, 'recruiter-screen');
  const applicationModel = buildTuiModel(store, { profileId: profile.id, selectedJobId: triageOnly.id });
  const applicationRow = applicationModel.jobs.find(item => item.id === triageOnly.id);
  assert.equal(applicationRow.stage, 'recruiter-screen');
  assert.equal(applicationRow.stageSource, 'application');
  assert.equal(applicationModel.selected.job.stage, 'recruiter-screen');
  assert.equal(applicationModel.selected.job.stageSource, 'application');
  assert.equal(applicationModel.counts.open, 1);
});

test('selected context prefers the profile-owned W06 action and task mirrors clear on close', async t => {
  const { store, profile, importJob } = await fixture(t);
  const other = createProfile(store, 'Other Status Profile').profile;
  const job = importJob('Lifecycle Role', 'Lifecycle Co');
  const application = appCreate(store, job.id, 'materials-ready', '', { at: '2026-07-20T09:00:00.000Z' });
  run(store, `INSERT INTO tasks
    (id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at,profile_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'general-first', job.id, application.id, 'Unrelated general task', '', 'review', '2026-07-20T08:00:00.000Z',
    'normal', 'open', 'test', '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z', profile.id
  ]);

  const context = selectedJobContext(store, job.id, profile.id);
  assert.equal(context.nextAction.schema, 'jobos.lifecycle-next-action.v1');
  assert.equal(context.nextAction.actionCode, 'complete-submission');
  assert.equal(context.nextAction.profileId, profile.id);
  assert.equal(context.next[0].id, context.nextAction.id);
  assert.throws(() => selectedJobContext(store, job.id, other.id), /Unknown job|profile/i);

  const dir = path.join(store.p.jobs, job.id);
  const jobYaml = readFileSync(path.join(dir, 'job.yaml'), 'utf8');
  const applicationYaml = readFileSync(path.join(dir, 'application.yaml'), 'utf8');
  const tasksYaml = readFileSync(path.join(dir, 'tasks.yaml'), 'utf8');
  assert.match(jobYaml, /nextAction:\n\s+schema: jobos\.lifecycle-next-action\.v1/);
  assert.match(applicationYaml, /nextAction:\n\s+schema: jobos\.lifecycle-next-action\.v1/);
  assert.match(tasksYaml, /profileId:/);
  assert.match(tasksYaml, /actionKind: application_next_action/);
  assert.match(tasksYaml, /scheduleSource: policy/);
  assert.match(tasksYaml, /sourceEvent:/);

  run(store, "UPDATE tasks SET status='done' WHERE id='general-first'");
  appCreate(store, job.id, 'rejected', '', { at: '2026-07-21T09:00:00.000Z' });
  assert.equal(readFileSync(path.join(dir, 'tasks.yaml'), 'utf8').trim(), '[]');
});

test('TUI open count includes active application stages and excludes terminal stages', async t => {
  const { store, profile, importJob } = await fixture(t);
  const activeStatuses = ['saved', 'researching', 'materials-ready', 'applied', 'recruiter-screen', 'interview', 'offer'];
  const terminalStatuses = ['rejected', 'withdrawn', 'ghosted'];
  const job = importJob('Pipeline Role', 'Pipeline Co');

  for (const status of activeStatuses) {
    appCreate(store, job.id, status);
    const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
    assert.equal(model.counts.open, 1, `${status} is active`);
  }
  for (const status of terminalStatuses) {
    appCreate(store, job.id, status);
    const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
    assert.equal(model.counts.open, 0, `${status} is terminal`);
  }
});
