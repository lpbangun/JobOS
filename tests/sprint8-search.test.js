import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { providerChain, searchWeb, searchWebDetailed } from '../src/search.js';

function fakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ path: url.pathname, query: url.searchParams.get('q') || '', headers: req.headers });
    handler(url, req, res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise(done => server.close(done))
  })));
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('duckduckgo remains the default and normalizes provider metadata', async () => {
  const fake = await fakeServer((url, _req, res) => {
    assert.equal(url.pathname, '/duck');
    sendJson(res, 200, {
      results: [
        { title: 'Acme Learning product', url: 'https://acme.example/product', snippet: 'Acme Learning builds tools for adult learners.' }
      ]
    });
  });
  try {
    const env = { JOBOS_SEARCH_BASE_URL: `${fake.baseUrl}/duck`, JOBOS_SEARCH_TIMEOUT_MS: '1000' };
    assert.deepEqual(providerChain(env), ['duckduckgo']);
    const detailed = await searchWebDetailed('Acme Learning product', { env, limit: 3 });
    assert.equal(detailed.provider, 'duckduckgo');
    assert.deepEqual(detailed.warnings, []);
    assert.equal(detailed.results[0].provider, 'duckduckgo');
    assert.equal(detailed.results[0].query, 'Acme Learning product');
    assert.equal(detailed.results[0].rank, 1);
    assert.ok(detailed.results[0].fetchedAt);
    const legacy = await searchWeb('Acme Learning product', { env, limit: 3 });
    assert.equal(legacy[0].provider, 'duckduckgo');
    assert.deepEqual(legacy.warnings, []);
  } finally {
    await fake.close();
  }
});

test('brave provider is selectable by env and maps web results', async () => {
  const fake = await fakeServer((url, req, res) => {
    assert.equal(url.pathname, '/brave');
    assert.equal(req.headers['x-subscription-token'], 'test-key');
    sendJson(res, 200, {
      web: {
        results: [
          { title: 'Acme Learning funding', url: 'https://news.example/acme-funding', description: 'Acme Learning raised capital for workforce learning.' }
        ]
      }
    });
  });
  try {
    const env = {
      JOBOS_SEARCH_PROVIDER: 'brave',
      JOBOS_BRAVE_API_KEY: 'test-key',
      JOBOS_BRAVE_SEARCH_URL: `${fake.baseUrl}/brave`,
      JOBOS_SEARCH_TIMEOUT_MS: '1000'
    };
    const detailed = await searchWebDetailed('Acme Learning funding', { env, limit: 2 });
    assert.equal(detailed.provider, 'brave');
    assert.deepEqual(detailed.attempted, ['brave']);
    assert.equal(detailed.results[0].provider, 'brave');
    assert.equal(detailed.results[0].snippet, 'Acme Learning raised capital for workforce learning.');
  } finally {
    await fake.close();
  }
});

test('primary provider failure falls back and records warnings without throwing', async () => {
  const fake = await fakeServer((url, _req, res) => {
    if (url.pathname === '/brave') {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('temporarily unavailable');
      return;
    }
    if (url.pathname === '/duck') {
      sendJson(res, 200, {
        results: [
          { title: 'Acme Learning careers', url: 'https://acme.example/careers', snippet: 'Hiring product managers for learning workflows.' }
        ]
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  try {
    const env = {
      JOBOS_SEARCH_PROVIDER: 'brave',
      JOBOS_BRAVE_API_KEY: 'test-key',
      JOBOS_BRAVE_SEARCH_URL: `${fake.baseUrl}/brave`,
      JOBOS_SEARCH_BASE_URL: `${fake.baseUrl}/duck`,
      JOBOS_SEARCH_TIMEOUT_MS: '1000'
    };
    const detailed = await searchWebDetailed('Acme Learning careers', { env, limit: 2 });
    assert.equal(detailed.provider, 'duckduckgo');
    assert.deepEqual(detailed.attempted, ['brave', 'duckduckgo']);
    assert.equal(detailed.warnings.length, 1);
    assert.equal(detailed.warnings[0].provider, 'brave');
    assert.match(detailed.warnings[0].message, /HTTP 503/);
    assert.equal(detailed.results[0].provider, 'duckduckgo');
    assert.equal(detailed.results[0].warnings[0].provider, 'brave');
  } finally {
    await fake.close();
  }
});
