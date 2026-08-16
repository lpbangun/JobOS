import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, one } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { listAnswers } from '../src/answers.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import { callDomainTool } from '../src/domain-tools.js';
import { JobosTui, renderTui } from '../src/tui.js';
import { SLASH_CATALOG } from '../src/tui/model.js';
import { createCompleteResumeFixture } from './fixtures/resume.js';

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
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-answers-entry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  const proof = addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio', ['product'], ['30%']);
  createCompleteResumeFixture(store, profile, proof);
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\n## Requirements\n- Must lead educator discovery and launch a learning platform that improves activation.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  await callDomainTool(store, 'score_job', { jobId: job.id, profileId: profile.id }, { source: 'tui' });
  await tailor(store, job.id, profile.id, 'resume');
  return { store, profile, job };
}

function makeTui(store, profile, job) {
  const tui = new JobosTui(store, { ...streams(), profileId: profile.id, selectedJobId: job.id, connectAgent: false, color: false });
  tui.refresh();
  return tui;
}

const openQuestions = (store, profile, job) =>
  compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id }).answers.questions
    .filter(q => q.status === 'unmatched' || q.status === 'blocked');

test('ANSW-01 answers_add denies mcp/acp mediation and allows the trusted TUI source', async t => {
  const { store, profile } = await seeded(t);
  for (const source of ['mcp', 'acp']) {
    await assert.rejects(
      callDomainTool(store, 'answers_add', { profileId: profile.id, question: 'Do you now or will you require sponsorship?', answer: 'No' }, { source }),
      error => error.code === 'human_answer_input_required',
      `${source} must not write answers`
    );
  }
  const saved = await callDomainTool(store, 'answers_add', { profileId: profile.id, category: 'other', question: 'Why JobOS?', answer: 'Human-gated mutations.' }, { source: 'tui' });
  assert.ok(saved.id);
});

test('ANSW-02 a trusted tui answers_add saves a verified answer and clears its readiness blocker', async t => {
  const { store, profile, job } = await seeded(t);
  const question = openQuestions(store, profile, job).find(q => q.status === 'unmatched' && !q.question.includes('|'));
  assert.ok(question, 'seeded readiness has an unmatched question');

  const saved = await callDomainTool(store, 'answers_add', {
    profileId: profile.id,
    category: question.category,
    question: question.question,
    answer: 'A verified response grounded in stored evidence.',
    sensitivity: 'public',
    verificationStatus: 'verified',
  }, { source: 'tui' });
  assert.ok(saved.id);
  const row = one(store, 'SELECT sensitivity,verification_status,reuse_scope FROM answers WHERE id=?', [saved.id]);
  assert.equal(row.sensitivity, 'public');
  assert.equal(row.verification_status, 'verified');
  // The valid persisted reuse scopes are global / employer_specific /
  // never_auto_fill; a public verified answer without an explicit scope lands
  // in the global pool (auto-fill only ever uses verified non-restricted rows).
  assert.equal(row.reuse_scope, 'global');

  const after = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id })
    .answers.questions.find(q => q.question === question.question);
  assert.notEqual(after.status, 'unmatched', 'the answered question is no longer unmatched');
});

test('ANSW-03 restricted answers are stored redacted, job-scoped, and never displayed', async t => {
  const { store, profile, job } = await seeded(t);
  const restricted = openQuestions(store, profile, job).find(q => q.status === 'blocked' && !q.question.includes('|'));
  assert.ok(restricted, 'seeded readiness has a restricted question');
  const SENTINEL = 'RESTRICTED-SENTINEL-VALUE';

  const saved = await callDomainTool(store, 'answers_add', {
    profileId: profile.id,
    category: restricted.category,
    question: restricted.question,
    answer: SENTINEL,
    sourceRef: `job:${job.id}`,
  }, { source: 'tui' });
  assert.ok(saved.id);

  const row = one(store, "SELECT * FROM answers WHERE profile_id=? AND sensitivity='restricted' ORDER BY created_at DESC LIMIT 1", [profile.id]);
  assert.ok(row, 'restricted answer stored');
  assert.equal(row.reuse_scope, 'never_auto_fill');
  assert.equal(row.employer, `job:${job.id}`, 'restricted answer is scoped to the selected job');

  const listed = listAnswers(store, { profileId: profile.id }).find(a => a.question === restricted.question);
  assert.equal(listed.answer, null, 'list redacts the restricted value');
  assert.equal(listed.redacted, true);

  const after = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id })
    .answers.questions.find(q => q.question === restricted.question);
  assert.notEqual(after.status, 'blocked', 'restricted direct input resolves the blocker');

  const tui = makeTui(store, profile, job);
  tui.openOverlay('files');
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.doesNotMatch(screen, new RegExp(SENTINEL), 'the TUI never shows the restricted value');
  assert.doesNotMatch(tui.state.status, new RegExp(SENTINEL), 'status never echoes the restricted value');
  // The questions reference row is the last Files row; its detail names the gate.
  tui.state.overlayIndex = tui.model.selected.docs.length;
  const questionsScreen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.match(questionsScreen, /restricted answers stay gated/, 'the files copy states the restricted-answer gate');
});

test('ANSW-04 malformed answers_add is rejected without mutating', async t => {
  const { store, profile } = await seeded(t);
  const before = one(store, 'SELECT COUNT(*) AS n FROM answers').n;
  await assert.rejects(
    callDomainTool(store, 'answers_add', { profileId: profile.id, question: 'Missing answer field' }, { source: 'tui' }),
    error => /required|answer/i.test(error.message)
  );
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM answers').n, before);
});

test('ANSW-05 the locked IA has no answers overlay and no colon answer bar', async t => {
  assert.equal(SLASH_CATALOG.some(item => /answer/.test(item.id)), false, 'no slash answer command in the locked catalog');
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  const text = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.doesNotMatch(text, /:answer add/, 'no colon command bar');
  assert.doesNotMatch(text, /┌ JOBS|SELECTED JOB/, 'no retired dashboard chrome');
  tui.state.overlay = 'answers';
  const fallback = renderTui(tui.model, tui.state, { width: 120, height: 38, color: false });
  assert.match(fallback, /Overlay — not a pane\./, 'a retired answers overlay falls back to the generic overlay');
});
