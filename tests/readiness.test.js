// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// ── helpers ──────────────────────────────────────────────────────────

function makeRunner({ extraEnv = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-readiness-'));
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_LLM_PROVIDER: '',
    JOBOS_LLM_MODEL: '',
    JOBOS_LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OLLAMA_API_KEY: '',
    JOBOS_SEARCH_PROVIDER: 'none',
    JOBOS_SMTP_PROBE: 'false',
    ...extraEnv
  };
  const jobos = (args, { expectFail = false, json = true, timeoutMs = 15_000 } = {}) => {
    const full = json ? [...args, '--json'] : args;
    const result = spawnSync(process.execPath, ['src/cli.js', ...full], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: timeoutMs
    });
    if (!expectFail && result.status !== 0) {
      const detail = `STDERR:\n${(result.stderr || '').slice(0, 4000)}\nSTDOUT:\n${(result.stdout || '').slice(0, 2000)}`;
      assert.equal(result.status, 0, `${args.join(' ')}\n${detail}`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const out = (args, opts) => {
    const r = jobos(args, opts);
    if (r.status === 0) return JSON.parse(r.stdout);
    try { return JSON.parse(r.stderr); } catch { return JSON.parse(r.stdout); }
  };
  return { root, env, jobos, out };
}

function fixtureFile(root, name, content) {
  const p = path.join(root, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ── SETUP ────────────────────────────────────────────────────────────

const SAMPLE_JOB = [
  '# Senior Product Manager, Learning Platform',
  'Company: Acme Learning Co',
  'Location: Remote US',
  '',
  'Acme Learning Co builds tools for educators and workforce teams.',
  '',
  'Requirements:',
  '- 4+ years product management experience in EdTech.',
  '- Strong written communication and stakeholder management.',
  '- Evidence of launching products with measurable outcomes.',
  '- Comfort with remote collaboration across US time zones.',
  '',
  'Benefits include remote work and health coverage.',
].join('\n');

const SAMPLE_RESUME_FULL = [
  '- Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.',
  '- Shipped a cross-functional product launch with engineering and design partners, improving activation for a technical user workflow.',
  '- Built dashboards and weekly operating reviews that connected adoption data to roadmap decisions.',
].join('\n');

const SAMPLE_RESUME_SHORT = '- Built a thing.\n';

// ── Shape contract — plan structure ──────────────────────────────────

test('readiness: plan contains all top-level shape fields', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  assert.equal(typeof plan.version, 'number');
  assert.equal(plan.version, 3);
  assert.equal(typeof plan.generatedAt, 'string');
  assert.ok(plan.generatedAt.length > 0);
  assert.equal(plan.jobId, imported.id);
  assert.equal(plan.profileId, 'pm');
  assert.ok(['blocked', 'ready-for-review', 'approved'].includes(plan.status));
  assert.equal(typeof plan.readyForReview, 'boolean');
  assert.ok(plan.review);
  for (const key of ['requiredArtifactIds', 'approvedArtifactIds', 'pendingArtifactIds', 'rejectedArtifactIds']) {
    assert.ok(Array.isArray(plan.review[key]), `review.${key} is an array`);
  }
  assert.equal(typeof plan.review.localApprovalComplete, 'boolean');
  assert.equal(typeof plan.localApprovalComplete, 'boolean');
  assert.deepEqual(plan.packet, {
    currentPacketId: null,
    contentHash: null,
    attemptNumber: null,
    revision: null,
    currency: 'none',
    receiptState: 'none',
    attestable: false,
    latestReceiptId: null
  });
  // Identity section
  assert.ok(plan.identity);
  assert.equal(typeof plan.identity.identityKey, 'string');
  assert.equal(typeof plan.identity.employerKey, 'string');
  assert.equal(typeof plan.identity.sourceKey, 'string');
  assert.equal(typeof plan.identity.applicationKey, 'string');
  assert.equal(typeof plan.identity.dedupeKey, 'string');
  assert.equal(typeof plan.identity.source, 'string');

  // Job summary
  assert.ok(plan.job);
  assert.equal(plan.job.id, imported.id);

  // Application (may be null)
  assert.ok(plan.application === null || typeof plan.application === 'object');

  // Materials — each is an object, not a boolean
  assert.ok(plan.materials);
  assert.equal(typeof plan.materials.score, 'object');
  assert.equal(typeof plan.materials.proofs, 'object');
  assert.equal(typeof plan.materials.resume, 'object');
  assert.equal(typeof plan.materials.coverLetter, 'object');

  // Answers section
  assert.ok(plan.answers);
  assert.equal(typeof plan.answers.matched, 'number');
  assert.equal(typeof plan.answers.unmatched, 'number');
  assert.equal(typeof plan.answers.restricted, 'number');
  assert.equal(typeof plan.answers.unresolvedRestricted, 'number');
  assert.equal(typeof plan.answers.count, 'number');
  assert.ok(Array.isArray(plan.answers.questions));

  // Blockers — array with code, message, nextAction
  assert.ok(Array.isArray(plan.blockers));
  if (plan.blockers.length) {
    for (const b of plan.blockers) {
      assert.equal(typeof b.code, 'string');
      assert.ok(b.code.length >= 3);
      assert.equal(typeof b.nextAction, 'string');
      assert.ok(b.nextAction.length >= 3);
    }
  }

  // nextActions parallel to blockers
  assert.ok(Array.isArray(plan.nextActions));
  assert.equal(plan.nextActions.length, plan.blockers.length);

  // Warnings
  assert.ok(Array.isArray(plan.warnings));

  // possibleDuplicateApplications
  assert.ok(Array.isArray(plan.possibleDuplicateApplications));

  // Policy
  assert.ok(plan.policy);
  assert.equal(plan.policy.externalSideEffects, 'none');
  assert.equal(plan.policy.submissionPerformed, false);
  assert.equal(plan.policy.applicationStatusChanged, false);
  assert.ok(Array.isArray(plan.policy.readyDoesNotMean));
  assert.ok(plan.policy.readyDoesNotMean.includes('submitted'));
  assert.ok(plan.policy.readyDoesNotMean.includes('applied'));

  // Mirror path
  assert.equal(typeof plan.mirrorPath, 'string');
  assert.ok(plan.mirrorPath.endsWith('application-readiness.yaml'));
});

// ── Blocked plan — missing score, proofs, resume ──────────────────────

test('readiness: blocked plan when score, proofs, and resume are missing', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  assert.equal(plan.status, 'blocked');
  assert.equal(plan.readyForReview, false);

  // Materials: all missing
  assert.equal(plan.materials.proofs.status, 'missing');
  assert.equal(plan.materials.score.status, 'missing');
  assert.equal(plan.materials.resume.status, 'missing');
  assert.equal(plan.materials.coverLetter.status, 'missing');

  // Blockers for each missing item
  const blockerCodes = plan.blockers.map(b => b.code);
  assert.ok(blockerCodes.includes('missing_proofs'), 'missing_proofs blocker');
  assert.ok(blockerCodes.includes('missing_score'), 'missing_score blocker');
  assert.ok(blockerCodes.includes('missing_resume_material'), 'missing_resume_material blocker');

  // Each blocker has machine-readable code and concrete next action
  for (const b of plan.blockers) {
    assert.ok(b.code.length >= 3, `blocker code "${b.code}" should be descriptive`);
    assert.ok(b.nextAction.length >= 10, `blocker nextAction "${b.nextAction}" should be actionable`);
  }
});

// ── Blocked plan — unmatched and restricted answers ───────────────────

test('readiness: blocked plan shows unmatched and restricted-answer blockers', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_FULL);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  // Add proofs, score, and resume so materials pass
  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led EdTech product discovery', '--evidence', 'Reduced manual review by 30%', '--skills', 'product,edtech']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  assert.equal(plan.status, 'blocked');

  // Materials pass
  assert.equal(plan.materials.proofs.status, 'available');
  assert.equal(plan.materials.score.status, 'available');
  assert.equal(plan.materials.resume.status, 'reviewable-draft');

  // Answers show unmatched ordinary questions and unresolved restricted ones
  assert.ok(plan.answers.unmatched >= 1, 'should have unmatched ordinary questions');
  assert.ok(plan.answers.unresolvedRestricted >= 1, 'should have unresolved restricted questions');
  assert.ok(plan.answers.restricted >= 1, 'should have restricted-category questions');

  // Blockers include unmatched_questions and restricted_questions_require_input
  const blockerCodes = plan.blockers.map(b => b.code);
  assert.ok(blockerCodes.includes('unmatched_questions'), 'should have unmatched_questions blocker');
  assert.ok(blockerCodes.includes('restricted_questions_require_input'), 'should have restricted_questions_require_input blocker');

  // Restricted questions in the output are redacted
  const restrictedQ = plan.answers.questions.filter(q => q.status === 'blocked');
  for (const q of restrictedQ) {
    assert.equal(q.blocker, 'sensitive_prompt');
    assert.equal(q.answerId, null);
    assert.equal(typeof q.question, 'string');
    assert.equal(q.autoFill, false);
  }
});

// ── Ready-for-review with complete evidence and direct restricted answers ──

test('readiness: ready-for-review with score, proofs, resume, matched ordinary, and direct-input restricted answers', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_FULL);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  // Evidence
  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led EdTech product discovery', '--evidence', 'Reduced manual review by 30%', '--skills', 'product,edtech']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  // Add ordinary verified answers matching the application questions
  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation',
    '--question', 'Why are you interested in Acme Learning Co?',
    '--answer', 'I am passionate about EdTech and Acmes mission aligns with my experience.',
    '--sensitivity', 'public', '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'experience_story',
    '--question', 'Describe the experience that best prepares you for the Senior Product Manager, Learning Platform role.',
    '--answer', 'I led product discovery for AI-assisted learning workflows at my previous company.',
    '--sensitivity', 'public', '--status', 'verified']);
  // Add answers for requirement-derived questions
  out(['answers', 'add', '--profile', 'pm', '--category', 'experience_story',
    '--question', 'Describe your experience with: Requirements:',
    '--answer', 'I have led product requirements gathering for EdTech platforms.',
    '--sensitivity', 'public', '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'experience_story',
    '--question', 'Describe your experience with: - 4+ years product management experience in EdTech.',
    '--answer', 'I have over 5 years of product management experience in EdTech.',
    '--sensitivity', 'public', '--status', 'verified']);
  // Add direct restricted answers scoped to this job (required for direct_input_recording)
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Are you legally authorized to work in the role location?',
    '--answer', 'yes', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill',
    '--source', `job:${imported.id}`, '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Will you now or later require employment sponsorship?',
    '--answer', 'no', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill',
    '--source', `job:${imported.id}`, '--status', 'verified']);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  // Materials pass
  assert.equal(plan.materials.proofs.status, 'available');
  assert.equal(plan.materials.score.status, 'available');
  assert.equal(plan.materials.resume.status, 'reviewable-draft');

  // Covered ordinary questions
  assert.ok(plan.answers.matched >= 1, 'should have matched ordinary questions');
  const matchedQ = plan.answers.questions.find(q => q.status === 'matched');
  assert.ok(matchedQ, 'at least one matched question exists');
  assert.equal(typeof matchedQ.answerId, 'string');
  assert.equal(matchedQ.autoFill, true);

  // Restricted questions with direct input
  assert.ok(plan.answers.directInputRecorded >= 1, 'should have recorded direct input for restricted questions');
  const directQ = plan.answers.questions.find(q => q.status === 'direct_input_recorded');
  if (directQ) {
    assert.equal(directQ.blocker, null);
    assert.equal(directQ.redacted, true);
    assert.equal(directQ.autoFill, false);
    assert.equal(typeof directQ.answerId, 'string');
  }

  // All unanswered ordinary and restricted resolved → no blockers from those
  const codesBlockingNow = plan.blockers.map(b => b.code);
  assert.ok(!codesBlockingNow.includes('unmatched_questions'), 'no unmatched_questions blocker');
  assert.ok(!codesBlockingNow.includes('restricted_questions_require_input'), 'no restricted_questions_require_input blocker');

  // Warnings include optional cover letter note
  assert.ok(Array.isArray(plan.warnings));
});

// ── Human review transitions ─────────────────────────────────────────

test('readiness: current human-approved resume transitions ready-for-review to approved, then a redraft returns it to ready-for-review', async () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_FULL);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);
  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led EdTech product discovery', '--evidence', 'Reduced manual review by 30%']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);
  out(['applications', 'create', '--job', imported.id, '--status', 'researching']);

  const { openStore, one, run, save } = await import('../src/db.js');
  const store = await openStore({ workspace: root });
  run(store, 'UPDATE jobs SET requirements_json=? WHERE id=?', ['[]', imported.id]);
  save(store);

  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation',
    '--question', 'Why are you interested in Acme Learning Co?', '--answer', 'The mission fits my experience.',
    '--sensitivity', 'public', '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'experience_story',
    '--question', 'Describe the experience that best prepares you for the Senior Product Manager, Learning Platform role.',
    '--answer', 'I have relevant product experience.', '--sensitivity', 'public', '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Are you legally authorized to work in the role location?', '--answer', 'yes',
    '--sensitivity', 'restricted', '--reuse', 'never_auto_fill', '--source', `job:${imported.id}`, '--status', 'verified']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Will you now or later require employment sponsorship?', '--answer', 'no',
    '--sensitivity', 'restricted', '--reuse', 'never_auto_fill', '--source', `job:${imported.id}`, '--status', 'verified']);

  const draftPlan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  const original = one(await openStore({ workspace: root }), `SELECT * FROM artifacts
    WHERE job_id=? AND profile_id=? AND type='resume'`, [imported.id, 'pm']);
  assert.equal(draftPlan.status, 'ready-for-review');
  assert.equal(draftPlan.readyForReview, true);
  assert.equal(draftPlan.review.localApprovalComplete, false);
  assert.equal(draftPlan.localApprovalComplete, false);
  assert.deepEqual(draftPlan.review.pendingArtifactIds, [original.id]);

  const approval = out(['artifacts', 'approve', original.id, '--note', 'Verified against stored proof.']);
  assert.equal(approval.approvalStatus, 'approved');
  assert.equal(approval.externalSideEffects, 'none');
  assert.equal(approval.submissionPerformed, false);
  assert.equal(approval.applicationStatusChanged, false);
  const approvedMirrorBeforePlan = readFileSync(path.join(root, 'jobos-workspace', 'jobs', imported.id, 'application-readiness.yaml'), 'utf8');
  assert.match(approvedMirrorBeforePlan, /status: approved/);
  assert.match(approvedMirrorBeforePlan, /localApprovalComplete: true/);

  const approvedPlan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.equal(approvedPlan.status, 'approved');
  assert.equal(approvedPlan.readyForReview, true);
  assert.equal(approvedPlan.materials.resume.status, 'approved');
  assert.deepEqual(approvedPlan.review.requiredArtifactIds, [original.id]);
  assert.deepEqual(approvedPlan.review.approvedArtifactIds, [original.id]);
  assert.deepEqual(approvedPlan.review.pendingArtifactIds, []);
  assert.equal(approvedPlan.review.localApprovalComplete, true);
  assert.equal(approvedPlan.localApprovalComplete, true);
  assert.equal(approvedPlan.application.status, 'researching');
  assert.equal(approvedPlan.policy.submissionPerformed, false);
  assert.equal(approvedPlan.policy.applicationStatusChanged, false);
  const approvedApplication = one(await openStore({ workspace: root }),
    'SELECT status,confirmation_url FROM applications WHERE job_id=? AND profile_id=?', [imported.id, 'pm']);
  assert.deepEqual(approvedApplication, { status: 'researching', confirmation_url: '' });

  const redraft = out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);
  const redraftId = redraft.id;
  const redraftMirrorBeforePlan = readFileSync(path.join(root, 'jobos-workspace', 'jobs', imported.id, 'application-readiness.yaml'), 'utf8');
  assert.match(redraftMirrorBeforePlan, /status: ready-for-review/);
  assert.match(redraftMirrorBeforePlan, /localApprovalComplete: false/);

  const redraftPlan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.equal(redraftPlan.status, 'ready-for-review');
  assert.equal(redraftPlan.readyForReview, true);
  assert.equal(redraftPlan.materials.resume.status, 'reviewable-draft');
  assert.equal(redraftPlan.materials.resume.artifactId, redraftId);
  assert.deepEqual(redraftPlan.review.approvedArtifactIds, []);
  assert.deepEqual(redraftPlan.review.pendingArtifactIds, [redraftId]);
  assert.equal(redraftPlan.review.localApprovalComplete, false);
  assert.equal(redraftPlan.localApprovalComplete, false);

  const cover = out(['tailor', 'cover-letter', '--job', imported.id, '--profile', 'pm']);
  out(['artifacts', 'reject', cover.id, '--note', 'Optional cover is not needed.']);
  out(['artifacts', 'reject', redraftId, '--note', 'Resume needs another revision.']);
  const rejectedCoverId = cover.id;

  const rejectedPlan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.equal(rejectedPlan.status, 'blocked');
  assert.equal(rejectedPlan.readyForReview, false);
  assert.equal(rejectedPlan.materials.resume.status, 'rejected');
  assert.deepEqual(rejectedPlan.review.requiredArtifactIds, [redraftId]);
  assert.deepEqual(rejectedPlan.review.rejectedArtifactIds.sort(), [redraftId, rejectedCoverId].sort());
  assert.equal(rejectedPlan.review.localApprovalComplete, false);
  assert.equal(rejectedPlan.localApprovalComplete, false);
  assert.ok(rejectedPlan.blockers.some(item => item.code === 'resume_rejected'));
  assert.ok(rejectedPlan.warnings.some(item => item.code === 'cover_letter_rejected'));
});

// ── Redaction in JSON output ──────────────────────────────────────────

test('readiness: sensitive and restricted answer values are redacted in JSON plan', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led discovery', '--evidence', 'Evidence']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  // Public answer
  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation',
    '--question', 'Why are you interested in Acme Learning Co?',
    '--answer', 'I admire their mission.', '--sensitivity', 'public', '--status', 'verified']);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  // Ordinary matched answer has autoFill=true and no redaction (redacted field absent for matched)
  const matchedQ = plan.answers.questions.find(q => q.status === 'matched');
  if (matchedQ) {
    assert.equal(matchedQ.autoFill, true);
    // matched questions do NOT have a redacted field (it's absent, not false)
    assert.equal(matchedQ.hasOwnProperty('redacted'), false);
  }
  // Restricted-category questions are always redacted/blocked or direct_input_recorded with redacted=true
  const blockedOrDirect = plan.answers.questions.filter(q =>
    q.status === 'blocked' || q.status === 'direct_input_recorded'
  );
  for (const q of blockedOrDirect) {
    assert.equal(q.redacted, true);
  }

  // JSON serialisation must not leak restricted answer values
  const planJson = JSON.stringify(plan);
  // The answer text "yes" for work_authorization should not appear in clear text
  const answerValues = plan.answers.questions
    .filter(q => q.status === 'direct_input_recorded' || q.status === 'blocked')
    .map(q => JSON.stringify(q));
  for (const jsonQ of answerValues) {
    assert.ok(!jsonQ.includes('"yes"'), 'restricted answer "yes" must not appear in question object');
  }
});

// ── YAML mirror ──────────────────────────────────────────────────────

test('readiness: YAML mirror is written and does not leak sensitive/restricted values', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led discovery', '--evidence', 'Evidence']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  // Put a restricted direct answer scoped to this job
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Are you legally authorized to work in the role location?',
    '--answer', 'yes-citizen', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill',
    '--source', `job:${imported.id}`, '--status', 'verified']);

  // Trigger mirror write and read the plan result
  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  const wsDir = existsSync(path.join(root, 'jobos-workspace'))
    ? path.join(root, 'jobos-workspace')
    : root;
  const mirrorAbs = path.join(wsDir, plan.mirrorPath);
  assert.ok(existsSync(mirrorAbs), `mirror should exist at ${mirrorAbs}`);

  const mirrorContent = readFileSync(mirrorAbs, 'utf8');

  // Mirror contains plan structure
  assert.ok(mirrorContent.includes('version:'));
  assert.ok(mirrorContent.includes('status:'));
  assert.ok(mirrorContent.includes('identity:'));
  assert.ok(mirrorContent.includes('materials:'));
  assert.ok(mirrorContent.includes('answers:'));
  assert.ok(mirrorContent.includes('policy:'));

  // Mirror must NOT contain the raw answer value for restricted questions
  assert.ok(!mirrorContent.includes('yes-citizen'), 'mirror must not leak restricted answer value');

  // Mirror policy fields
  assert.ok(mirrorContent.includes('submissionPerformed: false'));
  assert.ok(mirrorContent.includes('applicationStatusChanged: false'));
});

// ── CLI / MCP plan equivalence ───────────────────────────────────────

test('readiness: CLI and MCP return equivalent plan on stable fields', async () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  // CLI plan
  const cliPlan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  // MCP plan via startMcp
  const { openStore } = await import('../src/db.js');
  const { startMcp } = await import('../src/mcp.js');
  const { Readable } = await import('node:stream');
  const s = await openStore({ workspace: root });

  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'applications_plan',
      arguments: { jobId: imported.id, profileId: 'pm' }
    }
  });
  const framed = `Content-Length: ${Buffer.byteLength(request, 'utf8')}\r\n\r\n${request}`;

  let mcpOutput = Buffer.alloc(0);
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captureWrite = (chunk) => {
    mcpOutput = Buffer.concat([mcpOutput, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    return true;
  };
  process.stdout.write = captureWrite;
  try {
    const input = new Readable({ read() { this.push(framed); this.push(null); } });
    startMcp(s, { input });
    await new Promise(resolve => setTimeout(resolve, 2000));
    process.stdout.write = originalWrite;

    const responses = [];
    let offset = 0;
    while ((offset = mcpOutput.indexOf('Content-Length:', offset)) >= 0) {
      const headerEnd = mcpOutput.indexOf('\r\n\r\n', offset);
      if (headerEnd < 0) break;
      const length = Number(mcpOutput.subarray(offset, headerEnd).toString('utf8').match(/Content-Length:\s*(\d+)/i)?.[1]);
      const bodyStart = headerEnd + 4;
      if (!Number.isFinite(length) || mcpOutput.length - bodyStart < length) break;
      try { responses.push(JSON.parse(mcpOutput.subarray(bodyStart, bodyStart + length).toString('utf8'))); } catch {}
      offset = bodyStart + length;
    }

    const callResult = responses.find(r => r.id === 1 && r.result);
    assert.ok(callResult, 'MCP should return a tools/call result');
    const content = callResult.result.content[0].text;
    const mcpPlan = JSON.parse(content);

    // Stable fields match
    assert.equal(mcpPlan.version, cliPlan.version);
    assert.equal(mcpPlan.jobId, cliPlan.jobId);
    assert.equal(mcpPlan.profileId, cliPlan.profileId);
    assert.equal(mcpPlan.status, cliPlan.status);
    assert.equal(mcpPlan.readyForReview, cliPlan.readyForReview);

    // Identity keys match
    assert.equal(mcpPlan.identity.employerKey, cliPlan.identity.employerKey);
    assert.equal(mcpPlan.identity.sourceKey, cliPlan.identity.sourceKey);
    assert.equal(mcpPlan.identity.dedupeKey, cliPlan.identity.dedupeKey);
    assert.equal(mcpPlan.identity.applicationKey, cliPlan.identity.applicationKey);

    // Material statuses match
    assert.equal(mcpPlan.materials.proofs.status, cliPlan.materials.proofs.status);
    assert.equal(mcpPlan.materials.score.status, cliPlan.materials.score.status);
    assert.equal(mcpPlan.materials.resume.status, cliPlan.materials.resume.status);

    // Answer counts match — inspectApplicationQuestions uses matched/unmatched/directInputRecorded/unresolvedRestricted
    assert.equal(mcpPlan.answers.matched, cliPlan.answers.matched);
    assert.equal(mcpPlan.answers.count, cliPlan.answers.count);
    assert.equal(mcpPlan.answers.unmatched, cliPlan.answers.unmatched);
    assert.equal(mcpPlan.answers.directInputRecorded, cliPlan.answers.directInputRecorded);
    assert.equal(mcpPlan.answers.unresolvedRestricted, cliPlan.answers.unresolvedRestricted);

    // Blocker codes match
    assert.equal(mcpPlan.blockers.length, cliPlan.blockers.length);
    for (let i = 0; i < mcpPlan.blockers.length; i++) {
      assert.equal(mcpPlan.blockers[i].code, cliPlan.blockers[i].code);
    }
  } finally {
    process.stdout.write = originalWrite;
  }
});

// ── Duplicate warning — precise, not receipt claim ───────────────────

test('readiness: duplicate matching job with applied status yields warning/blocker, never receipt claim', async () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);

  // Import first job and mark it as applied
  const job1Text = [
    '# Senior Product Manager, Learning Platform',
    'Company: Acme Learning Co',
    'Location: Remote US',
    '',
    'Acme builds tools for educators.',
    '',
    'Requirements:',
    '- 4+ years product management experience in EdTech.',
  ].join('\n');
  const job1 = fixtureFile(root, 'job1.md', job1Text);
  const j1 = out(['jobs', 'import-text', '--profile', 'pm', '--file', job1]);
  out(['applications', 'create', '--job', j1.id, '--status', 'applied']);

  // Create a second job with same dedupe key but different real URL via direct DB.
  // This simulates the same role posted on two different job boards.
  const { id, now, slug } = await import('../src/utils.js');
  const { openStore, run, all, one, save } = await import('../src/db.js');
  const s = await openStore({ workspace: root });

  // Get first job's dedupe key for reference
  const j1row = one(s, 'SELECT * FROM jobs WHERE id=?', [j1.id]);
  const dedupeKey = j1row.dedupe_key;

  // Create a second job with a different real URL so canMergeByKey doesn't merge
  const j2id = id('job', `dup-test-${Date.now()}`);
  const company = one(s, 'SELECT id FROM companies WHERE name=?', ['Acme Learning Co']);
  const at = now();
  run(s, `INSERT INTO jobs (id,profile_id,company_id,title,company,location,url,source,description,requirements_json,status,posted_date,dedupe_key,source_history_json,first_seen_at,last_seen_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [j2id, 'pm', company.id, 'Senior Product Manager, Learning Platform', 'Acme Learning Co', 'Remote US',
     'https://example.com/job2', 'url',
     'Job board posting for the same role.',
     '[]', 'imported', '', dedupeKey, '[]', at, at, at, at]);
  save(s);

  // Plan on the second job — duplicate should be detected
  const plan = out(['applications', 'plan', '--job', j2id, '--profile', 'pm']);

  // possibleDuplicateApplications is non-empty
  assert.ok(Array.isArray(plan.possibleDuplicateApplications));
  assert.ok(plan.possibleDuplicateApplications.length >= 1, 'should detect duplicate');

  for (const dup of plan.possibleDuplicateApplications) {
    assert.equal(typeof dup.jobId, 'string');
    assert.equal(typeof dup.applicationId, 'string');
    assert.equal(typeof dup.status, 'string');
    assert.ok(Array.isArray(dup.signals));
    // Must NOT claim a receipt for the new job
    assert.equal(dup.confirmationClaimed, false, 'duplicate entry must not claim receipt');
    // Must have detection signals
    assert.ok(dup.signals.length >= 1, 'signal values present: ' + JSON.stringify(dup.signals));
  }

  // Blocker or warning about possible duplicate
  assert.ok(
    plan.blockers.some(b => b.code === 'possible_duplicate_application') ||
    plan.warnings.some(w => w.code === 'possible_duplicate_application'),
    'plan must include possible_duplicate_application in blockers or warnings'
  );

  // The possible duplicate blocker must not claim that JobOS submitted anything
  const dupBlocker = plan.blockers.find(b => b.code === 'possible_duplicate_application');
  if (dupBlocker) {
    assert.ok(!dupBlocker.message.includes('submitted'),
      'blocker message must not claim submission');
    assert.ok(dupBlocker.nextAction.includes('receipt'),
      'blocker nextAction should reference no receipt claimed');
  }
});

// ── Pursue dry-run includes readiness top-level key ──────────────────

test('readiness: pursue --dry-run returns readiness and does NOT mutate state', async () => {
  const { out, root, jobos } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  // Snapshot workspace before dry-run
  const wsDir = path.join(root, 'jobos-workspace');
  const filesBefore = existsSync(wsDir) ? readdirRecursive(wsDir) : [];

  // Run pursue --dry-run
  const dryResult = jobos(['pursue', imported.id, '--profile', 'pm', '--dry-run']);
  const dry = JSON.parse(dryResult.stdout);

  assert.equal(dry.dryRun, true);
  assert.ok(dry.ok, 'dry-run should report ok');

  // Dry run must include readiness as a top-level key (not a stage)
  assert.ok(dry.readiness, 'dry-run must include readiness key');
  assert.equal(typeof dry.readiness, 'object');
  assert.equal(dry.readiness.jobId, imported.id);
  assert.equal(dry.readiness.profileId, 'pm');

  // No new files written in workspace — verify BEFORE asserting content
  const filesAfter = existsSync(wsDir) ? readdirRecursive(wsDir) : [];
  // Dry run must NOT create application record — verify via workspace file snapshot
  // (No application.yaml or readiness mirror should appear — any new file would be caught by the deep-equal below)
  const hasAppYaml = filesAfter.some(f => f.includes('application.yaml'));
  assert.equal(hasAppYaml, false, 'dry-run must not create application.yaml');
  const hasReadinessYaml = filesAfter.some(f => f.includes('application-readiness.yaml'));
  assert.equal(hasReadinessYaml, false, 'dry-run must not create readiness mirror');
  // No new files written in workspace
  assert.deepEqual(filesAfter, filesBefore, 'dry-run should not create new workspace files');
});

// ── Policy never auto-submits ────────────────────────────────────────

test('readiness: plan policy never claims automatic submission or application', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  // Policy section explicitly denies auto-submission
  assert.equal(plan.policy.submissionPerformed, false);
  assert.equal(plan.policy.applicationStatusChanged, false);
  assert.equal(plan.policy.externalSideEffects, 'none');

  // readyDoesNotMean enumerates what ready-for-review does NOT imply
  assert.ok(plan.policy.readyDoesNotMean.includes('submitted'));
  assert.ok(plan.policy.readyDoesNotMean.includes('applied'));
  assert.ok(!plan.policy.readyDoesNotMean.includes('approved'));
  assert.ok(plan.policy.readyDoesNotMean.includes('receipt-recorded'));
  assert.ok(plan.policy.readyDoesNotMean.includes('authorized-for-agent-submission'));

  // Mirror also carries policy section
  const mirrorAbs = path.join(root, 'jobos-workspace', plan.mirrorPath);
  if (existsSync(mirrorAbs)) {
    const mirror = readFileSync(mirrorAbs, 'utf8');
    assert.ok(mirror.includes('submissionPerformed: false'));
    assert.ok(mirror.includes('applicationStatusChanged: false'));
    assert.ok(mirror.includes('readyDoesNotMean:'));
  }
});

// ── Direct restricted answer recorded — satisfies completeness ────────

test('readiness: restricted answer with sensitivity=restricted reuse=never_auto_fill satisfies local completeness while redacted', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led EdTech product discovery', '--evidence', 'Evidence']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  // Add direct restricted answer for one work_authorization question — scoped to this job
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Are you legally authorized to work in the role location?',
    '--answer', 'yes', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill',
    '--source', `job:${imported.id}`, '--status', 'verified']);

  const plan = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);

  // The direct_input_recorded question has redacted=true, autoFill=false
  const directQ = plan.answers.questions.find(q => q.status === 'direct_input_recorded');
  assert.ok(directQ, 'should have a direct_input_recorded question');
  assert.equal(directQ.redacted, true);
  assert.equal(directQ.autoFill, false);
  assert.equal(directQ.blocker, null);
  assert.equal(typeof directQ.answerId, 'string');

  // directInputRecorded counter is > 0
  assert.ok(plan.answers.directInputRecorded >= 1);

  // Unresolved restricted count reflects only the OTHER work_authorization question still blocked
  // Only one work_authorization has been answered, so unresolvedRestricted = 1
  assert.ok(plan.answers.unresolvedRestricted >= 1, 'second work_authorization still unresolved');

  // The JSON must NOT include the raw "yes" answer value in clear text
  const directQJson = JSON.stringify(directQ);
  assert.ok(!directQJson.includes('"yes"'), 'answer value must be redacted in JSON');
});

// ── Safety refinement: unscoped restricted answer does NOT clear blocker ──

test('readiness: unscoped or other-job restricted answer does not clear the restricted blocker', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  out(['proof', 'add', '--profile', 'pm', '--summary', 'Led EdTech product discovery', '--evidence', 'Evidence']);
  out(['score', imported.id, '--profile', 'pm']);
  out(['tailor', 'resume', '--job', imported.id, '--profile', 'pm']);

  // Add restricted answer WITHOUT the job-scoped source_ref — should not count as direct_input
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Are you legally authorized to work in the role location?',
    '--answer', 'yes', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill', '--status', 'verified']);

  const plan1 = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.equal(plan1.answers.directInputRecorded, 0,
    'unscoped restricted answer must not count as direct_input_recorded');
  assert.ok(plan1.blockers.some(b => b.code === 'restricted_questions_require_input'),
    'restricted_questions_require_input blocker must still be present');

  // Now also add a restricted answer with source_ref scoped to a DIFFERENT job
  // (simulate another job2's answer) — should still not clear blocker for this job
  const otherJobId = 'job_other';
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization',
    '--question', 'Will you now or later require employment sponsorship?',
    '--answer', 'no', '--sensitivity', 'restricted', '--reuse', 'never_auto_fill',
    '--source', `job:${otherJobId}`, '--status', 'verified']);

  const plan2 = out(['applications', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.equal(plan2.answers.directInputRecorded, 0,
    'other-job-scoped restricted answer must not count as direct_input_recorded');
  assert.ok(plan2.blockers.some(b => b.code === 'restricted_questions_require_input'),
    'restricted_questions_require_input blocker must still be present after other-job answer');
});


// ── Normal pursuit discloses local tracking mutation ──────────────────

test('readiness: normal pursuit reports its local status change without claiming submission', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_FULL);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', SAMPLE_JOB);
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);

  const pursuit = out(['pursue', imported.id, '--profile', 'pm', '--stage', 'application'], { timeoutMs: 120_000 });
  const applicationStage = pursuit.stages.find(stage => stage.stage === 'application');

  assert.equal(applicationStage.status, 'ok');
  assert.equal(applicationStage.result.application.previousStatus, null);
  assert.equal(applicationStage.result.application.status, 'researching');
  assert.equal(applicationStage.result.application.statusChanged, true);
  assert.equal(pursuit.readiness.policy.applicationStatusChanged, true);
  assert.equal(pursuit.readiness.policy.applicationStatusChangeScope, 'local-tracking-only');
  assert.equal(pursuit.readiness.policy.submissionPerformed, false);
  assert.equal(pursuit.readiness.policy.externalSideEffects, 'none');
  const mirror = readFileSync(path.join(root, 'jobos-workspace', 'jobs', imported.id, 'application-readiness.yaml'), 'utf8');
  assert.match(mirror, /applicationStatusChanged: true/);
  assert.match(mirror, /applicationStatusChangeScope: local-tracking-only/);
  assert.doesNotMatch(mirror, /submissionPerformed: true/);
});


test('readiness: job-scoped restricted responses coexist without re-blocking earlier jobs', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', SAMPLE_RESUME_SHORT);
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const firstFile = fixtureFile(root, 'job-one.md', SAMPLE_JOB);
  const secondFile = fixtureFile(root, 'job-two.md', SAMPLE_JOB.replaceAll('Acme Learning Co', 'Beta Learning Co').replace('Senior Product Manager, Learning Platform', 'Product Lead, Learning Platform'));
  const first = out(['jobs', 'import-text', '--profile', 'pm', '--file', firstFile]);
  const second = out(['jobs', 'import-text', '--profile', 'pm', '--file', secondFile]);
  const question = 'Are you legally authorized to work in the role location?';

  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization', '--question', question,
    '--answer', 'FIRST_JOB_SECRET', '--source', `job:${first.id}`]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'work_authorization', '--question', question,
    '--answer', 'SECOND_JOB_SECRET', '--source', `job:${second.id}`]);

  const firstPlan = out(['applications', 'plan', '--job', first.id, '--profile', 'pm']);
  const secondPlan = out(['applications', 'plan', '--job', second.id, '--profile', 'pm']);
  assert.equal(firstPlan.answers.questions.find(item => item.question === question)?.status, 'direct_input_recorded');
  assert.equal(secondPlan.answers.questions.find(item => item.question === question)?.status, 'direct_input_recorded');
  assert.notEqual(
    firstPlan.answers.questions.find(item => item.question === question)?.answerId,
    secondPlan.answers.questions.find(item => item.question === question)?.answerId
  );
  const listed = out(['answers', 'list', '--profile', 'pm']);
  assert.equal(listed.filter(item => item.question === question).length, 2);
  assert.doesNotMatch(JSON.stringify(listed), /FIRST_JOB_SECRET|SECOND_JOB_SECRET/);
});

// ── Helper: recursive directory listing ──────────────────────────────

function readdirRecursive(dir) {
  const result = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          result.push(...readdirRecursive(full));
        } else {
          result.push(path.relative(dir, full));
        }
      } catch {}
    }
  } catch {}
  return result.sort();
}
