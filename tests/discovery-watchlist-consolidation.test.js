import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { all, openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import {
  addWatchlist,
  createCompanySearch,
  createSearch,
  listWatchlist,
  migrateLegacyWatchlist
} from '../src/discovery.js';

async function fixture(prefix = 'jobos-watch-consolidation-') {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'Discovery profile').profile;
  return { root, store, profile };
}

test('company watches are executable saved-search presets with adapter-specific config', async () => {
  const { store, profile } = await fixture();
  const greenhouse = createCompanySearch(store, {
    company: 'Acme Learning',
    profileId: profile.id,
    adapter: 'GREENHOUSE',
    handle: 'acme',
    notes: 'Priority target'
  });
  assert.equal(greenhouse.created, true);
  assert.equal(greenhouse.adapter, 'greenhouse');
  assert.equal(greenhouse.minFit, 70);
  assert.deepEqual(greenhouse.config, {
    boardToken: 'acme',
    companyLabel: 'Acme Learning',
    notes: 'Priority target',
    preset: 'company-watch'
  });

  const lever = createCompanySearch(store, {
    company: 'Pathway Labs',
    profileId: profile.id,
    adapter: 'lever',
    handle: 'pathway',
    notes: 'Check weekly',
    minFit: 82
  });
  assert.deepEqual(lever.config, {
    companyLabel: 'Pathway Labs',
    handle: 'pathway',
    notes: 'Check weekly',
    preset: 'company-watch'
  });
  assert.equal(lever.minFit, 82);
  assert.equal(all(store, 'SELECT * FROM company_watchlist').length, 0);
});

test('company watches dedupe by normalized adapter/config and preserve colliding names', async () => {
  const { store, profile } = await fixture();
  const unrelated = createSearch(store, {
    name: 'Acme Learning jobs',
    profileId: profile.id,
    adapter: 'greenhouse',
    config: { boardToken: 'different', companyLabel: 'Different Co' }
  });
  const created = createCompanySearch(store, {
    company: 'Acme Learning',
    profileId: profile.id,
    adapter: 'greenhouse',
    handle: 'acme',
    notes: 'Priority target'
  });
  assert.equal(created.name, 'Acme Learning jobs (greenhouse)');
  assert.notEqual(created.id, unrelated.id);

  const sameTarget = createCompanySearch(store, {
    company: '  ACME   LEARNING ',
    profileId: profile.id,
    adapter: ' GreenHouse ',
    handle: 'ACME',
    notes: 'Priority target',
    name: 'A completely different name'
  });
  assert.equal(sameTarget.created, false);
  assert.equal(sameTarget.deduped, true);
  assert.equal(sameTarget.id, created.id);
  assert.equal(all(store, 'SELECT * FROM saved_searches').length, 2);
});

test('legacy watchlist migration is explicit, detailed, deduping, and non-destructive', async () => {
  const { store, profile } = await fixture();
  addWatchlist(store, { company: 'Acme', adapter: 'greenhouse', handle: 'acme', notes: 'Target' });
  addWatchlist(store, { company: 'ACME', adapter: 'GREENHOUSE', handle: 'ACME', notes: 'Target' });
  addWatchlist(store, { company: 'Pathway Labs', adapter: 'lever', handle: 'pathway', notes: 'Later' });

  // A manually-created equivalent search is recognized even though it has no
  // preset marker and uses a historical config spelling.
  const existing = createSearch(store, {
    name: 'Existing Pathway search',
    profileId: profile.id,
    adapter: 'lever',
    config: { company: 'pathway', companyLabel: 'Pathway Labs', notes: 'Later' }
  });
  const result = migrateLegacyWatchlist(store, { profileId: profile.id, minFit: 75 });
  assert.deepEqual(
    { total: result.total, created: result.created, deduped: result.deduped, failed: result.failed },
    { total: 3, created: 1, deduped: 2, failed: 0 }
  );
  assert.equal(result.items.length, 3);
  assert.equal(result.items.find(item => item.search?.id === existing.id)?.status, 'deduped');
  assert.equal(all(store, 'SELECT * FROM saved_searches').length, 2);
  assert.equal(listWatchlist(store).length, 3, 'legacy rows remain available for compatibility');

  const second = migrateLegacyWatchlist(store, { profileId: profile.id, minFit: 75 });
  assert.deepEqual(
    { created: second.created, deduped: second.deduped, failed: second.failed },
    { created: 0, deduped: 3, failed: 0 }
  );
});

test('legacy watchlist migration requires an explicit valid profile', async () => {
  const { store } = await fixture();
  assert.throws(() => migrateLegacyWatchlist(store), /Missing profileId/);
  assert.throws(() => migrateLegacyWatchlist(store, { profileId: 'profile_missing' }), /Unknown profile/);
});
