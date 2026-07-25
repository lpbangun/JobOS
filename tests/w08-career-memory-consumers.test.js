import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { one, openStore } from '../src/db.js';
import { score } from '../src/scoring.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-consumers-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('W08-CONSUMERS-01 scoring returns retrieval guidance without changing persisted fit semantics', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const job = one(store, "SELECT * FROM jobs WHERE profile_id='alpha' ORDER BY id LIMIT 1");
  const result = await score(store, job.id, 'alpha');
  assert.deepEqual(result.memoryGuidance, {
    schema: 'jobos.career-memory-search-guidance.v1',
    adjustment: 0,
    matchedRuleIds: [],
    citations: [],
    explanation: 'accepted guidance; fit score unchanged',
  });
});
