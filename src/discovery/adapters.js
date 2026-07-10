import fs from 'node:fs';
import * as cheerio from 'cheerio';

const UA = 'JobOS local discovery (+direct ATS API; no scraping)';

function textFromHtml(value = '') {
  const $ = cheerio.load(String(value || ''));
  $('script,style,noscript').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

function matchesFilters(job, cfg = {}) {
  const words = Array.isArray(cfg.keywords) ? cfg.keywords : String(cfg.keywords || '').split(',');
  const wanted = words.map(x => String(x).trim().toLowerCase()).filter(Boolean);
  const haystack = `${job.title} ${job.company} ${job.location} ${job.description}`.toLowerCase();
  if (wanted.length && !wanted.some(w => haystack.includes(w))) return false;
  const loc = String(cfg.location || '').trim().toLowerCase();
  if (loc && !String(job.location || '').toLowerCase().includes(loc)) return false;
  return true;
}

async function sleep(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

async function getJson(url, cfg, opts = {}) {
  if (cfg.fixture) return JSON.parse(fs.readFileSync(cfg.fixture, 'utf8'));
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) throw Error('fetch is unavailable in this Node runtime');
  await sleep(Number(opts.delayMs ?? cfg.delayMs ?? 250));
  const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': opts.userAgent || cfg.userAgent || UA } });
  if (!res.ok) throw Error(`HTTP ${res.status} fetching ${url}`);
  return await res.json();
}

function greenhouseCompany(cfg = {}, row = {}) {
  return cfg.company || cfg.boardToken || cfg.board_token || row.company_name || 'Unknown company';
}

export const greenhouse = {
  id: 'greenhouse',
  label: 'Greenhouse public boards',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const board = searchConfig.boardToken || searchConfig.board_token || searchConfig.handle || searchConfig.company;
    if (!board && !searchConfig.fixture) throw Error('Greenhouse search requires boardToken');
    const data = await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, searchConfig, opts);
    const rows = Array.isArray(data?.jobs) ? data.jobs : [];
    return rows.map(row => ({
      title: row.title || 'Imported role',
      company: greenhouseCompany(searchConfig, row),
      location: row.location?.name || row.location || '',
      url: row.absolute_url || row.url || '',
      source: 'greenhouse',
      description: textFromHtml(row.content || row.description || ''),
      postedDate: row.updated_at || row.first_published || row.created_at || ''
    })).filter(job => matchesFilters(job, searchConfig));
  }
};

export const lever = {
  id: 'lever',
  label: 'Lever public postings',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const company = searchConfig.company || searchConfig.handle;
    if (!company && !searchConfig.fixture) throw Error('Lever search requires company');
    const data = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`, searchConfig, opts);
    const rows = Array.isArray(data) ? data : [];
    return rows.map(row => ({
      title: row.text || row.title || 'Imported role',
      company: searchConfig.companyLabel || searchConfig.company || searchConfig.handle || 'Unknown company',
      location: row.categories?.location || row.location || '',
      url: row.hostedUrl || row.applyUrl || row.url || '',
      source: 'lever',
      description: textFromHtml([row.descriptionPlain || row.description || '', ...(row.lists || []).map(list => `${list.text || ''}\n${(list.content || '').replace(/<br\s*\/?>/gi, '\n')}`)].join('\n\n')),
      postedDate: row.createdAt ? new Date(Number(row.createdAt)).toISOString() : (row.updatedAt ? new Date(Number(row.updatedAt)).toISOString() : '')
    })).filter(job => matchesFilters(job, searchConfig));
  }
};

export const adapters = { greenhouse, lever };

export function getAdapter(id) {
  const adapter = adapters[String(id || '').toLowerCase()];
  if (!adapter) throw Error(`Unknown discovery adapter: ${id}`);
  return adapter;
}
