import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withAuthenticatedPage } from '../src/browser.js';
import * as network from '../src/browser-network-policy.js';

function fakeWsSocket() {
  return {
    sent: [],
    closed: false,
    send(data) { this.sent.push(data); },
    close() { this.closed = true; }
  };
}

function fakePlaywright(events, { routeWebSocket = true } = {}) {
  let routeHandler = null;
  const page = {
    goto: async url => {
      events.push('goto');
      assert.equal(typeof routeHandler, 'function', 'routing must be installed before navigation');
      const request = {
        url: () => String(url),
        isNavigationRequest: () => true,
        frame: () => ({ page: () => ({ mainFrame: () => request.frame() }) })
      };
      await routeHandler({ continue: async () => events.push('continue'), abort: async () => events.push('abort') }, request);
      return { status: () => 200 };
    },
    evaluate: async () => ({ captcha: false, loginForm: false, blockedText: false }),
    url: () => 'https://apply.example.test/jobs/1',
  };
  const context = {
    route: async (_pattern, handler) => { events.push('route'); routeHandler = handler; },
    newPage: async () => { events.push('newPage'); return page; },
    cookies: async () => [],
    close: async () => { events.push('close'); },
  };
  if (routeWebSocket) context.routeWebSocket = async (_pattern, handler) => { events.push('routeWebSocket'); context.wsHandler = handler; };
  return {
    chromium: {
      launchPersistentContext: async (_profilePath, options) => {
        events.push('launch');
        assert.equal(options.serviceWorkers, 'block');
        assert.match(options.proxy.server, /^http:\/\/127\.0\.0\.1:/);
        assert.ok(options.args.includes('--disable-quic'));
        return context;
      }
    }
  };
}

test('protected form page installs proxy, routes, service-worker and WebSocket blocks before goto', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-browser-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const result = await withAuthenticatedPage({
    workspace: root,
    name: 'protected',
    url: 'https://apply.example.test/jobs/1',
    playwright: fakePlaywright(events),
    createIfMissing: true,
    protectRequests: true,
    networkPolicyOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
  }, async () => {
    events.push('operation');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.ok(events.indexOf('route') < events.indexOf('newPage'));
  assert.ok(events.indexOf('routeWebSocket') < events.indexOf('goto'));
  assert.ok(events.indexOf('continue') < events.indexOf('operation'));
});

test('pinned connection uses the validated address and blocks private or conflicting destinations', async () => {
  const connects = [];
  const policy = await network.createBrowserNetworkPolicy({
    ownedOrigin: 'https://apply.example.test',
    lookup: async hostname => hostname === 'mixed.example.test'
      ? [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }]
      : [{ address: '93.184.216.34', family: 4 }],
    connect: async options => { connects.push(options); return { destroy() {} }; }
  });
  try {
    await policy.connectPinned('cdn.example.test', 443);
    assert.equal(connects[0].host, '93.184.216.34');
    assert.equal(connects[0].serverName, 'cdn.example.test');
    await assert.rejects(() => policy.connectPinned('mixed.example.test', 443), error => error.code === 'browser_private_network_blocked');
    assert.throws(() => policy.assertRequestUrl('https://other.example.test/redirect', { mainFrame: true }), error => error.code === 'browser_origin_blocked');
    assert.doesNotThrow(() => policy.assertRequestUrl('https://cdn.example.test/script.js', { mainFrame: false }));
    assert.throws(() => policy.assertRequestUrl('ws://cdn.example.test/socket', { mainFrame: false }), error => error.code === 'browser_websocket_blocked');
  } finally {
    await policy.close();
  }
});

test('protected routing fails closed when required WebSocket interception is unavailable', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-browser-policy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await assert.rejects(() => withAuthenticatedPage({
    workspace: root,
    name: 'unprotected',
    url: 'https://apply.example.test/jobs/1',
    playwright: fakePlaywright([], { routeWebSocket: false }),
    createIfMissing: true,
    protectRequests: true,
    networkPolicyOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
  }, async () => 'must-not-run'), error => error.code === 'browser_protected_routing_unavailable');
});

test('policy sealing reports late routing failures before protected success returns', async () => {
  const policy = await network.createBrowserNetworkPolicy({
    ownedOrigin: 'https://apply.example.test',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  try {
    policy.recordFailure(Object.assign(new Error('late failure'), { code: 'browser_route_failed' }));
    await assert.rejects(() => policy.seal(), error => error.code === 'browser_route_failed');
  } finally {
    await policy.close();
  }
});

test('routeWebSocket block transmits nothing and is not a routing failure that trips seal', async () => {
  const policy = await network.createBrowserNetworkPolicy({
    ownedOrigin: 'https://apply.example.test',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  let wsHandler = null;
  const context = {
    route: async () => {},
    routeWebSocket: async (_pattern, handler) => { wsHandler = handler; }
  };
  try {
    await policy.install(context);
    assert.equal(typeof wsHandler, 'function');
    const socket = fakeWsSocket();
    wsHandler(socket);
    assert.equal(socket.closed, true, 'WebSocket socket must be closed');
    assert.deepEqual(socket.sent, [], 'WebSocket block must not transmit any data');
    await policy.seal();
  } finally {
    await policy.close();
  }
});

test('proxy upgrade block transmits nothing and is not a routing failure that trips seal', async () => {
  const policy = await network.createBrowserNetworkPolicy({
    ownedOrigin: 'https://apply.example.test',
    lookup: async () => [{ address: '93.184.216.34', family: 4 }]
  });
  const proxyUrl = new URL(policy.proxyServer);
  try {
    const blocked = await new Promise(resolve => {
      const req = http.request({
        host: '127.0.0.1',
        port: proxyUrl.port,
        method: 'GET',
        path: '/socket',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          ['Sec-WebSocket' + '-Key']: 'testkey',
          'Sec-WebSocket-Version': '13'
        }
      });
      req.on('error', () => resolve(true));
      req.on('upgrade', () => resolve(false));
      req.on('response', () => resolve(false));
      req.end();
      setTimeout(() => resolve(false), 2000);
    });
    assert.equal(blocked, true, 'proxy upgrade must destroy the socket without an upgrade or response');
    await policy.seal();
  } finally {
    await policy.close();
  }
});

test('a blocked WebSocket during a protected inspect operation does not doom sealing', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-browser-policy-ws-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const socket = fakeWsSocket();
  const result = await withAuthenticatedPage({
    workspace: root,
    name: 'ws-inspect',
    url: 'https://apply.example.test/jobs/1',
    playwright: fakePlaywright(events),
    createIfMissing: true,
    protectRequests: true,
    networkPolicyOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] }
  }, async ({ context }) => {
    context.wsHandler(socket);
    return 'inspected';
  });
  assert.equal(result, 'inspected');
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
});

test('a blocked WebSocket during a confirmed protected submission does not lose the confirmed result', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'jobos-browser-policy-ws-confirmed-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const events = [];
  const socket = fakeWsSocket();
  const result = await withAuthenticatedPage({
    workspace: root,
    name: 'ws-submit',
    url: 'https://apply.example.test/jobs/1',
    playwright: fakePlaywright(events),
    createIfMissing: true,
    protectRequests: true,
    networkPolicyOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }] },
    postOperationValidator: ({ result }) => result?.status === 'confirmed'
  }, async ({ context }) => {
    context.wsHandler(socket);
    return { status: 'confirmed', confirmation: { reference: 'CONF-1' } };
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(socket.closed, true);
  assert.deepEqual(socket.sent, []);
});
