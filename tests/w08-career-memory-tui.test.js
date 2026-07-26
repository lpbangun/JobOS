import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { all, one, openStore, run, save } from '../src/db.js';
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

function seedProposal(store, profileId, suffix, status = 'proposed') {
  const proposalId = `memory_proposal_${suffix}`;
  run(store, `INSERT INTO career_memory_proposals (
    id,profile_id,domain,scope,rule_type,value_json,rule_key,conflict_key,
    rationale,confidence_milli,confidence_band,conflict_state,evidence_hash,
    evidence_fresh_until,created_at,actor,source,proposal_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
    proposalId, profileId, 'search', 'search', 'role_family',
    JSON.stringify({ match: 'exact', polarity: 'prefer', value: `${profileId} product` }),
    `rule-${suffix}`, `conflict-${suffix}`, `${profileId} visible rationale`,
    800, 'medium', 'none', `evidence-${suffix}`, '2027-01-20T12:00:00.000Z',
    '2026-07-24T12:00:00.000Z', 'fixture-user', 'cli', `proposal-${suffix}`,
  ]);
  run(store, `INSERT INTO career_memory_proposal_transitions (
    id,proposal_id,profile_id,sequence,from_status,to_status,reason,reference_id,
    actor,source,occurred_at,transition_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    `memory_transition_${suffix}_1`, proposalId, profileId, 1, null, 'proposed', '',
    `seed-${suffix}`, 'fixture-user', 'cli', '2026-07-24T12:00:00.000Z', `transition-${suffix}-1`,
  ]);
  if (status === 'accepted') {
    run(store, `INSERT INTO career_memory_proposal_transitions (
      id,proposal_id,profile_id,sequence,from_status,to_status,reason,reference_id,
      actor,source,occurred_at,transition_hash
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
      `memory_transition_${suffix}_2`, proposalId, profileId, 2, 'proposed', 'accepted', '',
      `accept-${suffix}`, 'fixture-user', 'cli', '2026-07-24T12:30:00.000Z', `transition-${suffix}-2`,
    ]);
  }
  return proposalId;
}

function makeTui(store, profileId) {
  const tui = new JobosTui(store, {
    ...streams(),
    profileId,
    connectAgent: false,
    color: false,
    now: () => new Date(AS_OF),
  });
  tui.refresh({ disk: false });
  return tui;
}

function transitions(store) {
  return all(store, `SELECT proposal_id AS proposalId,profile_id AS profileId,to_status AS toStatus,
    actor,source FROM career_memory_proposal_transitions ORDER BY rowid`);
}

test('W08-TUI-01 Career Memory model and four-view workspace are deterministic and profile-safe', async t => {
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

  const tui = makeTui(store, 'alpha');
  tui.onKeypress('m', { name: 'm' });
  assert.equal(tui.state.overlay, 'memory');
  for (const [key, view, heading] of [
    ['1', 'observations', 'OBSERVATIONS'],
    ['2', 'proposals', 'PROPOSALS'],
    ['3', 'career-brief', 'CAREER BRIEF'],
    ['4', 'voice-guide', 'VOICE GUIDE'],
  ]) {
    tui.onKeypress(key, { name: key });
    assert.equal(tui.state.memoryView, view);
    const screen = renderTui(tui.model, tui.state, { width: 120, height: 40, color: false });
    assert.match(screen, new RegExp(`CAREER MEMORY · ${heading}`));
    assert.doesNotMatch(screen, new RegExp(betaProposal));
    assert.equal(screen, renderTui(tui.model, tui.state, { width: 120, height: 40, color: false }));
  }

  tui.state.profileId = 'beta';
  tui.state.selectedJobId = null;
  tui.refresh({ disk: false });
  assert.equal(tui.model.memory.profileId, 'beta');
  assert.equal(tui.model.memory.proposals.some(item => item.id === betaProposal), true);
  assert.equal(tui.model.memory.proposals.some(item => item.id === alphaProposal), false);
});

test('W08-TUI-02 human-only memory actions are reachable from TUI commands, profile-bound, and inert in the agent pane', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const alphaProposal = seedProposal(store, 'alpha', 'human-action');
  const betaProposal = seedProposal(store, 'beta', 'cross-profile');
  save(store);
  const tui = makeTui(store, 'alpha');

  tui.executeCommand('memory');
  assert.equal(tui.state.overlay, 'memory');

  const beforeCrossProfile = transitions(store);
  tui.executeCommand(`memory reject ${betaProposal} | not mine`);
  assert.deepEqual(transitions(store), beforeCrossProfile);
  assert.match(tui.state.status, /failed|unknown/i);

  tui.executeCommand(`memory reject ${alphaProposal} | not representative`);
  const rejected = transitions(store).at(-1);
  const rejectedTransitionId = one(store, `SELECT id FROM career_memory_proposal_transitions
    WHERE proposal_id=? ORDER BY sequence DESC LIMIT 1`, [alphaProposal]).id;
  assert.deepEqual(rejected, {
    proposalId: alphaProposal,
    profileId: 'alpha',
    toStatus: 'rejected',
    actor: 'user',
    source: 'tui',
  });
  assert.match(tui.state.status, /rejected/i);

  const beforeAgent = transitions(store);
  let prompt = '';
  tui.client = {
    state: 'ready',
    prompt: async text => {
      prompt = text;
      return { stopReason: 'end_turn' };
    },
  };
  await tui.promptAgent(`:memory undo ${rejected.proposalId} | bypass human gate`);
  assert.match(prompt, /^:memory undo/);
  assert.deepEqual(transitions(store), beforeAgent, 'agent text must not dispatch trusted TUI memory commands');

  tui.executeCommand(`memory undo ${rejectedTransitionId} | restore proposal`);
  assert.equal(transitions(store).at(-1).toStatus, 'proposed');
  assert.equal(transitions(store).at(-1).source, 'tui');
});
