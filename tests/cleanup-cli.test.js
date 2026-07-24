import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, run as dbRun, save } from '../src/db.js';
import { addWatchlist } from '../src/discovery.js';

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-cleanup-cli-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_API_KEY: '' };
  const cli = args => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args, '--json'], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { root, cli };
}

test('task CLI separates the inbox from due tasks and applies category filters', async () => {
  const { root, cli } = fixture();
  cli(['init']);
  const store = await openStore({ workspace: root });
  const rows = [
    ['due-review', 'review', 'system', '2026-07-20T09:00:00.000Z'],
    ['due-followup', 'followup', 'outreach', '2026-07-20T10:00:00.000Z'],
    ['future-followup', 'followup', 'outreach', '2999-07-20T10:00:00.000Z'],
    ['undated-review', 'review', 'system', null]
  ];
  for (const [id, type, createdBy, dueAt] of rows) {
    dbRun(store, 'INSERT INTO tasks (id,job_id,application_id,title,description,type,due_at,priority,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [id, null, null, id, '', type, dueAt, 'normal', 'open', createdBy, '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z']);
  }
  save(store);

  assert.deepEqual(cli(['tasks', 'due', '--type', 'followup']).map(task => task.id), ['due-followup']);
  assert.deepEqual(cli(['tasks', 'list', '--created-by', 'outreach']).map(task => task.id), ['due-followup', 'future-followup']);
});

test('watchlist alias creates a canonical search and legacy migration is explicit', async () => {
  const { root, cli } = fixture();
  const profile = cli(['profile', 'create', 'PM']);
  const alias = cli(['watchlist', 'add', '--profile', profile.id, '--company', 'Acme', '--adapter', 'greenhouse', '--board-token', 'acme']);
  assert.equal(alias.config.preset, 'company-watch');
  assert.equal(alias.deprecated, true);
  assert.ok(cli(['searches', 'list']).some(search => search.id === alias.id));

  const store = await openStore({ workspace: root });
  addWatchlist(store, { company: 'Legacy Co', adapter: 'lever', handle: 'legacy', notes: 'old row' });
  const migration = cli(['searches', 'migrate-watchlist', '--profile', profile.id]);
  assert.equal(migration.total, 1);
  assert.equal(migration.created, 1);
  const compatibility = cli(['watchlist', 'list']).filter(item => item.company === 'Legacy Co');
  assert.equal(compatibility.length, 1);
  assert.equal(compatibility[0].legacy, false);
});

test('agent registry distinguishes pursue dependencies from standalone and streaming commands', () => {
  const { cli } = fixture();
  const guide = cli(['agent-guide']);
  const pursue = guide.commands.find(command => command.name === 'pursue');
  const score = guide.commands.find(command => command.name === 'score');
  const loop = guide.commands.find(command => command.name === 'loop scheduler');
  assert.equal(pursue.runsDependencies, true);
  assert.equal(score.relatedWorkflow, 'pursue');
  assert.equal(score.runsDependencies, false);
  assert.equal(loop.category, 'agent-stream');
  assert.equal(loop.audience, 'agent');
});
