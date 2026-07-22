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
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });
  return tui;
}

const tick = (ms = 120) => new Promise(resolve => setTimeout(resolve, ms));
const openQuestions = (store, profile, job) =>
  compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id }).answers.questions
    .filter(q => q.status === 'unmatched' || q.status === 'blocked');

// Gap #6 — the answers overlay is more than counts-only for blocked jobs
test('answers overlay lists open questions with a minimal add path', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  const questions = openQuestions(store, profile, job);
  assert.ok(questions.length > 0, 'seeded readiness has open questions');
  tui.openOverlay('answers');
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.match(screen, /Open questions for the selected job/);
  assert.match(screen, /:answer add \[category\] \| <exact question> \| <your answer>/);
  const shown = questions.find(q => q.question.length <= 90 && !q.question.includes('|'));
  assert.ok(shown, 'at least one question is short enough to render whole');
  assert.ok(screen.includes(shown.question), 'question text (not any answer value) is listed');
  if (questions.some(q => q.status === 'blocked')) {
    assert.match(screen, /restricted — direct input required/);
  }
});

// Gap #6 — minimal add path clears the unmatched blocker
test(':answer add saves a verified answer and clears its readiness blocker', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  const question = openQuestions(store, profile, job).find(q => q.status === 'unmatched' && !q.question.includes('|'));
  assert.ok(question, 'seeded readiness has an unmatched question');

  tui.executeCommand(`answer add ${question.category} | ${question.question} | A verified response grounded in stored evidence.`);
  await tick();
  assert.match(tui.state.status, /Answer saved/);

  const after = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id })
    .answers.questions.find(q => q.question === question.question);
  assert.notEqual(after.status, 'unmatched', 'the answered question is no longer unmatched');
});

// Gap #6 — restricted values are stored redacted, job-scoped, and never displayed
test(':answer add stores restricted answers redacted and never displays the value', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  const restricted = openQuestions(store, profile, job).find(q => q.status === 'blocked' && !q.question.includes('|'));
  assert.ok(restricted, 'seeded readiness has a restricted question');
  const SENTINEL = 'RESTRICTED-SENTINEL-VALUE';

  tui.executeCommand(`answer add ${restricted.category} | ${restricted.question} | ${SENTINEL}`);
  await tick();
  assert.match(tui.state.status, /Answer saved/);
  assert.doesNotMatch(tui.state.status, new RegExp(SENTINEL), 'status never echoes the restricted value');

  const row = one(store, "SELECT * FROM answers WHERE profile_id=? AND sensitivity='restricted' ORDER BY created_at DESC LIMIT 1", [profile.id]);
  assert.ok(row, 'restricted answer stored');
  assert.equal(row.reuse_scope, 'never_auto_fill');
  assert.equal(row.employer, `job:${job.id}`, 'restricted answer is scoped to the selected job');

  const listed = listAnswers(store, { profileId: profile.id }).find(a => a.question === restricted.question);
  assert.equal(listed.answer, null, 'list redacts the restricted value');
  assert.equal(listed.redacted, true);

  tui.refresh({ disk: false });
  tui.openOverlay('answers');
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.doesNotMatch(screen, new RegExp(SENTINEL), 'TUI overlay never shows the restricted value');

  const after = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id })
    .answers.questions.find(q => q.question === restricted.question);
  assert.notEqual(after.status, 'blocked', 'restricted direct input resolves the blocker');
});

// Gap #6 — malformed input explains usage without mutating
test(':answer add rejects malformed input without mutating', async t => {
  const { store, profile, job } = await seeded(t);
  const tui = makeTui(store, profile, job);
  const before = one(store, 'SELECT COUNT(*) AS n FROM answers').n;
  tui.executeCommand('answer add onlyonepart');
  await tick(40);
  assert.match(tui.state.status, /Usage: :answer add/);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM answers').n, before);
});

// Gap #6 — answers stay human input: agent mediation is denied
test('answers_add denies mcp/acp mediation', async t => {
  const { store, profile } = await seeded(t);
  for (const source of ['mcp', 'acp']) {
    await assert.rejects(
      callDomainTool(store, 'answers_add', { profileId: profile.id, question: 'Do you now or will you require sponsorship?', answer: 'No' }, { source }),
      error => error.code === 'human_answer_input_required',
      `${source} must not write answers`
    );
  }
  // tui source is allowed
  const saved = await callDomainTool(store, 'answers_add', { profileId: profile.id, category: 'other', question: 'Why JobOS?', answer: 'Human-gated mutations.' }, { source: 'tui' });
  assert.ok(saved.id);
});
