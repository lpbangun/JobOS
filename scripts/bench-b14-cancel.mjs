#!/usr/bin/env node
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp.js';
import { makeBenchTui } from './bench-b10-fixture.mjs';

const fixture = await makeBenchTui();
const { tui, root } = fixture;
try {
  tui.state.overlay = null;
  tui.state.headerMode = 'jobs';
  tui.state.jobTab = 'chat';
  tui.state.working = true;
  tui.state.agentState = 'working';
  tui.state.status = 'working · job assistant';

  const client = new AcpClient({ root, command: '__b14_no_spawn__' });
  client.sessionId = 'b14-live-turn';
  client.state = 'working';
  const notifications = [];
  const events = [];
  client.notify = (method, params) => { notifications.push({ method, params }); return true; };
  client.on('event', event => events.push(event));
  tui.client = client;

  tui.handleKey('', { name: 'escape', escape: true });
  client.onMessage({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'b14-live-turn',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'LATE UPDATE MUST BE DISCARDED' } }
    }
  });

  const failures = [];
  const check = (name, fn) => { try { fn(); } catch (error) { failures.push(`${name}: ${error.message}`); } };
  check('cancel notification', () => assert.deepEqual(notifications, [{ method: 'session/cancel', params: { sessionId: 'b14-live-turn' } }], 'Esc while working must call AcpClient.cancel exactly once'));
  check('session quarantine', () => assert.equal(client.quarantinedSessionId, 'b14-live-turn', 'cancelled session must be quarantined'));
  check('quarantine reason', () => assert.equal(client.quarantineReason, 'cancelled'));
  check('pane working reset', () => assert.equal(tui.state.working, false, 'pane must leave working state after in-pane cancel'));
  check('pane agent reset', () => assert.ok(['ready', 'off'].includes(tui.state.agentState), `pane agent state must be ready/off, got ${tui.state.agentState}`));
  check('late update discarded', () => assert.ok(events.some(event => event.type === 'discarded_update' && event.sessionId === 'b14-live-turn'), 'late quarantined session update was not discarded'));
  check('late text quarantined', () => assert.equal(events.some(event => event.type === 'agent_message' && /LATE UPDATE/.test(event.text || '')), false, 'late agent text escaped quarantine'));
  if (failures.length) assert.fail(`B14 in-pane cancel failures:\n${failures.join('\n')}`);
  process.stdout.write('B14 PASS: Esc cancelled, quarantined, reset the pane, and discarded the late update.\n');
} finally {
  tui.client = null;
  fixture.cleanup();
}
