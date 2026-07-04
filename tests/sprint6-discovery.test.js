import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { greenhouse, lever } from '../src/discovery/adapters.js';
import { all, openStore } from '../src/db.js';
import { mcpToolNames } from '../src/mcp.js';

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-sprint6-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout.trim();
  };
  return { root, run };
}

test('Greenhouse and Lever adapters normalize fixture-style API responses with injected fetch', async () => {
  const greenhousePayload = JSON.parse(readFileSync(path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json'), 'utf8'));
  const leverPayload = JSON.parse(readFileSync(path.join(process.cwd(), 'tests', 'fixtures-lever.json'), 'utf8'));
  const fakeFetch = async (url, opts) => {
    assert.match(opts.headers['user-agent'], /JobOS local discovery/);
    return { ok: true, json: async () => url.includes('greenhouse') ? greenhousePayload : leverPayload };
  };
  const gh = await greenhouse.fetchJobs({ boardToken: 'acme', company: 'Acme Learning', keywords: ['Product'], location: 'Remote' }, { fetch: fakeFetch, delayMs: 0 });
  assert.equal(gh.length, 1);
  assert.deepEqual({ title: gh[0].title, company: gh[0].company, location: gh[0].location, source: gh[0].source }, { title: 'Product Manager, Learning Platform', company: 'Acme Learning', location: 'Remote', source: 'greenhouse' });
  assert.match(gh[0].description, /educator discovery/);

  const lv = await lever.fetchJobs({ company: 'Pathway Labs', keywords: ['learning'] }, { fetch: fakeFetch, delayMs: 0 });
  assert.equal(lv.length, 1);
  assert.equal(lv[0].source, 'lever');
  assert.match(lv[0].url, /jobs\.lever\.co/);
  assert.match(lv[0].description, /Lead discovery/);
});

test('saved search discovery run imports, scores, dedupes, flags high fit, writes AutomationRun and workspace files', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.\n- Shipped activation experiments for adult learning products with design and engineering partners.\n- Managed stakeholder tradeoffs across operations, product, and research teams for a learning platform launch.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  const fixture = path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json');
  const search = JSON.parse(run(['searches', 'create', 'Acme Discovery', '--profile', profile.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', fixture, '--keywords', 'Product,Learning', '--location', 'Remote', '--min-fit', '50', '--json']));
  assert.equal(search.adapter, 'greenhouse');
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'searches', `${search.id}.yaml`)));
  const watch = JSON.parse(run(['watchlist', 'add', '--company', 'Acme Learning', '--adapter', 'greenhouse', '--board-token', 'acme', '--notes', 'Target company', '--json']));
  assert.equal(watch.handle, 'acme');
  assert.ok(JSON.parse(run(['watchlist', 'list', '--json'])).some(x => x.id === watch.id));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'watchlist', `${watch.id}.yaml`)));

  const first = JSON.parse(run(['discover', 'run', '--search', 'Acme Discovery', '--json']));
  assert.equal(first.status, 'succeeded');
  assert.equal(first.counts.fetched, 1);
  assert.equal(first.counts.imported, 1);
  assert.equal(first.counts.highFit, 1);
  assert.equal(first.jobs[0].created, true);

  const second = JSON.parse(run(['discover', 'run', '--search', 'Acme Discovery', '--json']));
  assert.equal(second.status, 'succeeded');
  assert.equal(second.counts.imported, 0);
  assert.equal(second.counts.deduped, 1);
  assert.equal(second.jobs[0].created, false);
  const allRuns = JSON.parse(run(['discover', 'run-all', '--json']));
  assert.equal(allRuns.count, 1);
  assert.equal(allRuns.runs[0].counts.deduped, 1);

  const jobs = JSON.parse(run(['jobs', 'list', '--json']));
  assert.equal(jobs.length, 1);
  const store = await openStore({ workspace: root });
  const dbJobs = all(store, 'SELECT * FROM jobs');
  assert.equal(dbJobs[0].status, 'new');
  assert.equal(dbJobs[0].high_fit, 1);
  assert.equal(dbJobs[0].posted_date, '2026-07-01T12:00:00Z');
  assert.match(dbJobs[0].source_history_json, /greenhouse/);
  const runs = all(store, "SELECT * FROM automation_runs WHERE trigger_name='discover.run'");
  assert.equal(runs.length, 3);
  assert.equal(JSON.parse(runs[0].outputs_json).counts.fetched, 1);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'discovery', 'runs', `${first.runId}.yaml`)));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', first.jobs[0].id, 'job.yaml')));
  assert.match(readFileSync(path.join(root, 'jobos-workspace', 'jobs', first.jobs[0].id, 'job.yaml'), 'utf8'), /highFit: true/);
});

test('discovery fetch failure records a failed run without crashing the CLI', () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  run(['searches', 'create', 'Offline Search', '--profile', profile.id, '--adapter', 'greenhouse', '--board-token', 'acme', '--fixture', path.join(root, 'missing-fixture.json'), '--json']);
  const result = JSON.parse(run(['discover', 'run', '--search', 'Offline Search', '--json']));
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.length >= 1);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'discovery', 'runs', `${result.runId}.yaml`)));
});

test('API discovery routes and MCP discovery tools are exposed', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  const port = 4700 + Math.floor(Math.random() * 500);
  const server = spawn(process.execPath, ['src/cli.js', 'web', '--port', String(port)], { cwd: process.cwd(), env: { ...process.env, JOBOS_HOME: root }, encoding: 'utf8' });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('web server did not start')), 5000);
    server.stdout.on('data', data => { if (String(data).includes('JobOS dashboard running')) { clearTimeout(timeout); resolve(); } });
    server.stderr.on('data', data => reject(new Error(String(data))));
  });
  try {
    const fixture = path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json');
    const created = await fetch(`http://127.0.0.1:${port}/api/searches`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API Discovery', profileId: profile.id, adapter: 'greenhouse', minFit: 50, config: { fixture, company: 'Acme Learning', keywords: ['Product'], location: 'Remote' } }) }).then(r => r.json());
    assert.match(created.id, /^search_/);
    const apiSearches = await fetch(`http://127.0.0.1:${port}/api/searches`).then(r => r.json());
    assert.equal(apiSearches.length, 1);
    const runResult = await fetch(`http://127.0.0.1:${port}/api/searches/${created.id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' } }).then(r => r.json());
    assert.equal(runResult.status, 'succeeded');
    const runs = await fetch(`http://127.0.0.1:${port}/api/discovery/runs`).then(r => r.json());
    assert.equal(runs[0].id, runResult.runId);
  } finally {
    server.kill('SIGTERM');
  }
  for (const name of ['search_jobs', 'list_saved_searches', 'import_job_url']) assert.ok(mcpToolNames().includes(name));
});
