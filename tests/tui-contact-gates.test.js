import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { openStore, one, reload, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { upsertContactPoint } from '../src/research/contacts.js';
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
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });
  return tui;
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

// Gap #5 — discovered contacts/candidates are listed with human-gate hints
test('network overlay lists discovered contacts and candidates with human-gate hints', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('network');
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.match(screen, /Contacts & candidates · human gates \(2\)/);
  assert.match(screen, /\[contact\] Ada Lovelace/);
  assert.match(screen, new RegExp(CONTACT_VALUE.replace('.', '\\.')));
  assert.match(screen, /\[candidate\] Ada Lovelace · Engineering Manager · candidate/);
  assert.match(screen, /j\/k select · m map · A approve · X suppress · P promote · Esc close/);
});

// Gap #5 — approve contact (human/TUI source, audited)
test('A approves the highlighted contact as a human/TUI gate', async t => {
  const { store, profile, job, contactId } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('network');
  tui.onKeypress('A', { name: 'a', shift: true });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(one(store, 'SELECT human_approved FROM contact_points WHERE id=?', [contactId]).human_approved, 1);
  assert.match(tui.state.status, /Contact approved/);
  assert.match(tui.state.status, /JobOS sends nothing/);
  assert.equal(one(store, "SELECT COUNT(*) AS n FROM audit_log WHERE action='research.contact.approved'").n, 1);
});

// Gap #5 — suppress contact with reason; suppressed value disappears from rendered surfaces
test('X suppresses the highlighted contact with a reason and hides its value', async t => {
  const { store, profile, job, contactId } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('network');
  tui.onKeypress('X', { name: 'x', shift: true });
  assert.equal(tui.state.mode, 'suppress-reason');
  for (const char of 'wrong person') tui.onKeypress(char, { name: char.toLowerCase() });
  tui.onKeypress('', { name: 'return' });
  assert.equal(one(store, 'SELECT do_not_use FROM contact_points WHERE id=?', [contactId]).do_not_use, 1);
  assert.match(one(store, "SELECT payload_json FROM audit_log WHERE action='research.contact.suppressed'").payload_json, /wrong person/);
  assert.match(tui.state.status, /suppressed locally/);
  const screen = renderTui(tui.model, tui.state, { width: 130, height: 42, color: false });
  assert.doesNotMatch(screen, new RegExp(CONTACT_VALUE.replace('.', '\\.')), 'suppressed value must leave the rendered overlay');
  assert.doesNotMatch(tui.state.status, new RegExp(CONTACT_VALUE.replace('.', '\\.')));
  assert.match(screen, /suppressed/);
});

// Gap #5 — promote candidate → stakeholder, outreach stays not_contacted
test('P promotes the highlighted candidate to a stakeholder without outreach', async t => {
  const { store, profile, job } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('network');
  tui.onKeypress('j', { name: 'j' }); // contact row → candidate row
  tui.onKeypress('P', { name: 'p', shift: true });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(one(store, "SELECT status FROM person_candidates WHERE id='cand_ada'").status, 'promoted');
  const stakeholder = one(store, "SELECT * FROM stakeholders WHERE name='Ada Lovelace'");
  assert.ok(stakeholder, 'stakeholder row created');
  assert.equal(stakeholder.outreach_status, 'not_contacted');
  assert.match(tui.state.status, /promoted → stakeholder/);
  assert.match(tui.state.status, /nothing was sent/);
});

// Gap #5 — row-kind mismatches explain themselves and mutate nothing
test('gate keys explain row-kind mismatches without mutating', async t => {
  const { store, profile, job, contactId } = await contactWorkspace(t);
  const tui = makeTui(store, profile, job);
  tui.openOverlay('network');
  tui.onKeypress('P', { name: 'p', shift: true }); // on the contact row
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(tui.state.status, /P promotes a candidate row/);
  tui.onKeypress('j', { name: 'j' });
  tui.onKeypress('A', { name: 'a', shift: true }); // on the candidate row
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.match(tui.state.status, /A approves a contact row/);
  assert.equal(one(store, 'SELECT human_approved FROM contact_points WHERE id=?', [contactId]).human_approved, 0);
  assert.equal(one(store, 'SELECT COUNT(*) AS n FROM stakeholders').n, 0);
});

// Gap #5 — the registered-but-dead CLI commands now dispatch
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
