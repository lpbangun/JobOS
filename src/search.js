import * as cheerio from 'cheerio';

function timeoutMs(provider, env) {
  const key = `JOBOS_SEARCH_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_TIMEOUT_MS`;
  return Math.max(1000, Number(env[key] || env.JOBOS_SEARCH_TIMEOUT_MS || 15000));
}

function searchUrl(base, query, params = {}) {
  const url = new URL(base);
  if (!url.searchParams.has('q')) url.searchParams.set('q', query);
  for (const [key, value] of Object.entries(params)) {
    if (!url.searchParams.has(key)) url.searchParams.set(key, value);
  }
  return url;
}

function normalizeUrl(raw, base = 'https://duckduckgo.com') {
  if (!raw) return '';
  try {
    const url = new URL(raw, base);
    return url.searchParams.get('uddg') || url.href;
  } catch {
    return String(raw);
  }
}

function resultItems(data) {
  const web = data?.web;
  const dataWeb = data?.data?.web;
  return data?.results
    || (Array.isArray(web) ? web : web?.results)
    || data?.items
    || (Array.isArray(dataWeb) ? dataWeb : dataWeb?.results)
    || [];
}

function normalizeResults(items, { limit, provider, query, fetchedAt, baseUrl = 'https://duckduckgo.com' }) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      title: String(item.title || item.name || '').replace(/\s+/g, ' ').trim(),
      url: normalizeUrl(item.url || item.link || item.href, baseUrl),
      snippet: String(item.snippet || item.description || item.summary || item.content || '').replace(/\s+/g, ' ').trim()
    }))
    .filter(item => item.title && item.url)
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, limit)
    .map((item, index) => ({ ...item, provider, query, rank: index + 1, fetchedAt }));
}

function jsonResults(data, options) {
  return normalizeResults(resultItems(data), options);
}

function htmlResults(html, options) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result, .web-result, .results_links, .result__body, article[data-testid="result"]').each((_, el) => {
    if (results.length >= options.limit) return false;
    const a = $(el).find('a.result__a[href], a[data-testid="result-title-a"][href], h2 a[href], a[href]').first();
    const href = a.attr('href');
    const title = a.text().trim();
    if (!href || !title) return;
    const snippet = $(el).text().replace(title, '').replace(/\s+/g, ' ').trim();
    results.push({ title, url: normalizeUrl(href), snippet });
  });
  if (!results.length) {
    $('a[href]').each((_, el) => {
      if (results.length >= options.limit) return false;
      const title = $(el).text().replace(/\s+/g, ' ').trim();
      const href = $(el).attr('href');
      if (title && href) results.push({ title, url: normalizeUrl(href), snippet: '' });
    });
  }
  return normalizeResults(results, options);
}

async function fetchText(url, { provider, env, headers = {} }) {
  const response = await fetch(url, {
    headers: { 'accept': 'application/json,text/html;q=0.9,*/*;q=0.8', 'user-agent': 'JobOS local research (+human-initiated search)', ...headers },
    signal: AbortSignal.timeout(timeoutMs(provider, env))
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  const text = await response.text();
  return { text, type: response.headers.get('content-type') || '' };
}

async function duckduckgoSearch(query, { limit, env }) {
  const provider = 'duckduckgo';
  const base = env.JOBOS_SEARCH_BASE_URL || 'https://duckduckgo.com/html/';
  const url = searchUrl(base, query);
  const { text, type } = await fetchText(url, { provider, env });
  const options = { limit, provider, query, fetchedAt: new Date().toISOString(), baseUrl: 'https://duckduckgo.com' };
  if (type.includes('json') || text.trim().startsWith('{') || text.trim().startsWith('[')) return jsonResults(JSON.parse(text), options);
  return htmlResults(text, options);
}

async function braveSearch(query, { limit, env }) {
  const provider = 'brave';
  const apiKey = env.JOBOS_BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY || '';
  if (!apiKey) throw new Error('Missing JOBOS_BRAVE_API_KEY or BRAVE_SEARCH_API_KEY');
  const base = env.JOBOS_BRAVE_SEARCH_URL || 'https://api.search.brave.com/res/v1/web/search';
  const url = searchUrl(base, query, { count: String(limit) });
  const { text } = await fetchText(url, { provider, env, headers: { 'X-Subscription-Token': apiKey } });
  return jsonResults(JSON.parse(text), { limit, provider, query, fetchedAt: new Date().toISOString(), baseUrl: 'https://search.brave.com' });
}

async function searxngSearch(query, { limit, env }) {
  const provider = 'searxng';
  const base = env.JOBOS_SEARXNG_URL || '';
  if (!base) throw new Error('Missing JOBOS_SEARXNG_URL');
  const url = searchUrl(base, query, { format: 'json' });
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/search';
  const { text } = await fetchText(url, { provider, env });
  return jsonResults(JSON.parse(text), { limit, provider, query, fetchedAt: new Date().toISOString(), baseUrl: url.origin });
}

export const searchProviders = {
  duckduckgo: { name: 'duckduckgo', search: duckduckgoSearch },
  brave: { name: 'brave', search: braveSearch },
  searxng: { name: 'searxng', search: searxngSearch }
};

function splitProviderNames(value) {
  return String(value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
}

function addUnique(items, name) {
  if (name && !items.includes(name)) items.push(name);
}

export function providerChain(env = process.env) {
  const explicit = splitProviderNames(env.JOBOS_SEARCH_PROVIDERS || env.JOBOS_SEARCH_PROVIDER);
  const chain = [];
  const requested = explicit.length ? explicit : ['duckduckgo'];
  for (const name of requested) {
    if (name === 'auto') {
      if (env.JOBOS_BRAVE_API_KEY || env.BRAVE_SEARCH_API_KEY) addUnique(chain, 'brave');
      if (env.JOBOS_SEARXNG_URL) addUnique(chain, 'searxng');
      addUnique(chain, 'duckduckgo');
      continue;
    }
    addUnique(chain, name);
  }
  addUnique(chain, 'duckduckgo');
  return chain;
}

export async function searchWebDetailed(query, { limit = 5, env = process.env, providers = null } = {}) {
  const warnings = [];
  const attempted = [];
  for (const name of providers || providerChain(env)) {
    attempted.push(name);
    const provider = searchProviders[name];
    if (!provider) {
      warnings.push({ provider: name, message: `Unknown search provider: ${name}` });
      continue;
    }
    try {
      const results = await provider.search(query, { limit, env });
      return {
        query,
        provider: name,
        attempted,
        warnings,
        results: warnings.length ? results.map(result => ({ ...result, warnings: [...warnings] })) : results
      };
    } catch (e) {
      warnings.push({ provider: name, message: e.message });
    }
  }
  return { query, provider: null, attempted, warnings, results: [] };
}

export async function searchWeb(query, options = {}) {
  const detailed = await searchWebDetailed(query, options);
  const results = detailed.results;
  Object.defineProperty(results, 'warnings', { value: detailed.warnings, enumerable: false });
  Object.defineProperty(results, 'provider', { value: detailed.provider, enumerable: false });
  Object.defineProperty(results, 'attempted', { value: detailed.attempted, enumerable: false });
  return results;
}
