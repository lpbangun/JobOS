import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import React from 'react';
import { renderToString } from 'ink';
import stringWidth from 'string-width';
import { openStore, run, save } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { appCreate } from '../src/tracking.js';
import { createArtifact } from '../src/artifacts.js';
import { buildTuiModel } from '../src/tui-model.js';
import { CLASSIC_THEME, defaultTuiState, JobosTui, renderTui } from '../src/tui.js';
import { SLASH_CATALOG, actionChip, newRows, jobRows, hitTestGrid, setupStepViews } from '../src/tui/model.js';

const AS_OF = '2026-08-02T12:00:00.000Z';
const SIZES = [
  { width: 60, height: 20, name: 'minimum' },
  { width: 80, height: 24, name: 'compact' },
  { width: 120, height: 36, name: 'standard' },
  { width: 160, height: 50, name: 'wide' }
];

async function fixture(t, { withJob = false, withApplication = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-tui-ux-benchmark-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = withJob ? createProfile(store, 'Product Leader').profile : null;
  let job = null;
  if (withJob) {
    const filePath = path.join(root, 'role.md');
    writeFileSync(filePath, [
      'Title: Senior Product Manager',
      'Company: Westbrook Learning',
      'Location: Remote',
      '',
      'Lead product discovery and launch improvements for educators.'
    ].join('\n'));
    job = importText(store, { profileId: profile.id, filePath }).job;
    if (withApplication) appCreate(store, job.id, 'materials-ready', '', { at: AS_OF });
  }
  const model = buildTuiModel(store, {
    profileId: profile?.id || null,
    selectedJobId: job?.id || null,
    at: AS_OF
  });
  return { root, store, profile, job, model };
}

function makeTui(store, profileId, jobId) {
  const tui = new JobosTui(store, {
    ...streams(),
    profileId,
    selectedJobId: jobId || null,
    connectAgent: false,
    color: false
  });
  tui.refresh();
  return tui;
}

function streams() {
  const stdout = new PassThrough();
  stdout.columns = 120;
  stdout.rows = 36;
  stdout.isTTY = false;
  const stdin = new PassThrough();
  stdin.isTTY = false;
  return { stdin, stdout };
}

function render(model, state, width, height) {
  return renderTui(model, state, { width, height, color: false }).split('\n');
}

function assertFrame(lines, { width, height, name }) {
  assert.ok(lines.length > 0, `${name}: frame renders content`);
  assert.ok(lines.length <= height, `${name}: frame never exceeds the terminal height`);
  assert.ok(lines.every(line => stringWidth(line) <= width), `${name}: no row exceeds terminal width`);
  assert.ok(lines.every(line => !line.includes('\u0000')), `${name}: no control-data leak enters visible copy`);
  assert.ok(lines.every(line => !/\u0001|\u0002|\u0007/.test(line)), `${name}: no stray control bytes in visible copy`);
}

const RETIRED_CHROME = [
  /┌ JOBS/,
  /SELECTED JOB/,
  /┌ ASSISTANT/,
  /\[today\]/,
  /:answer add/,
  /:packet create/,
  /:story-verify/,
  /:debrief/,
  /JOBOS ·/,
  /spike:ink/,
  /Northstar Learning|Harbor Schools|Example Learning Co|Contoso Careers Lab|Lumen Labs/,
  /\bFIT\s+\d+/
];

function assertNoRetiredChrome(text, name) {
  for (const pattern of RETIRED_CHROME) {
    assert.doesNotMatch(text, pattern, `${name}: retired chrome "${pattern}" must not be painted`);
  }
}

test('UX-BENCH-01 the locked Classic red theme token set is exact', () => {
  assert.equal(CLASSIC_THEME.name, 'classic-red');
  assert.equal(CLASSIC_THEME.bg, '#111111');
  assert.equal(CLASSIC_THEME.panel, '#161616');
  assert.equal(CLASSIC_THEME.accent, '#ff6b6b');
  assert.equal(CLASSIC_THEME.ink, '#111111');
  assert.equal(CLASSIC_THEME.text, '#f5f5f5');
  assert.equal(CLASSIC_THEME.muted, '#c8c8c8');
  assert.equal(CLASSIC_THEME.mono, 'JetBrains Mono, Menlo, ui-monospace, monospace');
  assert.deepEqual(CLASSIC_THEME.fontFamily, ['JetBrains Mono', 'Menlo', 'ui-monospace', 'monospace']);
  assert.deepEqual(CLASSIC_THEME.wordmark, { job: '#f5f5f5', os: '#ff6b6b' });
  // Not Charm green, not the Ink-spike cyan/purple theme.
  assert.notEqual(CLASSIC_THEME.accent.toLowerCase(), '#50fa7b');
  assert.notEqual(CLASSIC_THEME.accent.toLowerCase(), '#00d4ff');
  assert.notEqual(CLASSIC_THEME.bg.toLowerCase(), '#282a36');
});

test('UX-BENCH-02 the shell keeps every frame inside width x height at minimum, compact, standard, and wide sizes', async t => {
  const { model } = await fixture(t);
  for (const size of SIZES) {
    const welcome = render(model, { ...defaultTuiState(), overlay: 'welcome' }, size.width, size.height);
    assertFrame(welcome, size);
    assertNoRetiredChrome(welcome.join('\n'), `${size.name} welcome`);

    const setup = render(model, { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 }, size.width, size.height);
    assertFrame(setup, size);
    assertNoRetiredChrome(setup.join('\n'), `${size.name} setup`);
  }
});

test('UX-BENCH-03 header is Job + OS wordmark with Workspace | Jobs modes and company as context', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  const lines = render(tui.model, tui.state, 120, 36).join('\n');

  assert.match(lines, /JobOS/, 'wordmark JobOS with no space');
  assert.doesNotMatch(lines, /JOBOS ·/, 'retired JOBOS · header is gone');
  assert.match(lines, /Workspace/, 'header mode Workspace is present');
  assert.match(lines, /Jobs/, 'header mode Jobs is present');
  assert.match(lines, /Westbrook Learning/, 'company is header context for the selected listing');

  const workspace = render(tui.model, { ...tui.state, headerMode: 'workspace' }, 120, 36).join('\n');
  assert.match(workspace, /JobOS/, 'workspace header keeps the wordmark');
  assert.match(workspace, /Workspace/, 'workspace mode stays highlighted as the active mode');
  assert.doesNotMatch(workspace, /Westbrook Learning/, 'company context is listing-scoped, not workspace-wide');
});

test('UX-BENCH-04 left rail is New | Jobs and job rows carry action chips, not numeric FIT', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true });
  const tui = makeTui(store, profile.id, job.id);
  tui.state.leftMode = 'new';
  const newText = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(newText, /New/, 'New rail segment is present');
  assert.match(newText, /Jobs/, 'Jobs rail segment is present');
  assert.doesNotMatch(newText, /\b\d+\/100\b/, 'rail rows never show a numeric fit score');

  // A pipeline job with an application shows a real action chip instead.
  appCreate(store, job.id, 'saved', '', { at: AS_OF });
  tui.refresh();
  tui.state.leftMode = 'jobs';
  const jobsText = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(jobsText, /Create files|Find people|Needs review|Due follow-up/, 'Jobs rows show an action chip');
  assert.doesNotMatch(jobsText, /\bFIT\s+\d+/, 'numeric FIT is not the row action');
});

test('UX-BENCH-05 action chip precedence is deterministic and null when nothing is actionable', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true });
  const chip = () => {
    const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
    return actionChip(model, model.jobs.find(item => item.id === job.id));
  };
  assert.equal(chip(), 'Create files', 'no artifacts yet -> Create files');

  createArtifact(store, {
    jobId: job.id,
    profileId: profile.id,
    type: 'resume',
    path: `jobs/${job.id}/artifacts/resume.md`,
    title: 'Tailored resume',
    content: 'Draft.',
    evidence: [],
    warnings: []
  });
  assert.equal(chip(), 'Find people', 'artifacts exist but no outreach path -> Find people');

  run(store, `INSERT INTO outreach_plans (id,job_id,profile_id,stakeholder_id,contact_point_id,goal,channel,path_strength,recommended,reasoning_json,warnings_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, [
    'plan_ux', job.id, profile.id, null, null, 'informational', 'email', 'strong', 1, '{}', '[]', AS_OF
  ]);
  save(store);
  assert.equal(chip(), null, 'artifacts and a path exist -> nothing actionable');

  const model = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
  const rows = jobRows(model);
  assert.equal(rows.some(row => row.id === job.id), false, 'no application and no saved status -> not on the Jobs rail');
  assert.equal(newRows(model).some(row => row.id === job.id), true, 'imported listing -> on the New rail');
});

test('UX-BENCH-06 the right pane has equal Job | People | Chat tabs and the composer exists only on Chat and Workspace', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  tui.state.jobTab = 'job';
  const jobPane = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(jobPane, /Job/, 'Job tab present');
  assert.match(jobPane, /People/, 'People tab present');
  assert.match(jobPane, /Chat/, 'Chat tab present');
  assert.doesNotMatch(jobPane, /Ask about /, 'no composer on the Job pane');
  assert.doesNotMatch(jobPane, /❯/, 'no prompt glyph on the Job pane');

  tui.state.jobTab = 'people';
  const peoplePane = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(peoplePane, /PEOPLE · THIS JOB/, 'People pane is listing-scoped');
  assert.doesNotMatch(peoplePane, /Network/, 'no Network button on the People pane');
  assert.doesNotMatch(peoplePane, /Ask about /, 'no composer on the People pane');

  tui.state.jobTab = 'chat';
  const chatPane = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(chatPane, /Ask about Westbrook Learning/, 'Chat pane owns the this-job composer');
  assert.match(chatPane, /❯/, 'composer prompt is visible on Chat');

  const workspace = render(tui.model, { ...tui.state, headerMode: 'workspace' }, 120, 36).join('\n');
  assert.match(workspace, /Workspace — the whole search/, 'Workspace is whole-search chat');
  assert.match(workspace, /Ask about the search/, 'workspace composer is present');
  assert.doesNotMatch(workspace, /PEOPLE · THIS JOB/, 'workspace has no job-scoped panes');
});

test('UX-BENCH-07 the footer is a hint, not a launcher, and names Tab and the slash hint', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  const text = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(text, /\/ in Chat/, 'footer is a slash hint, not a launcher');
  assert.match(text, /Tab/, 'Tab is advertised');
  assert.match(text, /Job · People · Chat/, 'Tab cycles Job · People · Chat');
  assert.match(text, /Esc/, 'Esc is advertised');
  assert.doesNotMatch(text, /:packet|:answer|:prep/, 'no colon command bar in the footer');
});

test('UX-BENCH-08 every overlay in the family renders its locked identity without retired panes', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  const expectations = {
    welcome: /WELCOME TO JOBOS/,
    setup: /SET UP JOBOS/,
    'setup-resume-source': /SETUP · YOUR RESUME/,
    'setup-job-source': /SETUP · ADD A JOB YOU LIKE/,
    files: /FILES · THIS JOB/,
    tracker: /TRACKER · THIS JOB/,
    review: /THIS MORNING/,
    network: /NETWORK · PROFILE/,
    memory: /CAREER MEMORY/
  };
  for (const [overlay, expected] of Object.entries(expectations)) {
    const state = { ...tui.state, overlay };
    const text = render(tui.model, state, 120, 38).join('\n');
    assert.match(text, expected, `${overlay} overlay must render its locked identity`);
    assertNoRetiredChrome(text, overlay);
  }
});

test('UX-BENCH-09 first-run empty state is honest and never invents jobs, companies, or fit scores', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-ux-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const tui = makeTui(store, null, null);
  const text = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(text, /welcome to jobos/i, 'welcome overlay is first-run chrome');
  assert.match(text, /Start guided setup/, 'welcome offers guided setup');
  assert.match(text, /Skip for now/, 'welcome offers a skip path');
  assert.doesNotMatch(text, /Westbrook Learning|Harbor Schools|Example Learning Co|Contoso Careers Lab|Lumen Labs/, 'empty workspace must not invent visualizer mock listings');
  assert.doesNotMatch(text, /Acme|Contoso/, 'empty workspace must not invent companies');
  assertNoRetiredChrome(text, 'empty first-run');
  // The controller boundary keeps the empty flags honest on a genuinely empty store.
  assert.equal(tui.model.empty.noProfile, true);
  assert.equal(tui.model.empty.noJobs, true);
});

test('UX-BENCH-WELCOME-FOOTER effective welcome hides navigation structures and rail hints until dismissal', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-ux-welcome-footer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const tui = makeTui(store, null, null);
  const lines = state => render(tui.model, state, 140, 42);
  const railHint = line => /\bn\s+New\b.*\bj\s+Jobs\b/.test(line);
  const railTabs = line => /\bNew\b.*\bJobs\b/.test(line) && !railHint(line);
  const paneTabs = line => /\bJob\b.*\bPeople\b.*\bChat\b/.test(line) && !/\bTab\b/.test(line);

  const welcome = lines(tui.state);
  assert.match(welcome.join('\n'), /WELCOME TO JOBOS|Welcome to JobOS/, 'effective first-run welcome is open');
  assert.equal(welcome.some(railHint), false, 'welcome footer omits the n New / j Jobs hints');
  assert.equal(welcome.some(railTabs), false, 'welcome covers the structural New | Jobs rail tabs');
  assert.equal(welcome.some(paneTabs), false, 'welcome covers the structural Job | People | Chat pane tabs');

  const dismissed = lines({ ...tui.state, welcomeDismissed: true });
  assert.ok(dismissed.some(railHint), 'dismissed board restores the documented n New / j Jobs footer hints');
  assert.ok(dismissed.some(railTabs), 'dismissed board restores the structural New | Jobs rail tabs');
  assert.ok(dismissed.some(paneTabs), 'dismissed board restores the structural Job | People | Chat pane tabs');
});

test('UX-BENCH-10 working turns are visible in the header and the status line stays local', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  tui.state.working = true;
  const text = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(text, /working/, 'header shows working while a domain/ACP turn is busy');
  tui.state.working = false;
  const idle = render(tui.model, tui.state, 120, 36).join('\n');
  assert.doesNotMatch(idle, / working /, 'working badge clears when idle');
  assert.match(idle, /Ready · local workspace/, 'status line states the local workspace');
});

test('UX-BENCH-11 renderTui bounds width and height defensively and never throws', async t => {
  const { model } = await fixture(t);
  for (const [width, height] of [[20, 5], [60, 20], [200, 100]]) {
    const lines = renderTui(model, defaultTuiState(), { width, height, color: false }).split('\n');
    assert.ok(lines.length > 0 && lines.length <= height, `height bounded at ${width}x${height}`);
    assert.ok(lines.every(line => stringWidth(line) <= width), `width bounded at ${width}x${height}`);
  }
});

test('UX-BENCH-12 the slash catalog is locked and every command routes to a live handler', async t => {
  assert.deepEqual(SLASH_CATALOG.map(item => item.id), [
    'create-files', 'find-people', 'network', 'tracker', 'review', 'daily', 'chat', 'jobs', 'workspace', 'memory', 'setup'
  ]);
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  // Navigation and overlay routes are synchronous; the domain-heavy routes
  // (create-files, find-people) are proven end-to-end in their own files.
  for (const id of ['daily', 'chat', 'jobs', 'workspace', 'memory', 'setup', 'review', 'tracker', 'network']) {
    assert.doesNotThrow(() => tui.runSlash(id), `runSlash(${id}) must route to a live handler`);
  }
  tui.runSlash('jobs');
  assert.equal(tui.state.headerMode, 'jobs', '/jobs returns to the board');
  tui.runSlash('workspace');
  assert.equal(tui.state.headerMode, 'workspace', '/workspace opens whole-search chat');
  tui.runSlash('tracker');
  assert.equal(tui.state.overlay, 'tracker', '/tracker opens the tracker overlay');
  // An unknown command is not a silent no-op.
  tui.runSlash('not-a-command');
  assert.match(tui.state.status, /No matching command/);
});

test('UX-BENCH-13 the production @inkjs/ui tree is mounted: ThemeProvider + INKUI_THEME + Spinner render real output', async t => {
  // Facade exports must be the real mounted @inkjs/ui primitives, not theme constants or source text.
  const { INKUI_THEME, ThemeProvider, Spinner } = await import('../src/tui.js');
  assert.equal(typeof ThemeProvider, 'function', 'ThemeProvider is the real @inkjs/ui facade export');
  assert.equal(typeof Spinner, 'function', 'Spinner is the real @inkjs/ui facade export');
  assert.equal(INKUI_THEME.components.Badge.styles.container().backgroundColor, CLASSIC_THEME.accent, 'Badge inherits the Classic red accent');
  assert.equal(INKUI_THEME.components.Spinner.styles.frame().color, CLASSIC_THEME.accent, 'Spinner inherits the Classic red accent');
  assert.equal(INKUI_THEME.components.Spinner.styles.label().color, CLASSIC_THEME.accent, 'Spinner label inherits the Classic red accent');

  // A real working snapshot: mount the exported facade components and paint output.
  const widget = renderToString(
    React.createElement(ThemeProvider, { theme: INKUI_THEME },
      React.createElement(Spinner, { label: 'working' })),
    { columns: 40 }
  );
  assert.match(String(widget), /working/, 'the mounted @inkjs/ui Spinner paints its label through the facade ThemeProvider');

  // The product shell mounts the same widget in the header while a domain turn is busy.
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  const tui = makeTui(store, profile.id, job.id);
  tui.state.working = true;
  const header = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(header, /working/, 'the App header mounts the @inkjs/ui Spinner while working');
});

test('UX-BENCH-14 the frozen 140x42 SGR hit-rects map to the actions the frame paints', async t => {
  const { store, profile, job } = await fixture(t, { withJob: true, withApplication: true });
  // Seed a second pipeline job so the rail paints a second row: the frozen
  // rail-row cell (10,5) is visual index 1 and must map to a real row.
  const secondFile = path.join(store.root, 'second-role.md');
  writeFileSync(secondFile, [
    'Title: Senior Product Manager II',
    'Company: Westbrook Learning',
    'Location: Remote',
    '',
    'Launch a second learning program for educators.'
  ].join('\n'));
  const second = importText(store, { profileId: profile.id, filePath: secondFile }).job;
  appCreate(store, second.id, 'materials-ready', '', { at: AS_OF });
  const tui = makeTui(store, profile.id, job.id);
  tui.state.welcomeDismissed = true;
  tui.state.headerMode = 'jobs';
  tui.state.leftMode = 'jobs';
  tui.state.jobTab = 'job';
  tui.refresh();
  const frame = render(tui.model, tui.state, 140, 42);
  const joint = frame.join('\n');
  // The frame really paints the mode segs, rail segs, pane tabs, and rows the
  // hit-test grid targets at the frozen coordinates.
  assert.match(joint, /Workspace/, 'header paints Workspace mode');
  assert.match(joint, /Jobs/, 'header paints Jobs mode');
  const row2 = frame[1] || '';
  assert.match(row2, /New/, 'row 2 paints the New rail seg');
  assert.match(row2, /Job/, 'row 2 paints the Job pane tab');
  assert.match(row2, /People/, 'row 2 paints the People pane tab');
  assert.match(row2, /Chat/, 'row 2 paints the Chat pane tab');

  const grid = { width: 140, height: 42 };
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 124, 1, grid), { action: 'setHeaderMode', value: 'workspace' }, 'header Workspace seg');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 137, 1, grid), { action: 'setHeaderMode', value: 'jobs' }, 'header Jobs seg');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 12, 2, grid), { action: 'setLeftMode', value: 'new' }, 'rail New seg');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 36, 2, grid), { action: 'setLeftMode', value: 'jobs' }, 'rail Jobs seg');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 53, 2, grid), { action: 'setJobTab', value: 'job' }, 'Job pane tab');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 63, 2, grid), { action: 'setJobTab', value: 'people' }, 'People pane tab');
  assert.deepEqual(hitTestGrid(tui.model, tui.state, 73, 2, grid), { action: 'setJobTab', value: 'chat' }, 'Chat pane tab');

  // The rail row click targets the visual row under the cursor (row 3 = first
  // painted rail row, row 5 = second) regardless of fixture insertion order.
  const railHit = hitTestGrid(tui.model, tui.state, 10, 5, grid);
  assert.equal(railHit.action, 'selectRow', 'the second painted rail row is a selectRow hit');
  assert.equal(railHit.index, 1, 'the second painted rail row carries visual index 1');

  // Setup overlay: the centered step rows are clickable and map to overlayIndex.
  const setupState = { ...tui.state, overlay: 'setup', overlayIndex: 0 };
  const steps = setupStepViews(tui.model);
  assert.ok(steps.length > 5, 'the setup overlay has enough steps to cover the frozen cell');
  assert.deepEqual(hitTestGrid(tui.model, setupState, 60, 20, grid), { action: 'setOverlayIndex', index: 5 }, 'setup step row click maps to overlayIndex 5');

  // Composer: the bottom row inside the main pane dispatches submitComposer.
  const chatState = { ...tui.state, jobTab: 'chat', headerMode: 'jobs', input: 'send this grounded question' };
  assert.deepEqual(hitTestGrid(tui.model, chatState, 135, 40, grid), { action: 'submitComposer' }, 'composer send click dispatches submitComposer');

  // A miss stays a no-op: no action descriptor is invented for empty chrome.
  assert.equal(hitTestGrid(tui.model, tui.state, 5, 8, grid), null, 'unmapped cells are a no-op');
});
