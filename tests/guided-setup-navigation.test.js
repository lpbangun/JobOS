import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import stringWidth from 'string-width';
import { openStore } from '../src/db.js';
import { createProfile } from '../src/profiles.js';
import {
  JobosTui,
  TUI_HANDLED_KEYS,
  TUI_KEYMAP,
  expandKeymapBinding,
  renderTui
} from '../src/tui.js';

const AS_OF = '2026-08-02T12:00:00.000Z';

function workspace() {
  return mkdtempSync(path.join(tmpdir(), 'jobos-setup-navigation-'));
}

function output(width = 120, height = 36) {
  return { columns: width, rows: height, isTTY: false, write() {}, on() {}, off() {} };
}

async function emptyTui({ width = 120, height = 36 } = {}) {
  const store = await openStore({ workspace: workspace() });
  const stdout = output(width, height);
  const tui = new JobosTui(store, {
    stdout,
    connectAgent: false,
    now: () => new Date(AS_OF)
  });
  return { store, stdout, tui };
}

test('first run preserves the main shell and centers the canonical seven-step setup journey', async () => {
  const { tui } = await emptyTui();
  assert.equal(tui.state.overlay, 'setup');
  assert.deepEqual(
    tui.model.onboarding.steps.filter(step => step.required).map(step => step.id),
    ['workspace', 'profile', 'resume', 'proofs', 'intake', 'decision', 'materials']
  );

  const screen = renderTui(tui.model, tui.state, { width: 120, height: 36, color: false });
  const lines = screen.split('\n');
  const modalTop = lines.findIndex(line => line.includes('╔ GUIDED SETUP'));
  assert.ok(modalTop > 1, 'modal is inset below the stable header and priorities');
  assert.ok(lines[modalTop].indexOf('╔') > 0, 'modal is horizontally inset over the shell');
  assert.match(screen, /JOBOS ·/);
  assert.match(screen, /JOBS · today/);
  assert.match(screen, /CORE JOURNEY  \[●\]─\[2\]─\[3\]─\[4\]─\[5\]─\[6\]─\[7\]/);
  assert.match(screen, /Navigate  j\/k or ↑\/↓ · Tab\/Shift\+Tab · 1–7 required step/);
  assert.match(screen, /Act  Enter · c correct · r recompute · Esc close/);
  assert.equal(lines.length, 36);
  assert.ok(lines.every(line => stringWidth(line) <= 120), 'modal composition never overflows the terminal width');
});

test('arrows, tabs, j/k, and 1–7 all reach the required setup steps', async () => {
  const { tui } = await emptyTui();
  const focusedId = () => tui.model.onboarding.steps[tui.state.overlayIndex]?.id;

  tui.onKeypress('', { name: 'down' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('', { name: 'up' });
  assert.equal(focusedId(), 'workspace');
  tui.onKeypress('', { name: 'tab' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('', { name: 'tab', shift: true });
  assert.equal(focusedId(), 'workspace');
  tui.onKeypress('j', { name: 'j' });
  assert.equal(focusedId(), 'profile');
  tui.onKeypress('k', { name: 'k' });
  assert.equal(focusedId(), 'workspace');

  for (let number = 1; number <= 7; number++) {
    tui.onKeypress(String(number), { name: String(number) });
    assert.equal(
      tui.model.onboarding.steps[tui.state.overlayIndex]?.id,
      ['workspace', 'profile', 'resume', 'proofs', 'intake', 'decision', 'materials'][number - 1]
    );
  }

  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, null);
});

test('the setup legend is executable and profile picker navigation uses the same controls', async () => {
  const { store, tui } = await emptyTui();
  const declared = new Set(TUI_HANDLED_KEYS.setup);
  for (const [binding] of TUI_KEYMAP.setup) {
    for (const token of expandKeymapBinding(binding)) {
      assert.ok(declared.has(token), `${binding} expands to routed setup token ${token}`);
    }
  }

  createProfile(store, 'Alpha');
  createProfile(store, 'Beta');
  tui.refresh({ disk: false });
  tui.state.overlay = 'setup';
  tui.state.overlayIndex = tui.model.onboarding.steps.findIndex(step => step.id === 'profile');
  tui.onKeypress('', { name: 'return' });
  assert.equal(tui.state.overlay, 'setup-profile-picker');

  tui.onKeypress('', { name: 'down' });
  assert.equal(tui.state.overlayIndex, 1);
  tui.onKeypress('', { name: 'up' });
  assert.equal(tui.state.overlayIndex, 0);
  tui.onKeypress('', { name: 'tab' });
  assert.equal(tui.state.overlayIndex, 1);
  tui.onKeypress('', { name: 'tab', shift: true });
  assert.equal(tui.state.overlayIndex, 0);
  tui.onKeypress('', { name: 'escape' });
  assert.equal(tui.state.overlay, 'setup');
});

test('minimum supported terminal keeps setup hierarchy and controls visible', async () => {
  const { tui } = await emptyTui({ width: 60, height: 20 });
  const screen = renderTui(tui.model, tui.state, { width: 60, height: 20, color: false });
  const lines = screen.split('\n');
  assert.equal(lines.length, 20);
  assert.ok(lines.every(line => stringWidth(line) === 60));
  assert.doesNotMatch(screen, /JobOS needs a larger terminal/);
  assert.match(screen, /╔ GUIDED SETUP/);
  assert.match(screen, /CORE JOURNEY/);
  assert.match(screen, /Navigate/);
  assert.match(screen, /Act  Enter · c correct · r recompute · Esc close/);
  assert.match(screen, /SELECTED · REQUIRED 1\/7 · WORKSPACE/);
});
