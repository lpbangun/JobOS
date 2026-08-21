#!/usr/bin/env node
import assert from 'node:assert/strict';
import { click, makeBenchTui } from './bench-b10-fixture.mjs';

const fixture = await makeBenchTui();
const { tui } = fixture;
const failures = [];
const check = (name, fn) => {
  try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); }
};
const selectedStage = () => tui.trackerSelectedRow()?.label || null;

try {
  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.jobTab = 'job';
  tui.state.leftMode = 'jobs';
  tui.handleKey('n', { name: 'n' });
  check('documented n key selects New rail', () => assert.equal(tui.state.leftMode, 'new'));
  tui.handleKey('j', { name: 'j' });
  check('documented j key selects Jobs rail', () => assert.equal(tui.state.leftMode, 'jobs'));
  click(tui, 12, 2);
  check('New rail click', () => assert.equal(tui.state.leftMode, 'new'));
  click(tui, 36, 2);
  check('Jobs rail click', () => assert.equal(tui.state.leftMode, 'jobs'));
  check('rail keys are documented', () => assert.match(tui.render({ width: 140, height: 42, color: false }), /n\s+New.*j\s+Jobs/i));

  const stages = [
    { key: '1', stage: 'saved', col: 51 },
    { key: '2', stage: 'researching', col: 60 },
    { key: '3', stage: 'applied', col: 73 },
    { key: '4', stage: 'waiting', col: 82 }
  ];
  tui.openOverlay('tracker');
  for (const [index, item] of stages.entries()) {
    tui.state.overlayIndex = index === 0 ? 1 : 0;
    tui.handleKey(item.key, { name: item.key });
    check(`tracker ${item.stage} key`, () => assert.equal(selectedStage(), item.stage));
    tui.state.overlayIndex = index === 0 ? 1 : 0;
    click(tui, item.col, 11);
    check(`tracker ${item.stage} click`, () => assert.equal(selectedStage(), item.stage));
  }
  check('tracker direct-stage keys are documented', () => assert.match(
    tui.render({ width: 140, height: 42, color: false }),
    /1\s+saved.*2\s+researching.*3\s+applied.*4\s+waiting/is
  ));

  tui.openOverlay('network');
  tui.state.setupMode = null;
  tui.handleKey('i', { name: 'i' });
  check('network i key opens Edit intent', () => assert.equal(tui.state.setupMode, 'network-intent'));
  tui.state.setupMode = null;
  click(tui, 55, 22);
  check('network Edit intent click', () => assert.equal(tui.state.setupMode, 'network-intent'));
  check('network Edit intent key is documented', () => assert.match(
    tui.render({ width: 140, height: 42, color: false }),
    /i\s+Edit intent/i
  ));

  if (failures.length) assert.fail(`B11 direct key/click reachability failures:\n${failures.join('\n')}`);
  process.stdout.write('B11 PASS: New/Jobs, tracker stages, and Network Edit intent each have documented direct keys and fixed-grid clicks.\n');
} finally {
  fixture.cleanup();
}
