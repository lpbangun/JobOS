import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/db.js';
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

  const context = selectedJobContext(store, triageOnly.id);
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
