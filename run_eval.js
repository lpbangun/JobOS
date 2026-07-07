import http from 'node:http';
import path from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

function searchServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const q = url.searchParams.get('q') || '';
    if (process.env.DEBUG_JOBOS_EVAL) console.error(`eval-search: ${q}`);
    const isStakeholder = /stakeholder|hiring manager|recruiter|product leader/i.test(q);
    const results = isStakeholder ? [
      {
        title: 'Maya Chen - Head of Product at Acme Learning',
        url: 'https://acme.example/team/maya-chen',
        snippet: 'Maya Chen leads product at Acme Learning and writes about AI learning workflows.'
      },
      {
        title: 'Jordan Patel - Recruiting Lead at Acme Learning',
        url: 'https://acme.example/team/jordan-patel',
        snippet: 'Jordan Patel supports product and design hiring at Acme Learning.'
      }
    ] : [
      {
        title: 'Acme Learning product overview',
        url: 'https://acme.example/product',
        snippet: 'Acme Learning builds an AI tutoring platform for workforce upskilling programs.'
      },
      {
        title: 'Acme Learning funding news',
        url: 'https://acme.example/funding',
        snippet: 'Acme Learning announced funding to expand employer partnerships and product development.'
      }
    ];
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ results }));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function parseJson(text) {
  return JSON.parse(String(text || '').trim());
}

async function main() {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-blind-agent-'));
  const server = await searchServer();
  const port = server.address().port;
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_SEARCH_PROVIDER: 'duckduckgo',
    JOBOS_SEARCH_PROVIDERS: 'duckduckgo',
    JOBOS_SEARCH_BASE_URL: `http://127.0.0.1:${port}/search`,
    JOBOS_SEARCH_TIMEOUT_MS: '2000',
    JOBOS_LLM_PROVIDER: '',
    JOBOS_LLM_MODEL: '',
    JOBOS_LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OLLAMA_API_KEY: ''
  };
  const steps = [];

  const run = (name, args, check) => new Promise(resolve => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('close', status => {
      const result = { status, stdout, stderr };
      let parsed = null;
      let ok = status === 0;
      let detail = '';
      try {
        parsed = args.includes('--json') ? parseJson(stdout) : stdout;
      } catch (e) {
        ok = false;
        detail = `JSON parse failed: ${e.message}`;
      }
      if (ok && check) {
        try {
          const checked = check(parsed, result);
          ok = checked === undefined ? true : Boolean(checked);
        } catch (e) {
          ok = false;
          detail = e.message;
        }
      }
      if (!detail && !ok) detail = stderr || stdout || `exit ${status}`;
      steps.push({ name, pass: ok, command: `jobos ${args.join(' ')}`, detail: ok ? 'ok' : detail.trim() });
      resolve(parsed);
    });
  });

  try {
    const guide = await run('read agent guide', ['agent-guide', '--json'], value => value.commands?.length >= 30);
    const resume = path.join(root, 'resume.md');
    writeFileSync(resume, '- Led educator discovery for an AI-assisted learning workflow and reduced manual review time by 30%.\n- Shipped activation experiments for adult learning products with design and engineering partners.\n');
    const profile = await run('create profile', ['profile', 'create', 'PM EdTech', '--from-resume', resume, '--json'], value => value.id === 'pm-edtech');
    await run('bootstrap workspace', ['jobs', 'list', '--json'], () => existsSync(path.join(root, '.jobos', 'jobos.sqlite')) && existsSync(path.join(root, 'jobos-workspace')));
    const fixture = path.join(process.cwd(), 'tests', 'fixtures-greenhouse.json');
    await run('create discovery search', ['searches', 'create', 'Acme Discovery', '--profile', profile.id, '--adapter', 'greenhouse', '--company', 'Acme Learning', '--fixture', fixture, '--keywords', 'Product,Learning', '--location', 'Remote', '--min-fit', '50', '--json'], value => value.id);
    const discovery = await run('run discovery', ['discover', 'run', '--search', 'Acme Discovery', '--json'], value => value.status === 'succeeded' && value.counts.imported >= 1);
    const jobs = await run('review queue through jobs list', ['jobs', 'list', '--json'], value => Array.isArray(value) && value.some(job => job.id === discovery.jobs[0].id));
    const jobId = jobs.find(job => job.id === discovery.jobs[0].id).id;
    await run('score job', ['score', jobId, '--profile', profile.id, '--json'], value => Number(value.overall) > 0);
    const stakeholders = await run('research stakeholders', ['research', 'stakeholders', '--job', jobId, '--json'], value => Array.isArray(value.stakeholderIds) && value.stakeholderIds.length >= 1);
    await run('draft outreach', ['outreach', 'draft', '--job', jobId, '--stakeholder', stakeholders.stakeholderIds[0], '--profile', profile.id, '--json'], value => value.approvalStatus === 'draft_needs_human_review');
    await run('track application', ['applications', 'create', '--job', jobId, '--status', 'materials-ready', '--json'], value => value.status === 'materials-ready');
    await run('bounded scheduler loop', ['loop', 'scheduler', '--max-iterations', '1', '--json'], (_value, result) => result.stdout.trim().split('\n').every(line => JSON.parse(line).type === 'loop.iteration'));
    await run('check automation runs', ['runs', 'list', '--json'], value => Array.isArray(value));
    await run('agent guide was sufficient', [], () => guide.commands.some(command => command.name === 'outreach draft'));

    const passed = steps.filter(step => step.pass).length;
    const score = Math.round((passed / steps.length) * 100);
    const report = { scenario: 'blind-agent-json-flow', score, passed, total: steps.length, threshold: 90, steps };
    console.log(JSON.stringify(report, null, 2));
    if (score < 90) process.exitCode = 1;
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (!process.env.KEEP_JOBOS_EVAL) rmSync(root, { recursive: true, force: true });
  }
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exitCode = 1;
});
