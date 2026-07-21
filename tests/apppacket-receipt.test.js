import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { openStore, all, one, queuePostCommit, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { addAnswer, inspectApplicationQuestions } from '../src/answers.js';
import { createArtifact, approveArtifact } from '../src/artifacts.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import { appCreate, appUpdate } from '../src/tracking.js';
import { buildTuiModel } from '../src/tui-model.js';
import { callDomainTool, DOMAIN_TOOLS, DomainToolError } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';
import { runPursuit } from '../src/workflows.js';

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function packetApi() {
  return import('../src/packets.js');
}

function workspace(t, prefix = 'jobos-packet-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function cli(root, args) {
  const result = spawnSync(process.execPath, ['src/cli.js', ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      JOBOS_HOME: root,
      JOBOS_LLM_PROVIDER: '',
      JOBOS_LLM_MODEL: '',
      JOBOS_LLM_API_KEY: '',
      JOBOS_SEARCH_PROVIDER: 'none',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      OLLAMA_API_KEY: ''
    },
    encoding: 'utf8'
  });
  const body = (result.status === 0 ? result.stdout : result.stderr).trim();
  let json = null;
  if (body) {
    try { json = JSON.parse(body); } catch {}
  }
  return { ...result, body, json };
}

function cliOk(root, args) {
  const result = cli(root, args);
  assert.equal(result.status, 0, `${args.join(' ')} failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.notEqual(result.json, null, `${args.join(' ')} did not return parseable JSON`);
  return result.json;
}

async function cliAsync(root, args) {
  try {
    const result = await execFileAsync(process.execPath, ['src/cli.js', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        JOBOS_HOME: root,
        JOBOS_LLM_PROVIDER: '',
        JOBOS_LLM_MODEL: '',
        JOBOS_LLM_API_KEY: '',
        JOBOS_SEARCH_PROVIDER: 'none',
        OPENAI_API_KEY: '',
        ANTHROPIC_API_KEY: '',
        OLLAMA_API_KEY: ''
      },
      encoding: 'utf8'
    });
    return JSON.parse(result.stdout.trim());
  } catch (error) {
    const detail = `${error.stdout || ''}\n${error.stderr || ''}`;
    throw new Error(`async CLI failed: ${args.join(' ')}\n${detail}`);
  }
}

function count(store, table, where = '', params = []) {
  return Number(one(store, `SELECT COUNT(*) AS count FROM ${table}${where ? ` WHERE ${where}` : ''}`, params).count);
}

function artifactInput(fixture, type, content) {
  const cover = type === 'cover_letter';
  return {
    jobId: fixture.job.id,
    profileId: fixture.profile.id,
    type,
    path: path.join('jobs', fixture.job.id, 'artifacts', cover ? 'cover-letter.md' : 'tailored-resume.md'),
    title: cover ? 'Cover letter' : 'Tailored resume',
    content,
    evidence: [{ proofPointId: fixture.proof.id }],
    warnings: [],
    series: { kind: cover ? 'cover_letter' : 'resume' }
  };
}

async function baseFixture(t, {
  prefix = 'jobos-packet-fixture-',
  score = true,
  answers = true,
  artifacts = true,
  approve = true,
  cover = true,
  applicationStatus = null,
  sentinels = null
} = {}) {
  const root = workspace(t, prefix);
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, `Packet PM ${crypto.randomUUID().slice(0, 8)}`).profile;
  const proof = addProof(
    store,
    profile.id,
    'Led an evidence-backed launch that improved activation by 30%.',
    'portfolio evidence',
    ['product', 'launch'],
    ['30%']
  );
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, 'Title: Product Manager\nCompany: Packet Co\nLocation: Remote\n\nLead product launches and improve activation.');
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  const values = sentinels || {
    public: `PUBLIC-${crypto.randomUUID()}`,
    personal: `PERSONAL-${crypto.randomUUID()}`,
    sensitive: `SENSITIVE-${crypto.randomUUID()}`,
    restricted: `RESTRICTED-${crypto.randomUUID()}`
  };

  if (score) {
    run(store, 'UPDATE jobs SET fit_score=?,score_json=? WHERE id=?', [84, JSON.stringify({ overall: 84, confidence: 'high', mode: 'fixture', dimensions: {}, redFlags: [], reasoning: 'Acceptance fixture score.' }), job.id]);
    save(store);
  }

  if (answers) {
    const inspection = inspectApplicationQuestions(store, { jobId: job.id, profileId: profile.id });
    let ordinary = 0;
    for (const question of inspection.questions) {
      if (question.category === 'work_authorization') {
        addAnswer(store, {
          profileId: profile.id,
          category: question.category,
          question: question.question,
          answer: values.restricted,
          sensitivity: 'restricted',
          reuseScope: 'never_auto_fill',
          verificationStatus: 'verified',
          sourceRef: `job:${job.id}`
        });
      } else {
        addAnswer(store, {
          profileId: profile.id,
          category: question.category,
          question: question.question,
          answer: ordinary++ === 0 ? values.public : values.personal,
          sensitivity: ordinary === 1 ? 'public' : 'personal',
          reuseScope: 'global',
          verificationStatus: 'verified',
          sourceRef: 'acceptance-fixture'
        });
      }
    }
    addAnswer(store, {
      profileId: profile.id,
      category: 'other',
      question: 'What private accommodation should be considered?',
      answer: values.sensitive,
      sensitivity: 'sensitive',
      reuseScope: 'never_auto_fill',
      verificationStatus: 'verified',
      sourceRef: 'acceptance-fixture'
    });
  }

  const fixture = { root, store, profile, proof, job, sentinels: values, resume: null, cover: null };
  if (artifacts) {
    fixture.resume = createArtifact(store, artifactInput(fixture, 'resume', '# Resume\n\nEvidence-backed launch improved activation by 30%.'));
    if (cover) fixture.cover = createArtifact(store, artifactInput(fixture, 'cover_letter', '# Cover letter\n\nEvidence-backed interest in Packet Co.'));
    if (approve) {
      fixture.resume = approveArtifact(store, fixture.resume.id, { reviewedBy: 'cli', note: 'Acceptance fixture review.' });
      if (fixture.cover) fixture.cover = approveArtifact(store, fixture.cover.id, { reviewedBy: 'cli', note: 'Acceptance fixture review.' });
    }
  }
  if (applicationStatus) fixture.application = appCreate(store, job.id, applicationStatus, 'Acceptance fixture status.');
  return fixture;
}

function packetMirror(root, jobId, packetId) {
  return path.join(root, 'jobos-workspace', 'jobs', jobId, 'packets', `${packetId}.yaml`);
}

function allTextUnder(directory) {
  if (!existsSync(directory)) return '';
  const parts = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) parts.push(allTextUnder(target));
    else parts.push(readFileSync(target, 'utf8'));
  }
  return parts.join('\n');
}

function assertTyped(error, code) {
  return Boolean(error && error.code === code);
}

async function assertRejectCode(action, code) {
  await assert.rejects(action, error => assertTyped(error, code));
}

test('AP01 packet create rejects unknown identities and profile-job mismatch with typed errors', async t => {
  const fixture = await baseFixture(t);
  const other = createProfile(fixture.store, `Other ${crypto.randomUUID()}`).profile;
  const before = {
    applications: count(fixture.store, 'applications'),
    audits: count(fixture.store, 'audit_log'),
    statuses: count(fixture.store, 'status_changes')
  };
  for (const [jobId, profileId, code] of [
    ['missing-job', fixture.profile.id, 'unknown_job'],
    [fixture.job.id, 'missing-profile', 'unknown_profile'],
    [fixture.job.id, other.id, 'profile_job_mismatch']
  ]) {
    const result = cli(fixture.root, ['apply', 'packet', 'create', '--job', jobId, '--profile', profileId, '--json']);
    assert.notEqual(result.status, 0);
    assert.equal(result.json?.error?.code, code);
  }
  const check = await openStore({ workspace: fixture.root });
  assert.equal(count(check, 'applications'), before.applications);
  assert.equal(count(check, 'audit_log'), before.audits);
  assert.equal(count(check, 'status_changes'), before.statuses);
  assert.equal(count(check, 'application_packets'), 0);
  assert.equal(count(check, 'application_receipts'), 0);
  assert.equal(existsSync(path.join(check.p.jobs, fixture.job.id, 'packets')), false);
});

test('AP02 packet create requires approved local readiness and exact artifact integrity', async t => {
  const { createApplicationPacket } = await packetApi();
  const blocked = await baseFixture(t, { prefix: 'jobos-packet-blocked-', score: false, answers: false, artifacts: false });
  await assertRejectCode(
    () => Promise.resolve().then(() => createApplicationPacket(blocked.store, { jobId: blocked.job.id, profileId: blocked.profile.id, createdBy: 'cli' })),
    'packet_not_ready'
  );

  const pending = await baseFixture(t, { prefix: 'jobos-packet-pending-', approve: false });
  await assertRejectCode(
    () => Promise.resolve().then(() => createApplicationPacket(pending.store, { jobId: pending.job.id, profileId: pending.profile.id, createdBy: 'cli' })),
    'artifact_unapproved'
  );
  assert.equal(count(pending.store, 'application_packets'), 0);

  const approved = await baseFixture(t, { prefix: 'jobos-packet-integrity-' });
  writeFileSync(path.join(approved.store.p.ws, approved.resume.path), '# Resume\n\nTampered mirror.\n');
  await assert.rejects(
    () => Promise.resolve().then(() => createApplicationPacket(approved.store, { jobId: approved.job.id, profileId: approved.profile.id, createdBy: 'cli' })),
    error => ['artifact_mirror_diverged', 'artifact_content_hash_mismatch'].includes(error?.code)
  );
  assert.equal(count(approved.store, 'application_packets'), 0);
});

test('AP03 packet freezes exact approved materials answers target and initializes missing tracking only', async t => {
  const { createApplicationPacket } = await packetApi();
  const fixture = await baseFixture(t);
  assert.equal(count(fixture.store, 'applications'), 0);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const application = one(fixture.store, 'SELECT * FROM applications WHERE id=?', [packet.applicationId]);
  assert.equal(application.status, 'materials-ready');
  assert.equal(packet.resumeArtifactId, fixture.resume.id);
  assert.equal(packet.resumeContentHash, fixture.resume.contentHash);
  assert.equal(packet.coverArtifactId, fixture.cover.id);
  assert.equal(packet.coverContentHash, fixture.cover.contentHash);
  assert.equal(packet.readinessVersion, 3);
  assert.equal(packet.readinessStatusAtCreate, 'approved');
  assert.equal(packet.externalSideEffects, 'none');
  assert.equal(packet.submissionPerformed, false);
  assert.deepEqual(packet.materials.proofPointIds, [fixture.proof.id]);
  assert.equal(packet.target.identityKey, compileApplicationReadiness(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id }).identity.identityKey);
  assert.ok(packet.answers.length >= 4);
  for (const answer of packet.answers) {
    assert.ok(answer.answerId);
    assert.ok(answer.questionFingerprint);
    assert.match(answer.rowFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(Object.hasOwn(answer, 'answer'), false);
    assert.equal(Object.hasOwn(answer, 'answerText'), false);
  }
  const serialized = JSON.stringify(packet);
  for (const value of Object.values(fixture.sentinels)) assert.equal(serialized.includes(value), false);

  const existing = await baseFixture(t, { prefix: 'jobos-packet-existing-', applicationStatus: 'researching' });
  const before = one(existing.store, 'SELECT status,notes,confirmation_url,updated_at FROM applications WHERE id=?', [existing.application.id]);
  const beforeChanges = count(existing.store, 'status_changes', 'application_id=?', [existing.application.id]);
  const existingPacket = createApplicationPacket(existing.store, { jobId: existing.job.id, profileId: existing.profile.id, createdBy: 'cli' });
  assert.deepEqual(one(existing.store, 'SELECT status,notes,confirmation_url,updated_at FROM applications WHERE id=?', [existing.application.id]), before);
  assert.equal(count(existing.store, 'status_changes', 'application_id=?', [existing.application.id]), beforeChanges);
  assert.equal(existingPacket.applicationId, existing.application.id, 'packet links the pre-existing application');
  assert.equal(count(existing.store, 'applications'), 1, 'no second application row is created');
});

test('AP04 canonical packet hash is stable and identical create is idempotent', async t => {
  const { canonicalJson, packetContentHash, createApplicationPacket } = await packetApi();
  const a = { z: 1, a: { y: 2, x: 3 } };
  const b = { a: { x: 3, y: 2 }, z: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(packetContentHash(a), packetContentHash(b));

  const fixture = await baseFixture(t);
  const first = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const before = {
    packets: count(fixture.store, 'application_packets'),
    audits: count(fixture.store, 'audit_log', "action='application_packet.created'"),
    statuses: count(fixture.store, 'status_changes'),
    tasks: count(fixture.store, 'tasks')
  };
  const second = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  assert.equal(second.id, first.id);
  assert.equal(second.contentHash, first.contentHash);
  assert.equal(second.idempotent, true);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);
  assert.equal(count(fixture.store, 'application_packets'), before.packets);
  assert.equal(count(fixture.store, 'audit_log', "action='application_packet.created'"), before.audits);
  assert.equal(count(fixture.store, 'status_changes'), before.statuses);
  assert.equal(count(fixture.store, 'tasks'), before.tasks);
  assert.equal(readdirSync(path.dirname(packetMirror(fixture.root, fixture.job.id, first.id))).filter(name => name.endsWith('.yaml')).length, 1);
});

test('AP05 packet versions preserve revision attempt lineage and deterministic diff', async t => {
  const { createApplicationPacket, attestApplicationSubmitted, diffApplicationPackets, showApplicationPacket } = await packetApi();
  const fixture = await baseFixture(t);
  const first = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });

  const resume2 = createArtifact(fixture.store, artifactInput(fixture, 'resume', '# Resume\n\nSecond approved revision with 30% evidence.'));
  approveArtifact(fixture.store, resume2.id, { reviewedBy: 'cli', note: 'Second revision approved.' });
  const second = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  assert.equal(second.attemptNumber, first.attemptNumber);
  assert.equal(second.revision, first.revision + 1);
  assert.equal(second.supersedesPacketId, first.id);
  assert.notEqual(second.contentHash, first.contentHash);
  const diff = diffApplicationPackets(fixture.store, first.id, second.id);
  assert.equal(diff.sameContent, false);
  assert.ok(diff.changes.some(change => change.path.includes('/materials/resume')));
  assert.equal(JSON.stringify(diff).includes('Second approved revision'), false);

  attestApplicationSubmitted(fixture.store, { packetId: second.id, submittedAt: '2026-07-20T12:00:00Z', note: 'Submitted.', source: 'cli' });
  const resume3 = createArtifact(fixture.store, artifactInput(fixture, 'resume', '# Resume\n\nThird approved revision with 30% evidence.'));
  approveArtifact(fixture.store, resume3.id, { reviewedBy: 'cli', note: 'Third revision approved.' });
  const third = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  assert.equal(third.attemptNumber, second.attemptNumber + 1);
  assert.equal(third.revision, 1);
  assert.equal(third.supersedesPacketId, second.id);
  assert.equal(showApplicationPacket(fixture.store, first.id).id, first.id);
  assert.equal(existsSync(packetMirror(fixture.root, fixture.job.id, first.id)), true);
});

test('AP06 material answer or target changes make an old packet non-attestable', async t => {
  const { createApplicationPacket, attestApplicationSubmitted, showApplicationPacket } = await packetApi();
  const fixture = await baseFixture(t);
  const first = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const draft = createArtifact(fixture.store, artifactInput(fixture, 'resume', '# Resume\n\nUnapproved successor.'));
  await assertRejectCode(
    () => Promise.resolve().then(() => attestApplicationSubmitted(fixture.store, { packetId: first.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' })),
    'packet_stale'
  );
  assert.equal(showApplicationPacket(fixture.store, first.id).currency, 'stale');
  assert.equal(count(fixture.store, 'application_receipts'), 0);

  approveArtifact(fixture.store, draft.id, { reviewedBy: 'cli', note: 'Approved successor.' });
  const second = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const answer = one(fixture.store, "SELECT id FROM answers WHERE sensitivity IN ('public','personal') ORDER BY id LIMIT 1");
  run(fixture.store, 'UPDATE answers SET answer_text=?,updated_at=? WHERE id=?', ['Changed answer value', '2026-07-21T00:00:00.000Z', answer.id]);
  save(fixture.store);
  await assertRejectCode(
    () => Promise.resolve().then(() => attestApplicationSubmitted(fixture.store, { packetId: second.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' })),
    'packet_stale'
  );
  const third = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  run(fixture.store, 'UPDATE jobs SET location=?,dedupe_key=? WHERE id=?', ['Hybrid', 'packet-co|product-manager|hybrid', fixture.job.id]);
  save(fixture.store);
  await assertRejectCode(
    () => Promise.resolve().then(() => attestApplicationSubmitted(fixture.store, { packetId: third.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' })),
    'packet_stale'
  );
  assert.equal(count(fixture.store, 'application_packets'), 3);
  assert.equal(count(fixture.store, 'application_receipts'), 0);
});

test('AP07 CLI attestation creates one receipt and binds pre-apply status to the exact packet', async t => {
  const { createApplicationPacket, attestApplicationSubmitted } = await packetApi();
  for (const status of ['saved', 'researching', 'materials-ready', 'applied', 'interview']) {
    const fixture = await baseFixture(t, { prefix: `jobos-attest-${status}-`, applicationStatus: status });
    const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
    if (status === 'saved') {
      await assertRejectCode(
        () => Promise.resolve().then(() => attestApplicationSubmitted(fixture.store, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00', source: 'cli' })),
        'invalid_submitted_at'
      );
    }
    const beforeChanges = count(fixture.store, 'status_changes', 'application_id=?', [fixture.application.id]);
    const result = cli(fixture.root, ['apply', 'attest-submitted', packet.id, '--submitted-at', '2026-07-20T12:00:00-04:00', '--note', 'Submitted by user.', '--json']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.receipt.submittedAt, '2026-07-20T16:00:00.000Z');
    assert.equal(result.json.receiptBound, true);
    assert.equal(result.json.externalSideEffects, 'none');
    assert.equal(result.json.submissionPerformed, false);
    const check = await openStore({ workspace: fixture.root });
    const app = one(check, 'SELECT status FROM applications WHERE id=?', [fixture.application.id]);
    const shouldChange = ['saved', 'researching', 'materials-ready'].includes(status);
    assert.equal(app.status, shouldChange ? 'applied' : status);
    assert.equal(count(check, 'status_changes', 'application_id=?', [fixture.application.id]), beforeChanges + (shouldChange ? 1 : 0));
    const change = one(check, 'SELECT note FROM status_changes WHERE application_id=? ORDER BY created_at DESC,id DESC LIMIT 1', [fixture.application.id]);
    if (shouldChange) {
      assert.match(change.note, new RegExp(packet.id));
      assert.match(change.note, new RegExp(packet.contentHash));
      assert.match(change.note, new RegExp(result.json.receipt.id));
    }
    const audit = one(check, "SELECT payload_json,external_side_effect FROM audit_log WHERE action='application.submission_attested' ORDER BY created_at DESC,id DESC LIMIT 1");
    assert.equal(audit.external_side_effect, 'none');
    assert.equal(JSON.parse(audit.payload_json).submissionPerformed, false);
  }
});

test('AP08 MCP and ACP can inspect but cannot freeze attest or confirm under spoofed overrides', async t => {
  const api = await packetApi();
  const fixture = await baseFixture(t);
  const packet = api.createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const advertised = mcpToolNames();
  for (const name of ['application_packets_list', 'application_packet_show', 'application_packet_diff']) assert.ok(advertised.includes(name));
  for (const name of ['create_application_packet', 'attest_application_submitted', 'confirm_application_receipt']) assert.equal(advertised.includes(name), false);
  assert.ok(DOMAIN_TOOLS.some(tool => tool.name === 'create_application_packet'));
  assert.equal(advertised.length, DOMAIN_TOOLS.length - 3, 'MCP advertises DOMAIN_TOOLS minus exactly the three MUTATION_DENY packet tools');

  const oldMediation = process.env.JOBOS_MEDIATION;
  const oldOverride = process.env.JOBOS_ALLOW_AGENT_ATTESTATION;
  process.env.JOBOS_MEDIATION = 'cli';
  process.env.JOBOS_ALLOW_AGENT_ATTESTATION = '1';
  t.after(() => {
    if (oldMediation == null) delete process.env.JOBOS_MEDIATION; else process.env.JOBOS_MEDIATION = oldMediation;
    if (oldOverride == null) delete process.env.JOBOS_ALLOW_AGENT_ATTESTATION; else process.env.JOBOS_ALLOW_AGENT_ATTESTATION = oldOverride;
  });

  for (const source of ['mcp', 'acp']) {
    await assert.rejects(
      callDomainTool(fixture.store, 'create_application_packet', { jobId: fixture.job.id, profileId: fixture.profile.id }, { source, allowExternalAttestation: true }),
      error => error instanceof DomainToolError && error.code === 'human_packet_freeze_required'
    );
    for (const [tool, args] of [
      ['attest_application_submitted', { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z' }],
      ['confirm_application_receipt', { packetId: packet.id, reference: 'REF-123' }]
    ]) {
      await assert.rejects(
        callDomainTool(fixture.store, tool, args, { source, allowExternalAttestation: true }),
        error => error instanceof DomainToolError && error.code === 'human_submission_attestation_required'
      );
    }
    await assertRejectCode(
      () => Promise.resolve().then(() => api.attestApplicationSubmitted(fixture.store, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', source })),
      'human_submission_attestation_required'
    );
    await assertRejectCode(
      () => Promise.resolve().then(() => api.confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF', source })),
      'human_submission_attestation_required'
    );
  }
  assert.equal(count(fixture.store, 'application_receipts'), 0);
});

test('AP09 exact receipt replay is idempotent and conflicting immutable evidence is rejected', async t => {
  const { createApplicationPacket, attestApplicationSubmitted } = await packetApi();
  const fixture = await baseFixture(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const input = { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', note: 'Exact note.', source: 'cli' };
  const first = attestApplicationSubmitted(fixture.store, input);
  const before = {
    receipts: count(fixture.store, 'application_receipts'),
    audits: count(fixture.store, 'audit_log', "action='application.submission_attested'"),
    statuses: count(fixture.store, 'status_changes')
  };
  const replay = attestApplicationSubmitted(fixture.store, input);
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(replay.idempotent, true);
  assert.equal(count(fixture.store, 'application_receipts'), before.receipts);
  assert.equal(count(fixture.store, 'audit_log', "action='application.submission_attested'"), before.audits);
  assert.equal(count(fixture.store, 'status_changes'), before.statuses);
  for (const conflict of [
    { ...input, submittedAt: '2026-07-20T13:00:00Z' },
    { ...input, note: 'Different note.' }
  ]) {
    await assertRejectCode(() => Promise.resolve().then(() => attestApplicationSubmitted(fixture.store, conflict)), 'receipt_conflict');
  }
  assert.equal(one(fixture.store, 'SELECT receipt_hash FROM application_receipts WHERE id=?', [first.receipt.id]).receipt_hash, first.receipt.receiptHash);
});

test('AP10 confirmation requires prior attestation and records reference without status mutation', async t => {
  const { createApplicationPacket, attestApplicationSubmitted, confirmApplicationReceipt, showApplicationPacket } = await packetApi();
  const fixture = await baseFixture(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  await assertRejectCode(
    () => Promise.resolve().then(() => confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF-1', source: 'cli' })),
    'receipt_attestation_required'
  );
  const attested = attestApplicationSubmitted(fixture.store, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' });
  await assertRejectCode(
    () => Promise.resolve().then(() => confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: '', source: 'cli' })),
    'receipt_reference_required'
  );
  const beforeChanges = count(fixture.store, 'status_changes');
  const confirmed = confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'https://board.example/receipt/123', note: 'Board confirmation.', source: 'cli' });
  assert.equal(confirmed.receipt.submittedAt, attested.receipt.submittedAt);
  assert.equal(confirmed.receiptState, 'confirmed');
  assert.equal(confirmed.externalSideEffects, 'none');
  assert.equal(confirmed.submissionPerformed, false);
  assert.equal(count(fixture.store, 'status_changes'), beforeChanges);
  assert.equal(one(fixture.store, 'SELECT confirmation_url FROM applications WHERE id=?', [packet.applicationId]).confirmation_url, 'https://board.example/receipt/123');
  assert.equal(confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'https://board.example/receipt/123', note: 'Board confirmation.', source: 'cli' }).idempotent, true);
  await assertRejectCode(
    () => Promise.resolve().then(() => confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF-DIFFERENT', note: 'Board confirmation.', source: 'cli' })),
    'receipt_conflict'
  );
  assert.equal(showApplicationPacket(fixture.store, packet.id).receiptState, 'confirmed');

  const textFixture = await baseFixture(t, { prefix: 'jobos-confirm-text-' });
  const textPacket = createApplicationPacket(textFixture.store, { jobId: textFixture.job.id, profileId: textFixture.profile.id, createdBy: 'cli' });
  attestApplicationSubmitted(textFixture.store, { packetId: textPacket.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' });
  confirmApplicationReceipt(textFixture.store, { packetId: textPacket.id, reference: 'BOARD-REF-123', source: 'cli' });
  assert.equal(one(textFixture.store, 'SELECT confirmation_url FROM applications WHERE id=?', [textPacket.applicationId]).confirmation_url, '');
});

test('AP11 bare application applied update creates no receipt and remains explicitly unbound', async t => {
  const { createApplicationPacket, attestApplicationSubmitted } = await packetApi();
  const fixture = await baseFixture(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const update = cli(fixture.root, ['applications', 'update', packet.applicationId, '--status', 'applied', '--json']);
  assert.equal(update.status, 0, update.stderr);
  const check = await openStore({ workspace: fixture.root });
  assert.equal(count(check, 'application_receipts'), 0);
  const audit = one(check, "SELECT payload_json FROM audit_log WHERE action='application.status_changed' AND entity_id=? ORDER BY created_at DESC,id DESC LIMIT 1", [packet.applicationId]);
  const payload = JSON.parse(audit.payload_json);
  assert.equal(payload.receiptBound, false);
  assert.equal(Object.hasOwn(payload, 'receiptId'), false);
  assert.equal(compileApplicationReadiness(check, { jobId: fixture.job.id, profileId: fixture.profile.id }).packet.receiptState, 'none');
  const before = count(check, 'status_changes');
  const attested = attestApplicationSubmitted(check, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' });
  assert.equal(attested.applicationStatusChanged, false);
  assert.equal(count(check, 'status_changes'), before);
});

test('AP12 restricted and sensitive answer plaintext never crosses packet inspection surfaces', async t => {
  const api = await packetApi();
  const fixture = await baseFixture(t);
  const first = api.createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const shown = api.showApplicationPacket(fixture.store, first.id);
  const listed = api.listApplicationPackets(fixture.store, { jobId: fixture.job.id });
  const diff = api.diffApplicationPackets(fixture.store, first.id, first.id);
  const domainShown = await callDomainTool(fixture.store, 'application_packet_show', { packetId: first.id }, { source: 'mcp' });
  const tui = buildTuiModel(fixture.store, { profileId: fixture.profile.id });
  const row = one(fixture.store, 'SELECT answers_json,identity_json,materials_json,blockers_json,warnings_json FROM application_packets WHERE id=?', [first.id]);
  const auditRows = all(fixture.store, 'SELECT payload_json FROM audit_log').map(item => item.payload_json).join('\n');
  const packetYaml = readFileSync(packetMirror(fixture.root, fixture.job.id, first.id), 'utf8');
  const readinessYaml = readFileSync(path.join(fixture.store.p.jobs, fixture.job.id, 'application-readiness.yaml'), 'utf8');
  const jobYaml = readFileSync(path.join(fixture.store.p.jobs, fixture.job.id, 'job.yaml'), 'utf8');
  const cliShow = cliOk(fixture.root, ['apply', 'packet', 'show', first.id, '--json']);
  const cliList = cliOk(fixture.root, ['apply', 'packet', 'list', '--job', fixture.job.id, '--json']);
  const cliDiff = cliOk(fixture.root, ['apply', 'packet', 'diff', first.id, first.id, '--json']);
  const surfaces = JSON.stringify({ shown, listed, diff, domainShown, tui, row, auditRows, packetYaml, readinessYaml, jobYaml, cliShow, cliList, cliDiff });
  for (const value of Object.values(fixture.sentinels)) {
    assert.equal(surfaces.includes(value), false, `plaintext leaked: ${value}`);
  }
  for (const value of [fixture.sentinels.sensitive, fixture.sentinels.restricted]) {
    const directHash = crypto.createHash('sha256').update(value).digest('hex');
    assert.equal(surfaces.includes(directHash), false, 'value-derived sensitive hash leaked');
  }
  assert.match(surfaces, /rowFingerprint/);
  assert.match(surfaces, /restricted/);
  assert.match(surfaces, /direct_input_redacted/);
});

test('AP13 concurrent packet writers converge and stale persistence leaves no half projection', async t => {
  const fixture = await baseFixture(t);
  const stale = await openStore({ workspace: fixture.root });
  const [a, b] = await Promise.all([
    cliAsync(fixture.root, ['apply', 'packet', 'create', '--job', fixture.job.id, '--profile', fixture.profile.id, '--json']),
    cliAsync(fixture.root, ['apply', 'packet', 'create', '--job', fixture.job.id, '--profile', fixture.profile.id, '--json'])
  ]);
  assert.equal(a.id, b.id);
  assert.equal(a.contentHash, b.contentHash);
  const check = await openStore({ workspace: fixture.root });
  assert.equal(count(check, 'application_packets'), 1);
  assert.equal(count(check, 'audit_log', "action='application_packet.created'"), 1);
  assert.equal(readdirSync(path.dirname(packetMirror(fixture.root, fixture.job.id, a.id))).filter(name => name.endsWith('.yaml')).length, 1);

  const half = path.join(check.p.ws, 'half-packet.yaml');
  run(stale, 'INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)', [
    `audit_stale_${crypto.randomUUID()}`,
    'application_packet.created',
    'application_packet',
    'packet_stale',
    '{}',
    'none',
    new Date().toISOString()
  ]);
  queuePostCommit(stale, () => writeFileSync(half, 'must not exist'));
  assert.throws(() => save(stale), error => error.code === 'stale_snapshot');
  assert.equal(existsSync(half), false);

  const conflict = cli(fixture.root, ['apply', 'attest-submitted', a.id, '--submitted-at', 'not-a-time', '--json']);
  assert.notEqual(conflict.status, 0);
  const final = await openStore({ workspace: fixture.root });
  assert.equal(count(final, 'application_receipts'), 0);
  assert.equal(compileApplicationReadiness(final, { jobId: fixture.job.id, profileId: fixture.profile.id }).packet.receiptState, 'none');
  assert.equal(allTextUnder(path.dirname(packetMirror(fixture.root, fixture.job.id, a.id))).includes('receiptState: attested'), false);
});

test('AP13b conflicting receipt confirmation leaves every surface consistent with SQLite', async t => {
  const { createApplicationPacket, attestApplicationSubmitted, confirmApplicationReceipt } = await packetApi();
  const fixture = await baseFixture(t);
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  attestApplicationSubmitted(fixture.store, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' });
  confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF-FIRST', source: 'cli' });

  const statusBefore = one(fixture.store, 'SELECT status FROM applications WHERE id=?', [packet.applicationId]).status;
  const changesBefore = count(fixture.store, 'status_changes');
  const auditsBefore = count(fixture.store, 'audit_log');
  const readinessYaml = path.join(fixture.store.p.jobs, fixture.job.id, 'application-readiness.yaml');
  const readinessBefore = readFileSync(readinessYaml, 'utf8');
  const packetYaml = packetMirror(fixture.root, fixture.job.id, packet.id);
  const packetYamlBefore = readFileSync(packetYaml, 'utf8');
  // attest and confirm each record their own receipt row, so a fully-confirmed
  // packet has two rows (see AP12's count(..., 2) assert); the contract here is
  // that the rejected conflict adds no further row.
  const receiptsBefore = count(fixture.store, 'application_receipts');
  assert.ok(receiptsBefore >= 1, 'confirmed packet has at least one receipt row');

  await assertRejectCode(
    () => Promise.resolve().then(() => confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF-CONFLICT', source: 'cli' })),
    'receipt_conflict'
  );

  assert.equal(one(fixture.store, 'SELECT status FROM applications WHERE id=?', [packet.applicationId]).status, statusBefore, 'application status unchanged');
  assert.equal(count(fixture.store, 'status_changes'), changesBefore, 'no status history appended');
  assert.equal(count(fixture.store, 'application_receipts'), receiptsBefore, 'conflicting confirm adds no receipt row');
  assert.equal(count(fixture.store, 'audit_log'), auditsBefore, 'no audit entry for the failed confirmation');
  assert.equal(readFileSync(readinessYaml, 'utf8'), readinessBefore, 'readiness mirror unchanged');
  assert.equal(readFileSync(packetYaml, 'utf8'), packetYamlBefore, 'packet mirror unchanged');
});

test('AP14 readiness v3 reports packet receipt state without claiming adapter submission', async t => {
  const { createApplicationPacket, attestApplicationSubmitted, confirmApplicationReceipt } = await packetApi();
  const fixture = await baseFixture(t);
  const empty = compileApplicationReadiness(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id });
  assert.equal(empty.version, 3);
  assert.deepEqual(empty.packet, {
    currentPacketId: null,
    contentHash: null,
    attemptNumber: null,
    revision: null,
    currency: 'none',
    receiptState: 'none',
    attestable: false,
    latestReceiptId: null
  });
  const packet = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  let plan = compileApplicationReadiness(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id });
  assert.equal(plan.packet.currentPacketId, packet.id);
  assert.equal(plan.packet.receiptState, 'none');
  attestApplicationSubmitted(fixture.store, { packetId: packet.id, submittedAt: '2026-07-20T12:00:00Z', source: 'cli' });
  plan = compileApplicationReadiness(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id });
  assert.equal(plan.packet.receiptState, 'attested');
  confirmApplicationReceipt(fixture.store, { packetId: packet.id, reference: 'REF-READY', source: 'cli' });
  plan = compileApplicationReadiness(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id });
  assert.equal(plan.packet.receiptState, 'confirmed');
  assert.equal(plan.policy.submissionPerformed, false);
  assert.equal(plan.policy.externalSideEffects, 'none');
  for (const meaning of ['submitted', 'applied', 'receipt-recorded', 'authorized-for-agent-submission']) assert.ok(plan.policy.readyDoesNotMean.includes(meaning));

  const domainPlan = await callDomainTool(fixture.store, 'applications_plan', { jobId: fixture.job.id, profileId: fixture.profile.id }, { source: 'mcp' });
  assert.deepEqual(domainPlan.packet, plan.packet);
  const mirror = YAML.parse(readFileSync(path.join(fixture.store.p.jobs, fixture.job.id, 'application-readiness.yaml'), 'utf8'));
  assert.deepEqual(mirror.packet, plan.packet);
  const before = count(fixture.store, 'application_packets');
  const dry = await runPursuit(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, dryRun: true });
  assert.equal(dry.readiness.packet.currentPacketId, packet.id);
  assert.equal(count(fixture.store, 'application_packets'), before);
  const normal = await runPursuit(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, stage: 'application', stageTimeoutMs: 120000 });
  assert.equal(count(fixture.store, 'application_packets'), before);
  assert.ok(normal.stages.some(stage => stage.stage === 'application'));
});

test('AP15 packet CLI list show and diff are filterable parseable historical and typed', async t => {
  const { createApplicationPacket } = await packetApi();
  const fixture = await baseFixture(t);
  const first = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });
  const resume2 = createArtifact(fixture.store, artifactInput(fixture, 'resume', '# Resume\n\nCLI diff revision.'));
  approveArtifact(fixture.store, resume2.id, { reviewedBy: 'cli', note: 'CLI diff approval.' });
  const second = createApplicationPacket(fixture.store, { jobId: fixture.job.id, profileId: fixture.profile.id, createdBy: 'cli' });

  const missingFilter = cli(fixture.root, ['apply', 'packet', 'list', '--json']);
  assert.notEqual(missingFilter.status, 0);
  assert.equal(missingFilter.status, 2);
  assert.equal(missingFilter.json?.error?.code, 'usage_error');
  const byJob = cliOk(fixture.root, ['apply', 'packet', 'list', '--job', fixture.job.id, '--json']);
  const byProfile = cliOk(fixture.root, ['apply', 'packet', 'list', '--profile', fixture.profile.id, '--json']);
  const byBoth = cliOk(fixture.root, ['apply', 'packet', 'list', '--job', fixture.job.id, '--profile', fixture.profile.id, '--json']);
  assert.deepEqual(byJob.map(item => item.id), byProfile.map(item => item.id));
  assert.deepEqual(byBoth.map(item => item.id), byJob.map(item => item.id));
  assert.ok(byJob.some(item => item.id === first.id));
  assert.ok(byJob.some(item => item.id === second.id));

  // Cross-profile isolation: fabricate another profile's application+packet for the
  // SAME job; none of the first profile's filter combinations may list it.
  const otherProfile = createProfile(fixture.store, `Second ${crypto.randomUUID()}`).profile;
  const leakAt = new Date().toISOString();
  const otherApplicationId = `app_${crypto.randomUUID()}`;
  const otherPacketId = `packet_${crypto.randomUUID()}`;
  run(fixture.store, `INSERT INTO applications (id, job_id, profile_id, status, notes, confirmation_url, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
    [otherApplicationId, fixture.job.id, otherProfile.id, 'applied', '', '', leakAt, leakAt]);
  run(fixture.store, `INSERT INTO application_packets (id, job_id, profile_id, application_id, attempt_number, revision, content_hash, readiness_status_at_create, readiness_version, resume_artifact_id, resume_content_hash, created_at, created_by_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [otherPacketId, fixture.job.id, otherProfile.id, otherApplicationId, 1, 1, 'other-content-hash', 'approved', 3, fixture.resume.id, 'other-resume-hash', leakAt, 'cli']);
  save(fixture.store);
  // The fabricated row must be genuinely queryable, or the non-leak asserts below
  // would pass vacuously.
  const otherByProfile = cliOk(fixture.root, ['apply', 'packet', 'list', '--profile', otherProfile.id, '--json']);
  assert.ok(otherByProfile.some(item => item.id === otherPacketId), 'other-profile packet is queryable under its own profile');
  // Profile-scoped listings must never surface another profile's packet.
  for (const listing of [
    cliOk(fixture.root, ['apply', 'packet', 'list', '--profile', fixture.profile.id, '--json']),
    cliOk(fixture.root, ['apply', 'packet', 'list', '--job', fixture.job.id, '--profile', fixture.profile.id, '--json'])
  ]) {
    assert.equal(listing.some(item => item.id === otherPacketId), false, 'cross-profile packet must not leak through profile-scoped filters');
    assert.ok(listing.some(item => item.id === first.id), 'first-profile packet still listed');
  }
  // `--job` alone is a job-scoped, not profile-scoped, query: listApplicationPackets
  // filters job_id and profile_id independently, so a job shared by two profiles
  // lists both profiles' packets. JobOS is single-user local-first — profiles are
  // organizational units, not a security boundary — so this is intended behavior.
  const byJobAfter = cliOk(fixture.root, ['apply', 'packet', 'list', '--job', fixture.job.id, '--json']);
  assert.ok(byJobAfter.some(item => item.id === otherPacketId), 'job-scoped listing includes every profile for that job');
  assert.equal(cliOk(fixture.root, ['apply', 'packet', 'show', first.id, '--json']).id, first.id);
  const diff = cliOk(fixture.root, ['apply', 'packet', 'diff', first.id, second.id, '--json']);
  assert.equal(diff.sameContent, false);
  const text = cli(fixture.root, ['apply', 'packet', 'diff', first.id, second.id]);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /materials|resume|contentHash/);

  for (const args of [
    ['apply', 'packet', 'show', 'packet_missing', '--json'],
    ['apply', 'packet', 'diff', first.id, 'packet_missing', '--json'],
    ['apply', 'attest-submitted', 'packet_missing', '--submitted-at', '2026-07-20T12:00:00Z', '--json'],
    ['apply', 'confirm-receipt', 'packet_missing', '--reference', 'REF', '--json']
  ]) {
    const result = cli(fixture.root, args);
    assert.notEqual(result.status, 0);
    assert.equal(result.json?.error?.code, 'unknown_packet');
  }
  const guide = cliOk(fixture.root, ['agent-guide', '--json']);
  const commandNames = guide.commands.map(command => command.name);
  for (const name of ['apply packet create', 'apply packet show', 'apply packet list', 'apply packet diff', 'apply attest-submitted', 'apply confirm-receipt']) assert.ok(commandNames.includes(name));
  for (const name of ['application_packets_list', 'application_packet_show', 'application_packet_diff']) assert.ok(mcpToolNames().includes(name));
});

test('AP16 approved materials freeze attest confirm end to end with honest local evidence', async t => {
  const root = workspace(t, 'jobos-packet-e2e-');
  const profile = cliOk(root, ['profile', 'create', 'Packet E2E PM', '--json']);
  cliOk(root, ['proof', 'add', '--profile', profile.id, '--summary', 'Led a product launch that improved activation by 30%.', '--evidence', 'Portfolio evidence', '--skills', 'product,launch', '--json']);
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, 'Title: Product Manager\nCompany: E2E Packet Co\nLocation: Remote\n\nLead product launches and improve activation.');
  const job = cliOk(root, ['jobs', 'import-text', '--profile', profile.id, '--file', jobFile, '--json']);
  cliOk(root, ['score', job.id, '--profile', profile.id, '--json']);
  cliOk(root, ['tailor', 'resume', '--job', job.id, '--profile', profile.id, '--json']);
  cliOk(root, ['tailor', 'cover-letter', '--job', job.id, '--profile', profile.id, '--json']);
  const questions = cliOk(root, ['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']).answers.questions;
  const restrictedSentinel = `E2E-RESTRICTED-${crypto.randomUUID()}`;
  for (const question of questions) {
    if (question.category === 'work_authorization') {
      cliOk(root, ['answers', 'add', '--profile', profile.id, '--category', question.category, '--question', question.question, '--answer', restrictedSentinel, '--sensitivity', 'restricted', '--reuse', 'never_auto_fill', '--source', `job:${job.id}`, '--status', 'verified', '--json']);
    } else {
      cliOk(root, ['answers', 'add', '--profile', profile.id, '--category', question.category, '--question', question.question, '--answer', 'Evidence-backed application response.', '--sensitivity', 'public', '--status', 'verified', '--json']);
    }
  }
  const queue = cliOk(root, ['artifacts', 'queue', '--profile', profile.id, '--job', job.id, '--json']);
  assert.equal(queue.length, 2);
  for (const artifact of queue) cliOk(root, ['artifacts', 'approve', artifact.id, '--note', 'E2E exact revision review.', '--json']);
  const approved = cliOk(root, ['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']);
  assert.equal(approved.status, 'approved');
  assert.equal(approved.packet.receiptState, 'none');
  const packet = cliOk(root, ['apply', 'packet', 'create', '--job', job.id, '--profile', profile.id, '--json']);
  assert.equal(packet.resumeContentHash, queue.find(item => item.type === 'resume').contentHash);
  const attested = cliOk(root, ['apply', 'attest-submitted', packet.id, '--submitted-at', '2026-07-20T12:00:00Z', '--note', 'User submitted externally.', '--json']);
  assert.equal(attested.receiptBound, true);
  assert.equal(attested.submissionPerformed, false);
  const confirmed = cliOk(root, ['apply', 'confirm-receipt', packet.id, '--reference', 'https://board.example/confirmation/e2e', '--note', 'External confirmation.', '--json']);
  assert.equal(confirmed.receiptState, 'confirmed');
  assert.equal(confirmed.submissionPerformed, false);
  const finalPlan = cliOk(root, ['applications', 'plan', '--job', job.id, '--profile', profile.id, '--json']);
  assert.equal(finalPlan.application.status, 'applied');
  assert.equal(finalPlan.packet.receiptState, 'confirmed');
  assert.equal(finalPlan.policy.submissionPerformed, false);
  const store = await openStore({ workspace: root });
  assert.equal(count(store, 'application_receipts'), 2);
  assert.equal(all(store, 'SELECT external_side_effect FROM audit_log').every(row => row.external_side_effect === 'none'), true);
  const packetWorkspace = allTextUnder(path.join(store.p.jobs, job.id, 'packets'));
  assert.equal(packetWorkspace.includes(restrictedSentinel), false);
  assert.equal(cliOk(root, ['apply', 'packet', 'show', packet.id, '--json']).receiptState, 'confirmed');
});
