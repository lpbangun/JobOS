import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, one, run, save } from '../src/db.js';
import { addProof, createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { buildTuiModel, fitUnlockGuidance } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';
import { fitLabel } from '../src/tui/model.js';
import { createCompleteResumeFixture } from './fixtures/resume.js';

const AS_OF = '2026-08-07T12:00:00.000Z';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-p0-p1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
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

function makeTui(store, profileId, jobId) {
  const tui = new JobosTui(store, { ...streams(), profileId, selectedJobId: jobId, connectAgent: false, color: false });
  tui.refresh();
  return tui;
}

async function fixture(t) {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Alex Chen').profile;
  const firstProof = addProof(
    store,
    profile.id,
    'Led educator discovery and launched a learning platform that improved activation by 30%.',
    'Portfolio case study',
    ['product discovery', 'launch'],
    ['30%']
  );
  const secondProof = addProof(
    store,
    profile.id,
    'Coordinated product and engineering teams to ship a reliable workflow for twelve customer organizations.',
    'Launch retrospective',
    ['product', 'engineering'],
    ['12']
  );
  createCompleteResumeFixture(store, profile, firstProof, {
    identity: {
      name: 'Avery Candidate',
      email: 'avery@example.test',
      phone: '+1 555 555 0100',
      location: 'Remote',
      links: [],
      verificationStatus: 'verified'
    }
  });
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, [
    'Title: Senior Product Manager',
    'Company: Acme Learning',
    'Location: Remote',
    '',
    'Lead educator discovery and launch a learning platform.',
    'Coordinate product and engineering teams to ship reliable customer workflows.'
  ].join('\n'));
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  return { root, store, profile, firstProof, secondProof, job };
}

async function deterministic(fn) {
  const keys = ['JOBOS_AGENT', 'JOBOS_LLM_PROVIDER', 'JOBOS_LLM_MODEL', 'JOBOS_LLM_API_KEY'];
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.JOBOS_AGENT = 'off';
  delete process.env.JOBOS_LLM_PROVIDER;
  delete process.env.JOBOS_LLM_MODEL;
  delete process.env.JOBOS_LLM_API_KEY;
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

test('P0 identity and cover quality use canonical resume identity with proof-safe prose', async t => {
  const { store, profile, firstProof, secondProof, job } = await fixture(t);
  const cover = await deterministic(() => tailor(store, job.id, profile.id, 'cover'));

  assert.equal(cover.approvalStatus, 'draft_needs_human_review');
  assert.match(cover.content, /Dear hiring team,\n\nI am applying for Senior Product Manager at Acme Learning\./);
  assert.match(cover.content, new RegExp(firstProof.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(cover.content, new RegExp(secondProof.summary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((cover.content.match(/from my verified records:/g) || []).length, 2);
  assert.doesNotMatch(cover.content, /^- .*verified records/m);
  assert.match(cover.content, /Sincerely,\nAvery Candidate\n\n## Evidence warnings/);
  assert.doesNotMatch(cover.content, /Alex Chen|search profile/);
  assert.deepEqual(cover.evidence.filter(item => item.proofPointId).map(item => item.proofPointId).sort(), [firstProof.id, secondProof.id].sort());
  assert.match(cover.content, /Draft; human review required before sending/);
  assert.match(cover.content, /did not send email, submit forms, or contact anyone/);
});

test('P0 insufficient FIT names concrete preferences in the model and routes to setup', async t => {
  const { store, profile, job } = await fixture(t);
  const fit = {
    contract: 'jobos.fit-score.v1',
    version: 1,
    jobId: job.id,
    profileId: profile.id,
    overall: null,
    scoreStatus: 'insufficient_evidence',
    evidenceCoverage: 40,
    mode: 'deterministic-degraded',
    dimensions: {},
    constraints: [],
    postingRisks: [],
    reasoning: 'Not enough explicit preference evidence.'
  };
  run(store, 'UPDATE jobs SET fit_score=NULL,score_json=? WHERE id=?', [JSON.stringify(fit), job.id]);
  save(store);

  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
  const guidance = fitUnlockGuidance(model.selected.fit);
  assert.match(guidance, /target roles.*location\/work model.*compensation.*mission/i);
  assert.match(fitLabel(model.selected.fit), /low evidence · 40%/, 'the fit chip names the evidence gap, not unscored');
  assert.doesNotMatch(fitLabel(model.selected.fit), /unscored|unknown/);
  const unlockIndex = model.priority.findIndex(item => item.actionId === 'unlock_fit');
  assert.ok(unlockIndex >= 0, JSON.stringify(model.priority));
  assert.match(model.priority[unlockIndex].text, /Your preferences/);

  const tui = makeTui(store, profile.id, job.id);
  tui.runSlash('setup');
  assert.equal(tui.state.overlay, 'setup', '/setup opens guided setup');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(screen, /Your preferences/, 'the calibration step is reachable from setup');
  assert.doesNotMatch(screen, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');
});

test('P0/P1 in-process create-files exposes drafts and review opens the exact Files revision', async t => {
  const { store, profile, job } = await fixture(t);
  const tui = makeTui(store, profile.id, job.id);
  tui.runSlash('create-files');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(tui.state.overlay, 'files', '/create-files lands in the Files overlay');
  assert.deepEqual(new Set(tui.model.selected.docs.map(doc => doc.type)), new Set(['resume']), 'the resume artifact is written');
  assert.ok(tui.model.review.length >= 1, 'the draft joins the review queue');
  const filesText = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(filesText, /resume\.md/, 'the Files overlay names the exact draft');
  assert.match(filesText, /questions\.md/, 'the questions reference copy is present');
  assert.doesNotMatch(filesText, /No documents for this job/, 'drafts exist');

  // The review brief opens the exact revision.
  tui.runSlash('review');
  assert.equal(tui.state.overlay, 'review');
  const draftIndex = tui.model.review.findIndex(item => item.jobId === job.id);
  assert.ok(draftIndex >= 0);
  tui.state.overlayIndex = draftIndex;
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'files', 'Enter on the brief draft opens the Files overlay');
});

test('P1 setup source actions exist and the sample search persists; /network invents nothing', async t => {
  const { store, profile, job } = await fixture(t);
  const tui = makeTui(store, profile.id, job.id);
  const sourceStep = tui.model.onboarding.steps.find(step => step.id === 'source');
  const companyWatch = sourceStep.actions.find(action => action.id === 'create_source_custom');
  assert.match(companyWatch.label, /Greenhouse company board/);
  assert.match(companyWatch.command, /--board-token <board-token>/);

  tui.runSlash('network');
  assert.equal(tui.state.overlay, 'network');
  const network = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(network, /No stored relationships yet/, 'an empty graph says so');
  assert.doesNotMatch(network, /Ada Lovelace|Alumni Via|Example Learning|Contoso/, 'no invented contacts or paths');

  const sourceIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'source');
  tui.state.overlayIndex = sourceIndex;
  tui.state.overlay = 'setup';
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok(one(store, 'SELECT * FROM saved_searches WHERE profile_id=?', [profile.id]), 'the sample offline search persists');
  assert.equal(tui.model.discovery.searches.length, 1, 'the discovery model exposes the saved search');
});

test('P0/P1 first-run welcome is honest and skip never invents state', async t => {
  const root = workspace(t);
  const store = await openStore({ workspace: root });
  const tui = makeTui(store, null, null);
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 34, color: false });
  assert.match(screen, /welcome to jobos/i, 'welcome overlay is first-run chrome');
  assert.doesNotMatch(screen, /Example Learning|Harbor Schools|Contoso Careers Lab|Lumen Labs/, 'no invented listings');
  tui.handleKey('', { escape: true });
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM profiles').n, 0, 'skip creates no profile');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM jobs').n, 0, 'skip creates no jobs');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM proof_points').n, 0, 'skip creates no proofs');
});
