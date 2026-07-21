import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, all, one, queuePostCommit, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { createArtifact, approveArtifact, rejectArtifact, artifactQueue, diffArtifact } from '../src/artifacts.js';
import { callDomainTool, DomainToolError } from '../src/domain-tools.js';

async function seeded(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-human-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Human Review PM').profile;
  const proof = addProof(store, profile.id, 'Led a product launch that improved activation by 30%.', 'portfolio', ['product'], ['30%']);
  const jobFile = path.join(root, 'job.md');
  writeFileSync(jobFile, 'Title: Product Manager\nCompany: Review Co\nLocation: Remote\n\nLead product launches and improve activation.');
  const job = importText(store, { profileId: profile.id, filePath: jobFile }).job;
  return { root, store, profile, proof, job };
}

function resumeInput({ profile, proof, job, content, suffix = '' }) {
  return {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: path.join('jobs', job.id, 'artifacts', 'tailored-resume.md'),
    title: `Tailored resume${suffix}`,
    content,
    evidence: [{ proofPointId: proof.id }],
    warnings: [],
    series: { kind: 'resume' }
  };
}

test('artifact revisions preserve lineage and only current pending revisions enter the queue', async t => {
  const fixture = await seeded(t);
  const first = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nFirst revision.' }));
  const second = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nSecond revision.', suffix: ' v2' }));

  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesArtifactId, first.id);
  assert.equal(first.seriesKey, second.seriesKey);
  assert.deepEqual(artifactQueue(fixture.store).map(item => item.id), [second.id]);
  assert.equal(one(fixture.store, 'SELECT approval_status FROM artifacts WHERE id=?', [first.id]).approval_status, 'draft_needs_human_review');

  assert.throws(() => approveArtifact(fixture.store, first.id, { reviewedBy: 'cli' }), error => error.code === 'artifact_not_current');
  const diff = diffArtifact(fixture.store, second.id);
  assert.equal(diff.againstArtifactId, first.id);
  assert.match(diff.text, /-First revision\./);
  assert.match(diff.text, /\+Second revision\./);
});

test('approval is exact, idempotent, local-only, and redrafting makes it stale', async t => {
  const fixture = await seeded(t);
  const first = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nApproved content.' }));
  const beforeApplication = all(fixture.store, 'SELECT * FROM applications');
  const approved = approveArtifact(fixture.store, first.id, { reviewedBy: 'cli', note: 'Checked against proof.' });
  const repeated = approveArtifact(fixture.store, first.id, { reviewedBy: 'cli', note: 'Checked against proof.' });

  assert.equal(approved.approvalStatus, 'approved');
  assert.equal(approved.externalSideEffects, 'none');
  assert.equal(approved.submissionPerformed, false);
  assert.equal(approved.applicationStatusChanged, false);
  assert.equal(repeated.idempotent, true);
  assert.equal(Number(one(fixture.store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='artifact.approved' AND entity_id=?", [first.id]).count), 1);
  assert.deepEqual(all(fixture.store, 'SELECT * FROM applications'), beforeApplication);

  const second = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nRedrafted content.' }));
  assert.equal(second.effectiveReviewStatus, 'pending');
  assert.deepEqual(artifactQueue(fixture.store).map(item => item.id), [second.id]);
  const history = all(fixture.store, 'SELECT id,approval_status FROM artifacts WHERE series_key=? ORDER BY revision', [first.seriesKey]);
  assert.deepEqual(history, [
    { id: first.id, approval_status: 'approved' },
    { id: second.id, approval_status: 'draft_needs_human_review' }
  ]);
});

test('review rejects divergent workspace mirrors and rejected revisions cannot be approved', async t => {
  const fixture = await seeded(t);
  const draft = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nCanonical content.' }));
  writeFileSync(path.join(fixture.store.p.ws, draft.path), '# Resume\n\nTampered content.\n');
  assert.throws(() => approveArtifact(fixture.store, draft.id, { reviewedBy: 'tui' }), error => error.code === 'artifact_mirror_diverged');
  assert.equal(one(fixture.store, 'SELECT approval_status FROM artifacts WHERE id=?', [draft.id]).approval_status, 'draft_needs_human_review');

  writeFileSync(path.join(fixture.store.p.ws, draft.path), '# Resume\n\nCanonical content.\n');
  const rejected = rejectArtifact(fixture.store, draft.id, { reviewedBy: 'cli', note: 'Missing required detail.' });
  assert.equal(rejected.approvalStatus, 'rejected');
  assert.throws(() => approveArtifact(fixture.store, draft.id, { reviewedBy: 'cli' }), error => error.code === 'artifact_rejected_requires_redraft');
});

test('MCP and ACP cannot approve or reject even with spoofed mediation and attestation override', async t => {
  const fixture = await seeded(t);
  const draft = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nReview me.' }));
  const previousMediation = process.env.JOBOS_MEDIATION;
  const previousOverride = process.env.JOBOS_ALLOW_AGENT_ATTESTATION;
  process.env.JOBOS_MEDIATION = 'cli';
  process.env.JOBOS_ALLOW_AGENT_ATTESTATION = '1';
  t.after(() => {
    if (previousMediation == null) delete process.env.JOBOS_MEDIATION; else process.env.JOBOS_MEDIATION = previousMediation;
    if (previousOverride == null) delete process.env.JOBOS_ALLOW_AGENT_ATTESTATION; else process.env.JOBOS_ALLOW_AGENT_ATTESTATION = previousOverride;
  });

  for (const source of ['mcp', 'acp']) {
    for (const tool of ['approve_artifact', 'reject_artifact']) {
      await assert.rejects(
        callDomainTool(fixture.store, tool, { artifactId: draft.id, note: 'agent decision' }, { source, allowExternalAttestation: true }),
        error => error instanceof DomainToolError && error.code === 'human_review_required'
      );
    }
  }
});


test('two-store race rejects stale persistence and emits no queued approval projection', async t => {
  const fixture = await seeded(t);
  const stale = await openStore({ workspace: fixture.root });
  const first = createArtifact(fixture.store, resumeInput({ ...fixture, content: '# Resume\n\nWriter one.' }));
  const falseProjection = path.join(fixture.store.p.ws, 'false-approval.jsonl');

  run(stale, 'INSERT INTO audit_log VALUES (?,?,?,?,?,?,?)', [
    'audit_false_approval',
    'artifact.approved',
    'artifact',
    first.id,
    JSON.stringify({ approvalStatus: 'approved' }),
    'none',
    new Date().toISOString()
  ]);
  queuePostCommit(stale, () => writeFileSync(falseProjection, 'must not exist'));
  assert.throws(() => save(stale), error => error.code === 'stale_snapshot');
  assert.equal(existsSync(falseProjection), false);

  const second = createArtifact(stale, resumeInput({ ...fixture, content: '# Resume\n\nWriter two.' }));
  assert.equal(second.revision, 2);
  assert.equal(second.supersedesArtifactId, first.id);
  assert.equal(one(stale, "SELECT COUNT(*) AS count FROM audit_log WHERE id='audit_false_approval'").count, 0);
});

test('legacy artifacts migrate with deterministic resume lineage and separate ambiguous series', async t => {
  const fixture = await seeded(t);
  const at = new Date().toISOString();
  fixture.store.db.run('DROP INDEX IF EXISTS idx_artifacts_series_revision');
  fixture.store.db.run('DROP INDEX IF EXISTS idx_artifacts_supersedes');
  fixture.store.db.run('DROP INDEX IF EXISTS idx_artifacts_current');
  fixture.store.db.run('DROP TABLE artifacts');
  fixture.store.db.run(`CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, job_id TEXT, profile_id TEXT, type TEXT NOT NULL, path TEXT NOT NULL,
    title TEXT NOT NULL, content TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]',
    warnings_json TEXT NOT NULL DEFAULT '[]', approval_status TEXT NOT NULL DEFAULT 'draft_needs_human_review',
    created_at TEXT NOT NULL
  )`);
  const insertLegacy = 'INSERT INTO artifacts (id,job_id,profile_id,type,path,title,content,evidence_json,warnings_json,approval_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)';
  fixture.store.db.run(insertLegacy, [
    'legacy_resume', fixture.job.id, fixture.profile.id, 'resume', `jobs/${fixture.job.id}/artifacts/resume.md`, 'Legacy resume', 'legacy resume', '[]', '[]', 'draft_needs_human_review', at
  ]);
  fixture.store.db.run(insertLegacy, [
    'legacy_unknown_a', fixture.job.id, fixture.profile.id, 'unknown', 'legacy/ambiguous.md', 'Legacy A', 'A', '[]', '[]', 'draft_needs_human_review', at
  ]);
  fixture.store.db.run(insertLegacy, [
    'legacy_unknown_b', fixture.job.id, fixture.profile.id, 'unknown', 'legacy/ambiguous.md', 'Legacy B', 'B', '[]', '[]', 'draft_needs_human_review', at
  ]);
  fixture.store.db.run("UPDATE meta SET value='6' WHERE key='schema_version'");
  save(fixture.store);
  fixture.store.db.close();

  const migrated = await openStore({ workspace: fixture.root });
  const resume = one(migrated, "SELECT series_key,revision,content_hash FROM artifacts WHERE id='legacy_resume'");
  const unknown = all(migrated, "SELECT series_key FROM artifacts WHERE id IN ('legacy_unknown_a','legacy_unknown_b') ORDER BY id");
  assert.match(resume.series_key, /^resume:/);
  assert.equal(Number(resume.revision), 1);
  assert.match(resume.content_hash, /^[a-f0-9]{64}$/);
  assert.notEqual(unknown[0].series_key, unknown[1].series_key);
});
