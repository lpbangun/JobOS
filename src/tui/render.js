/**
 * Non-TTY snapshot renderer. Synchronously renders the SAME React tree as the
 * TTY runtime (src/tui/components.js App) via Ink's renderToString, then
 * enforces width/height bounds. No ACP child processes are ever started here.
 */
import React from 'react';
import { renderToString } from 'ink';
import { App } from './components.js';
import { CLASSIC_THEME } from './theme.js';

const h = React.createElement;

const NOOP_ACTIONS = Object.freeze({
  setHeaderMode() {},
  setLeftMode() {},
  setJobTab() {},
  openOverlay() {},
  closeOverlay() {},
  addToJobs() {},
  createFiles() {},
  findPeople() {},
  runSlash() {},
  sendChat() {},
  selectRow() {},
  exit() {}
});

export function renderTui(model, state, { width = 140, height = 42, color = false } = {}) {
  const measuredWidth = Math.max(1, Math.floor(Number(width) || 140));
  const measuredHeight = Math.max(1, Math.floor(Number(height) || 42));
  const output = renderToString(h(App, {
    model,
    state,
    actions: NOOP_ACTIONS,
    theme: CLASSIC_THEME,
    colorEnabled: Boolean(color),
    interactive: false,
    width: measuredWidth,
    height: measuredHeight
  }), { columns: measuredWidth });
  const lines = String(output || '').split('\n').slice(0, measuredHeight);
  return lines.join('\n');
}
