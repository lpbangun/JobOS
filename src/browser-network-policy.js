import dns from 'node:dns/promises';
import http from 'node:http';
import net, { isIP } from 'node:net';
import { isBlockedIp } from './discovery/http.js';

const BLOCKED_HOST_SUFFIX = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i;
const MAX_PROXY_HEADER_BYTES = 16 * 1024;

function policyError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, type: 'validation', details });
}

function publicHostname(value) {
  const hostname = String(value || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname || BLOCKED_HOST_SUFFIX.test(hostname) || (isIP(hostname) && isBlockedIp(hostname))) {
    throw policyError('browser_private_network_blocked', `Browser destination must use a public host: ${hostname || 'missing'}`);
  }
  return hostname;
}

function requestUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '')); } catch {
    throw policyError('browser_request_blocked', 'Browser request URL is invalid');
  }
  if (parsed.username || parsed.password) throw policyError('browser_request_blocked', 'Browser request URL cannot contain credentials');
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') throw policyError('browser_websocket_blocked', 'Browser WebSocket requests are blocked');
  if (!['http:', 'https:'].includes(parsed.protocol)) throw policyError('browser_request_blocked', `Browser request protocol is blocked: ${parsed.protocol}`);
  publicHostname(parsed.hostname);
  return parsed;
}

function defaultConnect(options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.host, port: options.port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export async function createBrowserNetworkPolicy({
  ownedOrigin,
  lookup = dns.lookup,
  connect = defaultConnect
} = {}) {
  const origin = requestUrl(ownedOrigin).origin;
  const pins = new Map();
  const pending = new Set();
  let firstFailure = null;
  let sealed = false;
  let closed = false;

  const recordFailure = error => {
    if (!firstFailure) firstFailure = error?.code ? error : policyError('browser_route_failed', 'Protected browser routing failed');
  };

  const track = promise => {
    const tracked = Promise.resolve(promise);
    pending.add(tracked);
    tracked.catch(recordFailure).finally(() => pending.delete(tracked));
    return tracked;
  };

  const resolvePinned = async hostnameValue => {
    const hostname = publicHostname(hostnameValue);
    if (pins.has(hostname)) return pins.get(hostname);
    let addresses;
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw policyError('browser_dns_blocked', `Browser destination DNS lookup failed: ${hostname}`);
    }
    if (!Array.isArray(addresses) || !addresses.length || addresses.some(item => !item?.address || isBlockedIp(item.address))) {
      throw policyError('browser_private_network_blocked', `Browser destination resolved to a non-public address: ${hostname}`);
    }
    const address = String(addresses[0].address);
    pins.set(hostname, address);
    return address;
  };

  const connectPinned = async (hostnameValue, port) => {
    if (sealed || closed) throw policyError('browser_policy_sealed', 'Protected browser routing is sealed');
    const hostname = publicHostname(hostnameValue);
    const address = await resolvePinned(hostname);
    return connect({ host: address, port: Number(port), serverName: hostname });
  };

  const assertRequestUrl = (value, { mainFrame = false } = {}) => {
    if (sealed || closed) throw policyError('browser_policy_sealed', 'Protected browser routing is sealed');
    const parsed = requestUrl(value);
    if (mainFrame && parsed.origin !== origin) {
      throw policyError('browser_origin_blocked', `Main-frame navigation left the frozen origin: ${parsed.origin}`, { ownedOrigin: origin });
    }
    return parsed;
  };

  const proxy = http.createServer((req, res) => {
    const work = (async () => {
      const parsed = assertRequestUrl(req.url, { mainFrame: false });
      const socket = await connectPinned(parsed.hostname, Number(parsed.port) || 80);
      const upstream = http.request({
        method: req.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: { ...req.headers, host: parsed.host },
        createConnection: () => socket,
        agent: false
      }, response => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      });
      upstream.on('error', error => { recordFailure(error); if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(upstream);
    })();
    track(work).catch(() => { if (!res.headersSent) res.writeHead(403); res.end(); });
  });
  proxy.maxHeadersCount = 100;
  proxy.on('clientError', error => recordFailure(error));
  proxy.on('upgrade', (_req, socket) => {
    socket.destroy();
  });
  proxy.on('connect', (req, clientSocket, head) => {
    const work = (async () => {
      const target = new URL(`http://${req.url}`);
      const hostname = publicHostname(target.hostname);
      const upstream = await connectPinned(hostname, Number(target.port) || 443);
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.on('error', recordFailure);
      clientSocket.on('error', recordFailure);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    })();
    track(work).catch(error => { recordFailure(error); clientSocket.destroy(); });
  });
  proxy.on('connection', socket => {
    socket.setTimeout(30_000, () => socket.destroy());
    if (socket.readableHighWaterMark > MAX_PROXY_HEADER_BYTES) socket.pause();
  });

  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const address = proxy.address();
  const proxyServer = `http://127.0.0.1:${address.port}`;

  const install = async context => {
    if (typeof context?.route !== 'function' || typeof context?.routeWebSocket !== 'function') {
      throw policyError('browser_protected_routing_unavailable', 'Chromium request and WebSocket routing are required');
    }
    await context.route('**/*', async (route, request) => {
      const work = (async () => {
        const frame = typeof request.frame === 'function' ? request.frame() : null;
        const page = typeof frame?.page === 'function' ? frame.page() : null;
        const mainFrame = Boolean(request.isNavigationRequest?.() && page && frame === page.mainFrame?.());
        assertRequestUrl(request.url(), { mainFrame });
        await route.continue();
      })();
      try { await track(work); } catch (error) {
        recordFailure(error);
        try { await route.abort('blockedbyclient'); } catch {}
      }
    });
    await context.routeWebSocket('**/*', socket => {
      try { socket.close(); } catch {}
    });
  };

  const seal = async () => {
    if (!sealed) sealed = true;
    while (pending.size) await Promise.allSettled([...pending]);
    if (firstFailure) throw firstFailure;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise(resolve => proxy.close(() => resolve()));
  };

  return { proxyServer, ownedOrigin: origin, install, assertRequestUrl, connectPinned, recordFailure, seal, close };
}
