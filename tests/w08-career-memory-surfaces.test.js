import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { one, openStore } from '../src/db.js';
import { callDomainTool, DOMAIN_TOOLS } from '../src/domain-tools.js';
import { mcpToolNames } from '../src/mcp.js';

const FIXTURE = path.join(import.meta.dirname, 'fixtures', 'w08-schema14.sqlite');
const HUMAN_TOOLS = [
  'record_job_feedback', 'correct_memory_observation', 'undo_memory_observation',
  'accept_memory_proposal', 'reject_memory_proposal', 'revoke_memory_proposal',
  'undo_memory_transition',
];
const READ_PROPOSE_TOOLS = [
  'list_memory_observations', 'list_memory_proposals', 'get_career_brief',
  'get_voice_positioning_guide', 'retrieve_career_memory',
  'derive_memory_proposals', 'create_memory_proposal',
];

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-w08-surfaces-'));
  mkdirSync(path.join(root, '.jobos'), { recursive: true });
  copyFileSync(FIXTURE, path.join(root, '.jobos', 'jobos.sqlite'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function counts(store) {
  return {
    observations: one(store, 'SELECT COUNT(*) AS count FROM career_memory_observations').count,
    proposals: one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposals').count,
    transitions: one(store, 'SELECT COUNT(*) AS count FROM career_memory_proposal_transitions').count,
    audit: one(store, 'SELECT COUNT(*) AS count FROM audit_log').count,
  };
}

function assertDenied(error, tool, source) {
  assert.equal(error.code, 'human_memory_input_required');
  assert.equal(error.type, 'domain_tool_error');
  assert.deepEqual(error.details, { tool, source, status: null, externalSideEffect: 'none' });
  return true;
}

test('W08-POLICY-01..03 catalogs read/propose tools, hides human mutations from MCP, and enforces unspoofable ACP/MCP denial', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const names = DOMAIN_TOOLS.map(tool => tool.name);
  for (const name of [...READ_PROPOSE_TOOLS, ...HUMAN_TOOLS]) assert.ok(names.includes(name), name);
  for (const name of HUMAN_TOOLS) assert.equal(mcpToolNames().includes(name), false, name);
  assert.ok(mcpToolNames().includes('create_memory_proposal'));

  for (const source of ['mcp', 'acp']) {
    for (const tool of HUMAN_TOOLS) {
      await assert.rejects(
        callDomainTool(store, tool, {
          profileId: 'alpha', actor: 'user', source: 'cli', proposalId: 'spoof',
          observationId: 'spoof', transitionId: 'spoof', referenceId: 'spoof', reason: 'spoof',
        }, { source, allowExternalAttestation: true }),
        error => assertDenied(error, tool, source),
      );
    }
    for (const proposal of [
      { scope: 'writing_global', ruleType: 'tone' },
      { scope: 'resume', ruleType: 'approved_exemplar' },
    ]) {
      await assert.rejects(
        callDomainTool(store, 'create_memory_proposal', {
          profileId: 'alpha', proposal: { ...proposal, actor: 'user', source: 'cli' },
        }, { source, allowExternalAttestation: true }),
        error => assertDenied(error, 'create_memory_proposal', source),
      );
    }
  }
  store.db.close();
});

test('W08-DOMAIN-01 validate-only returns typed JSON and writes no workspace state', async t => {
  const store = await openStore({ workspace: workspace(t) });
  const before = counts(store);
  const job = one(store, "SELECT id,title FROM jobs WHERE profile_id='alpha' AND status='saved' ORDER BY id LIMIT 1");
  const valid = await callDomainTool(store, 'record_job_feedback', {
    profileId: 'alpha', jobId: job.id, validateOnly: true,
    feedback: {
      schema: 'jobos.job-feedback-input.v1', decision: 'save', reasonCodes: ['role_fit'],
      signals: [{ field: 'role_family', polarity: 'prefer', value: job.title, match: 'exact' }],
      publicExplanation: '', privateNote: 'must remain isolated', referenceId: 'surface-feedback-validation',
      occurredAt: '2026-07-25T12:00:00.000Z',
    },
  }, { source: 'cli' });
  assert.equal(valid.schema, 'jobos.career-memory-validation.v1');
  assert.equal(valid.valid, true);
  assert.equal(valid.wouldWrite, false);
  assert.equal(valid.normalizedPublicPayload.privateNote, undefined);
  assert.deepEqual(counts(store), before);

  const result = await callDomainTool(store, 'create_memory_proposal', {
    profileId: 'alpha',
    validateOnly: true,
    proposal: {
      schema: 'jobos.memory-proposal-input.v1', domain: 'search', scope: 'search',
      ruleType: 'role_family', value: { polarity: 'prefer', value: 'product manager', match: 'exact' },
      rationale: 'Visible reviewable preference.',
      evidence: [{ observationSchema: 'jobos.interview-observation.v1', observationId: 'missing', polarity: 'support' }],
      referenceId: 'surface-validation', createdAt: '2026-07-25T12:00:00.000Z',
    },
  }, { source: 'cli' }).catch(error => error);
  assert.equal(result.code, 'memory_evidence_unknown');
  assert.deepEqual(counts(store), before);
  store.db.close();
});

test('W08-CLI-01 exposes frozen grammar and emits typed JSON errors', t => {
  const root = workspace(t);
  const help = spawnSync(process.execPath, ['src/cli.js', 'help', '--all', '--json'], {
    cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, JOBOS_HOME: root }, encoding: 'utf8',
  });
  assert.equal(help.status, 0, help.stderr);
  const names = JSON.parse(help.stdout).commands.map(command => command.name);
  for (const name of ['feedback job', 'feedback observations', 'preferences proposals', 'preferences propose', 'preferences derive', 'preferences accept', 'preferences reject', 'preferences revoke', 'preferences undo', 'profile brief', 'profile voice-guide', 'memory retrieve']) assert.ok(names.includes(name), name);

  const file = path.join(root, 'invalid-proposal.json');
  writeFileSync(file, JSON.stringify({ schema: 'wrong' }));
  const invalid = spawnSync(process.execPath, ['src/cli.js', 'preferences', 'propose', '--profile', 'alpha', '--file', file, '--validate-only', '--json'], {
    cwd: path.join(import.meta.dirname, '..'), env: { ...process.env, JOBOS_HOME: root }, encoding: 'utf8',
  });
  assert.equal(invalid.status, 1);
  const body = JSON.parse(invalid.stderr);
  assert.equal(body.ok, false);
  assert.match(body.error.code, /^memory_/);
});
