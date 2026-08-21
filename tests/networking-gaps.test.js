import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile, setNetworkIntent } from '../src/profiles.js';
import {
  networkGraphQuery,
  networkHealthBrief,
  networkOpportunitiesList,
  recordNetworkContact,
  warmthFromLastContact,
} from '../src/research/network.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';
import { AGENT_DOMAIN_TOOLS, HUMAN_ONLY_DOMAIN_TOOLS } from '../src/capabilities.js';
import { createAutomation, listAutomations } from '../src/scheduler/store.js';
import { runAutomationByName } from '../src/scheduler/core.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-networking-gaps-'));
  return openStore({ workspace: root }).then(store => ({ root, store }));
}

function addPerson(store, personId, name, at = '2025-01-01T00:00:00.000Z') {
  run(store, `INSERT INTO people
    (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [personId, name, name.toLowerCase(), '', '[]', 'high', at, at]);
}

function addEdge(store, values) {
  run(store, `INSERT INTO relationship_edges
    (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, values);
}

test('B01/B09 schema v16 adds recency columns and disabled networking automations', async () => {
  const { store } = await fixture();
  assert.equal(one(store, "SELECT value FROM meta WHERE key='schema_version'").value, '16');
  for (const table of ['relationship_edges', 'contact_points']) {
    const columns = all(store, `PRAGMA table_info(${table})`).map(row => row.name);
    assert.ok(columns.includes('last_contact_at'), `${table}.last_contact_at`);
    assert.ok(columns.includes('warmth'), `${table}.warmth`);
  }
  assert.deepEqual(all(store, 'PRAGMA foreign_key_check'), []);
  const defaults = listAutomations(store);
  for (const name of ['profile_network_research', 'network_nurture']) {
    const automation = defaults.find(item => item.name === name);
    assert.ok(automation, name);
    assert.equal(automation.enabled, false);
  }
});

test('B02/B03/B04 warmth derives deterministically and trusted recording updates local mirrors', async () => {
  const { root, store } = await fixture();
  const profile = createProfile(store, 'Network Owner').profile;
  addPerson(store, 'person_alumni', 'Alumni A');
  run(store, `INSERT INTO contact_points
    (id,person_id,type,value,normalized_value,evidence_tier,verification_status,confidence,source_observation_ids_json,checks_json,human_approved,do_not_use,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'contact_alumni', 'person_alumni', 'email', 'private@example.test', 'private@example.test',
    'U', 'user_imported', 'medium', '[]', '{}', 1, 0,
    '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z',
  ]);
  const recorded = recordNetworkContact(store, {
    profileId: profile.id,
    personId: 'person_alumni',
    contactPointId: 'contact_alumni',
    occurredAt: '2025-01-01T00:00:00.000Z',
    source: 'cli',
  });
  // Auto warmth decays from the contact event to asOf (now), matching the
  // replay path and every derived read view (see recordNetworkContact).
  assert.equal(recorded.warmth, warmthFromLastContact(recorded.occurredAt));
  const auditCount = all(store, 'SELECT id FROM audit_log').length;
  const replay = recordNetworkContact(store, {
    profileId: profile.id,
    personId: 'person_alumni',
    occurredAt: '2025-01-01T00:00:00.000Z',
    source: 'cli',
  });
  assert.equal(replay.idempotent, true);
  assert.equal(all(store, 'SELECT id FROM audit_log').length, auditCount);
  const older = recordNetworkContact(store, {
    profileId: profile.id,
    personId: 'person_alumni',
    occurredAt: '2024-01-01T00:00:00.000Z',
    source: 'cli',
  });
  assert.equal(older.ignoredAsOlder, true);
  assert.equal(one(store, 'SELECT last_contact_at FROM relationship_edges WHERE id=?', [recorded.updatedEdge]).last_contact_at, recorded.occurredAt);
  assert.equal(warmthFromLastContact(recorded.occurredAt, new Date('2025-01-31T00:00:00.000Z')), 'hot');
  assert.equal(warmthFromLastContact(recorded.occurredAt, new Date('2025-04-01T00:00:00.000Z')), 'warm');
  assert.equal(warmthFromLastContact(recorded.occurredAt, new Date('2025-06-30T00:00:00.000Z')), 'cool');
  assert.equal(warmthFromLastContact(recorded.occurredAt, new Date('2026-01-01T00:00:00.000Z')), 'cold');
  const health = networkHealthBrief(store, { profileId: profile.id, asOf: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(health.relationships[0].warmth, 'cold');
  assert.equal(health.generatedAt, health.asOf);
  const serialized = JSON.stringify(health);
  assert.doesNotMatch(serialized, /private@example\.test/);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'profiles', profile.id, 'network', 'health.yaml')));
  assert.doesNotMatch(readFileSync(path.join(root, 'jobos-workspace', 'profiles', profile.id, 'network', 'health.yaml'), 'utf8'), /private@example\.test/);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'profiles', profile.id, 'network', 'relationships.json')));
  assert.throws(() => recordNetworkContact(store, { profileId: profile.id, personId: 'person_alumni', occurredAt: '2999-01-01T00:00:00.000Z' }), /future/);
  assert.throws(() => recordNetworkContact(store, { profileId: profile.id, personId: 'person_alumni', warmth: 'burning' }), /Invalid warmth/);
});

test('B06/B07 graph query returns deterministic direct and two-hop mutual paths', async () => {
  const { store } = await fixture();
  const profile = createProfile(store, 'Graph Owner').profile;
  addPerson(store, 'person_via', 'Alumni A');
  addPerson(store, 'person_target', 'Target B');
  addEdge(store, ['edge_direct', 'profile', profile.id, 'person', 'person_via', 'direct_connection', '[{"label":"imported connection"}]', 'high', '2025-01-01T00:00:00.000Z']);
  addEdge(store, ['edge_mutual', 'person', 'person_via', 'person', 'person_target', 'shared_event', '[{"label":"community event"}]', 'medium', '2025-01-02T00:00:00.000Z']);
  save(store);
  const first = networkGraphQuery(store, { profileId: profile.id, personId: 'person_target', maxHops: 2 });
  const second = networkGraphQuery(store, { profileId: profile.id, personId: 'person_target', maxHops: 2 });
  assert.deepEqual(first, second);
  assert.equal(first.pathCount, 1);
  assert.equal(first.paths[0].hops, 2);
  assert.equal(first.paths[0].mutualPath, true);
  assert.deepEqual(first.paths[0].path.map(hop => hop.edgeId), ['edge_direct', 'edge_mutual']);
  assert.throws(() => networkGraphQuery(store, { profileId: profile.id, maxHops: 3 }), /maxHops/);
});

test('B12/B14 exposes three agent reads and preserves the human contact authority gate', async () => {
  const domainNames = DOMAIN_TOOLS.map(tool => tool.name);
  const agentNames = AGENT_DOMAIN_TOOLS.map(tool => tool.name);
  for (const name of ['network_opportunities_list', 'network_graph_query', 'network_health_brief']) {
    assert.ok(domainNames.includes(name));
    assert.ok(agentNames.includes(name));
  }
  assert.ok(HUMAN_ONLY_DOMAIN_TOOLS.includes('network_contact_record'));
  assert.ok(!agentNames.includes('network_contact_record'));
  assert.ok(HUMAN_ONLY_DOMAIN_TOOLS.includes('mark_outreach_sent'));
  assert.ok(!agentNames.includes('mark_outreach_sent'));
  const { store } = await fixture();
  const profile = createProfile(store, 'Authority Owner').profile;
  addPerson(store, 'person_authority', 'Authority Contact');
  await assert.rejects(
    () => callDomainTool(store, 'network_contact_record', { profileId: profile.id, personId: 'person_authority' }, { source: 'mcp' }),
    error => error.code === 'human_network_input_required',
  );
  await assert.rejects(
    () => callDomainTool(store, 'mark_outreach_sent', { artifactId: 'missing', channel: 'email' }, { source: 'mcp' }),
    error => error.code === 'human_network_input_required',
  );
  const result = await callDomainTool(store, 'network_contact_record', {
    profileId: profile.id,
    personId: 'person_authority',
    occurredAt: '2025-01-01T00:00:00.000Z',
  }, { source: 'cli' });
  assert.equal(result.personId, 'person_authority');
  assert.equal(all(store, "SELECT id FROM relationship_edges WHERE edge_type='direct_connection'").length, 1);
});

test('B05/B10 scheduler stages cold nurture drafts and reuses profile research runs', async () => {
  const { root, store } = await fixture();
  const profile = createProfile(store, 'Scheduled Network Owner').profile;
  addPerson(store, 'person_cold', 'Cold Contact');
  recordNetworkContact(store, {
    profileId: profile.id,
    personId: 'person_cold',
    occurredAt: '2025-01-01T00:00:00.000Z',
    source: 'cli',
  });
  createAutomation(store, {
    name: 'nurture_test',
    actionId: 'network_nurture',
    schedule: '* * * * *',
    profileId: profile.id,
    enabled: true,
  });
  const nurture = await runAutomationByName(store, 'nurture_test', { nowDate: new Date('2026-01-01T00:00:00.000Z') });
  assert.equal(nurture.status, 'succeeded');
  assert.equal(nurture.counts.cold, 1);
  assert.equal(one(store, "SELECT COUNT(*) AS count FROM tasks WHERE type='network_nurture' AND status='open'").count, 1);
  const artifact = one(store, "SELECT * FROM artifacts WHERE type='network_check_in'");
  assert.equal(artifact.approval_status, 'draft_needs_human_review');
  assert.match(artifact.content, /did not send email/);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', artifact.path)));
  const nurtureMirror = JSON.parse(readFileSync(path.join(root, 'jobos-workspace', 'profiles', profile.id, 'network', 'nurture-tasks.json'), 'utf8'));
  assert.equal(nurtureMirror.tasks.length, 1);

  setNetworkIntent(store, {
    profileId: profile.id,
    intent: { version: 1, allowedSources: { publicWeb: false, linkedinImport: false, xai: false } },
  });
  createAutomation(store, {
    name: 'profile_research_test',
    actionId: 'profile_network_research',
    schedule: '* * * * *',
    profileId: profile.id,
    enabled: true,
    config: { depth: 'standard', sources: ['local_network'] },
  });
  const research = await runAutomationByName(store, 'profile_research_test', { nowDate: new Date('2026-01-02T00:00:00.000Z') });
  assert.notEqual(research.status, 'failed', JSON.stringify(research, null, 2));
  assert.equal(research.counts.runs, 1);
  assert.equal(one(store, "SELECT scope FROM research_runs ORDER BY created_at DESC LIMIT 1").scope, 'profile');
});

test('network agent reads are deterministic, secret-safe, and side-effect free', async () => {
  const { store } = await fixture();
  const profile = createProfile(store, 'Opportunity Owner').profile;
  addPerson(store, 'person_opportunity', 'Opportunity Contact');
  recordNetworkContact(store, { profileId: profile.id, personId: 'person_opportunity', occurredAt: '2025-01-01T00:00:00.000Z', source: 'cli' });
  const args = { profileId: profile.id, asOf: new Date('2026-01-01T00:00:00.000Z'), limit: 10 };
  assert.deepEqual(networkOpportunitiesList(store, args), networkOpportunitiesList(store, args));
  const beforeBytes = Buffer.from(store.db.export());
  const beforeAudits = all(store, 'SELECT id FROM audit_log').length;
  await callDomainTool(store, 'network_opportunities_list', { profileId: profile.id, asOf: '2026-01-01T00:00:00.000Z' }, { source: 'mcp' });
  await callDomainTool(store, 'network_graph_query', { profileId: profile.id, maxHops: 2 }, { source: 'mcp' });
  await callDomainTool(store, 'network_health_brief', { profileId: profile.id, asOf: '2026-01-01T00:00:00.000Z' }, { source: 'mcp' });
  assert.equal(Buffer.compare(beforeBytes, Buffer.from(store.db.export())), 0);
  assert.equal(all(store, 'SELECT id FROM audit_log').length, beforeAudits);
});
