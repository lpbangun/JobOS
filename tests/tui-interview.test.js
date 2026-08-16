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
import { mcpToolNames } from '../src/mcp.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';
import { SLASH_CATALOG } from '../src/tui/model.js';

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
  tui.refresh();
  return tui;
}

test('W07-TUI-01 the interview projection is deterministic, profile-scoped, and application-scoped', async t => {
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

  const first = buildTuiModel(store, {
    profileId: alpha.id,
    selectedJobId: job.id,
    at: '2026-07-24T12:00:00.000Z',
  });
  const second = buildTuiModel(store, {
    profileId: alpha.id,
    selectedJobId: job.id,
    at: '2026-07-24T12:00:00.000Z',
  });
  assert.deepEqual(first.interviews, second.interviews, 'interview projection is deterministic');
  assert.equal(first.interviews.profileId, alpha.id);
  assert.deepEqual(first.interviews.counts, {
    stories: 3,
    verified: 1,
    stale: 1,
    draftIneligible: 1,
    debriefs: 2,
    currentDebriefRevisions: 2,
  });
  assert.equal(first.interviews.stories.some(story => story.profileId === beta.id), false);
  assert.equal(first.interviews.selectedApplication.applicationId, application.id);
  assert.equal(first.interviews.selectedApplication.jobId, job.id);
  assert.equal(first.interviews.selectedApplication.pack.audience, 'hiring_manager');
  assert.equal(first.interviews.selectedApplication.pack.coveredCount + first.interviews.selectedApplication.pack.gapCount, first.interviews.selectedApplication.pack.itemCount);
  assert.equal(first.interviews.selectedApplication.debriefs.count, 1);
  assert.equal(first.interviews.selectedApplication.debriefs.currentRevisions, 1);
});

test('W07-TUI-01 audience-aware prep uses the exact selected profile application', async t => {
  const { store, alpha, application, otherApplication } = await seeded(t);
  await callDomainTool(store, 'interview_prep', {
    applicationId: application.id,
    stage: 'interview',
    audience: 'hiring_manager',
  }, { source: 'tui' });
  const artifact = one(store, "SELECT * FROM artifacts WHERE type='interview_prep' ORDER BY created_at DESC,id DESC LIMIT 1");
  const item = one(store, 'SELECT * FROM interview_pack_items WHERE artifact_id=? ORDER BY position LIMIT 1', [artifact.id]);
  assert.equal(item.profile_id, alpha.id);
  assert.equal(item.application_id, application.id);
  assert.notEqual(item.application_id, otherApplication.id);
  assert.equal(item.interview_stage, 'interview');
  assert.equal(item.audience, 'hiring_manager');
});

test('W07-TUI-01 trusted story commands stay trusted-human and never appear in the agent catalog', async t => {
  const { store, alpha, activeProof } = await seeded(t);
  const verifyDraft = await draftStory(store, alpha.id, activeProof.id, 'Verify through TUI');
  await verifyStory(store, verifyDraft);
  const retired = await draftStory(store, alpha.id, activeProof.id, 'Retire through TUI');
  await callDomainTool(store, 'retire_interview_story', {
    profileId: alpha.id,
    storyId: retired.id,
    revision: retired.currentRevision.revision,
    reason: 'Replaced by a clearer example',
    actor: 'user',
  }, { source: 'tui' });

  const revision = one(store, "SELECT source,change_reason FROM interview_story_revisions WHERE story_id=? AND state='retired'", [retired.id]);
  assert.equal(revision.source, 'tui');
  assert.equal(revision.change_reason, 'Replaced by a clearer example');

  const mcp = new Set(mcpToolNames());
  for (const tool of ['verify_interview_story', 'retire_interview_story', 'add_interview_question_source', 'record_interview_debrief', 'correct_interview_debrief']) {
    assert.equal(mcp.has(tool), false, `${tool} must remain a direct trusted human surface`);
  }
  for (const tool of ['list_interview_stories', 'get_interview_story', 'draft_interview_story', 'interview_prep', 'list_interview_debriefs', 'list_interview_observations']) {
    assert.equal(mcp.has(tool), true, `${tool} must be readable by the ACP guest through its MCP catalog`);
  }
});

test('W07-TUI-01 debrief ownership cannot be spoofed through agent sources', async t => {
  const { store, alpha, beta, job, application, betaApplication } = await seeded(t);
  const betaDebrief = await callDomainTool(store, 'record_interview_debrief', {
    profileId: beta.id,
    applicationId: betaApplication.id,
    ...debriefPayload('beta-owned-debrief'),
  }, { source: 'tui' });
  const spoofed = await callDomainTool(store, 'record_interview_debrief', {
    profileId: beta.id,
    applicationId: betaApplication.id,
    ...debriefPayload('spoofed-source-debrief', { source: 'mcp' }),
  }, { source: 'tui' });
  const debrief = one(store, 'SELECT * FROM interview_debriefs WHERE id=?', [spoofed.id]);
  const revision = one(store, 'SELECT * FROM interview_debrief_revisions WHERE debrief_id=? AND revision=1', [debrief.id]);
  assert.equal(debrief.profile_id, beta.id);
  assert.equal(revision.source, 'tui', 'the persisted revision source is the trusted caller, never a spoofed field');
  assert.ok(betaDebrief.id);
  assert.equal(one(store, 'SELECT profile_id FROM interview_debriefs WHERE id=?', [betaDebrief.id]).profile_id, beta.id);
  assert.equal(
    all(store, "SELECT DISTINCT external_side_effect FROM audit_log WHERE action LIKE 'interview.%'").every(row => row.external_side_effect === 'none'),
    true
  );
});

test('W07-TUI-01 the locked IA has no interview pane or overlay and no colon interview commands', async t => {
  const { store, alpha, job } = await seeded(t);
  assert.equal(SLASH_CATALOG.some(item => /interview|prep|story|debrief/.test(item.id)), false, 'no interview slash commands in the locked catalog');
  const tui = makeTui(store, alpha.id, job.id);
  const text = renderTui(tui.model, tui.state, { width: 140, height: 46, color: false });
  assert.doesNotMatch(text, /INTERVIEWS ·|stories \d · verified/, 'no interview suite pane');
  assert.doesNotMatch(text, /:prep |:story-verify|:debrief/, 'no colon interview commands');
  assert.doesNotMatch(text, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');
  for (const overlay of ['interviews', 'docs', 'log', 'discovery', 'packet', 'due']) {
    tui.state.overlay = overlay;
    const screen = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
    assert.match(screen, /Overlay — not a pane\./, `retired overlay ${overlay} must fall back to the generic overlay, never a live pane`);
    assert.doesNotMatch(screen, /SELECTED JOB|┌ JOBS/, `retired overlay ${overlay} must not resurrect dashboard panes`);
  }
});
