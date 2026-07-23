import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { startMcp } from '../src/mcp.js';

function frame(id) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'test' });
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

function multiHeaderFrame(id) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, method: 'test' });
  return `Content-Length: ${Buffer.byteLength(body)}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n${body}`;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function turn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('MCP pauses input and dispatches only one in-flight framed request', async () => {
  const input = new PassThrough();
  const originalPause = input.pause.bind(input);
  const originalResume = input.resume.bind(input);
  let pauses = 0;
  let resumes = 0;
  input.pause = () => { pauses += 1; return originalPause(); };
  input.resume = () => { resumes += 1; return originalResume(); };
  const first = deferred();
  const dispatched = [];
  const session = startMcp({}, {
    input,
    send: () => {},
    handleRequest: async (_s, line) => {
      const id = JSON.parse(line).id;
      dispatched.push(id);
      if (id === 1) await first.promise;
    }
  });
  input.write(frame(1) + frame(2));
  await turn();
  assert.deepEqual(dispatched, [1]);
  assert.ok(pauses >= 1);
  first.resolve();
  await turn();
  await turn();
  assert.deepEqual(dispatched, [1, 2]);
  assert.ok(resumes >= 1);
  input.end();
  await session.completed;
});

test('MCP rejects oversized Content-Length and unterminated JSONL without dispatch', async () => {
  for (const payload of [
    'Content-Length: 100\r\n\r\n',
    `${'x'.repeat(65)}`
  ]) {
    const input = new PassThrough();
    const dispatched = [];
    const sent = [];
    const session = startMcp({}, {
      input,
      maxRequestBytes: 64,
      send: message => sent.push(message),
      handleRequest: async (_s, line) => dispatched.push(line)
    });
    input.end(payload);
    await session.completed;
    assert.deepEqual(dispatched, []);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].error.code, -32700);
  }
});

test('MCP close drops buffered requests and waits for the running request', async () => {
  const input = new PassThrough();
  const first = deferred();
  const dispatched = [];
  const session = startMcp({}, {
    input,
    send: () => {},
    handleRequest: async (_s, line) => {
      const id = JSON.parse(line).id;
      dispatched.push(id);
      if (id === 1) await first.promise;
    }
  });
  input.write(frame(1) + frame(2));
  await turn();
  session.close();
  let completed = false;
  session.completed.then(() => { completed = true; });
  await turn();
  assert.equal(completed, false);
  assert.deepEqual(dispatched, [1]);
  first.resolve();
  await session.completed;
  assert.deepEqual(dispatched, [1]);
});

test('MCP accepts spec-valid multi-header Content-Length frames without weakening bounds', async () => {
  const input = new PassThrough();
  const dispatched = [];
  const sent = [];
  const session = startMcp({}, {
    input,
    maxRequestBytes: 64,
    send: message => sent.push(message),
    handleRequest: async (_s, line) => dispatched.push(line)
  });
  input.end(multiHeaderFrame(7));
  await session.completed;
  assert.equal(dispatched.length, 1, 'multi-header Content-Length frame must be dispatched');
  assert.equal(JSON.parse(dispatched[0]).id, 7);
  assert.equal(sent.length, 0, 'no parse error must be emitted for a valid multi-header frame');
});
