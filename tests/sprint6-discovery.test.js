import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { greenhouse, lever } from '../src/discovery/adapters.js';
import { all, one, openStore, run as dbRun, save } from '../src/db.js';
import { runAllSearches } from '../src/discovery.js';
import { importNormalized } from '../src/jobs.js';
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
  assert.equal(runs[0].action_id, 'discover.run');
  assert.equal(JSON.parse(runs[0].outputs_json).counts.fetched, 1);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'discovery', 'runs', `${first.runId}.yaml`)));
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', first.jobs[0].id, 'job.yaml')));
  assert.match(readFileSync(path.join(root, 'jobos-workspace', 'jobs', first.jobs[0].id, 'job.yaml'), 'utf8'), /highFit: true/);
});

test('discovery fetch failure records a failed run without crashing the CLI', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  run(['searches', 'create', 'Offline Search', '--profile', profile.id, '--adapter', 'greenhouse', '--board-token', 'acme', '--fixture', path.join(root, 'missing-fixture.json'), '--json']);
  const result = JSON.parse(run(['discover', 'run', '--search', 'Offline Search', '--json']));
  assert.equal(result.status, 'failed');
  assert.ok(result.errors.length >= 1);
  const store = await openStore({ workspace: root });
  const row = one(store, 'SELECT error, action_id FROM automation_runs WHERE id=?', [result.runId]);
  assert.match(row.error, /missing-fixture/);
  assert.equal(row.action_id, 'discover.run');
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'discovery', 'runs', `${result.runId}.yaml`)));
});

test('run-all discovery can be scoped to one profile', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profileA = JSON.parse(run(['profile', 'create', 'PM EdTech', '--json']));
  const profileB = JSON.parse(run(['profile', 'create', 'Backend', '--json']));
  const fixture = path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json');
  run(['searches', 'create', 'Scoped A', '--profile', profileA.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', fixture, '--json']);
  run(['searches', 'create', 'Scoped B', '--profile', profileB.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', fixture, '--json']);
  const store = await openStore({ workspace: root });
  const result = await runAllSearches(store, { profileId: profileA.id });
  assert.equal(result.count, 1);
  assert.equal(result.runs[0].profileId, profileA.id);
  assert.ok(all(store, 'SELECT * FROM jobs WHERE profile_id=?', [profileA.id]).length > 0);
  assert.equal(all(store, 'SELECT * FROM jobs WHERE profile_id=?', [profileB.id]).length, 0);
});

test('job import refreshes exact URL matches but does not merge different real URLs on key alone', async () => {
  const { root, run } = makeRunner();
  run(['init', '--json']);
  const profile = JSON.parse(run(['profile', 'create', 'Engineering', '--json']));
  const store = await openStore({ workspace: root });
  const first = importNormalized(store, { profileId: profile.id, job: { title: 'Software Engineer', company: 'Acme', location: 'Remote', url: 'https://jobs.example/acme/se-1', source: 'test', description: 'Build backend APIs.' } });
  dbRun(store, 'UPDATE jobs SET first_seen_at=? WHERE id=?', ['2026-01-01T00:00:00.000Z', first.job.id]);
  save(store);
  const refreshed = importNormalized(store, { profileId: profile.id, job: { title: 'Software Engineer', company: 'Acme', location: 'Remote', url: 'https://jobs.example/acme/se-1', source: 'test', description: 'Build backend APIs and platform services.' } });
  assert.equal(refreshed.created, false);
  assert.match(one(store, 'SELECT description FROM jobs WHERE id=?', [first.job.id]).description, /platform services/);

  const second = importNormalized(store, { profileId: profile.id, job: { title: 'Software Engineer', company: 'Acme', location: 'Remote', url: 'https://jobs.example/acme/se-2', source: 'test', description: 'Build frontend product surfaces.' } });
  assert.equal(second.created, true);
  assert.equal(all(store, 'SELECT * FROM jobs WHERE profile_id=?', [profile.id]).length, 2);
  assert.equal(one(store, 'SELECT reposted FROM jobs WHERE id=?', [second.job.id]).reposted, 1);
  assert.match(one(store, 'SELECT title FROM tasks WHERE job_id=?', [second.job.id]).title, /possible duplicate/i);
});

test('MCP discovery tools are exposed', () => {
  for (const name of ['search_jobs', 'list_saved_searches', 'import_job_url']) assert.ok(mcpToolNames().includes(name));
});
