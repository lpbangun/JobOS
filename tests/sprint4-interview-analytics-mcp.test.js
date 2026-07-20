import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mcpToolNames } from '../src/mcp.js';

function makeRunner() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-sprint4-'));
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', OLLAMA_API_KEY: '' };
  const run = (args) => {
    const result = spawnSync(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
    assert.equal(result.status, 0, `${args.join(' ')}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
    return result.stdout;
  };
  return { root, env, run };
}

function seed(run, root) {
  run(['init', '--json']);
  const resume = path.join(root, 'resume.md');
  writeFileSync(resume, '- Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.\n- Shipped activation experiments for adult learning products with design and engineering partners.\n- Managed stakeholder tradeoffs across operations, product, and research teams for a learning platform launch.\n');
  const profile = JSON.parse(run(['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json']));
  const jobFile = path.join(root, 'acme-job.md');
  writeFileSync(jobFile, 'Title: Product Manager, Learning Platform\nCompany: Acme Learning\nLocation: Remote\n\nAcme Learning needs a PM to lead educator discovery, roadmap tradeoffs, activation metrics, stakeholder communication, and AI learning workflow experiments. Requirements include product discovery, learning technology, analytics, and cross-functional launch leadership.');
  const job = JSON.parse(run(['jobs', 'import-text', '--profile', profile.id, '--file', jobFile, '--json']));
  const app = JSON.parse(run(['applications', 'create', '--job', job.id, '--status', 'interview', '--json']));
  return { profile, job, app };
}

test('interview prep creates role-specific proof-grounded packet', () => {
  const { root, run } = makeRunner();
  const { app, job } = seed(run, root);
  const packet = JSON.parse(run(['interview', 'prep', '--application', app.id, '--stage', 'hiring-manager', '--json']));
  assert.match(packet.id, /^artifact_/);
  const content = readFileSync(path.join(root, 'jobos-workspace', packet.path), 'utf8');
  assert.match(content, /Product Manager, Learning Platform/);
  assert.match(content, /Role-specific|Likely interview questions/i);
  assert.match(content, /STAR story bank|STAR stories mapped/);
  assert.match(content, /proof_/);
  assert.match(content, /Questions to ask the interviewer/);
  assert.match(content, /did not contact the company/);
  assert.ok(existsSync(path.join(root, 'jobos-workspace', 'jobs', job.id, 'artifacts', 'interview-prep-hiring-manager.md')));
});

test('analytics funnel reports conversion by source, stage, and role family', () => {
  const { run } = makeRunner();
  const { profile, app } = seed(run, mkdtempSync(path.join(tmpdir(), 'jobos-sprint4-seed-')));
  run(['applications', 'update', app.id, '--status', 'interview', '--json']);
  const funnel = JSON.parse(run(['analytics', 'funnel', '--profile', profile.id, '--since', '30', '--json']));
  assert.equal(funnel.totals.applications, 1);
  assert.equal(funnel.totals.interviews, 1);
  assert.ok(funnel.byStage.some(s => s.stage === 'interview' && s.count === 1));
  assert.ok(funnel.bySource.some(s => s.source === 'text_file'));
  assert.ok(funnel.byRoleFamily.some(r => r.roleFamily === 'product'));
  assert.ok(funnel.insights.some(i => /Interview conversion|largest source/.test(i)));
  const review = run(['review', 'weekly', '--profile', profile.id, '--output', 'markdown']);
  assert.match(review, /Funnel analytics/);
  assert.match(review, /Recommended experiments/);
});

test('MCP exposes all Sprint 4 core operation tools and stdio framing', () => {
  const names = mcpToolNames();
  for (const name of ['score_job','tailor_resume','draft_cover_letter','research_company','draft_outreach','mark_outreach_sent','schedule_outreach_followup','list_outreach_due','create_application','update_application_status','list_tasks','interview_prep','weekly_review']) {
    assert.ok(names.includes(name), `${name} missing from MCP tools`);
  }
  const { env } = makeRunner();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  const result = spawnSync(process.execPath, ['src/cli.js', 'mcp'], { cwd: process.cwd(), env, input: `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Content-Length: /);
  const json = result.stdout.slice(result.stdout.indexOf('\r\n\r\n') + 4);
  const response = JSON.parse(json);
  assert.ok(response.result.tools.some(t => t.name === 'interview_prep'));
  const first = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { note: 'café' } });
  const second = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const framed = `Content-Length: ${Buffer.byteLength(first)}\r\n\r\n${first}Content-Length: ${Buffer.byteLength(second)}\r\n\r\n${second}`;
  const unicodeResult = spawnSync(process.execPath, ['src/cli.js', 'mcp'], { cwd: process.cwd(), env, input: framed, encoding: 'utf8', timeout: 10_000 });
  assert.equal(unicodeResult.status, 0, unicodeResult.stderr);
  assert.match(unicodeResult.stdout, /"id":1|"id":2/);
  assert.doesNotMatch(unicodeResult.stdout, /parse error|Missing Content-Length/i);
});
