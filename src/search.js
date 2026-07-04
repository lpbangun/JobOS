import * as cheerio from 'cheerio';

function timeoutMs(env) {
  return Math.max(1000, Number(env.JOBOS_SEARCH_TIMEOUT_MS || 15000));
}

function searchUrl(base, query) {
  const url = new URL(base || 'https://duckduckgo.com/html/');
  if (!url.searchParams.has('q')) url.searchParams.set('q', query);
  return url;
}

function normalizeUrl(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || url.href;
  } catch {
    return String(raw);
  }
}

function normalizeResults(items, limit) {
  const seen = new Set();
  return (Array.isArray(items) ? items : [])
    .map(item => ({
      title: String(item.title || item.name || '').replace(/\s+/g, ' ').trim(),
      url: normalizeUrl(item.url || item.link || item.href),
      snippet: String(item.snippet || item.description || item.summary || '').replace(/\s+/g, ' ').trim()
    }))
    .filter(item => item.title && item.url)
    .filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return true;
    })
    .slice(0, limit);
}

function jsonResults(data, limit) {
  return normalizeResults(data.results || data.web || data.items || data.data?.web || [], limit);
}

function htmlResults(html, limit) {
  const $ = cheerio.load(html);
  const results = [];
  $('.result, .web-result, .results_links, .result__body, article[data-testid="result"]').each((_, el) => {
    if (results.length >= limit) return false;
    const a = $(el).find('a.result__a[href], a[data-testid="result-title-a"][href], h2 a[href], a[href]').first();
    const href = a.attr('href');
    const title = a.text().trim();
    if (!href || !title) return;
    const snippet = $(el).text().replace(title, '').replace(/\s+/g, ' ').trim();
    results.push({ title, url: normalizeUrl(href), snippet });
  });
  if (!results.length) {
    $('a[href]').each((_, el) => {
      if (results.length >= limit) return false;
      const title = $(el).text().replace(/\s+/g, ' ').trim();
      const href = $(el).attr('href');
      if (title && href) results.push({ title, url: normalizeUrl(href), snippet: '' });
    });
  }
  return normalizeResults(results, limit);
}

export async function searchWeb(query, { limit = 5, env = process.env } = {}) {
  const base = env.JOBOS_SEARCH_BASE_URL || 'https://duckduckgo.com/html/';
  const url = searchUrl(base, query);
  const response = await fetch(url, {
    headers: { 'accept': 'application/json,text/html;q=0.9,*/*;q=0.8', 'user-agent': 'JobOS local research (+human-initiated search)' },
    signal: AbortSignal.timeout(timeoutMs(env))
  });
  if (!response.ok) throw new Error(`Search provider HTTP ${response.status}: ${await response.text()}`);
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  if (type.includes('json') || text.trim().startsWith('{')) return jsonResults(JSON.parse(text), limit);
  return htmlResults(text, limit);
}
