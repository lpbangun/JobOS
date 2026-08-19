#!/usr/bin/env node
import assert from 'node:assert/strict';
import { makeBenchTui } from './bench-b10-fixture.mjs';

const fixture = await makeBenchTui();
const { tui } = fixture;
try {
  tui.runSlash('chat');
  assert.equal(tui.state.jobTab, 'chat', '/chat must open this-job Chat');
  const dispatched = [];
  const originalRunSlash = tui.runSlash.bind(tui);
  tui.runSlash = id => { dispatched.push(id); return originalRunSlash(id); };
  tui.createFiles = async () => false;
  tui.handleKey('', { name: 'return', return: true });
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(dispatched, [], `bare Enter after /chat dispatched domain slash action(s): ${dispatched.join(', ')}`);
  assert.equal(tui.state.input, '', '/chat must leave an empty, ready composer rather than a catalog-wide slash query');
  process.stdout.write('B12 PASS: bare Enter after /chat dispatched no slash action.\n');
} finally {
  fixture.cleanup();
}
