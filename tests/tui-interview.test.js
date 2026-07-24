import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { all, one, openStore, run, save } from '../src/db.js';
import { addProof, createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { callDomainTool } from '../src/domain-tools.js';
import { INTERVIEW_STORY_CONTENT_FIELDS, INTERVIEW_STORY_FACTUAL_FIELDS } from '../src/interview.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';

const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const DEBRIEF_FIELDS = ['observedQuestions', 'observedOutcome', 'proofGaps', 'storyUses', 'notes'];

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

function storyPayload(proofPointId, title) {
  return {
    title,
    situation: 'A launch had fragmented ownership and a fixed deadline.',
    task: 'I owned delivery alignment and the adoption target.',
    action: 'I set milestones, resolved dependencies, and led weekly risk reviews.',
    result: 'The launch shipped on schedule and activation improved by 30%.',
    reflection: 'I learned to surface dependency risk before committing to dates.',
    competencyTags: ['leadership', 'delivery'],
    audienceTags: ['hiring_manager'],
    fieldProvenance: Object.fromEntries(INTERVIEW_STORY_CONTENT_FIELDS.map(field => [
      field,
      { origin: 'user', actor: 'user', source: 'tui', sourceRef: null },
    ])),
    confirmedFields: [],
    fieldEvidence: Object.fromEntries(INTERVIEW_STORY_FACTUAL_FIELDS.map(field => [field, [proofPointId]])),
    actor: 'user',
  };
}

function debriefPayload(referenceId, overrides = {}) {
  return {
    interviewStage: 'interview',
    audience: 'hiring_manager',
    referenceId,
    occurredAt: '2026-07-22T16:30:00Z',
    actor: 'candidate',
    observedQuestions: [],
    observedOutcome: { type: 'no_change', note: 'The team will finish the remaining interviews.' },
    proofGaps: [],
    storyUses: [],
    notes: 'Private local debrief note.',
    fieldProvenance: Object.fromEntries(DEBRIEF_FIELDS.map(field => [
      field,
      { origin: 'user', actor: 'candidate', source: 'tui', sourceRef: null },
    ])),
    ...overrides,
  };
}

async function importJob(store, root, profileId, name, company) {
  const file = path.join(root, `${name}.md`);
  writeFileSync(file, `Title: Product Manager ${name}\nCompany: ${company}\nLocation: Remote\n\nLead product launches and cross-functional delivery.`);
  return importText(store, { profileId, filePath: file }).job;
}

async function draftStory(store, profileId, proofPointId, title) {
  return callDomainTool(store, 'draft_interview_story', {
    profileId,
    ...storyPayload(proofPointId, title),
  }, { source: 'tui' });
}

async function verifyStory(store, draft) {
  return callDomainTool(store, 'verify_interview_story', {
    profileId: draft.profileId,
    storyId: draft.id,
    revision: draft.currentRevision.revision,
    confirmedFields: [],
    actor: 'user',
  }, { source: 'tui' });
}

async function seeded(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-tui-interview-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const alpha = createProfile(store, 'Alpha PM').profile;
  const beta = createProfile(store, 'Beta PM').profile;
  const activeProof = addProof(store, alpha.id, 'Led a product launch that improved activation by 30%.', 'Portfolio launch report.', ['delivery'], ['30%']);
  const staleProof = addProof(store, alpha.id, 'Led a migration that cut incidents by 20%.', 'Migration review.', ['leadership'], ['20%']);
  const betaProof = addProof(store, beta.id, 'Led a beta-only launch.', 'Beta portfolio.', ['delivery'], []);
  const job = await importJob(store, root, alpha.id, 'alpha-selected', 'Alpha Co');
  const otherJob = await importJob(store, root, alpha.id, 'alpha-other', 'Other Co');
  const betaJob = await importJob(store, root, beta.id, 'beta-hidden', 'Beta Co');
  const application = appCreate(store, job.id, 'interview', '', { at: '2026-07-20T09:00:00.000Z' });
  const otherApplication = appCreate(store, otherJob.id, 'interview', '', { at: '2026-07-20T10:00:00.000Z' });
  const betaApplication = appCreate(store, betaJob.id, 'interview', '', { at: '2026-07-20T11:00:00.000Z' });
  return {
    root,
    store,
    alpha,
    beta,
    activeProof,
    staleProof,
    betaProof,
    job,
    otherJob,
    betaJob,
    application,
    otherApplication,
    betaApplication,
  };
}

function makeTui(store, profileId, jobId) {
  const tui = new JobosTui(store, { ...streams(), profileId, connectAgent: false, color: false });
  tui.state.selectedJobId = jobId;
  tui.refresh({ disk: false });
  return tui;
}

function writeCount(store) {
  return Number(one(store, `SELECT
    (SELECT COUNT(*) FROM interview_story_revisions)
    + (SELECT COUNT(*) FROM interview_debrief_revisions)
    + (SELECT COUNT(*) FROM interview_pack_items)
    + (SELECT COUNT(*) FROM artifacts)
    + (SELECT COUNT(*) FROM audit_log) AS count`)?.count || 0);
}

test('W07-TUI-01 selected-profile interview projection and overlay are isolated and deterministic', async t => {
  const fixture = await seeded(t);
  const { store, alpha, beta, activeProof, staleProof, betaProof, job, otherApplication, betaApplication, application } = fixture;
  await verifyStory(store, await draftStory(store, alpha.id, activeProof.id, 'Eligible Alpha story'));
  await verifyStory(store, await draftStory(store, alpha.id, staleProof.id, 'Stale Alpha story'));
  await draftStory(store, alpha.id, activeProof.id, 'Draft Alpha story');
  await verifyStory(store, await draftStory(store, beta.id, betaProof.id, 'Hidden Beta story'));
  run(store, "UPDATE proof_points SET status='retired' WHERE id=?", [staleProof.id]);
  save(store);

  await callDomainTool(store, 'interview_prep', {
    applicationId: application.id,
    stage: 'interview',
    audience: 'hiring_manager',
  }, { source: 'tui' });
  await callDomainTool(store, 'interview_prep', {
    applicationId: otherApplication.id,
    stage: 'recruiter-screen',
    audience: 'recruiter',
  }, { source: 'tui' });
  await callDomainTool(store, 'record_interview_debrief', {
    profileId: alpha.id,
    applicationId: application.id,
    ...debriefPayload('alpha-selected-debrief'),
  }, { source: 'tui' });
  await callDomainTool(store, 'record_interview_debrief', {
    profileId: alpha.id,
    applicationId: otherApplication.id,
    ...debriefPayload('alpha-other-debrief'),
  }, { source: 'tui' });
  await callDomainTool(store, 'record_interview_debrief', {
    profileId: beta.id,
    applicationId: betaApplication.id,
    ...debriefPayload('beta-hidden-debrief'),
  }, { source: 'tui' });

  const model = buildTuiModel(store, {
    profileId: alpha.id,
    selectedJobId: job.id,
    at: '2026-07-24T12:00:00.000Z',
  });
  assert.equal(model.interviews.profileId, alpha.id);
  assert.deepEqual(model.interviews.counts, {
    stories: 3,
    verified: 1,
    stale: 1,
    draftIneligible: 1,
    debriefs: 2,
    currentDebriefRevisions: 2,
  });
  assert.equal(model.interviews.stories.some(story => story.profileId === beta.id), false);
  assert.equal(model.interviews.selectedApplication.applicationId, application.id);
  assert.equal(model.interviews.selectedApplication.jobId, job.id);
  assert.equal(model.interviews.selectedApplication.pack.audience, 'hiring_manager');
  assert.equal(model.interviews.selectedApplication.pack.coveredCount + model.interviews.selectedApplication.pack.gapCount, model.interviews.selectedApplication.pack.itemCount);
  assert.equal(model.interviews.selectedApplication.debriefs.count, 1);
  assert.equal(model.interviews.selectedApplication.debriefs.currentRevisions, 1);
  assert.equal(model.interviews.selectedApplication.debriefs.items[0].applicationId, application.id);

  const tui = makeTui(store, alpha.id, job.id);
  tui.executeCommand('interviews');
  assert.equal(tui.state.overlay, 'interviews');
  const first = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  const second = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.equal(first, second, 'interview overlay rendering is deterministic');
  assert.match(first, /INTERVIEWS · ALPHA PM/);
  assert.match(first, /stories 3 · verified 1 · stale 1 · draft\/ineligible 1/);
  assert.match(first, /debriefs 2 · current revisions 2/);
  assert.match(first, /Eligible Alpha story/);
  assert.match(first, /Stale Alpha story/);
  assert.match(first, /Draft Alpha story/);
  assert.doesNotMatch(first, /Hidden Beta story|beta-hidden-debrief|alpha-other-debrief/);
  assert.match(first, /:prep <stage> \[audience\]/);
  assert.match(first, /:story-verify <story-id> <revision> \| <confirmed-fields-csv>/);
  assert.match(first, /:story-retire <story-id> \| <reason>/);
  assert.match(first, /:debrief <json-file>/);
  assert.match(first, /:debrief-correct <debrief-id> \| <json-file> \| <reason>/);
});

test('W07-TUI-01 audience-aware prep uses the exact selected profile application', async t => {
  const { store, alpha, job, application, otherApplication } = await seeded(t);
  const tui = makeTui(store, alpha.id, job.id);
  const before = writeCount(store);

  tui.executeCommand('prep hiring-manager hiring_manager');
  await tick(250);

  assert.match(tui.state.status, /Interview prep draft created \(hiring-manager · hiring_manager\)/);
  const artifact = one(store, "SELECT * FROM artifacts WHERE type='interview_prep' ORDER BY created_at DESC,id DESC LIMIT 1");
  const item = one(store, 'SELECT * FROM interview_pack_items WHERE artifact_id=? ORDER BY position LIMIT 1', [artifact.id]);
  assert.equal(item.profile_id, alpha.id);
  assert.equal(item.application_id, application.id);
  assert.notEqual(item.application_id, otherApplication.id);
  assert.equal(item.interview_stage, 'hiring-manager');
  assert.equal(item.audience, 'hiring_manager');
  assert.ok(writeCount(store) > before);
});

test('W07-TUI-01 trusted story commands route as TUI and usage failures write nothing', async t => {
  const { store, alpha, activeProof, job } = await seeded(t);
  const verifyDraft = await draftStory(store, alpha.id, activeProof.id, 'Verify through TUI');
  const retireDraft = await draftStory(store, alpha.id, activeProof.id, 'Retire through TUI');
  await verifyStory(store, retireDraft);
  const tui = makeTui(store, alpha.id, job.id);

  const beforeUsage = writeCount(store);
  tui.executeCommand(`story-verify ${verifyDraft.id}`);
  await tick();
  assert.match(tui.state.status, /Usage: :story-verify/);
  tui.executeCommand(`story-retire ${retireDraft.id}`);
  await tick();
  assert.match(tui.state.status, /Usage: :story-retire/);
  assert.equal(writeCount(store), beforeUsage);

  tui.executeCommand(`story-verify ${verifyDraft.id} 1 |`);
  await tick();
  assert.match(tui.state.status, /Story verified/);
  assert.equal(one(store, "SELECT source FROM interview_story_revisions WHERE story_id=? AND state='verified'", [verifyDraft.id]).source, 'tui');

  tui.executeCommand(`story-retire ${retireDraft.id} | Replaced by a clearer example`);
  await tick();
  const retired = one(store, "SELECT source,change_reason FROM interview_story_revisions WHERE story_id=? AND state='retired'", [retireDraft.id]);
  assert.equal(retired.source, 'tui');
  assert.equal(retired.change_reason, 'Replaced by a clearer example');
});

test('W07-TUI-01 debrief files cannot spoof selected ownership and structured-file errors write nothing', async t => {
  const { root, store, alpha, beta, job, application, betaApplication } = await seeded(t);
  const tui = makeTui(store, alpha.id, job.id);
  const badFile = path.join(root, 'bad-debrief.json');
  writeFileSync(badFile, '[1,2,3]');
  const beforeBad = writeCount(store);
  tui.executeCommand(`debrief ${badFile}`);
  await tick();
  assert.match(tui.state.status, /Invalid JSON file .*expected an object/);
  assert.equal(writeCount(store), beforeBad);

  const recordFile = path.join(root, 'debrief.json');
  writeFileSync(recordFile, JSON.stringify({
    ...debriefPayload('tui-selected-debrief'),
    profileId: beta.id,
    jobId: betaApplication.job_id,
    applicationId: betaApplication.id,
    debriefId: 'spoofed-debrief',
    targetRevision: 99,
    reason: 'spoofed reason',
    source: 'mcp',
    fieldProvenance: Object.fromEntries(DEBRIEF_FIELDS.map(field => [
      field,
      { origin: 'user', actor: 'candidate', source: 'mcp', sourceRef: null },
    ])),
  }));
  tui.executeCommand(`debrief ${recordFile}`);
  await tick(200);
  assert.match(tui.state.status, /Debrief recorded/);
  const debrief = one(store, "SELECT * FROM interview_debriefs WHERE reference_id='tui-selected-debrief'");
  const revision = one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=? AND revision=1', [debrief.id]);
  assert.equal(debrief.profile_id, alpha.id);
  assert.equal(debrief.job_id, job.id);
  assert.equal(debrief.application_id, application.id);
  assert.equal(revision.source, 'tui');
  assert.equal(JSON.parse(revision.field_provenance_json).notes.source, 'tui');

  const correctionFile = path.join(root, 'debrief-correction.json');
  writeFileSync(correctionFile, JSON.stringify({
    ...debriefPayload('spoofed-reference', {
      occurredAt: '2026-07-22T16:45:00Z',
      observedOutcome: { type: 'advanced', note: 'A next conversation was scheduled.' },
      notes: 'Corrected local note.',
    }),
    profileId: beta.id,
    jobId: betaApplication.job_id,
    applicationId: betaApplication.id,
    interviewStage: 'offer',
    audience: 'executive',
    targetRevision: 99,
  }));
  tui.executeCommand(`debrief-correct ${debrief.id} | ${correctionFile} | Reviewed contemporaneous notes`);
  await tick(200);
  assert.match(tui.state.status, /Debrief corrected/);
  const current = one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=? ORDER BY revision DESC LIMIT 1', [debrief.id]);
  assert.equal(current.revision, 2);
  assert.equal(current.source, 'tui');
  assert.equal(current.correction_reason, 'Reviewed contemporaneous notes');
  const unchangedIdentity = one(store, 'SELECT * FROM interview_debriefs WHERE id=?', [debrief.id]);
  assert.equal(unchangedIdentity.profile_id, alpha.id);
  assert.equal(unchangedIdentity.application_id, application.id);
  assert.equal(unchangedIdentity.interview_stage, 'interview');
  assert.equal(unchangedIdentity.audience, 'hiring_manager');
  assert.equal(unchangedIdentity.reference_id, 'tui-selected-debrief');

  const beforeUsage = writeCount(store);
  tui.executeCommand(`debrief-correct ${debrief.id} | ${correctionFile}`);
  await tick();
  assert.match(tui.state.status, /Usage: :debrief-correct/);
  assert.equal(writeCount(store), beforeUsage);

  const betaFile = path.join(root, 'beta-debrief.json');
  writeFileSync(betaFile, JSON.stringify(debriefPayload('beta-owned-debrief')));
  const betaDebrief = await callDomainTool(store, 'record_interview_debrief', {
    profileId: beta.id,
    applicationId: betaApplication.id,
    ...debriefPayload('beta-owned-debrief'),
  }, { source: 'tui' });
  const beforeWrongApp = writeCount(store);
  tui.executeCommand(`debrief-correct ${betaDebrief.id} | ${betaFile} | Wrong selected application`);
  await tick();
  assert.match(tui.state.status, /selected profile\/application/);
  assert.equal(writeCount(store), beforeWrongApp);

  assert.equal(all(store, "SELECT DISTINCT external_side_effect FROM audit_log WHERE action LIKE 'interview.%'").every(row => row.external_side_effect === 'none'), true);
});
