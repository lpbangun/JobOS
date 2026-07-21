import { callDomainTool, DOMAIN_TOOLS } from './domain-tools.js';
import { reload } from './db.js';

const MUTATION_DENY = new Set(['create_application_packet', 'attest_application_submitted', 'confirm_application_receipt']);
const tools = DOMAIN_TOOLS.filter(t => !MUTATION_DENY.has(t.name));

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

export function startMcp(s, { input = process.stdin } = {}) {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  const dispatch = (line, framing) => {
    queue = queue.then(() => handleLine(s, line, message => send(message, framing))).catch(() => {});
  };
  input.on('data', chunk => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))]);
    while (buffer.length) {
      if (buffer.toString('utf8', 0, Math.min(buffer.length, 15)).startsWith('Content-Length:')) {
        const headerEnd = buffer.indexOf('\r\n\r\n');
        if (headerEnd < 0) break;
        const header = buffer.toString('utf8', 0, headerEnd);
        const len = Number(header.match(/Content-Length:\s*(\d+)/i)?.[1]);
        if (!Number.isFinite(len)) {
          send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Missing Content-Length' } }, 'header');
          buffer = Buffer.alloc(0);
          continue;
        }
        const bodyStart = headerEnd + 4;
        if (buffer.length - bodyStart < len) break;
        const body = buffer.toString('utf8', bodyStart, bodyStart + len);
        buffer = buffer.subarray(bodyStart + len);
        dispatch(body, 'header');
        continue;
      }
      const idx = buffer.indexOf('\n');
      if (idx < 0) break;
      const line = buffer.toString('utf8', 0, idx).trim();
      buffer = buffer.subarray(idx + 1);
      if (line) dispatch(line, 'jsonl');
    }
  });
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
