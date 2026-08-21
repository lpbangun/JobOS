import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { all, guardedWrite, one, openStore, run, save } from '../src/db.js';
import { callDomainTool } from '../src/domain-tools.js';
import { updateJobStatus } from '../src/jobs.js';
import { recordJobFeedback } from '../src/career-memory-observations.js';
import { createMemoryProposal, transitionMemoryProposal } from '../src/career-memory-proposals.js';
import { mcpToolNames } from '../src/mcp.js';
import { buildTuiModel } from '../src/tui-model.js';
import { JobosTui, renderTui } from '../src/tui.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const AS_OF = '2026-07-25T12:00:00.000Z';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-tui-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

// Seed a genuinely eligible proposal through the real observation + proposal
// APIs (job feedback -> observations -> createMemoryProposal), so accept can
// validate real evidence, gates, and hashes instead of a hand-written row.
function seedProposal(store, profileId, suffix, status = 'proposed') {
  const value = `${profileId}-${suffix}`;
  const baseJob = one(store, 'SELECT * FROM jobs WHERE profile_id=? AND status=? ORDER BY id LIMIT 1', [profileId, 'saved']);
  assert.ok(baseJob, `the schema-14 fixture has a saved job for ${profileId}`);
  const observations = [];
  for (let index = 0; index < 3; index += 1) {
    const row = {
      ...baseJob,
      id: `job_tui_${profileId}_${suffix}_${index}`,
      url: `jobos:test:${profileId}:${suffix}:${index}`,
      description: `${baseJob.description}\n${value}`,
      status: 'new',
      dedupe_key: `tui-${profileId}-${suffix}-${index}`,
    };
    const columns = Object.keys(row);
    guardedWrite(store, () => run(store, `INSERT INTO jobs (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, columns.map(column => row[column])));
    updateJobStatus(store, row.id, 'saved');
    observations.push(recordJobFeedback(store, {
      profileId,
      jobId: row.id,
      input: {
        schema: 'jobos.job-feedback-input.v1',
        decision: 'save',
        reasonCodes: ['role_fit'],
        signals: [{ field: 'mission', polarity: 'prefer', value, match: 'token' }],
        publicExplanation: '',
        privateNote: '',
        referenceId: `tui-obs-${profileId}-${suffix}-${index}`,
        occurredAt: `2026-07-${20 + index}T12:00:00.000Z`,
      },
      actor: 'user',
      source: 'cli',
    }));
  }
  const proposal = createMemoryProposal(store, {
    schema: 'jobos.memory-proposal-input.v1',
    domain: 'search',
    scope: 'search',
    ruleType: 'mission',
    value: { polarity: 'prefer', value, match: 'token' },
    rationale: 'Repeated direct search feedback supports guidance.',
    evidence: observations.map(item => ({ observationSchema: 'jobos.career-memory-observation.v1', observationId: item.id, polarity: 'support' })),
    referenceId: `tui-proposal-${profileId}-${suffix}`,
    createdAt: AS_OF,
  });
  if (status === 'accepted') {
    // The seed accept is a CLI action (fixture setup); the TUI actions below
    // must record their own actor/source on transition.
    transitionMemoryProposal(store, {
      profileId,
      proposalId: proposal.id,
      action: 'accept',
      reason: '',
      referenceId: `tui-seed-accept-${profileId}-${suffix}`,
      actor: 'user',
      source: 'cli',
      nowDate: new Date(AS_OF),
    });
  }
  return proposal.id;
}

function makeTui(store, profileId) {
  const tui = new JobosTui(store, {
    ...streams(),
    profileId,
    connectAgent: false,
    color: false
  });
  tui.refresh();
  return tui;
}

function transitions(store) {
  return all(store, `SELECT proposal_id AS proposalId,profile_id AS profileId,to_status AS toStatus,
    actor,source FROM career_memory_proposal_transitions ORDER BY rowid`);
}

test('W08-TUI-01 Career Memory projection is deterministic, profile-safe, and private', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const alphaProposal = seedProposal(store, 'alpha', 'alpha');
  const betaProposal = seedProposal(store, 'beta', 'beta');
  save(store);

  const first = buildTuiModel(store, { profileId: 'alpha', at: AS_OF });
  const second = buildTuiModel(store, { profileId: 'alpha', at: AS_OF });
  assert.deepEqual(first.memory, second.memory);
  assert.equal(first.memory.profileId, 'alpha');
  assert.equal(first.memory.proposals.some(item => item.id === alphaProposal), true);
  assert.equal(first.memory.proposals.some(item => item.id === betaProposal), false);
  assert.equal(first.memory.observations.every(item => item.profileId === 'alpha'), true);
  assert.equal(first.memory.careerBrief.profileId, 'alpha');
  assert.equal(first.memory.voiceGuide.profileId, 'alpha');
  assert.equal(JSON.stringify(first.memory).includes('privateNote'), false);
});

test('W08-TUI-01b the memory overlay renders real proposals and never leaks another profile', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const alphaProposal = seedProposal(store, 'alpha', 'alpha');
  const betaProposal = seedProposal(store, 'beta', 'beta');
  save(store);
  const tui = makeTui(store, 'alpha');
  tui.runSlash('memory');
  assert.equal(tui.state.overlay, 'memory');
  const screen = renderTui(tui.model, tui.state, { width: 120, height: 40, color: false });
  assert.match(screen, /CAREER MEMORY/, 'memory overlay identity');
  assert.match(screen, new RegExp(alphaProposal), 'the alpha proposal is listed');
  assert.doesNotMatch(screen, new RegExp(betaProposal), 'the beta proposal never leaks into the alpha profile');
  assert.doesNotMatch(screen, /privateNote/, 'private notes never render');
  assert.equal(screen, renderTui(tui.model, tui.state, { width: 120, height: 40, color: false }), 'memory overlay rendering is deterministic');
});

test('W08-TUI-02 accept/reject/revoke transitions are human TUI actions with persisted state', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const acceptId = seedProposal(store, 'alpha', 'accept');
  const rejectId = seedProposal(store, 'alpha', 'reject');
  const revokeId = seedProposal(store, 'alpha', 'revoke', 'accepted');
  save(store);
  const tui = makeTui(store, 'alpha');
  tui.runSlash('memory');

  // Accept is immediate and requires a proposed proposal.
  const acceptIndex = tui.model.memory.proposals.findIndex(item => item.id === acceptId);
  tui.state.overlayIndex = acceptIndex;
  tui.handleKey('a', { name: 'a' });
  await new Promise(resolve => setTimeout(resolve, 60));
  const accepted = transitions(store).at(-1);
  assert.deepEqual(accepted, {
    proposalId: acceptId,
    profileId: 'alpha',
    toStatus: 'accepted',
    actor: 'user',
    source: 'tui',
  });

  // Reject requires a typed reason.
  const rejectIndex = tui.model.memory.proposals.findIndex(item => item.id === rejectId);
  tui.state.overlayIndex = rejectIndex;
  tui.handleKey('r', { name: 'r' });
  assert.ok(tui.state.memoryReason, 'reject asks for a reason');
  tui.handleKey('', { name: 'return' });
  assert.ok(tui.state.memoryReason, 'an empty reason keeps the editor open');
  assert.match(tui.state.status, /reason is required/);
  for (const char of 'not representative') tui.handleKey(char, { name: char });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 60));
  const rejected = transitions(store).at(-1);
  assert.deepEqual(rejected, {
    proposalId: rejectId,
    profileId: 'alpha',
    toStatus: 'rejected',
    actor: 'user',
    source: 'tui',
  });
  assert.equal(one(store, "SELECT reason FROM career_memory_proposal_transitions WHERE proposal_id=? AND to_status='rejected'", [rejectId]).reason, 'not representative');

  // Revoke applies to accepted proposals only and lands in the frozen
  // 'revoked' terminal status.
  const revokeIndex = tui.model.memory.proposals.findIndex(item => item.id === revokeId);
  tui.state.overlayIndex = revokeIndex;
  tui.handleKey('v', { name: 'v' });
  for (const char of 'no longer accurate') tui.handleKey(char, { name: char });
  tui.handleKey('', { name: 'return' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(transitions(store).at(-1).toStatus, 'revoked', 'revoke moves the accepted proposal to revoked');
  assert.equal(transitions(store).at(-1).source, 'tui');
});

test('W08-TUI-02b memory actions are profile-bound and cross-profile targets are refused', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const alphaProposal = seedProposal(store, 'alpha', 'owned');
  const betaProposal = seedProposal(store, 'beta', 'other');
  save(store);
  const tui = makeTui(store, 'alpha');
  tui.runSlash('memory');
  const before = transitions(store);
  const betaIndex = tui.model.memory.proposals.findIndex(item => item.id === betaProposal);
  assert.equal(betaIndex, -1, 'the beta proposal is not visible to the alpha profile');
  // Attempt a direct transition on the beta proposal through the trusted gate.
  await tui.transitionProposal(betaProposal, 'reject', 'not mine');
  assert.deepEqual(transitions(store), before, 'cross-profile transitions write nothing');
  assert.ok(tui.state.error, 'the refusal is surfaced as an error');
  assert.ok(tui.model.memory.proposals.some(item => item.id === alphaProposal));
});

test('W08-TUI-03 memory lifecycle mutations stay human-only and out of the agent catalog', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const proposalId = seedProposal(store, 'alpha', 'gated');
  save(store);
  const mcp = new Set(mcpToolNames());
  for (const tool of ['accept_memory_proposal', 'reject_memory_proposal', 'revoke_memory_proposal', 'undo_memory_transition']) {
    assert.equal(mcp.has(tool), false, `${tool} must not be advertised to agents`);
  }
  await assert.rejects(
    callDomainTool(store, 'accept_memory_proposal', { profileId: 'alpha', proposalId, referenceId: 'acp-attempt', reason: '' }, { source: 'acp' }),
    error => error.code === 'human_memory_input_required',
    'ACP cannot transition memory'
  );
  await assert.rejects(
    callDomainTool(store, 'reject_memory_proposal', { profileId: 'alpha', proposalId, referenceId: 'mcp-attempt', reason: 'x' }, { source: 'mcp' }),
    error => error.code === 'human_memory_input_required',
    'MCP cannot transition memory'
  );
  const ok = await callDomainTool(store, 'accept_memory_proposal', { profileId: 'alpha', proposalId, referenceId: 'tui-attempt', reason: '' }, { source: 'tui' });
  assert.ok(ok, 'the trusted TUI source can transition memory');
});
