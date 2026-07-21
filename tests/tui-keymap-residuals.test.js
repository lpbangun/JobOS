import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { openStore, all, one, run, save } from '../src/db.js';
import { createProfile, addProof } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { tailor } from '../src/tailoring.js';
import { addAnswer } from '../src/answers.js';
import { compileApplicationReadiness } from '../src/readiness.js';
import { readinessPacketSummary } from '../src/packets.js';
import {
  TUI_KEYMAP,
  TUI_HANDLED_KEYS,
  FILTERS,
  expandKeymapBinding,
  keypressForToken,
  JobosTui,
  renderTui,
  defaultTuiState
} from '../src/tui.js';
import { callDomainTool } from '../src/domain-tools.js';
import { createArtifact } from '../src/artifacts.js';
import { buildTuiModel } from '../src/tui-model.js';

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 140;
  stdout.rows = 42;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

async function seeded(t, { draft = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-keymap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = createProfile(store, 'PM EdTech').profile;
  addProof(store, profile.id, 'Led educator discovery and launched a learning platform that improved activation by 30%.', 'portfolio', ['product'], ['30%']);
  const file = path.join(root, 'job.md');
  writeFileSync(file, 'Title: Product Manager\nCompany: Learning Co\nLocation: Remote\n\nLead educator discovery and launch a learning platform.');
  const job = importText(store, { profileId: profile.id, filePath: file }).job;
  await callDomainTool(store, 'score_job', { jobId: job.id, profileId: profile.id }, { source: 'tui' });
  if (draft) await tailor(store, job.id, profile.id, 'resume');
  return { store, profile, job };
}

// Residual 3 — KEYMAP ⊆ handled keys
test('TUI_KEYMAP bindings expand into TUI_HANDLED_KEYS for every scope', () => {
  for (const [scope, entries] of Object.entries(TUI_KEYMAP)) {
    const handled = new Set(TUI_HANDLED_KEYS[scope] || []);
    assert.ok(handled.size, `scope ${scope} must declare handled keys`);
    for (const [binding] of entries) {
      const atoms = expandKeymapBinding(binding);
      assert.ok(atoms.length, `binding ${scope}:${binding} expands`);
      for (const token of atoms) {
        assert.ok(
          handled.has(token),
          `KEYMAP ${scope} advertises "${binding}" → "${token}" but TUI_HANDLED_KEYS.${scope} lacks it`
        );
      }
    }
  }
});

// Residual 4 — automated KEYMAP drill (PTY-equivalent, non-interactive)
test('advertised KEYMAP keys do not throw when pressed in their scope', async t => {
  const { store, profile, job } = await seeded(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });

  const fire = (token) => {
    const { value, key } = keypressForToken(token);
    assert.doesNotThrow(() => tui.onKeypress(value, key), `token ${token}`);
  };

  // Global (skip Q — exits)
  for (const token of TUI_HANDLED_KEYS.global) {
    if (token === 'Q') continue;
    if (token === ':') {
      fire(token);
      tui.state.mode = 'normal';
      tui.state.input = '';
      continue;
    }
    if (token === 'i') {
      fire(token);
      tui.state.mode = 'normal';
      tui.state.input = '';
      continue;
    }
    fire(token);
  }

  // Docs scope
  tui.openDocuments();
  assert.equal(tui.state.overlay, 'docs');
  for (const token of TUI_HANDLED_KEYS.docs) {
    if (token === 'escape') continue;
    if (token === 'A' || token === 'R' || token === 'X') {
      // open confirm/note then cancel
      fire(token);
      tui.state.mode = 'normal';
      tui.state.input = '';
      tui.state.pendingConfirm = null;
      continue;
    }
    if (token === '/') {
      fire(token);
      tui.state.mode = 'normal';
      tui.state.input = '';
      continue;
    }
    if (token === 'E') continue; // may spawn external editor
    fire(token);
  }
  fire('escape');

  // Discovery
  tui.openOverlay('discovery');
  for (const token of TUI_HANDLED_KEYS.discovery) {
    if (token === 'escape' || token === 'd') continue; // d runs network discovery
    fire(token);
  }
  fire('escape');

  // Review
  tui.openOverlay('review');
  for (const token of TUI_HANDLED_KEYS.review) {
    if (token === 'escape' || token === 'E') continue;
    if (token === 'A' || token === 'R') {
      fire(token);
      tui.state.mode = 'normal';
      tui.state.input = '';
      continue;
    }
    fire(token);
  }
  fire('escape');

  // Stage mode
  tui.state.mode = 'stage';
  tui.state.stageIndex = 0;
  for (const token of TUI_HANDLED_KEYS.stage) {
    if (token === 'escape' || token === 'return') continue;
    fire(token);
  }
  fire('escape');
});

// Residual 1 — reject surfaces redraft nextAction
test('reject surfaces CLI redraft nextAction when agent is offline', async t => {
  const { store, profile, job } = await seeded(t);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });
  tui.openDocuments();
  const doc = tui.selectedDocument();
  assert.ok(doc);

  tui.onKeypress('X', { name: 'x', shift: true });
  assert.equal(tui.state.mode, 'reject-note');
  for (const char of 'Needs proof') tui.onKeypress(char, { name: char.toLowerCase() });
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'reject-confirm');
  tui.onKeypress('y', { name: 'y' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.match(tui.state.status, /redraft next: jobos tailor resume --job /);
  assert.match(tui.state.status, new RegExp(job.id));
  assert.match(tui.state.status, new RegExp(profile.id));
  assert.doesNotMatch(tui.state.status, /redraft skipped because the agent is not ready/);
});

// Residual 2 — packet show (read-only)
test('command packet opens packet summary overlay advertising :packet create', async t => {
  const { store, profile, job } = await seeded(t, { draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });

  tui.executeCommand('packet');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(tui.state.overlay, 'packet');
  assert.equal(tui.state.packetDetail?.empty, true);
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /PACKET/);
  assert.match(screen, /No application packet|:packet create|apply packet create/i);
  assert.match(tui.state.status, /No packet|packet create/i);
});

test('packet overlay renders readiness packet fields when present', async t => {
  const { store, profile, job } = await seeded(t, { draft: false });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
  const state = {
    ...defaultTuiState(),
    profileId: profile.id,
    selectedJobId: job.id,
    overlay: 'packet',
    packetDetail: {
      id: 'pkt_test',
      currency: 'current',
      receiptState: 'none',
      attemptNumber: 1,
      revision: 1,
      contentHash: 'abc123def456',
      attestable: true,
      resumeArtifactId: 'artifact_x',
      applicationId: 'app_x'
    }
  };
  // inject fake readiness on model for title
  const screen = renderTui({ ...model, selected: model.selected }, state, { width: 120, height: 36, color: false });
  assert.match(screen, /pkt_test/);
  assert.match(screen, /currency current/);
  assert.match(screen, /receipt none/);
  assert.match(screen, /next submit externally, then :attest/);
});

// Wave 1 — packet CTA follows receiptState
test('packet overlay CTA follows currency/receiptState', async t => {
  const { store, profile, job } = await seeded(t, { draft: false });
  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id });
  const renderWith = detail => renderTui(
    { ...model, selected: model.selected },
    { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, overlay: 'packet', packetDetail: detail },
    { width: 120, height: 36, color: false }
  );
  assert.match(renderWith({ id: 'p1', currency: 'stale', receiptState: 'none' }), /next :packet create — freeze a packet/);
  assert.match(renderWith({ id: 'p1', currency: 'current', receiptState: 'none', attestable: true }), /next submit externally, then :attest/);
  assert.match(renderWith({ id: 'p1', currency: 'current', receiptState: 'attested' }), /next :receipt <external-reference>/);
  assert.match(renderWith({ id: 'p1', currency: 'current', receiptState: 'confirmed' }), /receipt confirmed · follow-ups only/);
});

async function driveToApproved(store, profile, job) {
  for (let round = 0; round < 3; round++) {
    const plan = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id });
    if (plan.status === 'approved') return plan;
    for (const q of plan.answers.questions) {
      if (q.status === 'unmatched') {
        addAnswer(store, { profileId: profile.id, category: q.category, question: q.question, answer: 'A verified response grounded in stored evidence.', sensitivity: 'public', verificationStatus: 'verified' });
      } else if (q.status === 'blocked') {
        addAnswer(store, { profileId: profile.id, category: q.category, question: q.question, answer: 'direct-response', sensitivity: 'restricted', reuseScope: 'never_auto_fill', sourceRef: `job:${job.id}`, verificationStatus: 'verified' });
      }
    }
    for (const artifactId of plan.review.pendingArtifactIds) {
      await callDomainTool(store, 'approve_artifact', { artifactId }, { source: 'tui' });
    }
  }
  const plan = compileApplicationReadiness(store, { jobId: job.id, profileId: profile.id });
  assert.equal(plan.status, 'approved', `expected approved, got ${plan.status}: ${plan.blockers.map(b => b.code).join(',')}`);
  return plan;
}

// Wave 1 — full apply loop inside the TUI
test('packet create/attest/receipt commands run the apply loop inside the TUI', async t => {
  const { store, profile, job } = await seeded(t);
  await driveToApproved(store, profile, job);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });
  const tick = (ms = 100) => new Promise(resolve => setTimeout(resolve, ms));
  const summary = () => readinessPacketSummary(store, { jobId: job.id, profileId: profile.id });

  // Open the overlay, then freeze without leaving the shell
  tui.executeCommand('packet');
  await tick(40);
  assert.equal(tui.state.overlay, 'packet');
  tui.executeCommand('packet create');
  await tick();
  assert.ok(summary().currentPacketId, 'packet should be frozen from the TUI');
  assert.equal(tui.state.overlay, 'packet', 'overlay stays open and refreshes');
  assert.match(tui.state.status, /packet frozen · next: submit externally, then :attest/);
  let screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /next submit externally, then :attest/);

  // Invalid RFC3339 is rejected without mutating
  tui.executeCommand('attest not-a-date');
  await tick();
  assert.match(tui.state.status, /packet attest failed/);
  assert.equal(summary().receiptState, 'none');

  // Attest submission
  tui.executeCommand('attest 2026-07-21T10:00:00Z');
  await tick();
  assert.equal(summary().receiptState, 'attested');
  assert.match(tui.state.status, /submission attested at 2026-07-21T10:00:00Z · next: :receipt/);
  screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /next :receipt <external-reference>/);

  // Receipt requires a reference
  tui.executeCommand('receipt');
  await tick(40);
  assert.match(tui.state.status, /Usage: :receipt <external-reference>/);

  // Confirm receipt (multi-word reference preserved)
  tui.executeCommand('receipt EXT-REF-42 portal confirmation');
  await tick();
  assert.equal(summary().receiptState, 'confirmed');
  assert.match(tui.state.status, /receipt confirmed \(EXT-REF-42 portal confirmation\) · application loop complete locally/);
  screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  assert.match(screen, /receipt confirmed · follow-ups only/);

  // Mutations were recorded as trusted human/TUI source, never agent
  const sources = all(store, 'SELECT DISTINCT source FROM application_receipts').map(row => row.source);
  assert.deepEqual(sources, ['tui']);
});

// Wave 1 — freeze refuses unapproved readiness
test('packet create from TUI refuses when readiness is not approved', async t => {
  const { store, profile, job } = await seeded(t); // draft exists but is unapproved
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });

  tui.executeCommand('packet create');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.match(tui.state.status, /packet create failed/);
  assert.equal(readinessPacketSummary(store, { jobId: job.id, profileId: profile.id }).currentPacketId, null,
    'no packet may be frozen before approval');
});

// Gap #3 — every painted filter is reachable by a number key
test('number keys select every painted filter in header order', async t => {
  const { store, profile, job } = await seeded(t, { draft: false });
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.state.selectedJobId = job.id;
  tui.refresh({ disk: false });

  FILTERS.forEach((name, index) => {
    const key = String(index + 1);
    tui.onKeypress(key, { name: key });
    assert.equal(tui.state.filter, name, `key ${key} must select painted filter "${name}"`);
  });

  // Header paints exactly FILTERS; no advertised filter lacks a key
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  for (const name of FILTERS) assert.ok(screen.includes(name), `filter "${name}" painted in header`);
});

// Gap #4 — discovery Enter opens the highlighted job in the main list
test('discovery Enter saves the highlighted job and selects it in the main list', async t => {
  const { store, profile, job } = await seeded(t, { draft: false });
  run(store, "UPDATE jobs SET status='new' WHERE id=?", [job.id]);
  save(store);
  const io = streams();
  const tui = new JobosTui(store, { ...io, profileId: profile.id, connectAgent: false, color: false });
  tui.refresh({ disk: false });

  tui.openOverlay('discovery');
  assert.equal(tui.state.overlay, 'discovery');
  assert.equal(tui.state.selectedDiscoveryJobId, job.id, 'queue highlights the new job');

  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, null, 'overlay closes');
  assert.equal(one(store, 'SELECT status FROM jobs WHERE id=?', [job.id]).status, 'saved', 'job saved into the main list');
  assert.equal(tui.model.selected?.job.id, job.id, 'main selection follows the opened job');
  assert.match(tui.state.status, /saved · now selected in the main list/);
});
