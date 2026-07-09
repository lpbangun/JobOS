import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { providerChain, searchWeb, searchWebDetailed } from '../src/search.js';

function fakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ path: url.pathname, query: url.searchParams.get('q') || '', headers: req.headers, body });
      handler(url, req, res, body);
    });
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

test('optional agentic search providers normalize source results', async () => {
  const fake = await fakeServer((url, req, res) => {
    if (url.pathname === '/exa') {
      assert.equal(req.headers['x-api-key'], 'exa-key');
      sendJson(res, 200, { results: [{ title: 'Maya Chen profile', url: 'https://example.com/maya', text: 'Head of Product at Acme Learning.' }] });
      return;
    }
    if (url.pathname === '/tavily') {
      assert.equal(req.headers.authorization, 'Bearer tavily-key');
      sendJson(res, 200, { results: [{ title: 'Acme team', url: 'https://acme.example/team', content: 'Team page with public emails.' }] });
      return;
    }
    if (url.pathname === '/perplexity') {
      assert.equal(req.headers.authorization, 'Bearer pplx-key');
      sendJson(res, 200, { results: [{ title: 'Acme press', url: 'https://news.example/acme', snippet: 'Public company news.' }] });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  try {
    const exa = await searchWebDetailed('Maya Chen Acme', { env: { JOBOS_SEARCH_PROVIDER: 'exa', JOBOS_EXA_API_KEY: 'exa-key', JOBOS_EXA_SEARCH_URL: `${fake.baseUrl}/exa`, JOBOS_SEARCH_TIMEOUT_MS: '1000' }, limit: 2 });
    assert.equal(exa.provider, 'exa');
    assert.equal(exa.results[0].snippet, 'Head of Product at Acme Learning.');
    const tavily = await searchWebDetailed('Acme team', { env: { JOBOS_SEARCH_PROVIDER: 'tavily', JOBOS_TAVILY_API_KEY: 'tavily-key', JOBOS_TAVILY_SEARCH_URL: `${fake.baseUrl}/tavily`, JOBOS_SEARCH_TIMEOUT_MS: '1000' }, limit: 2 });
    assert.equal(tavily.provider, 'tavily');
    assert.equal(tavily.results[0].snippet, 'Team page with public emails.');
    const perplexity = await searchWebDetailed('Acme press', { env: { JOBOS_SEARCH_PROVIDER: 'perplexity', JOBOS_PERPLEXITY_API_KEY: 'pplx-key', JOBOS_PERPLEXITY_SEARCH_URL: `${fake.baseUrl}/perplexity`, JOBOS_SEARCH_TIMEOUT_MS: '1000' }, limit: 2 });
    assert.equal(perplexity.provider, 'perplexity');
    assert.equal(perplexity.results[0].snippet, 'Public company news.');
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
