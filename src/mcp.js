import { callDomainTool, DOMAIN_TOOLS } from './domain-tools.js';
import { reload } from './db.js';

// MCP agents must only be offered operations they can actually invoke. These
// human-gated mutations remain available through the trusted CLI/TUI paths.
const MCP_DENY = new Set([
  'approve_artifact',
  'reject_artifact',
  'approve_contact',
  'answers_add',
  'create_application_packet',
  'attest_application_submitted',
  'confirm_application_receipt',
  'checkpoint_application_form'
]);
const tools = DOMAIN_TOOLS.filter(t => !MCP_DENY.has(t.name));

function result(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function callTool(s, name, args = {}) {
  return result(await callDomainTool(s, name, args, { source: 'mcp' }));
}

function send(message, framing = 'header') {
  const json = JSON.stringify(message);
  process.stdout.write(framing === 'jsonl'
    ? `${json}\n`
    : `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

export function mcpToolNames() {
  return tools.map(t => t.name);
}

export function startMcp(s, {
  input = process.stdin,
  send: sendResponse = send,
  handleRequest = handleLine,
  maxRequestBytes = 1024 * 1024,
  maxHeaderBytes = 8 * 1024
} = {}) {
  let buffer = Buffer.alloc(0);
  let active = null;
  let ended = false;
  let closing = false;
  let settled = false;
  let resolveCompleted;
  const completed = new Promise(resolve => { resolveCompleted = resolve; });

  const detach = () => {
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onError);
  };
  const finish = () => {
    if (settled || active) return;
    settled = true;
    detach();
    resolveCompleted();
  };
  const beginClose = ({ destroy = true } = {}) => {
    if (!closing) {
      closing = true;
      buffer = Buffer.alloc(0);
      detach();
      input.pause?.();
      if (destroy && input !== process.stdin && typeof input.destroy === 'function') input.destroy();
    }
    finish();
  };
  const parseError = (message, framing = 'header') => {
    sendResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message } }, framing);
    beginClose();
  };
  const nextFrame = () => {
    if (!buffer.length) return null;
    const prefix = buffer.toString('utf8', 0, Math.min(buffer.length, 15));
    if ('Content-Length:'.startsWith(prefix) || prefix.startsWith('Content-Length:')) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) {
        if (buffer.length > maxHeaderBytes) throw Object.assign(new Error('MCP header exceeds limit'), { framing: 'header' });
        return null;
      }
      if (headerEnd > maxHeaderBytes) throw Object.assign(new Error('MCP header exceeds limit'), { framing: 'header' });
      const header = buffer.toString('utf8', 0, headerEnd);
      const match = header.match(/^Content-Length:\s*(\d+)\s*$/im);
      const length = Number(match?.[1]);
      if (!Number.isSafeInteger(length)) throw Object.assign(new Error('Missing Content-Length'), { framing: 'header' });
      if (length > maxRequestBytes) throw Object.assign(new Error('MCP request exceeds limit'), { framing: 'header' });
      const bodyStart = headerEnd + 4;
      if (buffer.length - bodyStart < length) return null;
      const line = buffer.toString('utf8', bodyStart, bodyStart + length);
      return { line, framing: 'header', consumed: bodyStart + length };
    }
    const newline = buffer.indexOf('\n');
    if (newline < 0) {
      if (buffer.length > maxRequestBytes) throw Object.assign(new Error('MCP request exceeds limit'), { framing: 'jsonl' });
      return null;
    }
    if (newline > maxRequestBytes) throw Object.assign(new Error('MCP request exceeds limit'), { framing: 'jsonl' });
    return { line: buffer.toString('utf8', 0, newline).trim(), framing: 'jsonl', consumed: newline + 1 };
  };
  const pump = () => {
    if (active || closing) return;
    let frame;
    try {
      frame = nextFrame();
    } catch (error) {
      parseError(error.message, error.framing);
      return;
    }
    if (!frame) {
      if (ended) {
        if (buffer.length) parseError('Incomplete MCP request');
        else finish();
      } else {
        input.resume?.();
      }
      return;
    }
    buffer = buffer.subarray(frame.consumed);
    if (!frame.line) {
      pump();
      return;
    }
    input.pause?.();
    active = Promise.resolve(handleRequest(s, frame.line, message => sendResponse(message, frame.framing)))
      .catch(() => {})
      .finally(() => {
        active = null;
        if (closing) finish();
        else pump();
      });
  };
  const onData = chunk => {
    if (closing) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (buffer.length + bytes.length > maxRequestBytes + maxHeaderBytes) {
      parseError('MCP input buffer exceeds limit');
      return;
    }
    buffer = buffer.length ? Buffer.concat([buffer, bytes]) : Buffer.from(bytes);
    pump();
  };
  const onEnd = () => {
    ended = true;
    pump();
  };
  const onError = () => beginClose({ destroy: false });
  input.on('data', onData);
  input.once('end', onEnd);
  input.once('error', onError);
  return {
    completed,
    close() { beginClose(); }
  };
}

async function handleLine(s, line, respond) {
  let msg;
  try { msg = JSON.parse(line); } catch (e) { respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } }); return; }
  try {
    if (msg.method === 'initialize') {
      respond({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'jobos', version: '0.1.0' }, capabilities: { tools: {} } } });
      return;
    }
    if (msg.method === 'notifications/initialized') return;
    if (msg.method === 'tools/list') { respond({ jsonrpc: '2.0', id: msg.id, result: { tools } }); return; }
    if (msg.method === 'tools/call') {
      reload(s);
      const { name, arguments: args } = msg.params || {};
      respond({ jsonrpc: '2.0', id: msg.id, result: await callTool(s, name, args || {}) });
      return;
    }
    respond({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32601, message: `Method not found: ${msg.method}` } });
  } catch (e) {
    const message = e?.code ? `${e.code}: ${e.message}` : e.message;
    respond({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32000, message, data: typeof e?.toJSON === 'function' ? e.toJSON() : undefined } });
  }
}
