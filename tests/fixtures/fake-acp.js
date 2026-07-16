#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';

const mode = process.argv[2] || 'normal';
const marker = process.argv[3] || '';
const sessionId = 'fake-session-1';
let promptId = null;
let permissionPromptId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(value) {
  send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: value } });
}

function finishPrompt(stopReason = 'end_turn') {
  if (promptId === null) return;
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason } });
  promptId = null;
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const message = JSON.parse(line);
  if (!message.method && message.id === 700) {
    if (marker) fs.writeFileSync(marker, JSON.stringify(message.result));
    finishPrompt(message.result?.outcome?.outcome === 'cancelled' ? 'end_turn' : 'permission');
    return;
  }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: mode === 'bad-version' ? 99 : 1, agentInfo: { name: 'fake-acp', version: '1.0.0' } } });
    return;
  }
  if (message.method === 'session/new' || message.method === 'session/load') {
    send({ jsonrpc: '2.0', id: message.id, result: { sessionId } });
    return;
  }
  if (message.method === 'session/prompt') {
    promptId = message.id;
    if (mode === 'crash' || (mode === 'crash-once' && marker && !fs.existsSync(marker))) {
      if (marker) fs.writeFileSync(marker, 'crashed');
      process.stderr.write('Authorization: Bearer sk-test-secret-value\napi_key=supersecretvalue\n');
      setTimeout(() => process.exit(9), 5);
      return;
    }
    if ((mode === 'hang' || mode === 'cancelable') && (!marker || !fs.existsSync(marker))) {
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'waiting safely' } });
      return;
    }
    update({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'mcp__jobos__get_job_context', kind: 'other', rawInput: { jobId: 'job-1', apiKey: 'sk-test-secret-value' } });
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', title: 'mcp__jobos__get_job_context', status: 'completed', rawOutput: { content: 'context loaded', token: 'supersecretvalue' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Grounded ' } });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'response.' } });
    permissionPromptId = message.id;
    send({ jsonrpc: '2.0', id: 700, method: 'session/request_permission', params: { sessionId, toolCall: { title: 'terminal: rm -rf /' }, options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }] } });
    return;
  }
  if (message.method === 'session/cancel') {
    if (marker) fs.writeFileSync(marker, 'cancelled');
    if (mode === 'cancelable') {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'between cancel and acknowledgement' } });
      finishPrompt('cancelled');
      setTimeout(() => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'stale cancelled output' } }), 5);
    }
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } });
  }
});

input.on('close', () => process.exit(0));
