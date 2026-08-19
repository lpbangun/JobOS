#!/usr/bin/env node
import assert from 'node:assert/strict';
import { click, makeBenchTui } from './bench-b10-fixture.mjs';

const fixture = await makeBenchTui();
const { tui, jobs } = fixture;
const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
};
const cleanMouse = label => assert.doesNotMatch(tui.state.input, /\[<\d+;\d+;\d+[Mm]/, `${label} leaked SGR mouse bytes into the composer`);

try {
  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.jobTab = 'job';
  tui.state.input = '';
  click(tui, 124, 1);
  check('header Workspace click', () => assert.equal(tui.state.headerMode, 'workspace'));
  check('header Workspace byte quarantine', () => cleanMouse('header Workspace click'));
  click(tui, 137, 1);
  check('header Jobs click', () => assert.equal(tui.state.headerMode, 'jobs'));
  check('header Jobs byte quarantine', () => cleanMouse('header Jobs click'));

  tui.state.overlay = null;
  tui.state.jobTab = 'job';
  click(tui, 12, 2);
  check('rail New click', () => assert.equal(tui.state.leftMode, 'new'));
  check('rail New byte quarantine', () => cleanMouse('rail New click'));
  click(tui, 36, 2);
  check('rail Jobs click', () => assert.equal(tui.state.leftMode, 'jobs'));
  check('rail Jobs byte quarantine', () => cleanMouse('rail Jobs click'));

  tui.state.leftMode = 'jobs';
  tui.state.selectedIndex = 0;
  tui.state.selectedJobId = jobs[0].id;
  tui.refresh();
  click(tui, 10, 5);
  check('second rail row click', () => assert.equal(tui.state.selectedJobId, jobs[1].id));
  check('rail row byte quarantine', () => cleanMouse('rail row click'));

  tui.state.overlay = null;
  click(tui, 63, 2);
  check('People pane click', () => assert.equal(tui.state.jobTab, 'people'));
  click(tui, 73, 2);
  check('Chat pane click', () => assert.equal(tui.state.jobTab, 'chat'));
  click(tui, 53, 2);
  check('Job pane click', () => assert.equal(tui.state.jobTab, 'job'));
  check('pane byte quarantine', () => cleanMouse('pane click'));

  tui.openOverlay('setup');
  tui.state.overlayIndex = 0;
  click(tui, 60, 20);
  check('covering overlay row click', () => assert.equal(tui.state.overlayIndex, 5));
  check('overlay byte quarantine', () => cleanMouse('overlay row click'));

  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.jobTab = 'chat';
  tui.state.input = 'send this grounded question';
  let sent = null;
  tui.sendChat = (scope, text) => { sent = { scope, text }; tui.setInput(''); };
  click(tui, 135, 40);
  check('composer send click', () => assert.deepEqual(sent, { scope: 'job', text: 'send this grounded question' }));
  check('composer byte quarantine', () => cleanMouse('composer send click'));

  if (failures.length) assert.fail(`B10 SGR mouse routing failures:\n${failures.join('\n')}`);
  process.stdout.write('B10 PASS: fixed-grid SGR clicks routed to header, rail, rows, panes, overlay, and composer without byte leakage.\n');
} finally {
  fixture.cleanup();
}
