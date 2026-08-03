import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import { importText } from '../src/jobs.js';
import { buildTuiModel } from '../src/tui-model.js';
import { defaultTuiState, JobosTui, renderTui } from '../src/tui.js';

const AS_OF = '2026-08-02T12:00:00.000Z';
const SIZES = [
  { width: 60, height: 20, name: 'minimum' },
  { width: 80, height: 24, name: 'compact' },
  { width: 120, height: 36, name: 'standard' },
  { width: 160, height: 50, name: 'wide' }
];

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

test('UX-BENCH-01 guided setup is stable at minimum, compact, standard, and wide sizes', async t => {
  const { model } = await fixture(t);
  for (const size of SIZES) {
    const state = { ...defaultTuiState(), overlay: 'setup', overlayIndex: 1 };
    const lines = render(model, state, size.width, size.height);
    assertFrame(lines, size);
    assert.match(lines.join('\n'), /GUIDED SETUP/, `${size.name}: setup identity remains visible`);
    assert.match(lines.join('\n'), /About you/, `${size.name}: focused task remains visible`);
    assert.match(lines.join('\n'), /Enter continue/, `${size.name}: primary action remains visible`);
    assert.match(lines.join('\n'), /\? help/, `${size.name}: help remains visible`);
  }
});

test('UX-BENCH-02 every resume-source choice and its format guidance survive compact rendering', async t => {
  const { store } = await fixture(t);
  const tui = new JobosTui(store, { connectAgent: false, stdout: { columns: 60, rows: 24, isTTY: false, write() {}, on() {}, off() {} }, now: () => new Date(AS_OF) });
  tui.beginSetupSource('resume');
  const text = render(tui.model, tui.state, 60, 24).map(line => line.replaceAll('║', '').trim()).join(' ');
  for (const label of ['Paste resume text', 'Browse this computer', 'Enter a file path']) assert.match(text, new RegExp(label));
  for (const format of ['TXT', 'Markdown', 'JSON', 'YAML', 'YML', 'PDF', 'DOCX']) assert.match(text, new RegExp(format));
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
});

test('UX-BENCH-05 populated dashboard presents hierarchy before technical detail', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const state = {
    ...defaultTuiState(),
    profileId: profile.id,
    selectedJobId: job.id,
    agentState: 'ready'
  };
  for (const size of SIZES.slice(1)) {
    const lines = render(model, state, size.width, size.height);
    assertFrame(lines, size);
    const text = lines.join('\n');
    assert.match(text, /PRIORITY|ACTION/);
    assert.match(text, /Senior Product Manager/);
    assert.match(text, /FIT /);
    assert.match(text, /STATUS /);
    assert.match(text, /NEXT/);
    const summaryIndex = text.indexOf('FIT ');
    const diagnosticsIndex = text.indexOf('EVIDENCE & READINESS');
    if (diagnosticsIndex >= 0) {
      assert.ok(summaryIndex < diagnosticsIndex, `${size.name}: decision summary precedes diagnostics`);
    } else {
      assert.ok(size.width < 90, `${size.name}: only compact layouts may omit below-fold diagnostics`);
    }
  }
});

test('UX-BENCH-06 priority hierarchy is a single strip rather than four competing boxes', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const lines = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id }, 140, 42);
  assert.match(lines[1], /PRIORITY  1 of 4/);
  assert.match(lines[2], /▶ ACTION/);
  assert.match(lines[3], /QUEUE  ACTION · INTERVIEW · NEW · FAILURE/);
  assert.ok(lines.slice(1, 4).every(line => !line.includes('┌') && !line.includes('┐')), 'priority hierarchy avoids card chrome');
});

test('UX-BENCH-07 minimum-size navigation keeps dashboard, chat, setup, help, and quit reachable', async t => {
  const { model, profile, job } = await fixture(t, { withJob: true });
  const dashboard = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id }, 60, 24).join('\n');
  for (const label of ['Tab chat', 'g setup', '? help', 'Q quit']) assert.match(dashboard, new RegExp(label.replace('?', '\\?')));
  const chat = render(model, { ...defaultTuiState(), profileId: profile.id, selectedJobId: job.id, focusTarget: 'agent' }, 60, 24).join('\n');
  assert.match(chat, /AGENT · FOCUSED/);
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
