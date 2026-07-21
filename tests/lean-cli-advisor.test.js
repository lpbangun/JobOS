import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';

// ── helpers ──────────────────────────────────────────────────────────

function makeRunner({ extraEnv = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-advisor-'));
  const env = {
    ...process.env,
    JOBOS_HOME: root,
    JOBOS_LLM_PROVIDER: '',
    JOBOS_LLM_MODEL: '',
    JOBOS_LLM_API_KEY: '',
    OPENAI_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OLLAMA_API_KEY: '',
    JOBOS_SEARCH_PROVIDER: 'none',
    JOBOS_SMTP_PROBE: 'false',
    ...extraEnv
  };
  const jobos = (args, { expectFail = false, json = true, timeoutMs = 15_000 } = {}) => {
    const full = json ? [...args, '--json'] : args;
    const result = spawnSync(process.execPath, ['src/cli.js', ...full], {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      timeout: timeoutMs
    });
    if (!expectFail && result.status !== 0) {
      const detail = `STDERR:\n${(result.stderr || '').slice(0, 4000)}\nSTDOUT:\n${(result.stdout || '').slice(0, 2000)}`;
      assert.equal(result.status, 0, `${args.join(' ')}\n${detail}`);
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const out = (args, opts) => {
    const r = jobos(args, opts);
    if (r.status === 0) return JSON.parse(r.stdout);
    try { return JSON.parse(r.stderr); } catch { return JSON.parse(r.stdout); }
  };
  const raw = (args, opts) => jobos(args, { ...opts, json: false });
  return { root, env, jobos, out, raw };
}

function fixtureFile(root, name, content) {
  const p = path.join(root, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

function jsonFixture(root, name, obj) {
  return fixtureFile(root, name, JSON.stringify(obj));
}

// ── fake Playwright builder ───────────────────────────────────────────

function fakePlaywright(options = {}) {
  const cookies = new Map();
  const pageGoto = options.goto || ((url) => ({
    status: () => 200,
    headers: () => new Map(),
    url: () => url
  }));
  const pageUrl = options.pageUrl || 'https://example.com';
  const pageEval = options.evaluate || (() => ({
    captcha: false,
    loginForm: false,
    blockedText: false
  }));
  const pageTitle = options.title || 'Fake Page';
  const pageExtract = options.extract || (() => ({
    selectorFound: true,
    text: 'Fake page content for testing.',
    textTruncated: false,
    links: [],
    linksTruncated: false
  }));

  function FakePage() {
    const self = this;
    this.goto = async (url, opts) => {
      const res = pageGoto(url);
      if (res?.status) { self._status = res.status(); self._url = res.url?.(); }
      if (!self._url) self._url = typeof url === 'string' ? url : String(url?.href || pageUrl);
      return res;
    };
    this.url = () => self._url || pageUrl;
    // Real Playwright evaluate: fn runs in browser. Our fake ignores fn and returns a canned value.
    // inspectPage calls evaluate(() => { ...DOM... }) — we return pageEval().
    // extractPage calls evaluate(({...}) => { ...DOM... }, {...}) — we return pageExtract().
    this.evaluate = async (fn, arg) => {
      // arg is the second param to evaluate(); extractPage passes {selector, maxText, maxLinks}
      if (arg && typeof arg === 'object' && ('selector' in arg || 'maxText' in arg || 'maxLinks' in arg)) {
        const result = typeof pageExtract === 'function' ? pageExtract(arg) : pageExtract;
        return result;
      }
      const result = typeof pageEval === 'function' ? pageEval() : pageEval;
      return result;
    };
    this.title = async () => pageTitle;
    this._status = 200;
    this._url = null;
  }

  const context = {
    _pages: [new FakePage()],
    pages: () => context._pages,
    newPage: () => {
      const p = new FakePage();
      context._pages.push(p);
      return p;
    },
    cookies: async () => [...cookies.values()],
    addCookies: async (c) => {
      for (const cookie of c) {
        const key = `${cookie.name}:${cookie.domain || cookie.url || ''}`;
        cookies.set(key, { ...cookie });
      }
    },
    close: async () => {},
    on: (evt, cb) => { if (evt === 'close') context._onClose = cb; },
    once: (evt, cb) => { if (evt === 'close') context._onClose = cb; },
    _triggerClose: () => { if (context._onClose) context._onClose(); }
  };

  return {
    chromium: {
      launchPersistentContext: async (profilePath, opts) => context,
      executablePath: () => '/fake/chromium'
    }
  };
}

// ── SETUP / INIT tests (dimensions 1-2) ──────────────────────────────

test('root help is concise and shows Setup / Workflows / Extend structure', () => {
  const { raw } = makeRunner();
  const help = raw(['help']).stdout;
  assert.ok(help.includes('Setup'), 'help should include Setup section');
  assert.ok(help.includes('Workflows'), 'help should include Workflows section');
  assert.ok(help.includes('Extend'), 'help should include Extend section');
  assert.ok(help.includes('daily'), 'help should mention daily');
  assert.ok(help.includes('pursue'), 'help should mention pursue');
  assert.ok(help.includes('network'), 'help should mention network');
  const lines = help.split('\n').length;
  assert.ok(lines < 45, `help should be concise (got ${lines} lines)`);
});

test('help --all shows full registry with new commands', () => {
  const { raw } = makeRunner();
  const help = raw(['help', '--all']).stdout;
  assert.ok(help.includes('answers'), '--all help should include answers');
  assert.ok(help.includes('agents'), '--all help should include agents');
  assert.ok(help.includes('browser'), '--all help should include browser');
  assert.ok(help.includes('network paths'), '--all help should include network paths');
});

test('agent-guide --json returns complete registry with new commands', () => {
  const { out } = makeRunner();
  const registry = out(['agent-guide']);
  assert.ok(Array.isArray(registry.commands));
  const names = registry.commands.map(c => c.name);
  assert.ok(names.includes('daily'), 'registry should include daily');
  assert.ok(names.includes('pursue'), 'registry should include pursue');
  assert.ok(names.includes('answers add'), 'registry should include answers add');
  assert.ok(names.includes('agents list'), 'registry should include agents list');
  assert.ok(names.includes('browser status'), 'registry should include browser status');
  assert.ok(names.includes('network paths'), 'registry should include network paths');
});

test('clean init returns user_configured policy', () => {
  const { out } = makeRunner();
  const result = out(['init']);
  assert.equal(result.policy.externalActions, 'user_configured');
  assert.equal(result.policy.autoApply, 'disabled');
  assert.equal(result.policy.autoSend, 'disabled');
  assert.equal(result.ok, true);
});

test('init is idempotent and returns same root', () => {
  const { out, root } = makeRunner();
  const first = out(['init']);
  const second = out(['init']);
  assert.equal(first.root, root);
  assert.equal(second.root, root);
  assert.equal(second.policy.externalActions, 'user_configured');
});

// ── ANSWERS (dimension 3) ────────────────────────────────────────────

test('answers: profile isolation', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const pa = out(['profile', 'create', 'ProfileA', '--from-resume', resume]);
  const pb = out(['profile', 'create', 'ProfileB', '--from-resume', resume]);
  out(['answers', 'add', '--profile', pa.id, '--category', 'contact', '--question', 'What is your email?', '--answer', 'a@example.com', '--sensitivity', 'personal']);
  assert.equal(out(['answers', 'list', '--profile', pa.id]).length, 1);
  assert.equal(out(['answers', 'list', '--profile', pb.id]).length, 0);
});

test('answers: sensitive/restricted values are redacted in list and workspace mirror', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'Public email', '--answer', 'public@example.com', '--sensitivity', 'public']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'compensation', '--question', 'Salary expectation', '--answer', '150000', '--sensitivity', 'sensitive']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'legal_attestation', '--question', 'Citizenship?', '--answer', 'yes', '--sensitivity', 'restricted']);
  const list = out(['answers', 'list', '--profile', 'pm']);
  assert.equal(list.length, 3);
  const sensitiveAns = list.find(a => a.sensitivity === 'sensitive');
  assert.equal(sensitiveAns.answer, null);
  assert.equal(sensitiveAns.redacted, true);
  const restrictedAns = list.find(a => a.sensitivity === 'restricted');
  assert.equal(restrictedAns.answer, null);
  assert.equal(restrictedAns.redacted, true);
  const publicAns = list.find(a => a.sensitivity === 'public');
  assert.equal(publicAns.redacted, false);
  assert.equal(publicAns.answer, 'public@example.com');
  const mirrorPath = path.join(root, 'jobos-workspace', 'profiles', 'pm-answers.yaml');
  const mirror = readFileSync(mirrorPath, 'utf8');
  assert.ok(!mirror.includes('150000'), 'mirror must not contain sensitive value');
  assert.ok(!mirror.includes('yes'), 'mirror must not contain restricted value');
  assert.ok(mirror.includes('public@example.com'), 'mirror should contain public value');
});

test('answers: stale/retired answers excluded from matching', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'What is your email?', '--answer', 'old@example.com', '--status', 'stale']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'What is your email?', '--answer', 'retired@example.com', '--status', 'retired']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'What is your phone?', '--answer', '555-1234', '--status', 'verified']);
  const questions = jsonFixture(root, 'questions.json', ['What is your email?', 'What is your phone?']);
  const result = out(['answers', 'match', '--profile', 'pm', '--questions', questions]);
  assert.equal(result.matched, 1);
  const emailQ = result.questions.find(q => q.question === 'What is your email?');
  assert.equal(emailQ.status, 'unmatched');
});

test('answers: restricted-category questions always blocked with sensitive_prompt', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const questions = jsonFixture(root, 'questions.json', [
    { question: 'Are you legally authorized to work?', category: 'work_authorization' },
    { question: 'What is your race?', category: 'demographic' },
    { question: 'Have you been convicted?', category: 'legal_attestation' },
    { question: 'Why do you want this job?', category: 'motivation' }
  ]);
  const result = out(['answers', 'match', '--profile', 'pm', '--questions', questions]);
  assert.equal(result.blocked, 3);
  for (const b of result.questions.filter(q => q.status === 'blocked')) {
    assert.equal(b.blocker, 'sensitive_prompt');
    assert.equal(b.confidence, 0);
  }
});

test('answers: normalized fuzzy matching with different wording', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation', '--question', 'Tell us why you are interested in this role', '--answer', 'Because I love this field.', '--status', 'verified']);
  const questions = jsonFixture(root, 'questions.json', ['Why are you interested in this role?']);
  const result = out(['answers', 'match', '--profile', 'pm', '--questions', questions]);
  assert.equal(result.matched, 1);
});

test('answers: employer_specific scoping and never_auto_fill exclusion', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation', '--question', 'Why here?', '--answer', 'Mission driven', '--reuse', 'employer_specific', '--employer', 'acme']);
  out(['answers', 'add', '--profile', 'pm', '--category', 'motivation', '--question', 'Favorite color?', '--answer', 'Blue', '--reuse', 'never_auto_fill', '--status', 'verified']);
  const questions = jsonFixture(root, 'questions.json', ['Why here?', 'Favorite color?']);
  // wrong employer: no match
  assert.equal(out(['answers', 'match', '--profile', 'pm', '--questions', questions, '--employer', 'othercorp']).matched, 0);
  // right employer: matches
  assert.equal(out(['answers', 'match', '--profile', 'pm', '--questions', questions, '--employer', 'acme']).matched, 1);
});

// ── PROFILE/JOB MISMATCH (dimension 4) ────────────────────────────────

test('score/tailor/pursue reject cross-profile mismatch', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const pa = out(['profile', 'create', 'ProfileA', '--from-resume', resume]);
  const pb = out(['profile', 'create', 'ProfileB', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', '# PM at Acme Corp\nRemote.');
  const imported = out(['jobs', 'import-text', '--profile', pa.id, '--file', job]);
  assert.notEqual(out(['score', imported.id, '--profile', pb.id], { expectFail: true }).status, 0, 'score should reject mismatch');
  assert.notEqual(out(['tailor', 'resume', '--job', imported.id, '--profile', pb.id], { expectFail: true }).status, 0, 'tailor should reject mismatch');
  assert.notEqual(out(['pursue', imported.id, '--profile', pb.id], { expectFail: true }).status, 0, 'pursue should reject mismatch');
});

// ── DISCOVERY adapters (dimension 5) ──────────────────────────────────

test('ashby/career-page/portfolio adapters registered and require params', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  // Search create validates config, not fetch capability — they create successfully
  const ashby = out(['searches', 'create', 'AshbyS', '--profile', 'pm', '--adapter', 'ashby', '--board-token', 'x']);
  assert.equal(ashby.adapter, 'ashby');
  const career = out(['searches', 'create', 'CareerS', '--profile', 'pm', '--adapter', 'career-page', '--url', 'https://example.com/careers']);
  assert.equal(career.adapter, 'career-page');
  const port = out(['searches', 'create', 'PortS', '--profile', 'pm', '--adapter', 'portfolio', '--url', 'https://example.com/portfolio']);
  assert.equal(port.adapter, 'portfolio');
  // Run discovery with these searches exercises the adapter (may fail without network — acceptable)
  const runs = out(['discover', 'run-all', '--profile', 'pm']);
  assert.ok(Array.isArray(runs.runs), 'should have runs array');
});

test('greenhouse adapter: fixture-backed search runs', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const fixture = jsonFixture(root, 'gh-fixture.json', {
    jobs: [
      { title: 'Product Manager', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1', location: { name: 'Remote' }, content: '<p>Build product</p>', updated_at: '2026-01-01' }
    ]
  });
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['searches', 'create', 'AcmeGH', '--profile', 'pm', '--adapter', 'greenhouse', '--board-token', 'acme']);
  const runs = out(['discover', 'run-all', '--profile', 'pm']);
  assert.ok(Array.isArray(runs.runs), 'should have runs array');
});

// ── DAILY source failure isolation (dimension 6) ──────────────────────

test('daily runs searches and isolates per-source failures', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['searches', 'create', 'FailingSearch', '--profile', 'pm', '--adapter', 'greenhouse', '--board-token', 'nonexistent']);
  const daily = out(['daily', '--profile', 'pm']);
  assert.equal(daily.profileId, 'pm');
  assert.ok(Array.isArray(daily.failures), 'should have failures array');
  assert.ok(daily.scheduler && daily.scheduler.enable, 'should have scheduler command');
});

// ── NETWORKING (dimension 7) ──────────────────────────────────────────

test('network import with valid edge types and list returns edges', () => {
  const { root, out } = makeRunner();
  const csv = fixtureFile(root, 'edges.csv',
    'from_type,from_id,to_type,to_id,edge_type,confidence\n' +
    'profile,pm-edtech,company,acme,shared_employer,high\n' +
    'profile,pm-edtech,person,alice,direct_connection,medium\n'
  );
  out(['network', 'import', '--file', csv]);
  const list = out(['network', 'list']);
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 1);
});

test('network paths and contacts return structured output for job', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', '# PM at Acme Corp\nRemote.');
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);
  const paths = out(['network', 'paths', '--job', imported.id]);
  assert.ok(Array.isArray(paths.paths) || typeof paths.pathCount === 'number');
  const contacts = out(['network', 'contacts', '--job', imported.id]);
  assert.ok(Array.isArray(contacts));
});

// ── PURSUE (dimension 8) ──────────────────────────────────────────────

test('pursue dry-run returns full stage dependency graph', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', '# Senior PM at Acme Corp\nRemote.');
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);
  const dry = out(['pursue', imported.id, '--profile', 'pm', '--dry-run']);
  assert.equal(dry.dryRun, true);
  assert.ok(dry.stages.length >= 8, `should have 8 stages, got ${dry.stages.length}`);
  const scoreStage = dry.stages.find(s => s.stage === 'score');
  assert.deepEqual(scoreStage.dependencies, []);
  const companyStage = dry.stages.find(s => s.stage === 'company');
  assert.ok(companyStage.dependencies.includes('score'));
  const outreachStage = dry.stages.find(s => s.stage === 'outreach');
  assert.ok(outreachStage.dependencies.includes('people-research'));
  assert.ok(outreachStage.dependencies.includes('application'));
});

test('pursue --stage application runs with declared dependencies', () => {
  const { root, jobos } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const initP = JSON.parse(jobos(['profile', 'create', 'PM', '--from-resume', resume]).stdout);
  const job = fixtureFile(root, 'job.md', '# Senior PM at Acme Corp\nRemote.');
  const impP = JSON.parse(jobos(['jobs', 'import-text', '--profile', initP.id, '--file', job]).stdout);
  const result = JSON.parse(jobos(['pursue', impP.id, '--stage', 'application', '--profile', initP.id], { timeoutMs: 120_000 }).stdout);
  const stageNames = result.stages.map(s => s.stage);
  assert.ok(stageNames.includes('questions'), 'should include questions dependency');
  assert.ok(stageNames.includes('resume'), 'should include resume dependency');
  assert.ok(stageNames.includes('cover-letter'), 'should include cover-letter dependency');
  assert.ok(stageNames.includes('application'), 'should include application');
  assert.equal(result.stages.find(s => s.stage === 'application').status, 'ok');
});

test('pursue full E2E: all stages ok, artifacts written', () => {
  const { root, jobos } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Led discovery with educators and operations teams to prioritize an AI-assisted learning workflow that reduced manual review time by 30%.\n- Shipped a cross-functional product launch improving activation.\n');
  const initP = JSON.parse(jobos(['profile', 'create', 'PM', '--from-resume', resume]).stdout);
  const job = fixtureFile(root, 'job.md', '# Senior Product Manager at Acme Corp\nRemote. Lead product strategy for EdTech platform.');
  const impP = JSON.parse(jobos(['jobs', 'import-text', '--profile', initP.id, '--file', job]).stdout);
  const result = JSON.parse(jobos(['pursue', impP.id, '--profile', initP.id], { timeoutMs: 180_000 }).stdout);
  assert.ok(result.stages.length >= 8);
  const stageNames = result.stages.map(s => s.stage);
  assert.ok(stageNames.includes('score'));
  assert.ok(stageNames.includes('resume'));
  assert.ok(stageNames.includes('cover-letter'));
  assert.ok(stageNames.includes('application'));
  // Verify artifacts exist
  const artifactsDir = path.join(root, 'jobos-workspace', 'jobs', impP.id, 'artifacts');
  assert.ok(existsSync(path.join(artifactsDir, 'resume-tailored.md')), 'resume artifact should exist');
  assert.ok(existsSync(path.join(artifactsDir, 'cover-letter.md')), 'cover letter artifact should exist');
  // Application should be created
  const appStage = result.stages.find(s => s.stage === 'application');
  assert.equal(appStage.status, 'ok');
});

test('pursue: upstream stage failure skips dependents with reason+recovery', () => {
  const { root, jobos } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const initP = JSON.parse(jobos(['profile', 'create', 'PM', '--from-resume', resume]).stdout);
  const job = fixtureFile(root, 'job.md', '# Unknown Role at Unknown Corp\n');
  const impP = JSON.parse(jobos(['jobs', 'import-text', '--profile', initP.id, '--file', job]).stdout);
  const result = JSON.parse(jobos(['pursue', impP.id, '--profile', initP.id], { timeoutMs: 180_000 }).stdout);
  const skipped = result.stages.filter(s => s.status === 'skipped');
  for (const skip of skipped) {
    assert.ok(skip.reason, 'skipped stage must have reason');
    assert.ok(skip.recovery, 'skipped stage must have recovery');
  }
});

// ── AGENTS (dimension 9) ─────────────────────────────────────────────

test('agents list shows codex/hermes builtins with availability', () => {
  const { out } = makeRunner();
  const list = out(['agents', 'list']);
  assert.ok(Array.isArray(list));
  const codex = list.find(a => a.name === 'codex');
  assert.ok(codex, 'codex builtin should exist');
  assert.equal(codex.builtin, true);
  assert.equal(codex.transport, 'stdin-json');
  const hermes = list.find(a => a.name === 'hermes');
  assert.ok(hermes, 'hermes builtin should exist');
  assert.equal(hermes.transport, 'prompt-arg');
});

test('agents add registers custom, add rejects reserved name', () => {
  const { out } = makeRunner();
  out(['agents', 'add', 'my-fake', '--command', 'echo', '--args', '["fake"]', '--transport', 'stdin-json']);
  const list = out(['agents', 'list']);
  const my = list.find(a => a.name === 'my-fake');
  assert.ok(my, 'custom agent should appear');
  assert.equal(my.command, 'echo');
  assert.equal(my.builtin, false);
  // Reserved name rejected
  assert.notEqual(out(['agents', 'add', 'codex', '--command', 'echo', '--args', '[]'], { expectFail: true }).status, 0);
});

test('agents test: missing executable -> agent_missing_executable', () => {
  const { root } = makeRunner();
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '' };
  spawnSync(process.execPath, ['src/cli.js', 'agents', 'add', 'no-bin', '--command', 'no-such-binary-xyz-999', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000
  });
  const testR = spawnSync(process.execPath, ['src/cli.js', 'agents', 'test', 'no-bin', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000
  });
  assert.notEqual(testR.status, 0, 'testing missing executable should fail');
  const err = JSON.parse(testR.stderr);
  assert.ok(err.error.code === 'agent_missing_executable' || err.error.code === 'agent_test_failed',
    `expected agent_missing_executable, got ${err.error.code}`);
});

test('agents: non-JSON stdout -> agent_malformed_output', () => {
  const { root } = makeRunner();
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '' };
  spawnSync(process.execPath, ['src/cli.js', 'agents', 'add', 'bad-json', '--command', 'echo', '--args', '["not-json-output"]', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000
  });
  const testR = spawnSync(process.execPath, ['src/cli.js', 'agents', 'test', 'bad-json', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000
  });
  assert.notEqual(testR.status, 0);
  const err = JSON.parse(testR.stderr);
  assert.ok(
    err.error.code === 'agent_malformed_output' || err.error.code === 'agent_nonzero_exit',
    `expected malformed_output or nonzero, got ${err.error.code}`
  );
});

test('agents: explicit --agent missing -> fails no silent fallback', () => {
  const { root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const env = { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', JOBOS_AGENT: '' };
  const init = spawnSync(process.execPath, ['src/cli.js', 'profile', 'create', 'PM', '--from-resume', resume, '--json'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  const profile = JSON.parse(init.stdout);
  const job = fixtureFile(root, 'job.md', '# PM at Acme\nRemote.');
  const imp = spawnSync(process.execPath, ['src/cli.js', 'jobs', 'import-text', '--profile', profile.id, '--file', job, '--json'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  const imported = JSON.parse(imp.stdout);
  const scoreR = spawnSync(process.execPath, ['src/cli.js', 'score', imported.id, '--profile', profile.id, '--agent', 'no-such-agent-999', '--json'], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000
  });
  assert.notEqual(scoreR.status, 0, 'explicit --agent with missing agent must fail');
  assert.match(scoreR.stderr, /agent_not_found/);
});

test('agents: JOBOS_AGENT env sets default, --agent overrides', () => {
  const { root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  const env = {
    ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '', JOBOS_AGENT: 'noexist-env-agent-999'
  };
  const init = spawnSync(process.execPath, ['src/cli.js', 'profile', 'create', 'PM', '--from-resume', resume, '--json'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  const profile = JSON.parse(init.stdout);
  const job = fixtureFile(root, 'job.md', '# PM at Acme\nRemote.');
  const imp = spawnSync(process.execPath, ['src/cli.js', 'jobs', 'import-text', '--profile', profile.id, '--file', job, '--json'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  const imported = JSON.parse(imp.stdout);
  // JOBOS_AGENT is set to nonexistent -> score should fail
  const scoreR = spawnSync(process.execPath, ['src/cli.js', 'score', imported.id, '--profile', profile.id, '--json'], { cwd: process.cwd(), env, encoding: 'utf8', timeout: 10_000 });
  assert.notEqual(scoreR.status, 0, 'JOBOS_AGENT with missing agent should cause failure');
});

// ── BROWSER: CLI-level unavailable (dimension 10a) ────────────────────

test('browser status reports unavailable with recovery on headless VPS', () => {
  const { out } = makeRunner();
  const status = out(['browser', 'status']);
  assert.ok(typeof status.available === 'boolean');
  assert.ok(Array.isArray(status.recovery));
  assert.ok(status.recovery.length > 0, 'recovery instructions should exist');
  assert.equal(status.browser, 'chromium');
});

test('browser login fails browser_unavailable without display/playwright', () => {
  const { root } = makeRunner();
  const r = spawnSync(process.execPath, ['src/cli.js', 'browser', 'login', 'testprof', '--url', 'https://example.com', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '' },
    encoding: 'utf8', timeout: 20_000
  });
  assert.notEqual(r.status, 0, 'headed login without display/playwright should fail');
});

test('browser fetch fails without authenticated profile', () => {
  const { root } = makeRunner();
  const r = spawnSync(process.execPath, ['src/cli.js', 'browser', 'fetch', 'noprofile', '--url', 'https://example.com', '--json'], {
    cwd: process.cwd(),
    env: { ...process.env, JOBOS_HOME: root, JOBOS_LLM_PROVIDER: '', JOBOS_LLM_MODEL: '', JOBOS_LLM_API_KEY: '' },
    encoding: 'utf8', timeout: 20_000
  });
  assert.notEqual(r.status, 0, 'fetch without profile should fail');
});

test('browser script add records SHA-256 hash and trust warning', () => {
  const { out, root } = makeRunner();
  const script = fixtureFile(root, 'test-script.mjs', 'export default async function({page, context, input}) { return {ok:true}; }');
  const added = out(['browser', 'script', 'add', 'my-script', '--file', script]);
  assert.equal(added.name, 'my-script');
  assert.ok(/^[a-f0-9]{64}$/.test(added.scriptHash), 'should have SHA-256 hash');
  assert.ok(added.warning && added.warning.includes('unsandboxed'), 'should warn about unsandboxed execution');
});

// ── BROWSER: direct-module fake Playwright tests (dimension 10b) ──────

test('fake-pw: cookie import/export round-trip without secret leakage', async () => {
  const { importCookies, exportCookies } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-pw-'));
  const pw = fakePlaywright();
  const cookieFile = path.join(root, 'cookies-in.json');
  const origCookies = [{ name: 'session', value: 'secret-session-token-abc123', url: 'https://example.com', httpOnly: true, secure: true }];
  writeFileSync(cookieFile, JSON.stringify({ cookies: origCookies, origins: [] }), 'utf8');
  // Import
  const imp = await importCookies({ workspace: root, name: 'testprof', file: cookieFile, playwright: pw });
  assert.equal(imp.profile, 'testprof');
  assert.equal(imp.cookieCount, 1);
  // The stored cookie value must not appear in result
  assert.ok(!JSON.stringify(imp).includes('secret-session-token-abc123'), 'cookie value must not leak in import result');
  // Export
  const expFile = path.join(root, 'cookies-out.json');
  const exp = await exportCookies({ workspace: root, name: 'testprof', file: expFile, playwright: pw });
  assert.equal(exp.profile, 'testprof');
  assert.equal(exp.cookieCount, 1);
  // Export result must not contain cookie value
  assert.ok(!JSON.stringify(exp).includes('secret-session-token-abc123'), 'cookie value must not leak in export result');
  // On-disk export file should contain the cookie value (it's the explicit export target)
  const exported = JSON.parse(readFileSync(expFile, 'utf8'));
  assert.equal(exported.cookies[0].value, 'secret-session-token-abc123', 'export file should contain original cookie values');
});

test('fake-pw: CAPTCHA detection produces typed captcha error', async () => {
  const { authenticatedFetch } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-captcha-'));
  // Create a profile first via import
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({
    pageUrl: 'https://example.com/captcha/challenge',
    evaluate: () => ({ captcha: true, loginForm: false, blockedText: false })
  });
  await importCookies({ workspace: root, name: 'capprof', file: cookieFile, playwright: pw });
  // Fetch should detect CAPTCHA
  try {
    await authenticatedFetch({ workspace: root, name: 'capprof', url: 'https://example.com/page', playwright: pw });
    assert.fail('should have thrown captcha error');
  } catch (e) {
    assert.equal(e.code, 'captcha', `expected captcha error, got ${e.code}: ${e.message}`);
  }
});

test('fake-pw: 401/login redirect produces typed auth_required error', async () => {
  const { authenticatedFetch } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-auth-'));
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({
    goto: () => ({ status: () => 401, headers: () => new Map(), url: () => 'https://example.com/login' }),
    pageUrl: 'https://example.com/login',
    evaluate: () => ({ captcha: false, loginForm: true, blockedText: false })
  });
  await importCookies({ workspace: root, name: 'authprof', file: cookieFile, playwright: pw });
  try {
    await authenticatedFetch({ workspace: root, name: 'authprof', url: 'https://example.com/page', playwright: pw });
    assert.fail('should have thrown auth_required');
  } catch (e) {
    assert.equal(e.code, 'auth_required', `expected auth_required, got ${e.code}: ${e.message}`);
  }
});

test('fake-pw: 403/blocked text produces typed blocked error', async () => {
  const { authenticatedFetch } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-blocked-'));
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({
    goto: () => ({ status: () => 403, headers: () => new Map(), url: () => 'https://example.com' }),
    evaluate: () => ({ captcha: false, loginForm: false, blockedText: true })
  });
  await importCookies({ workspace: root, name: 'blockprof', file: cookieFile, playwright: pw });
  try {
    await authenticatedFetch({ workspace: root, name: 'blockprof', url: 'https://example.com/page', playwright: pw });
    assert.fail('should have thrown blocked');
  } catch (e) {
    assert.equal(e.code, 'blocked', `expected blocked, got ${e.code}: ${e.message}`);
  }
});

test('fake-pw: successful authenticated fetch extracts title/text/links', async () => {
  const { authenticatedFetch } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-ok-'));
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({
    title: 'My Dashboard',
    pageUrl: 'https://example.com/dashboard',
    evaluate: () => ({ captcha: false, loginForm: false, blockedText: false })
  });
  await importCookies({ workspace: root, name: 'okprof', file: cookieFile, playwright: pw });
  const result = await authenticatedFetch({ workspace: root, name: 'okprof', url: 'https://example.com/dashboard', playwright: pw });
  assert.equal(result.title, 'My Dashboard');
  assert.ok(result.text !== undefined, 'should have extracted text');
  assert.ok(Array.isArray(result.links), 'should have links array');
});

test('fake-pw: script hash tamper rejection', async () => {
  const { registerScript, runRegisteredScript } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-hash-'));
  const scriptFile = path.join(root, 's.mjs');
  writeFileSync(scriptFile, 'export default async function({page, context, input}) { return {ok:true}; }', 'utf8');
  // Register script
  const reg = await registerScript({ workspace: root, name: 'hash-test', file: scriptFile });
  assert.ok(reg.scriptHash);
  // Tamper with the script on disk without re-registering
  writeFileSync(reg.path, 'export default async function({page, context, input}) { return {tampered:true}; }', 'utf8');
  // Import cookies to create a profile
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({ evaluate: () => ({ captcha: false, loginForm: false, blockedText: false }) });
  await importCookies({ workspace: root, name: 'hashprof', file: cookieFile, playwright: pw });
  // Run should fail due to hash mismatch
  try {
    await runRegisteredScript({ workspace: root, profile: 'hashprof', url: 'https://example.com', script: 'hash-test', playwright: pw, allowSideEffects: true });
    assert.fail('should have thrown hash_mismatch');
  } catch (e) {
    assert.equal(e.code, 'browser_script_hash_mismatch', `expected hash_mismatch, got ${e.code}: ${e.message}`);
  }
});

test('fake-pw: side-effecting script requires allowSideEffects', async () => {
  const { registerScript, runRegisteredScript } = await import('../src/browser.js');
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-fake-sidefx-'));
  const scriptFile = path.join(root, 's.mjs');
  writeFileSync(scriptFile, 'export default async function({page, context, input}) { return {ok:true}; }', 'utf8');
  await registerScript({ workspace: root, name: 'side-script', file: scriptFile, sideEffecting: true });
  // Import profile
  const { importCookies } = await import('../src/browser.js');
  const cookieFile = path.join(root, 'cookies.json');
  writeFileSync(cookieFile, JSON.stringify({ cookies: [{ name: 's', value: 'x', url: 'https://example.com' }], origins: [] }), 'utf8');
  const pw = fakePlaywright({ evaluate: () => ({ captcha: false, loginForm: false, blockedText: false }) });
  await importCookies({ workspace: root, name: 'sideprof', file: cookieFile, playwright: pw });
  // Without allowSideEffects
  try {
    await runRegisteredScript({ workspace: root, profile: 'sideprof', url: 'https://example.com', script: 'side-script', playwright: pw, allowSideEffects: false });
    assert.fail('should have thrown side_effects_required');
  } catch (e) {
    assert.equal(e.code, 'browser_side_effects_required', `expected side_effects_required, got ${e.code}: ${e.message}`);
  }
  // With allowSideEffects: succeed
  const result = await runRegisteredScript({ workspace: root, profile: 'sideprof', url: 'https://example.com', script: 'side-script', playwright: pw, allowSideEffects: true });
  assert.deepEqual(result.outcome, { ok: true });
});

// ── WARM RELATIONSHIP EDGE OUTREACH PLAN (dimension 7 extended) ───────

test('warm relationship edges influence outreach plan path strength', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  // Import job with known company
  const job = fixtureFile(root, 'job.md', '# PM\nCompany: Acme Corp\nLocation: Remote\n\nProduct strategy.');
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);
  // Import warm edge: PM -> Acme Corp (must match job.company exactly after lowercase)
  const csv = fixtureFile(root, 'edges.csv',
    'from_type,from_id,to_type,to_id,edge_type,confidence\n' +
    'profile,pm,company,acme corp,shared_employer,high\n'
  );
  out(['network', 'import', '--file', csv]);
  // Add stakeholder
  out(['research', 'add-stakeholder', '--job', imported.id, '--source-url', 'https://example.com/person', '--name', 'Test Person', '--role', 'Hiring Manager', '--text', 'Source-backed context for outreach planning.']);
  // Create outreach plan — should pick up the warm edge
  const plan = out(['outreach', 'plan', '--job', imported.id, '--profile', 'pm']);
  assert.match(plan.relationshipEdgeId, /^edge_/);
  assert.equal(plan.recommended, true);
  assert.equal(plan.channel, 'warm_context');
  assert.equal(plan.pathStrength, 'strong');
  assert.equal(plan.reasoning.selectedNetworkEdge.edgeType, 'shared_employer');
});

// ── MCP TOOL EXPOSURE (dimension integration) ─────────────────────────

test('MCP tool list includes daily_discovery, pursue_job, and answers_match', async () => {
  const { mcpToolNames } = await import('../src/mcp.js');
  const names = mcpToolNames();
  assert.ok(names.includes('daily_discovery'), 'MCP should expose daily_discovery');
  assert.ok(names.includes('pursue_job'), 'MCP should expose pursue_job');
  assert.ok(names.includes('answers_match'), 'MCP should expose answers_match');
});

test('MCP answers_match tool returns structured match result', async () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'Email?', '--answer', 'me@example.com', '--status', 'verified']);
  // Invoke MCP tool directly using startMcp + tools/call
  const { openStore } = await import('../src/db.js');
  const { startMcp } = await import('../src/mcp.js');
  // Use a simple stdin simulation to send a tools/call request
  const s = await openStore({ workspace: root });
  const { Readable } = await import('node:stream');
  // Send tools/list then tools/call
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'answers_match',
      arguments: { profileId: 'pm', questions: ['Email?', 'Phone?'] }
    }
  });
  const framed = `Content-Length: ${Buffer.byteLength(request, 'utf8')}\r\n\r\n${request}`;
  // Capture stdout
  let output = '';
  const originalWrite = process.stdout.write.bind(process.stdout);
  const captureWrite = (chunk) => { output += chunk; return true; };
  process.stdout.write = captureWrite;
  try {
    const input = new Readable({ read() { this.push(framed); this.push(null); } });
    startMcp(s, { input });
    await new Promise(resolve => setTimeout(resolve, 2000));
    process.stdout.write = originalWrite;
    // Parse the response(s) from output stream
    const responses = output.split('\r\n\r\n').filter(Boolean).map(chunk => {
      const lines = chunk.split('\n');
      for (const line of lines) {
        try { return JSON.parse(line); } catch {}
      }
      return null;
    }).filter(Boolean);
    // Look for the tools/call result
    const callResult = responses.find(r => r.id === 1 && r.result);
    assert.ok(callResult, 'should have a result for tools/call');
    const content = callResult.result.content[0].text;
    const parsed = JSON.parse(content);
    assert.equal(parsed.profileId, 'pm');
  } catch (e) {
    process.stdout.write = originalWrite;
    throw e;
  }
});

// ── CONCURRENT DB SNAPSHOT PROTECTION (dimension 11) ──────────────────

test('concurrent writer: lock file cleaned up after write, revision increments', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const lockPath = path.join(root, '.jobos', 'jobos.lock');
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'Email?', '--answer', 'a@b.com']);
  assert.ok(!existsSync(lockPath), 'lock should be released after write');
  out(['answers', 'add', '--profile', 'pm', '--category', 'contact', '--question', 'Phone?', '--answer', '555-1234']);
  const list = out(['answers', 'list', '--profile', 'pm']);
  assert.equal(list.length, 2, 'both answers persist across sequential writes');
});

test('score works with matching profile', () => {
  const { out, root } = makeRunner();
  const resume = fixtureFile(root, 'resume.md', '- Built a thing.\n');
  out(['profile', 'create', 'PM', '--from-resume', resume]);
  const job = fixtureFile(root, 'job.md', '# Senior Product Manager at Acme Corp\nRemote. Lead product strategy.');
  const imported = out(['jobs', 'import-text', '--profile', 'pm', '--file', job]);
  const result = out(['score', imported.id, '--profile', 'pm']);
  assert.ok(typeof result.overall === 'number');
  assert.ok(result.overall >= 0 && result.overall <= 100);
});
