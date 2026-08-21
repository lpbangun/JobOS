import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { openStore, one, reload, run, save } from '../src/db.js';
import { createProfile, setNetworkIntent } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { upsertContactPoint } from '../src/research/contacts.js';
import { mcpToolNames } from '../src/mcp.js';
import { callDomainTool } from '../src/domain-tools.js';
import { JobosTui, renderTui } from '../src/tui.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTACT_VALUE = 'ada.sentinel@learning.co';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function contactWorkspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-contact-gates-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\nLead educator discovery and launch a learning platform.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  const { company_id: companyId } = one(store, 'SELECT company_id FROM jobs WHERE id=?', [job.id]);
  const at = '2026-07-20T10:00:00.000Z';
  run(store, `INSERT INTO person_candidates (id, job_id, company_id, name, role, relevance, confidence, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['cand_ada', job.id, companyId, 'Ada Lovelace', 'Engineering Manager', 'Likely hiring manager', 'high', 'candidate', at, at]);
  upsertContactPoint(store, { companyId, personId: 'cand_ada', type: 'email', value: CONTACT_VALUE, evidenceTier: 'A', verificationStatus: 'verified', confidence: 'high' });
  save(store);
  const contactId = one(store, 'SELECT id FROM contact_points WHERE company_id=?', [companyId]).id;
  return { root, store, profile, job, companyId, contactId };
}

function makeTui(store, profile, job) {
  const tui = new JobosTui(store, { ...streams(), profileId: profile.id, selectedJobId: job.id, connectAgent: false, color: false });
  tui.refresh();
  return tui;
}

function seedRelationship(store, profile, personId, name, at = '2026-07-01T00:00:00.000Z') {
  run(store, `INSERT INTO people (id,name,normalized_name,primary_profile_url,aliases_json,identity_confidence,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`, [personId, name, name.toLowerCase(), '', '[]', 'high', at, at]);
  run(store, `INSERT INTO relationship_edges
    (id,from_type,from_id,to_type,to_id,edge_type,evidence_json,confidence,created_at,last_contact_at,warmth)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [`edge_${personId}`, 'profile', profile.id, 'person', personId, 'direct_connection', '[{"label":"known alumni"}]', 'high', at, at, 'warm']);
  save(store);
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

test('GATE-01 the network overlay lists stored relationships and opportunities only', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  setNetworkIntent(store, { profileId: profile.id, intent: { version: 1, targetCompanies: [], allowedSources: { publicWeb: false } } });
  seedRelationship(store, profile, 'person_via', 'Alumni Via');
  const tui = makeTui(store, profile, job);
  tui.runSlash('network');
  assert.equal(tui.state.overlay, 'network');
  const screen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(screen, /NETWORK · PROFILE/, 'network overlay identity');
  assert.match(screen, /Intent · /, 'the intent line renders');
  assert.match(screen, /Alumni Via/, 'the stored relationship person is listed');
  assert.doesNotMatch(screen, new RegExp(CONTACT_VALUE.replace('.', '\\.')), 'contact values are never rendered');
  assert.doesNotMatch(screen, /Ada Lovelace/, 'unrelated candidates are not network people');
});

test('GATE-02 the network overlay never invents people on an empty graph', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.runSlash('network');
  const screen = renderTui(tui.model, tui.state, { width: 140, height: 42, color: false });
  assert.match(screen, /No stored relationships yet/, 'empty graph states the absence honestly');
  assert.doesNotMatch(screen, /Ada Lovelace|Alumni Via|Example Learning|Contoso/, 'no invented contacts or people');
});

test('GATE-03 the connection overlay records a human-confirmed contact locally', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  setNetworkIntent(store, { profileId: profile.id, intent: { version: 1, targetCompanies: [], allowedSources: { publicWeb: false } } });
  seedRelationship(store, profile, 'person_via', 'Alumni Via');
  const tui = makeTui(store, profile, job);
  tui.runSlash('network');
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'connection', 'Enter opens the connection overlay');
  tui.handleKey('r', { name: 'r' });
  assert.ok(tui.state.recordContactNote, 'record contact asks for a note');
  for (const char of 'met at the alumni mixer') tui.handleKey(char, { name: char });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 80));
  const edge = one(store, "SELECT last_contact_at FROM relationship_edges WHERE edge_type='direct_connection' AND from_type='profile' AND from_id=? AND to_id='person_via'", [profile.id]);
  assert.ok(edge?.last_contact_at, 'record contact updates the relationship edge timestamp');
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='network.contact.recorded'").n, 1);
  assert.match(tui.state.status, /Contact recorded locally · no external action was taken/);
  assert.equal(one(store, "SELECT external_side_effect FROM audit_log WHERE action='network.contact.recorded'").external_side_effect, 'none');
});

test('GATE-04 approve contact is a human/TUI gate with an audit trail', async t => {
  const { store, profile, job, contactId } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.state.jobTab = 'people';
  tui.handleKey('', { name: 'return' });
  assert.equal(tui.state.overlay, 'connection', 'Enter on a People row opens the connection overlay');
  tui.handleKey('a', { name: 'a' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(one(store, 'SELECT human_approved FROM contact_points WHERE id=?', [contactId]).human_approved, 1);
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='research.contact.approved'").n, 1);
  assert.match(tui.state.status, /contact approved for human-reviewed use/);
  // Agents cannot approve contacts.
  await assert.rejects(
    callDomainTool(store, 'approve_contact', { contactId }, { source: 'acp' }),
    error => error.code === 'agent_human_confirmation_denied',
    'ACP cannot approve contacts'
  );
});

test('GATE-05 keep/skip review suppresses a contact with a reason and hides its value', async t => {
  const { store, profile, job, contactId } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('people-review');
  const before = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.match(before, /Ada Lovelace/, 'the staged contact is listed for review');
  assert.doesNotMatch(before, new RegExp(CONTACT_VALUE.replace('.', '\\.')), 'contact values are never rendered');

  tui.handleKey('x', { name: 'x' });
  assert.ok(tui.state.peopleSkipReason, 'skip requires a suppression reason');
  for (const char of 'wrong person') tui.handleKey(char, { name: char.toLowerCase() });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(one(store, 'SELECT do_not_use FROM contact_points WHERE id=?', [contactId]).do_not_use, 1);
  assert.match(one(store, "SELECT payload_json FROM audit_log WHERE action='research.contact.suppressed'").payload_json, /wrong person/);
  assert.match(tui.state.status, /suppressed locally/);
  const after = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.doesNotMatch(after, new RegExp(CONTACT_VALUE.replace('.', '\\.')), 'suppressed value must leave the rendered surfaces');
  assert.doesNotMatch(tui.state.status, new RegExp(CONTACT_VALUE.replace('.', '\\.')));
});

test('GATE-06 keeping a candidate promotes it to a local stakeholder without outreach', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('people-review');
  const rows = tui.model.selected.candidates;
  assert.ok(rows.some(candidate => candidate.id === 'cand_ada'), 'the candidate is staged');
  // The contact row is first; move the cursor to the candidate row.
  tui.handleKey('', { name: 'downArrow' });
  tui.handleKey('k', { name: 'k' });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(one(store, "SELECT status FROM person_candidates WHERE id='cand_ada'").status, 'promoted');
  const stakeholder = one(store, "SELECT * FROM stakeholders WHERE name='Ada Lovelace'");
  assert.ok(stakeholder, 'stakeholder row created');
  assert.equal(stakeholder.outreach_status, 'not_contacted');
  assert.match(tui.state.status, /promoted to local stakeholder/);
});

test('GATE-07 profile find-people runs real local research and opens keep/skip', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  setNetworkIntent(store, { profileId: profile.id, intent: { version: 1, targetCompanies: [], allowedSources: { publicWeb: false } } });
  seedRelationship(store, profile, 'person_via', 'Alumni Via');
  const tui = makeTui(store, profile, job);
  tui.setHeaderMode('workspace');
  await tui.findPeopleProfile();
  assert.equal(tui.state.overlay, 'people-review', 'profile research lands in the keep/skip overlay');
  assert.match(tui.state.status, /keep or skip|derived from local relationships/);
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.match(screen, /Keep or skip|Inbox clear/, 'the review surface renders');
  assert.doesNotMatch(screen, /Example Learning|Contoso/, 'no invented contacts');
});

test('GATE-08 profile find-people without network intent fails honestly, staging nothing', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.setHeaderMode('workspace');
  await tui.findPeopleProfile();
  assert.notEqual(tui.state.overlay, 'people-review', 'no review overlay without intent');
  assert.match(tui.state.status, /completed network intent|Create a profile|No profile/, 'the precondition is surfaced honestly');
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM research_runs WHERE scope=?', ['profile']).n, 0, 'nothing was staged');
});

test('GATE-09 human-only contact tools stay out of the MCP catalog', async t => {
  const mcp = new Set(mcpToolNames());
  for (const tool of ['approve_contact', 'network_contact_record', 'mark_outreach_sent']) {
    assert.equal(mcp.has(tool), false, `${tool} must not be advertised to agents`);
  }
  for (const tool of ['find_person', 'network_opportunities_list', 'network_health_brief', 'map_reachable_network']) {
    assert.equal(mcp.has(tool), true, `${tool} must stay readable by agents`);
  }
});

test('CLI research contact commands approve, suppress, and promote', async t => {
  const { root, store, contactId } = await contactWorkspace(t);
  const promoted = cliOk(root, ['research', 'promote-stakeholder', '--candidate', 'cand_ada', '--json']);
  assert.equal(promoted.candidateId, 'cand_ada');
  assert.equal(promoted.outreachStatus || 'not_contacted', 'not_contacted');

  const byCandidate = cliOk(root, ['research', 'approve-contact', '--worksheet-candidate', 'cand_ada', '--json']);
  assert.deepEqual(byCandidate.approvedContacts, [contactId]);

  const suppressed = cliOk(root, ['research', 'suppress-contact', '--contact', contactId, '--reason', 'stale lead', '--json']);
  assert.equal(suppressed.doNotUse, true);

  const missing = cli(root, ['research', 'approve-contact', '--json']);
  assert.equal(missing.status, 2);
  assert.equal(missing.json?.error?.code, 'usage_error');

  reload(store); // CLI runs in a separate process/connection
  assert.equal(one(store, "SELECT status FROM person_candidates WHERE id='cand_ada'").status, 'promoted');
});
