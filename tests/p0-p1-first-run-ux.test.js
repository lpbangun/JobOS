import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, run, save } from '../src/db.js';
import { addProof, createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { buildTuiModel, fitUnlockGuidance } from '../src/tui-model.js';
import { defaultTuiState, JobosTui, renderTui } from '../src/tui.js';
import { createCompleteResumeFixture } from './fixtures/resume.js';

const AS_OF = '2026-08-07T12:00:00.000Z';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-p0-p1-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function output(width = 140, height = 42) {
  return {
    columns: width,
    rows: height,
    isTTY: false,
    writes: [],
    write(chunk) { this.writes.push(String(chunk)); },
    on() {},
    off() {}
  };
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

async function waitFor(predicate, timeoutMs = 30_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for TUI workflow');
    await new Promise(resolve => setTimeout(resolve, 20));
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

test('P0 insufficient FIT names concrete preferences in selected job, priority, help, and routes to calibration', async t => {
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
  assert.match(guidance, /Setup.*Your preferences \(g\)/);
  const dashboard = renderTui(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false }, { width: 150, height: 46, color: false });
  assert.match(dashboard, /Unlock FIT: add target roles, location\/work model, compensation, and mission/);
  const unlockIndex = model.priority.findIndex(item => item.actionId === 'unlock_fit');
  assert.ok(unlockIndex >= 0, JSON.stringify(model.priority));
  assert.match(model.priority[unlockIndex].text, /Your preferences/);
  const help = renderTui(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, overlay: 'help', helpContextOverlay: 'dashboard', agentOn: false }, { width: 120, height: 38, color: false });
  assert.match(help, /Press g, choose Your preferences/);

  const tui = new JobosTui(store, { connectAgent: false, stdout: output(), profileId: profile.id, selectedJobId: job.id, now: () => new Date(AS_OF) });
  tui.state.stripIndex = tui.model.priority.findIndex(item => item.actionId === 'unlock_fit');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup');
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'calibration');
});

test('P0/P1 in-process pursue exposes drafts and dashboard Enter opens exact review revisions', async t => {
  const { store, profile, job } = await fixture(t);
  const tui = new JobosTui(store, { connectAgent: false, stdout: output(), profileId: profile.id, selectedJobId: job.id, now: () => new Date(AS_OF) });

  await deterministic(async () => {
    tui.onKeypress('p', { name: 'p' });
    await waitFor(() => !tui.state.busy);
  });

  assert.deepEqual(new Set(tui.model.selected.docs.map(doc => doc.type)), new Set(['resume', 'cover_letter']));
  assert.ok(tui.model.review.length >= 2);
  assert.equal(tui.model.recommendedAction.id, 'review_materials');
  assert.equal(tui.model.recommendedAction.label, 'Review exact revisions');
  assert.equal(tui.model.priority[0].actionId, 'review_materials');
  assert.equal(tui.model.onboarding.steps.find(step => step.id === 'materials').actions[0].id, 'review_materials');

  tui.openDocuments();
  assert.equal(tui.state.overlay, 'docs');
  assert.equal(tui.model.selected.docs.length, 2);
  tui.state.overlay = null;
  tui.onKeypress('r', { name: 'r' });
  assert.equal(tui.state.overlay, 'review');
  assert.ok(tui.model.review.some(item => item.jobId === job.id));
  tui.state.overlay = null;
  tui.state.stripIndex = 0;
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'review');

  tui.state.overlay = null;
  tui.openOverlay('build-network');
  assert.equal(tui.state.networkDraft.targetCompanies, 'Acme Learning');
  tui.state.overlay = 'network';
  const network = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.equal(tui.model.selected.contacts.length, 0);
  assert.match(network, /No source-backed contacts were found.*did not invent contacts or paths/s);
});

test('P1 setup and discovery create company-watch searches and expose failed daily sources', async t => {
  const { store, profile, job } = await fixture(t);
  let model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
  const source = model.onboarding.steps.find(step => step.id === 'source');
  const companyWatch = source.actions.find(action => action.id === 'create_source_custom');
  assert.match(companyWatch.label, /Greenhouse company board/);
  assert.match(companyWatch.command, /--board-token <board-token>/);

  const tui = new JobosTui(store, { connectAgent: false, stdout: output(), profileId: profile.id, selectedJobId: job.id, now: () => new Date(AS_OF) });
  tui.openOverlay('discovery');
  tui.onKeypress('w', { name: 'w' });
  assert.equal(tui.state.mode, 'setup-discovery');
  tui.setInput('Acme Learning | greenhouse | acme-learning');
  tui.onKeypress('', { name: 'return' });
  const saved = tui.model.discovery.searches.find(search => search.config?.preset === 'company-watch');
  assert.ok(saved, JSON.stringify(tui.model.discovery.searches));
  assert.equal(saved.config.boardToken, 'acme-learning');

  run(store, `INSERT INTO automation_runs (id,trigger_name,inputs_json,outputs_json,status,external_side_effects,created_at,action_id,trigger_type,started_at,finished_at,duration_ms,error,counts_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'daily-failure-p0-p1', 'daily', JSON.stringify({ profileId: profile.id }), '{}', 'failed', 'none', AS_OF,
    'daily_discovery', 'manual', AS_OF, AS_OF, 1, 'Greenhouse board token was rejected', '{}'
  ]);
  save(store);
  tui.refresh({ disk: false, render: false });
  tui.state.overlay = 'discovery';
  const discovery = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(discovery, /RECENT DAILY FAILURES/);
  assert.match(discovery, /FAILED.*Greenhouse board token was rejected/);
  assert.match(discovery, /w company watch.*board-token/);
});
