import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

import { all, guardedWrite, one, openStore, run } from '../src/db.js';
import {
  approveArtifact,
  rejectArtifact,
  ingestEditedArtifact,
  createArtifact,
  artifactContentHash,
  diffArtifact,
} from '../src/artifacts.js';
import {
  appendMemoryObservation,
  listMemoryObservations,
} from '../src/career-memory-observations.js';
import {
  ARTIFACT_FEEDBACK_INPUT_SCHEMA,
  normalizeArtifactFeedbackInput,
} from '../src/career-memory-contract.js';

const require = createRequire(import.meta.url);
const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const NOW = new Date('2026-07-25T12:00:00.000Z');

function fixtureWorkspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-artifacts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, '.jobos');
  mkdirSync(state, { recursive: true });
  const databasePath = path.join(state, 'jobos.sqlite');
  copyFileSync(FIXTURE, databasePath);
  return { root, databasePath };
}

function writeArtifactMirror(store, artifact) {
  const filePath = path.join(store.p.ws, artifact.path);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, artifact.content, 'utf8');
}

function alphaCurrentDraftArtifact(store) {
  // A draft_needs_human_review artifact that is the current revision in its series.
  return one(store, `SELECT a.* FROM artifacts a
    WHERE a.profile_id='alpha' AND a.approval_status='draft_needs_human_review'
    AND NOT EXISTS (SELECT 1 FROM artifacts newer
      WHERE newer.series_key=a.series_key AND newer.revision>a.revision)
    ORDER BY a.revision DESC LIMIT 1`);
}

function alphaApprovedArtifact(store) {
  return one(store, `SELECT * FROM artifacts
    WHERE profile_id='alpha' AND approval_status='approved' AND type='interview_prep'
    ORDER BY revision DESC LIMIT 1`);
}

function artifactFeedback(overrides = {}) {
  return {
    schema: ARTIFACT_FEEDBACK_INPUT_SCHEMA,
    reasonCodes: ['tone'],
    signals: [{ ruleType: 'tone', value: { value: 'concise' } }],
    publicExplanation: '',
    privateNote: '',
    referenceId: 'w08-artifact-feedback-ref',
    ...overrides,
  };
}

function memoryMirror(root, profileId = 'alpha') {
  return path.join(root, 'jobos-workspace', 'profiles', profileId, 'memory', 'observations.yaml');
}

function phase2Counts(store) {
  return {
    observations: one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count,
    audit: one(store, 'SELECT COUNT(*) AS count FROM audit_log').count,
    artifacts: one(store, 'SELECT COUNT(*) AS count FROM artifacts').count,
  };
}

function protectedRows(store) {
  return Object.fromEntries([
    'profiles',
    'proof_points',
    'jobs',
    'applications',
    'status_changes',
    'artifacts',
    'tasks',
  ].map(table => [table, all(store, `SELECT * FROM ${table} ORDER BY rowid`)]));
}

// ── W08-ART-01: approve with memoryFeedback records observation atomically ──

test('W08-ART-01 approve with memoryFeedback records an artifact_approved observation in the same guardedWrite', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const before = phase2Counts(store);
  const feedback = artifactFeedback({
    reasonCodes: [],
    signals: [],
    referenceId: 'w08-approve-feedback',
  });
  const result = approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'Approved for evidence.',
    memoryFeedback: feedback,
  });
  assert.equal(result.approvalStatus, 'approved');
  assert.equal(result.idempotent, false);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 1);
  const observation = one(store, 'SELECT * FROM career_memory_observations ORDER BY rowid DESC LIMIT 1');
  assert.equal(observation.event_type, 'artifact_approved');
  assert.equal(observation.source_entity_type, 'artifact');
  assert.equal(observation.source_entity_id, draft.id);
  assert.equal(observation.source_revision, Number(draft.revision));
  assert.equal(observation.source_content_hash, draft.content_hash);
  // The review audit and the observation audit are both written.
  const reviewAudit = one(store, `SELECT * FROM audit_log WHERE action='artifact.approved' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, [draft.id]);
  assert.ok(reviewAudit, 'artifact.approved audit exists');
  assert.equal(observation.source_version_id, reviewAudit.id);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM audit_log WHERE action='career_memory.observation_recorded'").count, 1);
  assert.ok(existsSync(memoryMirror(root)));
  // Approve without memoryFeedback leaves no extra observation.
  const draft2 = one(store, `SELECT a.* FROM artifacts a
    WHERE a.profile_id='alpha' AND a.approval_status='draft_needs_human_review'
    AND NOT EXISTS (SELECT 1 FROM artifacts newer WHERE newer.series_key=a.series_key AND newer.revision>a.revision)
    ORDER BY a.revision DESC LIMIT 1`);
  if (draft2) {
    writeArtifactMirror(store, draft2);
    approveArtifact(store, draft2.id, { reviewedBy: 'cli', note: 'approve no feedback' });
    assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 1);
  }
  store.db.close();
});

// ── W08-ART-02: reject with memoryFeedback records observation atomically ──

test('W08-ART-02 reject with memoryFeedback records an artifact_rejected observation in the same guardedWrite', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const feedback = artifactFeedback({
    reasonCodes: ['unsupported_claim'],
    signals: [],
    referenceId: 'w08-reject-feedback',
  });
  const result = rejectArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'Unsupported claim.',
    memoryFeedback: feedback,
  });
  assert.equal(result.approvalStatus, 'rejected');
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 1);
  const observation = one(store, 'SELECT * FROM career_memory_observations ORDER BY rowid DESC LIMIT 1');
  assert.equal(observation.event_type, 'artifact_rejected');
  assert.equal(observation.source_entity_id, draft.id);
  const reviewAudit = one(store, `SELECT * FROM audit_log WHERE action='artifact.rejected' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, [draft.id]);
  assert.equal(observation.source_version_id, reviewAudit.id);
  store.db.close();
});

// ── W08-ART-03: idempotent approval with feedback returns existing observation ──

test('W08-ART-03 idempotent approval with feedback returns existing observation and zero deltas on replay', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const feedback = artifactFeedback({ referenceId: 'w08-approve-idempotent' });
  const first = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'approve', memoryFeedback: feedback });
  const afterFirst = phase2Counts(store);
  const mirrorAfterFirst = readFileSync(memoryMirror(root));
  const databaseAfterFirst = readFileSync(path.join(root, '.jobos', 'jobos.sqlite'));
  const revisionAfterFirst = one(store, "SELECT value FROM meta WHERE key='store_revision'").value;
  // Replay the exact same approval — idempotent approval returns existing artifact review
  const replay = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'approve', memoryFeedback: feedback });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(phase2Counts(store), afterFirst);
  assert.deepEqual(readFileSync(memoryMirror(root)), mirrorAfterFirst);
  assert.deepEqual(readFileSync(path.join(root, '.jobos', 'jobos.sqlite')), databaseAfterFirst);
  assert.equal(one(store, "SELECT value FROM meta WHERE key='store_revision'").value, revisionAfterFirst);
  // Conflicting feedback with same reference fails with zero deltas
  assert.throws(() => approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'approve',
    memoryFeedback: artifactFeedback({ referenceId: 'w08-approve-idempotent', reasonCodes: ['length'] }),
  }), error => error?.code === 'memory_reference_conflict');
  assert.deepEqual(phase2Counts(store), afterFirst);
  store.db.close();
});

// ── W08-ART-04: artifact edit with memoryFeedback records artifact_edited atomically ──

test('W08-ART-04 edit with memoryFeedback records artifact_edited with diff hash and counts in one guardedWrite', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const base = alphaApprovedArtifact(store);
  writeArtifactMirror(store, base);
  const before = phase2Counts(store);
  const newContent = '# Edited prep\n\nRevised content with new evidence framing.\n';
  const feedback = artifactFeedback({
    reasonCodes: ['structure', 'specificity'],
    signals: [],
    referenceId: 'w08-edit-feedback',
  });
  const result = ingestEditedArtifact(store, {
    artifactId: base.id,
    content: newContent,
    source: 'tui',
    memoryFeedback: feedback,
  });
  assert.ok(result.id, 'new artifact created');
  assert.notEqual(result.id, base.id);
  assert.equal(result.revision, Number(base.revision) + 1);
  // One observation row, one artifact.edited audit, one career_memory audit, all in one transaction.
  const observation = one(store, 'SELECT * FROM career_memory_observations ORDER BY rowid DESC LIMIT 1');
  assert.equal(observation.event_type, 'artifact_edited');
  assert.equal(observation.source_entity_id, result.id);
  assert.equal(observation.source_revision, result.revision);
  assert.equal(observation.source_content_hash, result.contentHash);
  const editAudit = one(store, `SELECT * FROM audit_log WHERE action='artifact.edited' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, [result.id]);
  assert.ok(editAudit, 'artifact.edited audit exists');
  assert.equal(observation.source_version_id, editAudit.id);
  // Edit metadata is stored in the artifact.edited audit payload, not the observation payload.
  const auditPayload = JSON.parse(editAudit.payload_json);
  assert.equal(auditPayload.previousArtifactId, base.id, 'audit payload has previousArtifactId');
  assert.equal(auditPayload.artifactId, result.id, 'audit payload has new artifactId');
  assert.equal(auditPayload.baseRevision, Number(base.revision), 'audit payload has baseRevision');
  assert.equal(auditPayload.newRevision, result.revision, 'audit payload has newRevision');
  assert.equal(auditPayload.baseContentHash, base.content_hash, 'audit payload has baseContentHash');
  assert.equal(auditPayload.newContentHash, result.contentHash, 'audit payload has newContentHash');
  assert.ok(auditPayload.diffHash, 'audit payload has diffHash');
  assert.equal(typeof auditPayload.addedLines, 'number');
  assert.equal(typeof auditPayload.removedLines, 'number');
  // Observation payload is decision-only; no diff text anywhere.
  assert.equal(JSON.stringify(JSON.parse(observation.payload_json)).includes('--- '), false, 'no diff text in observation payload');
  assert.equal(JSON.stringify(auditPayload).includes('--- '), false, 'no diff text in audit payload');
  assert.equal(JSON.stringify(auditPayload).includes('+++ '), false, 'no diff text in audit payload');
  // Created artifact + observation rows grew by exactly 1 each, audit grew by 2 (edited + memory).
  assert.equal(phase2Counts(store).artifacts, before.artifacts + 1);
  assert.equal(phase2Counts(store).observations, before.observations + 1);
  store.db.close();
});

// ── W08-ART-05: same-content edit rejects; exact edit replay returns existing revision/event ──

test('W08-ART-05 same-content edit rejects and exact edit replay returns existing revision/event', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const base = alphaApprovedArtifact(store);
  writeArtifactMirror(store, base);
  const feedback = artifactFeedback({ referenceId: 'w08-edit-replay' });
  const first = ingestEditedArtifact(store, {
    artifactId: base.id,
    content: '# Edited prep\n\nRevised content.\n',
    source: 'tui',
    memoryFeedback: feedback,
  });
  const afterFirst = phase2Counts(store);
  // Exact replay returns the existing revision/event idempotently.
  const replay = ingestEditedArtifact(store, {
    artifactId: base.id,
    content: '# Edited prep\n\nRevised content.\n',
    source: 'tui',
    memoryFeedback: feedback,
  });
  assert.equal(replay.id, first.id);
  assert.deepEqual(phase2Counts(store), afterFirst);
  // Same content as the base artifact (no change) rejects.
  assert.throws(() => ingestEditedArtifact(store, {
    artifactId: base.id,
    content: base.content,
    source: 'tui',
    memoryFeedback: artifactFeedback({ referenceId: 'w08-edit-same-content' }),
  }), error => error?.code === 'artifact_same_content');
  assert.deepEqual(phase2Counts(store), afterFirst);
  store.db.close();
});

// ── W08-ART-06: review without memoryFeedback is behaviorally identical (no observation row) ──

test('W08-ART-06 approve/reject without memoryFeedback writes no observation row and preserves existing return shape', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const before = phase2Counts(store);
  const result = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'approve no feedback' });
  assert.equal(result.approvalStatus, 'approved');
  assert.equal(result.idempotent, false);
  assert.equal(result.externalSideEffects, 'none');
  assert.equal(result.submissionPerformed, false);
  assert.deepEqual(phase2Counts(store).observations, before.observations);
  // audit grew by exactly one (artifact.approved), no career_memory audit.
  assert.equal(phase2Counts(store).audit, before.audit + 1);
  // The idempotent approval (already approved) still returns idempotent without feedback.
  const replay = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'approve no feedback' });
  assert.equal(replay.idempotent, true);
  assert.deepEqual(phase2Counts(store), { ...before, audit: before.audit + 1 });
  store.db.close();
});

// ── W08-ART-07: failed feedback validation leaves artifact/review/observation deltas at zero ──

test('W08-ART-07 invalid memoryFeedback leaves artifact/review/audit/observation deltas at zero', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const before = phase2Counts(store);
  const beforeProtected = protectedRows(store);
  // Invalid reason codes for approve (zero reasons is allowed, but unknown reason is not).
  assert.throws(() => approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'approve',
    memoryFeedback: artifactFeedback({ reasonCodes: ['unknown_reason'], referenceId: 'w08-invalid-approve' }),
  }), error => error?.code === 'memory_enum_invalid');
  // Missing other explanation.
  assert.throws(() => rejectArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'reject',
    memoryFeedback: artifactFeedback({ reasonCodes: ['other'], referenceId: 'w08-invalid-reject' }),
  }), error => error?.code === 'memory_other_explanation_required');
  assert.deepEqual(phase2Counts(store), before);
  assert.deepEqual(protectedRows(store), beforeProtected);
  // The artifact review status is unchanged.
  assert.equal(one(store, 'SELECT approval_status FROM artifacts WHERE id=?', [draft.id]).approval_status, 'draft_needs_human_review');
  store.db.close();
});

// ── W08-ART-08: artifact reason codes are 1-5 unique canonical codes for reject/edit ──

test('W08-ART-08 reject/edit require 1-5 unique canonical artifact reason codes; approve permits zero', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  // Approve with zero reasons is allowed (zero signals, since zero reasons cannot support a signal).
  approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'approve zero reasons',
    memoryFeedback: artifactFeedback({ reasonCodes: [], signals: [], referenceId: 'w08-approve-zero' }),
  });
  // For reject tests, create a fresh draft by editing the approved artifact.
  const edited = ingestEditedArtifact(store, { artifactId: draft.id, content: '# Fresh draft\n\nNew content.\n', source: 'tui' });
  writeArtifactMirror(store, edited);
  // Reject requires at least 1 reason — zero fails.
  assert.throws(() => rejectArtifact(store, edited.id, {
    reviewedBy: 'cli',
    note: 'reject zero reasons',
    memoryFeedback: artifactFeedback({ reasonCodes: [], referenceId: 'w08-reject-zero' }),
  }), error => error?.code === 'memory_reason_count_invalid');
  // Six reasons fails.
  assert.throws(() => rejectArtifact(store, edited.id, {
    reviewedBy: 'cli',
    note: 'reject six reasons',
    memoryFeedback: artifactFeedback({ reasonCodes: ['tone', 'length', 'opening', 'closing', 'structure', 'vocabulary'], referenceId: 'w08-reject-six' }),
  }), error => error?.code === 'memory_reason_count_invalid');
  // Duplicate reasons fail.
  assert.throws(() => rejectArtifact(store, edited.id, {
    reviewedBy: 'cli',
    note: 'reject duplicate',
    memoryFeedback: artifactFeedback({ reasonCodes: ['tone', 'tone'], referenceId: 'w08-reject-dup' }),
  }), error => error?.code === 'memory_reason_duplicate');
  store.db.close();
});

// ── W08-ART-09: edit payload stores base/new IDs, revisions, hashes, diff hash, counts ──

test('W08-ART-09 edit payload stores base/new IDs, revisions, hashes, diff hash, and added/removed counts', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const base = alphaApprovedArtifact(store);
  writeArtifactMirror(store, base);
  const newContent = '# Edited prep\n\nRevised content with new framing.\n';
  const result = ingestEditedArtifact(store, {
    artifactId: base.id,
    content: newContent,
    source: 'tui',
    memoryFeedback: artifactFeedback({ reasonCodes: ['structure'], signals: [], referenceId: 'w08-edit-payload' }),
  });
  const observation = one(store, 'SELECT * FROM career_memory_observations ORDER BY rowid DESC LIMIT 1');
  const editAudit = one(store, `SELECT * FROM audit_log WHERE action='artifact.edited' AND entity_id=? ORDER BY rowid DESC LIMIT 1`, [result.id]);
  const auditPayload = JSON.parse(editAudit.payload_json);
  assert.equal(auditPayload.previousArtifactId, base.id);
  assert.equal(auditPayload.artifactId, result.id);
  assert.equal(auditPayload.baseRevision, Number(base.revision));
  assert.equal(auditPayload.newRevision, result.revision);
  assert.equal(auditPayload.baseContentHash, base.content_hash);
  assert.equal(auditPayload.newContentHash, result.contentHash);
  assert.ok(auditPayload.diffHash, 'audit payload has diffHash');
  // diff hash matches a canonical hash of the diff lines.
  const diff = diffArtifact(store, result.id, { againstArtifactId: base.id });
  // added/removed counts match the diff.
  const added = diff.lines.filter(line => line.startsWith('+')).length;
  const removed = diff.lines.filter(line => line.startsWith('-')).length;
  assert.equal(auditPayload.addedLines, added);
  assert.equal(auditPayload.removedLines, removed);
  store.db.close();
});

// ── W08-ART-10: compatibility — existing callers without memoryFeedback unchanged ──

test('W08-ART-10 existing review/edit without memoryFeedback remains behaviorally identical', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  // Approve without feedback: same return shape as before.
  const approved = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'legacy approve' });
  assert.equal(approved.approvalStatus, 'approved');
  assert.equal(approved.idempotent, false);
  assert.equal(approved.submissionPerformed, false);
  assert.equal(approved.applicationStatusChanged, false);
  assert.equal(approved.externalSideEffects, 'none');
  // No observation row.
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 0);
  // Idempotent approval without feedback.
  const replay = approveArtifact(store, draft.id, { reviewedBy: 'cli', note: 'legacy approve' });
  assert.equal(replay.idempotent, true);
  // Edit without feedback: same return shape and no observation row.
  const edited = ingestEditedArtifact(store, { artifactId: approved.id, content: '# New\n\ncontent\n', source: 'tui' });
  assert.ok(edited.id);
  assert.equal(edited.revision, Number(approved.revision) + 1);
  assert.equal(one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count, 0);
  // artifact.edited audit still exists.
  assert.ok(one(store, `SELECT * FROM audit_log WHERE action='artifact.edited' AND entity_id=?`, [edited.id]));
  store.db.close();
});

// ── W08-ART-F1: first feedback on an already-approved artifact is a real write ──

test('W08-ART-F1 already-approved artifact records first feedback audit and mirror atomically as non-idempotent', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const approved = alphaApprovedArtifact(store);
  writeArtifactMirror(store, approved);
  const before = phase2Counts(store);
  const feedback = artifactFeedback({
    reasonCodes: [],
    signals: [],
    referenceId: 'w08-approved-first-feedback',
  });

  const result = approveArtifact(store, approved.id, {
    reviewedBy: 'cli',
    note: 'feedback after approval',
    memoryFeedback: feedback,
  });

  assert.equal(result.idempotent, false, 'creating the first observation is not an idempotent call');
  assert.equal(phase2Counts(store).observations, before.observations + 1);
  assert.equal(phase2Counts(store).audit, before.audit + 1);
  const observation = one(store, 'SELECT * FROM career_memory_observations WHERE reference_id=?', [feedback.referenceId]);
  assert.ok(observation);
  assert.ok(one(store, "SELECT * FROM audit_log WHERE action='career_memory.observation_recorded' AND entity_id=?", [observation.id]));
  assert.match(readFileSync(memoryMirror(root), 'utf8'), new RegExp(observation.id));
  store.db.close();
});

// ── W08-ART-F2: review replay identity includes private feedback ──

test('W08-ART-F2 review reference replay conflicts when only privateNote changes', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const draft = alphaCurrentDraftArtifact(store);
  writeArtifactMirror(store, draft);
  const referenceId = 'w08-review-private-note-conflict';
  approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'approve',
    memoryFeedback: artifactFeedback({ referenceId, privateNote: 'first private note' }),
  });
  const afterFirst = phase2Counts(store);

  assert.throws(() => approveArtifact(store, draft.id, {
    reviewedBy: 'cli',
    note: 'approve',
    memoryFeedback: artifactFeedback({ referenceId, privateNote: 'different private note' }),
  }), error => error?.code === 'memory_reference_conflict');
  assert.deepEqual(phase2Counts(store), afterFirst);
  store.db.close();
});

// ── W08-ART-F3: edit replay identity includes all normalized feedback ──

test('W08-ART-F3 same-content edit replay conflicts when normalized feedback identity changes', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const base = alphaApprovedArtifact(store);
  writeArtifactMirror(store, base);
  const content = '# Edited prep\n\nSame replay content.\n';
  const referenceId = 'w08-edit-feedback-identity-conflict';
  ingestEditedArtifact(store, {
    artifactId: base.id,
    content,
    source: 'tui',
    memoryFeedback: artifactFeedback({ referenceId, privateNote: 'first private note' }),
  });
  const afterFirst = phase2Counts(store);

  assert.throws(() => ingestEditedArtifact(store, {
    artifactId: base.id,
    content,
    source: 'tui',
    memoryFeedback: artifactFeedback({ referenceId, privateNote: 'different private note' }),
  }), error => error?.code === 'memory_reference_conflict');
  assert.deepEqual(phase2Counts(store), afterFirst);
  store.db.close();
});

test('W08-ART-F4 same-content edit without feedback preserves legacy rejection behavior', async t => {
  const { root } = fixtureWorkspace(t);
  const store = await openStore({ workspace: root });
  const base = alphaApprovedArtifact(store);
  const before = phase2Counts(store);

  assert.throws(() => ingestEditedArtifact(store, {
    artifactId: base.id,
    content: base.content,
    source: 'tui',
  }), error => error?.code === 'artifact_same_content');
  assert.deepEqual(phase2Counts(store), before);
  store.db.close();
});
