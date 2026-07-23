import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, one } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import {
  buildFormSnapshot,
  getFormSnapshot,
  listFormSnapshots,
  persistFormSnapshot
} from '../src/forms.js';

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-form-evidence-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, `Form ${crypto.randomUUID()}`).profile;
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Form Co\n\nBuild products.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  return { store, profile, job };
}

function snapshotInput(f, secret) {
  return {
    snapshotId: `form_snapshot_${crypto.randomUUID()}`,
    jobId: f.job.id,
    profileId: f.profile.id,
    capturedAt: '2026-07-22T12:00:00.000Z',
    requestedUrl: `https://apply.example.test/jobs/123?token=${secret}#private`,
    finalUrl: `https://apply.example.test/jobs/123?session=${secret}`,
    adapter: { id: 'dom-v1', protocolVersion: 1, sourceHash: 'a'.repeat(64) },
    selection: { frameKey: 'main', formKey: 'application', candidateCount: 1, score: 8 },
    fields: [{
      frameKey: 'main',
      locator: { strategy: 'label', value: 'Email address', ordinal: 0 },
      atsFieldId: 'email',
      prompt: 'Email address',
      control: 'email',
      required: true,
      multiple: false,
      options: [],
      classification: { category: 'identity', sensitivity: 'personal', handling: 'auto-fill', reasonCode: 'identity_email', provenance: 'dom' }
    }],
    warnings: [{ code: 'fixture_warning', message: `must-not-store-${secret}` }]
  };
}

test('form snapshot evidence persists append-only secret-safe canonical rows', async t => {
  const f = await fixture(t);
  const secret = `SECRET-${crypto.randomUUID()}`;
  const snapshot = buildFormSnapshot(snapshotInput(f, secret));
  const created = persistFormSnapshot(f.store, snapshot);
  assert.equal(created.snapshotId, snapshot.snapshotId);
  assert.equal(created.fingerprint, snapshot.fingerprint);
  assert.deepEqual(getFormSnapshot(f.store, snapshot.snapshotId), created);
  assert.equal(listFormSnapshots(f.store, { jobId: f.job.id, profileId: f.profile.id }).length, 1);

  assert.throws(() => persistFormSnapshot(f.store, { ...snapshot, fingerprint: 'b'.repeat(64) }), error => error.code === 'form_snapshot_immutable');
  const row = one(f.store, 'SELECT * FROM form_snapshots WHERE id=?', [snapshot.snapshotId]);
  assert.equal(row.requested_origin, 'https://apply.example.test');
  assert.equal(row.requested_path, '/jobs/123');
  assert.equal(row.final_origin, 'https://apply.example.test');
  assert.equal(row.final_path, '/jobs/123');
  assert.equal(Buffer.from(f.store.db.export()).includes(Buffer.from(secret)), false);
  assert.equal(JSON.stringify(created).includes(secret), false);
});

test('form snapshot evidence permits repeated inspections but preserves one semantic fingerprint', async t => {
  const f = await fixture(t);
  const first = buildFormSnapshot(snapshotInput(f, 'one'));
  const second = buildFormSnapshot({
    ...snapshotInput(f, 'two'),
    capturedAt: '2026-07-22T13:00:00.000Z'
  });
  assert.equal(first.fingerprint, second.fingerprint);
  persistFormSnapshot(f.store, first);
  persistFormSnapshot(f.store, second);
  const rows = listFormSnapshots(f.store, { jobId: f.job.id, profileId: f.profile.id });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.fingerprint), [first.fingerprint, second.fingerprint]);
});
