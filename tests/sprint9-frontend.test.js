import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandRegistry } from '../src/cli.js';

function makeRoot(prefix = 'jobos-sprint9-') {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

function cli(root, args, opts = {}) {
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_LLM_PROVIDER: '',
    JOBOS_LLM_MODEL: '',
    JOBOS_LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OLLAMA_API_KEY: '',
    ...(opts.env || {})
  };
  return spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
}

function parseJson(stdout) {
  return JSON.parse(stdout.trim());
}

test('command registry drives root, JSON, and per-command help metadata', () => {
  assert.ok(commandRegistry.length >= 35);
  for (const command of commandRegistry) {
    assert.ok(command.name);
    assert.ok(command.usage.startsWith('jobos '), command.name);
    assert.ok(command.summary.length > 10, command.name);
    assert.notEqual(command.json, undefined, command.name);
    assert.ok(command.output, command.name);
    assert.ok(Array.isArray(command.tests) && command.tests.length >= 1, command.name);

    const result = spawnSync(process.execPath, ['src/cli.js', ...command.path, '--help'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(result.status, 0, `${command.name}\n${result.stderr}`);
    assert.match(result.stdout, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const helpJson = spawnSync(process.execPath, ['src/cli.js', '--help', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(helpJson.status, 0);
  const registry = parseJson(helpJson.stdout);
  assert.equal(registry.exitCodes.usageError, 2);
  assert.equal(registry.commands.length, commandRegistry.length);
});

test('removed web command is absent and returns a usage error', () => {
  assert.equal(commandRegistry.some(item => item.name === 'web'), false);
  const result = cli(makeRoot(), ['web', '--json']);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
  assert.deepEqual(parseJson(result.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: 'Unknown command: web --json'
    }
  });
});

test('first successful command auto-creates workspace and preserves JSON stdout', () => {
  const root = makeRoot();
  const result = cli(root, ['jobs', 'list', '--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseJson(result.stdout), []);
  assert.match(result.stderr, /initialized workspace/);
  assert.ok(existsSync(path.join(root, '.jobos', 'jobos.sqlite')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'profiles')));
});

test('usage and runtime errors have stable exit codes and JSON stderr', () => {
  const usageRoot = makeRoot();
  const usage = cli(usageRoot, ['jobs', 'import-text', '--json']);
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, '');
  assert.deepEqual(parseJson(usage.stderr), {
    ok: false,
    error: {
      code: 'usage_error',
      type: 'usage',
      message: 'Missing --file <path>'
    }
  });

  const runtimeRoot = makeRoot();
  const runtime = cli(runtimeRoot, ['score', 'job_missing', '--profile', 'profile_missing', '--json']);
  assert.equal(runtime.status, 1);
  const error = parseJson(runtime.stderr);
  assert.equal(error.ok, false);
  assert.equal(error.error.type, 'runtime');
  assert.match(error.error.message, /Unknown job/);
});

test('loop and watch modes emit bounded JSONL events for agents', () => {
  const root = makeRoot();
  const loop = cli(root, ['loop', 'scheduler', '--max-iterations', '1', '--json']);
  assert.equal(loop.status, 0, loop.stderr);
  const loopLines = loop.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(loopLines.length, 1);
  assert.equal(loopLines[0].type, 'loop.iteration');
  assert.equal(loopLines[0].targetType, 'scheduler');
  assert.equal(loopLines[0].result.ok, true);

  const watch = cli(root, ['tasks', 'due', '--global', '--watch', '--max-iterations', '1', '--json']);
  assert.equal(watch.status, 0, watch.stderr);
  const watchLines = watch.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(watchLines.length, 1);
  assert.equal(watchLines[0].type, 'watch.iteration');
  assert.ok(Array.isArray(watchLines[0].result.tasks));
});

test('agent guide exposes command schemas and the blind-agent eval clears 90 percent', () => {
  const root = makeRoot();
  const guide = cli(root, ['agent-guide', '--json']);
  assert.equal(guide.status, 0, guide.stderr);
  const parsed = parseJson(guide.stdout);
  assert.ok(parsed.commands.some(command => command.name === 'loop scheduler'));
  assert.ok(parsed.commands.some(command => command.name === 'outreach draft'));

  const evalRun = spawnSync(process.execPath, ['run_eval.js'], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
  assert.equal(evalRun.status, 0, evalRun.stderr);
  const report = parseJson(evalRun.stdout);
  assert.equal(report.scenario, 'blind-agent-json-flow');
  assert.ok(report.score >= 90);
});

test('workspace paths tolerate spaces and Windows-like path characters', () => {
  const parent = makeRoot('jobos sprint9 parent ');
  const root = path.join(parent, 'C:\\Users\\Ada\\JobOS Workspace');
  const result = spawnSync(process.execPath, ['src/cli.js', '--workspace', root, 'jobs', 'list', '--json'], { cwd: process.cwd(), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseJson(result.stdout), []);
  assert.ok(existsSync(path.join(root, '.jobos', 'jobos.sqlite')));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'automations', 'automations.yaml')));
});
