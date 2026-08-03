import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { createArtifact } from '../src/artifacts.js';
import { buildTuiModel } from '../src/tui-model.js';
import { defaultTuiState, JobosTui, renderTui } from '../src/tui.js';

const AS_OF = '2026-08-02T12:00:00.000Z';
const SIZES = [
  { width: 60, height: 20, name: 'minimum' },
  { width: 80, height: 24, name: 'compact' },
  { width: 120, height: 36, name: 'standard' },
  { width: 160, height: 50, name: 'wide' }
];

const RESUME_SOURCE_LABELS = ['Paste resume text', 'Browse this computer', 'Enter a file path'];
const RESUME_SOURCE_FORMATS = ['TXT', 'Markdown', 'JSON', 'YAML', 'YML', 'PDF', 'DOCX'];

function output(width = 120, height = 36) {
  return {
    columns: width,
    rows: height,
    isTTY: false,
    writes: [],
    write(chunk) { this.writes.push(String(chunk)); },
    on() {},
    off() {}
  };
}

async function fixture(t, { withProfile = false, withJob = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-tui-ux-benchmark-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = await openStore({ workspace: root });
  const profile = withProfile || withJob ? createProfile(store, 'Product Leader').profile : null;
  let job = null;
  if (withJob) {
    const filePath = path.join(root, 'role.md');
    writeFileSync(filePath, [
      'Title: Senior Product Manager',
      'Company: Northstar Learning',
      'Location: Remote',
      '',
      'Lead product discovery and launch improvements for educators.'
    ].join('\n'));
    job = importText(store, { profileId: profile.id, filePath }).job;
  }
  const model = buildTuiModel(store, {
    profileId: profile?.id || null,
    selectedJobId: job?.id || null,
    at: AS_OF
  });
  return { root, store, profile, job, model };
}

function render(model, state, width, height) {
  return renderTui(model, state, { width, height, color: false }).split('\n');
}

function assertFrame(lines, { width, height, name }) {
  assert.equal(lines.length, height, `${name}: frame uses the full terminal height`);
  assert.ok(lines.every(line => stringWidth(line) <= width), `${name}: no row exceeds terminal width`);
  assert.ok(lines.every(line => !line.includes('\u0000')), `${name}: no control-data leak enters visible copy`);
}

function panelRows(lines, title) {
  const start = lines.findIndex(line => line.includes(`┌ ${title}`));
  const end = start < 0 ? -1 : lines.findIndex((line, index) => index > start && line.startsWith('└'));
  return start < 0 ? [] : lines.slice(start, end < 0 ? lines.length : end);
}

/** Drive a full profile capture and assert the atomic save contract. */
async function captureProfile(tui, stdout, name = 'Alex Chen') {
  const stepIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'profile');
  tui.state.overlay = 'setup';
  tui.state.overlayIndex = stepIndex;
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.mode, 'setup-profile', 'profile step opens name capture');
  tui.onKeypress(name, { name: 'paste' });
  stdout.writes.length = 0; // frames from the save onward only
  tui.onKeypress('', { name: 'return' });
}

test('UX-BENCH-01 guided setup is stable at minimum, compact, standard, and wide sizes', async t => {
  const { model } = await fixture(t);
  for (const size of SIZES) {
    const state = { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 };
    const lines = render(model, state, size.width, size.height);
    assertFrame(lines, size);
    const text = lines.join('\n');
    assert.match(text, /GUIDED SETUP/, `${size.name}: setup identity remains visible`);
    assert.match(text, /About you/, `${size.name}: focused task remains visible`);
    assert.match(text, /Enter continue/, `${size.name}: primary action remains visible`);
    assert.match(text, /\? help/, `${size.name}: help remains visible`);
    assert.ok(!text.includes('…'), `${size.name}: setup copy is never truncated with an ellipsis`);
  }
});

test('UX-BENCH-02 every resume-source choice and its format guidance survive compact rendering', async t => {
  const { store } = await fixture(t);
  const tui = new JobosTui(store, { connectAgent: false, stdout: output(60, 24), now: () => new Date(AS_OF) });
  tui.beginSetupSource('resume');
  const lines = render(tui.model, tui.state, 60, 24);
  assertFrame(lines, { width: 60, height: 24, name: 'resume source at minimum' });
  const text = lines.map(line => line.replaceAll('║', '').trim()).join(' ');
  for (const label of RESUME_SOURCE_LABELS) assert.match(text, new RegExp(label), `source choice "${label}" survives compact rendering`);
  for (const format of RESUME_SOURCE_FORMATS) assert.match(text, new RegExp(format), `format guidance "${format}" survives compact rendering`);
});

test('UX-BENCH-03 blocked setup help names both the reason and the recovery', async t => {
  const { model } = await fixture(t);
  const resumeIndex = model.onboarding.steps.findIndex(item => item.id === 'resume');
  const state = {
    ...defaultTuiState(),
    overlay: 'help',
    helpContextOverlay: 'setup',
    helpContextIndex: resumeIndex
  };
  const text = render(model, state, 80, 24).join('\n');
  assert.match(text, /Select a profile before importing a resume/);
  assert.match(text, /Complete profile setup/);
  assert.doesNotMatch(text, /This task is done/);
});

test('UX-BENCH-04 empty dashboard uses one centered welcome surface with a clear primary action', async t => {
  const { model } = await fixture(t);
  const lines = render(model, { ...defaultTuiState(), overlay: null }, 120, 36);
  assertFrame(lines, { width: 120, height: 36, name: 'empty dashboard' });
  const text = lines.join('\n');
  assert.equal(lines.filter(line => line.includes('╔')).length, 1, 'welcome state has one visual container');
  assert.doesNotMatch(text, /┌ JOBS|┌ SELECTED JOB|┌ AGENT/, 'empty state does not render three hollow dashboard panels');
  assert.match(text, /WELCOME TO JOBOS/);
  assert.match(text, /g  Start guided setup/);
  assert.ok(text.indexOf('g  Start guided setup') < text.indexOf('jobos profile create'), 'human-first action precedes the CLI alternative');
  const top = lines.findIndex(line => line.includes('╔'));
  const bottom = lines.findIndex(line => line.includes('╚'));
  assert.ok(top >= 6 && bottom <= 30, 'welcome surface is vertically centered with margin above and below');
  assert.ok(model.recommendedAction?.label === 'Create profile', 'the empty workspace recommends the single first setup step');
});

test('UX-BENCH-05 populated dashboard presents decision summary before hidden technical detail', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false };
  for (const size of SIZES.slice(1)) {
    const lines = render(model, base, size.width, size.height);
    assertFrame(lines, size);
    const text = lines.join('\n');
    assert.match(text, /▶ ACTION/, `${size.name}: priority strip names the action`);
    assert.match(text, /Senior Product Manager/, `${size.name}: selected job stays visible`);
    assert.match(text, /FIT /, `${size.name}: fit summary stays visible`);
    assert.match(text, /READINESS /, `${size.name}: readiness state stays visible`);
    const summaryIndex = text.indexOf('FIT ');
    const detailsIndex = text.indexOf('TECHNICAL DETAILS');
    assert.equal(detailsIndex, -1, `${size.name}: technical details are hidden by default`);
    assert.ok(summaryIndex >= 0, `${size.name}: decision summary renders before any diagnostics`);
  }

  // The e key discloses the same diagnostics on demand and hides them again.
  const tui = new JobosTui((await fixture(t, { withJob: true })).store, {
    connectAgent: false,
    stdout: output(120, 36),
    now: () => new Date(AS_OF)
  });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = model;
  const hidden = render(tui.model, tui.state, 120, 36).join('\n');
  assert.doesNotMatch(hidden, /TECHNICAL DETAILS/, 'technical details hidden by default on the dashboard');
  assert.match(hidden, /e details/, 'the disclosure affordance names the e key');
  tui.onKeypress('e', { name: 'e' });
  assert.equal(tui.state.detailsExpanded, true, 'e expands technical details');
  const shown = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(shown, /TECHNICAL DETAILS/, 'expanded surface shows the technical details block');
  assert.match(shown, /JOB ID /, 'expanded surface shows job identity diagnostics');
  tui.onKeypress('e', { name: 'e' });
  assert.equal(tui.state.detailsExpanded, false, 'e collapses technical details again');
  assert.doesNotMatch(render(tui.model, tui.state, 120, 36).join('\n'), /TECHNICAL DETAILS/, 'details hidden again after collapse');
});

test('UX-BENCH-06 priority hierarchy is a single strip rather than four competing boxes', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const lines = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false }, 140, 42);
  assert.match(lines[1], /PRIORITY  1 of 4/);
  assert.match(lines[2], /▶ ACTION/);
  assert.match(lines[3], /QUEUE  ACTION · INTERVIEW · NEW · FAILURE/);
  assert.ok(lines.slice(1, 4).every(line => !line.includes('┌') && !line.includes('┐')), 'priority hierarchy avoids card chrome');
  const tui = new JobosTui((await fixture(t, { withJob: true })).store, { connectAgent: false, stdout: output(140, 42), now: () => new Date(AS_OF) });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = model;
  for (let index = 0; index < 4; index++) tui.onKeypress('', { name: 'right' });
  assert.equal(tui.state.stripIndex, 0, 'strip cycles through the four cards and wraps to the start');
  tui.onKeypress('', { name: 'right' });
  assert.equal(tui.state.stripIndex, 1, 'strip continues to the second card after wrap');
});

test('UX-BENCH-07 minimum-size navigation keeps dashboard, chat, setup, help, and quit reachable', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id };
  const dashboard = render(model, base, 60, 24).join('\n');
  for (const label of ['Tab chat', 'g setup', '? help', 'Q quit']) assert.match(dashboard, new RegExp(label.replace('?', '\\?')));
  const chat = render(model, { ...base, focusTarget: 'agent' }, 60, 24).join('\n');
  assert.match(chat, /ASSISTANT · FOCUSED/);
  assert.match(chat, /Tab\/Esc dashboard/);
});

test('UX-BENCH-08 optional setup rows report honest readiness states', async t => {
  const { model } = await fixture(t);
  const text = render(model, { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 }, 120, 42).join('\n');
  assert.match(text, /Job discovery  ·  optional/);
  assert.match(text, /Your preferences  ·  optional/);
  assert.match(text, /AI assistant  ·  unavailable/);
  assert.match(text, /Connections  ·  optional/);
  assert.doesNotMatch(text, /AI assistant  ·  ready/);
});

test('UX-BENCH-09 one recommended action is consistent across priority, selected, readiness, and setup', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const label = model.recommendedAction?.label;
  assert.ok(label && label.length > 0, 'model exposes a single recommended action label');
  const dash = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false }, 120, 36).join('\n');
  assert.match(dash, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'priority strip names the same action');
  assert.match(dash, /▶ NEXT/, 'selected-job surface leads with a NEXT block');
  const selectedRows = panelRows(dash.split('\n'), 'SELECTED JOB');
  assert.ok(selectedRows.some(row => row.includes(label)), 'selected NEXT block names the same action');

  const expanded = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, detailsExpanded: true, agentOn: false }, 140, 42).join('\n');
  assert.match(expanded, new RegExp(`next ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'readiness summary names the same action');

  const setup = render(model, { ...defaultTuiState(), overlay: 'setup', overlayIndex: 0 }, 120, 36).join('\n');
  assert.match(setup, new RegExp(`RECOMMENDED NEXT · ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'setup progress names the same action');

  const tui = new JobosTui((await fixture(t, { withJob: true })).store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = model;
  tui.openHelp();
  const help = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(help, /RECOMMENDED NEXT ACTION/, 'help surface leads with the recommended action');
  assert.ok(help.includes(label), 'context help names the same recommended action');
});

test('UX-BENCH-10 panel geometry is aligned across breakpoints and surfaces', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false };
  for (const size of SIZES.slice(1)) {
    const lines = render(model, base, size.width, size.height);
    assertFrame(lines, size);
    const tops = lines.map((line, index) => (/┌/.test(line) ? index : -1)).filter(index => index >= 0);
    const bottoms = lines.map((line, index) => (/└/.test(line) ? index : -1)).filter(index => index >= 0);
    assert.equal(tops.length, bottoms.length, `${size.name}: every panel opens and closes in the same frame`);
    assert.ok(tops.every((top, index) => top < bottoms[index]), `${size.name}: each panel opens before it closes`);
    for (let index = 0; index < tops.length; index++) {
      const top = lines[tops[index]];
      const bottom = lines[bottoms[index]];
      const topBorders = [...top].map((char, col) => (char === '┌' ? col : -1)).filter(col => col >= 0);
      for (const col of topBorders) {
        assert.ok(col < stringWidth(bottom), `${size.name}: panel ${index} left border ${col} exists in its close row`);
        assert.equal(bottom[col] || bottom[col - 1], '└', `${size.name}: panel ${index} closes under its open border`);
      }
    }
  }

  const setup = render(model, { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 }, 80, 24);
  assertFrame(setup, { width: 80, height: 24, name: 'setup at compact' });
  const setupTop = setup.findIndex(line => line.includes('╔'));
  const setupBottom = setup.findIndex(line => line.includes('╚'));
  assert.ok(setupTop >= 1 && setupBottom <= 23, 'setup panel fits inside the workspace with vertical margin');
  assert.ok(setupBottom - setupTop >= 10, 'setup panel is tall enough to present the step list');

  const chat = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, focusTarget: 'agent', agentOn: true }, 120, 36);
  assertFrame(chat, { width: 120, height: 36, name: 'chat focus' });
});

test('UX-BENCH-11 job list and detail panels reorder information by priority as width shrinks', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, agentOn: false };
  const label = model.recommendedAction.label;

  for (const width of [160, 120]) {
    const rows = panelRows(render(model, base, width, 42), 'JOBS');
    assert.ok(rows.some(row => row.includes('Senior Product Manager')), `${width}: job card keeps the title`);
    assert.ok(rows.some(row => row.includes('Northstar Learning')), `${width}: job card keeps the company`);
    assert.ok(rows.some(row => row.includes(`NEXT ${label}`)), `${width}: job card leads with the recommended action`);
  }

  const compact = panelRows(render(model, base, 80, 24), 'JOBS');
  assert.ok(compact.some(row => row.includes('Senior Product Manager')), '80: job card keeps the title');
  assert.ok(compact.some(row => row.includes(`NEXT ${label}`)), '80: job card keeps the recommended action');
  assert.ok(!compact.some(row => row.includes('Northstar Learning')), '80: company line is dropped before the recommended action');

  const minimum = panelRows(render(model, base, 60, 20), 'JOBS');
  assert.ok(minimum.some(row => row.includes('Senior Product Manager')), '60: job card keeps the title');
  assert.ok(!minimum.some(row => row.includes('Northstar Learning')), '60: decorative company line is dropped');
});

test('UX-BENCH-12 dashboard and setup copy stay compact without ellipsis truncation', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const base = { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id };
  for (const size of SIZES) {
    const dashboard = render(model, base, size.width, size.height);
    assertFrame(dashboard, size);
    assert.ok(!dashboard.join('\n').includes('…'), `${size.name}: dashboard copy is wrapped, never truncated with an ellipsis`);
    const setup = render(model, { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 }, size.width, size.height);
    assertFrame(setup, size);
    assert.ok(!setup.join('\n').includes('…'), `${size.name}: setup copy is wrapped, never truncated with an ellipsis`);
  }
});

test('UX-BENCH-13 clicking an actionable row dispatches the same Enter action, gates included', async t => {
  const { store, model, profile, job } = await fixture(t, { withJob: true });
  const tui = new JobosTui(store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = model;
  const clickTerm = term => {
    tui.render();
    const lines = render(tui.model, tui.state, 120, 36);
    const y = lines.findIndex(line => line.includes(term));
    assert.ok(y >= 0, `row for "${term}" renders`);
    const x = lines[y].indexOf(term);
    tui.onMouseData(`\x1b[<0;${x + 1};${y + 1}M`);
  };

  // Clicking an overlay row runs the same handler Enter runs: the resume step
  // opens its source chooser.
  tui.state.overlay = 'setup';
  tui.state.overlayIndex = model.onboarding.steps.findIndex(step => step.id === 'resume');
  clickTerm('Your resume');
  assert.equal(tui.state.overlay, 'setup-resume-source', 'click on the resume step opens the source chooser exactly like Enter');

  // Consequential rows still pass through the confirmation gate.
  tui.state.overlay = 'setup';
  tui.state.overlayIndex = model.onboarding.steps.findIndex(step => step.id === 'decision');
  tui.state.pendingConfirm = null;
  clickTerm('Check the fit');
  assert.equal(tui.state.pendingConfirm?.kind, 'setup-domain-action', 'click on a consequential action lands on the confirm gate, not the action');

  // The profile picker applies its selection the same way Enter does.
  tui.state.overlay = 'setup-profile-picker';
  tui.state.overlayIndex = 0;
  tui.state.pendingConfirm = null;
  clickTerm('Product Leader');
  assert.equal(tui.state.overlay, 'setup', 'click on a profile row selects it and returns to setup');
  assert.match(tui.state.status, /Selection saved/, 'picker click reports the selection outcome');

  // The file browser opens folders with one click, exactly like Enter.
  tui.state.setupFilePurpose = 'resume';
  tui.setupFiles(store.root, 'resume');
  tui.state.overlay = 'setup-file-browser';
  tui.state.overlayIndex = 0;
  clickTerm(store.root.split('/').pop());
  assert.equal(tui.state.setupBrowseCwd, store.root, 'clicking a folder entry opens it like Enter');

  // Dashboard job rows remain selectors: click selects, Enter then jumps.
  const dash = new JobosTui(store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  dash.state.profileId = profile.id;
  dash.state.selectedJobId = null;
  dash.model = buildTuiModel(store, { profileId: profile.id, selectedJobId: null, at: AS_OF });
  dash.render();
  const lines = render(dash.model, dash.state, 120, 36);
  const y = lines.findIndex(line => line.includes('Senior Product Manager'));
  const x = lines[y].indexOf('Senior Product Manager');
  dash.onMouseData(`\x1b[<0;${x + 1};${y + 1}M`);
  assert.equal(dash.state.selectedJobId, job.id, 'click on a job row selects the job');
  assert.equal(dash.state.overlay, null, 'job-row click does not dispatch a domain action');
});

test('UX-BENCH-14 file browser opens on Home and offers Home, Documents, Downloads, and working-directory shortcuts', async t => {
  const { store, model } = await fixture(t);
  // Deterministic HOME: the browser must open there and offer the standard
  // quick rows even when the fixture workspace is elsewhere.
  const fakeHome = mkdtempSync(path.join(tmpdir(), 'jobos-fake-home-'));
  mkdirSync(path.join(fakeHome, 'Documents'));
  mkdirSync(path.join(fakeHome, 'Downloads'));
  const previousHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    process.env.HOME = previousHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  const tui = new JobosTui(store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  tui.model = model;
  tui.state.setupFilePurpose = 'resume';

  // A fresh browser session starts at the home directory, never at cwd.
  const items = tui.setupFiles();
  assert.equal(tui.state.setupBrowseCwd, fakeHome, 'fresh browser opens at the home directory');
  const labels = items.filter(item => item.quick).map(item => item.label);
  for (const label of ['Home', 'Documents', 'Downloads', 'Working directory']) {
    assert.ok(labels.includes(label), `browser offers the "${label}" shortcut`);
  }
  assert.ok(labels.indexOf('Home') < labels.indexOf('Working directory'), 'Home and Working directory are always offered');

  // Navigating elsewhere is remembered for the next open.
  tui.setupFiles(store.root, 'resume');
  assert.equal(tui.state.setupBrowseCwd, store.root, 'explicit navigation is remembered');
  tui.setupFiles(undefined, 'resume');
  assert.equal(tui.state.setupBrowseCwd, store.root, 'reopening the browser restores the remembered folder');

  // Quick rows are visible in the rendered browser. tui.render() must run
  // first so onMouseData resolves clicks against a fresh lastFrame.
  tui.state.overlay = 'setup-file-browser';
  tui.render();
  const text = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(text, /Quick  Home/, 'browser renders the Home quick row');
  assert.match(text, /Quick  Working directory/, 'browser renders the Working directory quick row');

  // Clicking a quick row navigates there like Enter would.
  const lines = render(tui.model, tui.state, 120, 36);
  const y = lines.findIndex(line => line.includes('Quick  Home'));
  assert.ok(y >= 0, 'Home quick row renders for clicking');
  const x = lines[y].indexOf('Home');
  tui.onMouseData(`\x1b[<0;${x + 1};${y + 1}M`);
  assert.equal(tui.state.setupBrowseCwd, fakeHome, 'click on Home quick row navigates home');
});

test('UX-BENCH-15 profile save, setup refresh, and resume-step advance are atomic', async t => {
  const { store, model } = await fixture(t);
  const stdout = output(120, 36);
  const tui = new JobosTui(store, { connectAgent: false, stdout, now: () => new Date(AS_OF) });
  tui.model = model;

  await captureProfile(tui, stdout);
  assert.equal(tui.state.overlay, 'setup', 'profile save returns to the setup workspace');
  assert.ok(tui.state.profileId && tui.state.setupProfileId, 'profile save records the created profile');
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'resume', 'profile save advances focus to the next required step');
  // The save must paint exactly one frame; inspect the actual painted screen
  // (lastScreen) per line so a ▶ marker from one row can never leak onto an
  // unselected row via a newline-less diff write.
  assert.equal(stdout.writes.length, 1, 'profile save paints exactly one frame');
  const frame = (tui.lastScreen || stdout.writes[0]).split('\n');
  assert.ok(frame.some(line => line.includes('▶') && line.includes('Your resume')), 'the saved workspace renders the resume step as focused');
  assert.ok(!frame.some(line => line.includes('▶') && line.includes('About you')), 'profile save never puts the focus marker on the completed step');
  assert.match(stdout.writes[0], /RECOMMENDED NEXT/, 'the final painted frame is the updated setup workspace');

  // r refresh rebuilds the projection in one frame and lands on the next task.
  stdout.writes.length = 0;
  tui.onKeypress('r', { name: 'r' });
  assert.ok(stdout.writes.length <= 1, 'setup refresh paints at most one frame');
  assert.equal(tui.model.onboarding.steps[tui.state.overlayIndex].id, 'resume', 'refresh focuses the recommended task');
  assert.match(tui.lastScreen, /Your resume/, 'refreshed screen shows the recommended task focused');

  // Opening the resume task from the updated workspace advances directly
  // into its source chooser without exposing an intermediate profile frame.
  const tui2 = new JobosTui(store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  tui2.state.overlay = 'setup';
  tui2.state.overlayIndex = tui2.model.onboarding.steps.findIndex(step => step.id === 'resume');
  tui2.onKeypress('', { name: 'return' });
  assert.equal(tui2.state.overlay, 'setup-resume-source', 'resume step advances into its source chooser');
});

test('UX-BENCH-16 artifact evidence stays hidden until the docs surface expands it', async t => {
  const { store, model, profile, job } = await fixture(t, { withJob: true });
  createArtifact(store, {
    profileId: profile.id,
    jobId: job.id,
    type: 'resume',
    path: 'resume.md',
    title: 'Resume draft',
    content: '# Resume\n\nAlex Chen - product leader.',
    evidence: ['proof_1'],
    warnings: ['draft needs review']
  });
  const withDocs = buildTuiModel(store, { profileId: profile.id, selectedJobId: job.id, at: AS_OF });
  const tui = new JobosTui(store, { connectAgent: false, stdout: output(120, 36), now: () => new Date(AS_OF) });
  tui.state.profileId = profile.id;
  tui.state.selectedJobId = job.id;
  tui.model = withDocs;
  tui.openDocuments();
  const hidden = render(tui.model, tui.state, 120, 36).join('\n');
  assert.doesNotMatch(hidden, /EVIDENCE/, 'artifact evidence is hidden by default');
  assert.doesNotMatch(hidden, /WARNINGS/, 'artifact warnings are hidden by default');
  tui.onKeypress('I', { name: 'i', shift: true });
  assert.equal(tui.state.docsEvidenceExpanded, true, 'I expands the docs evidence surface');
  const shown = render(tui.model, tui.state, 120, 36).join('\n');
  assert.match(shown, /EVIDENCE/, 'expanded docs surface shows evidence');
  assert.match(shown, /WARNINGS/, 'expanded docs surface shows warnings');
  assert.doesNotMatch(shown, /TECHNICAL DETAILS/, 'docs evidence is a separate surface from dashboard technical details');
});
