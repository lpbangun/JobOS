import fs from 'node:fs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import * as cheerio from 'cheerio';

const UA = 'JobOS local discovery (+public career pages and ATS APIs)';

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

class DiscoveryLimitError extends Error {
  constructor(reason) {
    super(`Discovery limit reached: ${reason}`);
    this.name = 'DiscoveryLimitError';
    this.reason = reason;
  }
}

function isBlockedIp(value) {
  let address = String(value || '').split('%')[0].toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113);
  }
  if (isIP(address) === 6) {
    return address === '::' || address === '::1' ||
      address.startsWith('fc') || address.startsWith('fd') ||
      /^fe[89ab]/.test(address) || address.startsWith('ff') ||
      address.startsWith('2001:db8:');
  }
  return false;
}

function publicUrl(value, base) {
  let parsed;
  try {
    parsed = new URL(String(value || ''), base);
  } catch {
    throw Error(`Invalid discovery URL: ${value}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw Error(`Unsupported discovery URL protocol: ${parsed.protocol}`);
  if (parsed.username || parsed.password) throw Error('Discovery URLs must not contain credentials');
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa') || isBlockedIp(hostname)) {
    throw Error(`Discovery URL must use a public host: ${hostname}`);
  }
  parsed.hash = '';
  return parsed;
}

async function assertPublicAddress(parsed, fetchImpl, opts) {
  if (fetchImpl !== globalThis.fetch || isIP(parsed.hostname)) return;
  const lookupImpl = opts.lookup || lookup;
  const addresses = await lookupImpl(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) {
    throw Error(`Discovery URL resolved to a non-public host: ${parsed.hostname}`);
  }
}

function positiveLimit(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

async function requestOnce(url, cfg, opts, accept) {
  const parsed = publicUrl(url);
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) throw Error('fetch is unavailable in this Node runtime');
  const delayMs = Math.max(0, Number(opts.delayMs ?? cfg.delayMs ?? 250) || 0);
  if (opts.budget && delayMs >= opts.budget.remainingMs()) {
    opts.budget.truncate('time_limit');
    throw new DiscoveryLimitError('time_limit');
  }
  await sleep(delayMs);
  opts.budget?.enter(parsed.href);
  const remainingMs = opts.budget?.remainingMs() ?? 10_000;
  if (remainingMs <= 0) {
    opts.budget?.truncate('time_limit');
    throw new DiscoveryLimitError('time_limit');
  }
  const timeoutMs = Math.max(1, Math.min(
    positiveLimit(opts.requestTimeoutMs ?? cfg.requestTimeoutMs, 10_000, 10_000),
    remainingMs
  ));
  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(Error(`Request timed out after ${timeoutMs}ms fetching ${parsed.href}`));
    }, timeoutMs);
  });
  const request = (async () => {
    await assertPublicAddress(parsed, fetchImpl, opts);
    if (timedOut) throw Error(`Request timed out after ${timeoutMs}ms fetching ${parsed.href}`);
    return await fetchImpl(parsed.href, {
      headers: { accept, 'user-agent': opts.userAgent || cfg.userAgent || UA },
      redirect: 'manual',
      signal: controller.signal
    });
  })();
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (opts.budget && opts.budget.remainingMs() <= 0) {
      opts.budget.truncate('time_limit');
      throw new DiscoveryLimitError('time_limit');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchResponse(url, cfg, opts, accept) {
  let current = publicUrl(url).href;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const res = await requestOnce(current, cfg, opts, accept);
    const status = Number(res.status || 0);
    const location = status >= 300 && status < 400 && res.headers?.get?.('location');
    if (location) {
      current = publicUrl(location, current).href;
      continue;
    }
    if (res.ok === false) throw Error(`HTTP ${res.status} fetching ${current}`);
    return res;
  }
  throw Error(`Too many redirects fetching ${url}`);
}

async function getJson(url, cfg, opts = {}) {
  if (cfg.fixture) return JSON.parse(fs.readFileSync(cfg.fixture, 'utf8'));
  const res = await fetchResponse(url, cfg, opts, 'application/json');
  return await res.json();
}

async function getText(url, cfg, opts = {}) {
  if (cfg.fixture) return fs.readFileSync(cfg.fixture, 'utf8');
  const res = await fetchResponse(url, cfg, opts, 'text/html,application/xhtml+xml');
  return await res.text();
}

function greenhouseCompany(cfg = {}, row = {}) {
  return cfg.companyLabel || cfg.company || cfg.boardToken || cfg.board_token || row.company_name || 'Unknown company';
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

export const ashby = {
  id: 'ashby',
  label: 'Ashby public job boards',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const board = searchConfig.handle || searchConfig.boardToken || searchConfig.board_token || searchConfig.company;
    if (!board && !searchConfig.fixture) throw Error('Ashby search requires handle');
    const data = await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`, searchConfig, opts);
    const rows = Array.isArray(data?.jobs) ? data.jobs : [];
    return rows.filter(row => row?.isListed !== false).map(row => ({
      title: row.title || 'Imported role',
      company: searchConfig.companyLabel || searchConfig.company || data?.organizationName || board || 'Unknown company',
      location: row.location || row.secondaryLocations?.map(item => item.location || item.name).filter(Boolean).join(', ') || '',
      url: row.jobUrl || row.applyUrl || row.url || '',
      source: 'ashby',
      description: textFromHtml(row.descriptionHtml || row.descriptionPlain || row.description || ''),
      postedDate: row.publishedAt || row.updatedAt || row.createdAt || ''
    })).filter(job => matchesFilters(job, searchConfig));
  }
};

function schemaTypes(value) {
  const types = Array.isArray(value) ? value : [value];
  return types.some(type => String(type || '').toLowerCase().split('/').pop() === 'jobposting');
}

function collectJobPostings(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    for (const item of value) collectJobPostings(item, found);
    return found;
  }
  if (schemaTypes(value['@type'])) found.push(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') collectJobPostings(child, found);
  }
  return found;
}

function locationFromPosting(posting) {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation].filter(Boolean);
  const names = locations.map(location => {
    if (typeof location === 'string') return location;
    const address = typeof location?.address === 'string' ? location.address : location?.address || {};
    return location?.name || [
      address.addressLocality,
      address.addressRegion,
      typeof address.addressCountry === 'object' ? address.addressCountry?.name : address.addressCountry
    ].filter(Boolean).join(', ');
  }).filter(Boolean);
  if (String(posting.jobLocationType || '').toUpperCase() === 'TELECOMMUTE') names.unshift('Remote');
  return [...new Set(names)].join(' / ');
}

function atsTarget(value, base) {
  let parsed;
  try {
    parsed = publicUrl(value, base);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') {
    const handle = parsed.searchParams.get('for') || parts[0];
    return handle ? { adapter: 'greenhouse', handle, url: parsed.href } : null;
  }
  if (host === 'boards-api.greenhouse.io' && parts[0] === 'v1' && parts[1] === 'boards' && parts[2]) {
    return { adapter: 'greenhouse', handle: parts[2], url: parsed.href };
  }
  if (host === 'jobs.lever.co' && parts[0]) return { adapter: 'lever', handle: parts[0], url: parsed.href };
  if (host === 'api.lever.co' && parts[0] === 'v0' && parts[1] === 'postings' && parts[2]) {
    return { adapter: 'lever', handle: parts[2], url: parsed.href };
  }
  if (host === 'jobs.ashbyhq.com' && parts[0]) return { adapter: 'ashby', handle: parts[0], url: parsed.href };
  if (host === 'api.ashbyhq.com' && parts[0] === 'posting-api' && parts[1] === 'job-board' && parts[2]) {
    return { adapter: 'ashby', handle: parts[2], url: parsed.href };
  }
  return null;
}

function isDirectJobLink(parsed, target) {
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (target?.adapter === 'greenhouse') return parts.includes('jobs') && parts.length >= 3 || parsed.searchParams.has('gh_jid');
  if (target?.adapter === 'lever' || target?.adapter === 'ashby') return parts.length >= 2;
  if (['job', 'jobid', 'job_id', 'gh_jid'].some(key => parsed.searchParams.has(key))) return true;
  const marker = parts.findIndex(part => /^(?:jobs?|careers?|openings?|positions?|roles?)$/i.test(part));
  return marker >= 0 && marker < parts.length - 1;
}

function titleFromLink($, link, parsed) {
  const direct = $(link).attr('aria-label') || $(link).attr('title') || $(link).text();
  const cleaned = String(direct || '').replace(/\s+/g, ' ').trim();
  if (cleaned && !/^(?:apply|apply now|learn more|view (?:job|role|opening)|details)$/i.test(cleaned)) return cleaned;
  const cardTitle = $(link).closest('li,article,[class*="job"],[class*="opening"],[class*="position"],[class*="role"]').find('h1,h2,h3,h4,[class*="title"]').first().text().replace(/\s+/g, ' ').trim();
  if (cardTitle) return cardTitle;
  const slugPart = parsed.pathname.split('/').filter(Boolean).pop() || 'Imported role';
  return decodeURIComponent(slugPart).replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}

function jobKey(job) {
  if (job.url) {
    try {
      const parsed = publicUrl(job.url);
      return `url:${parsed.href.replace(/\/$/, '')}`;
    } catch {
      // Fall through to a content key.
    }
  }
  return `job:${job.title}|${job.company}|${job.location}`.toLowerCase();
}

function dedupeJobs(jobs) {
  const unique = new Map();
  for (const job of jobs) {
    const key = jobKey(job);
    const prior = unique.get(key);
    if (!prior || String(job.description || '').length > String(prior.description || '').length) unique.set(key, job);
  }
  return [...unique.values()];
}

function parseCareerPage(html, pageUrl, searchConfig = {}) {
  const $ = cheerio.load(String(html || ''));
  const fallbackCompany = searchConfig.companyLabel || searchConfig.company || publicUrl(pageUrl).hostname.replace(/^www\./, '');
  const jobs = [];
  $('script[type="application/ld+json"]').each((_, script) => {
    try {
      const data = JSON.parse($(script).html() || $(script).text() || '');
      for (const posting of collectJobPostings(data)) {
        const organization = posting.hiringOrganization;
        const rawUrl = posting.url || posting.mainEntityOfPage || pageUrl;
        let jobUrl;
        try {
          jobUrl = publicUrl(typeof rawUrl === 'object' ? rawUrl['@id'] || rawUrl.url : rawUrl, pageUrl).href;
        } catch {
          continue;
        }
        jobs.push({
          title: posting.title || posting.name || 'Imported role',
          company: searchConfig.companyLabel || searchConfig.company || (typeof organization === 'string' ? organization : organization?.name) || fallbackCompany,
          location: locationFromPosting(posting),
          url: jobUrl,
          source: 'career-page',
          description: textFromHtml(posting.description || posting.responsibilities || posting.skills || ''),
          postedDate: posting.datePosted || posting.dateModified || ''
        });
      }
    } catch {
      // Malformed third-party JSON-LD is ignored; useful links can still be recovered.
    }
  });
  const targets = [];
  const seenTargets = new Set();
  $('a[href]').each((_, link) => {
    let parsed;
    try {
      parsed = publicUrl($(link).attr('href'), pageUrl);
    } catch {
      return;
    }
    const target = atsTarget(parsed.href);
    if (target) {
      const targetKey = `${target.adapter}:${target.handle}`;
      if (!seenTargets.has(targetKey)) {
        seenTargets.add(targetKey);
        targets.push(target);
      }
    }
    if (!isDirectJobLink(parsed, target)) return;
    const card = $(link).closest('li,article,[class*="job"],[class*="opening"],[class*="position"],[class*="role"]');
    jobs.push({
      title: titleFromLink($, link, parsed),
      company: fallbackCompany,
      location: $(link).attr('data-location') || card.find('[class*="location"]').first().text().replace(/\s+/g, ' ').trim() || '',
      url: parsed.href,
      source: 'career-page',
      description: '',
      postedDate: ''
    });
  });
  return {
    jobs: dedupeJobs(jobs).filter(job => matchesFilters(job, searchConfig)),
    targets
  };
}

export const careerPage = {
  id: 'career-page',
  label: 'Public career pages',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const url = searchConfig.url;
    if (!url && !searchConfig.fixture) throw Error('Career-page search requires url');
    const pageUrl = url || 'https://fixture.invalid/careers';
    const html = await getText(pageUrl, searchConfig, opts);
    return parseCareerPage(html, pageUrl, searchConfig).jobs;
  }
};

const NON_COMPANY_HOSTS = new Set([
  'facebook.com', 'instagram.com', 'linkedin.com', 'medium.com', 'twitter.com',
  'x.com', 'youtube.com'
]);

function portfolioCompanies(html, pageUrl) {
  const $ = cheerio.load(String(html || ''));
  const portfolioHost = publicUrl(pageUrl).hostname.replace(/^www\./, '');
  const seen = new Set();
  const companies = [];
  $('a[href]').each((_, link) => {
    let parsed;
    try {
      parsed = publicUrl($(link).attr('href'), pageUrl);
    } catch {
      return;
    }
    const host = parsed.hostname.replace(/^www\./, '');
    if (host === portfolioHost || NON_COMPANY_HOSTS.has(host) || [...NON_COMPANY_HOSTS].some(item => host.endsWith(`.${item}`))) return;
    const key = atsTarget(parsed.href) ? parsed.href : parsed.origin;
    if (seen.has(key)) return;
    seen.add(key);
    companies.push({
      name: $(link).attr('aria-label') || $(link).attr('title') || $(link).text().replace(/\s+/g, ' ').trim() || host.split('.')[0],
      url: parsed.href
    });
  });
  return companies;
}

export const portfolio = {
  id: 'portfolio',
  label: 'VC and startup portfolio routing',
  async fetchJobs(searchConfig = {}, opts = {}) {
    if (!searchConfig.url && !searchConfig.fixture) throw Error('Portfolio search requires url');
    const url = searchConfig.url || 'https://fixture.invalid/portfolio';
    const metadata = { truncated: false, reason: null, fetchedCount: 0, errors: [] };
    const startedAt = Date.now();
    const totalTimeoutMs = positiveLimit(opts.totalTimeoutMs ?? searchConfig.totalTimeoutMs, 60_000, 60_000);
    const maxRequests = positiveLimit(opts.maxRequests ?? searchConfig.maxRequests, 90, 90);
    const budget = {
      enter() {
        if (metadata.fetchedCount >= maxRequests) {
          this.truncate('request_limit');
          throw new DiscoveryLimitError('request_limit');
        }
        if (this.remainingMs() <= 0) {
          this.truncate('time_limit');
          throw new DiscoveryLimitError('time_limit');
        }
        metadata.fetchedCount += 1;
      },
      remainingMs() {
        return totalTimeoutMs - (Date.now() - startedAt);
      },
      truncate(reason) {
        metadata.truncated = true;
        if (!metadata.reason) metadata.reason = reason;
      }
    };
    const routedOpts = {
      ...opts,
      budget,
      delayMs: opts.delayMs ?? searchConfig.delayMs ?? 0,
      requestTimeoutMs: positiveLimit(opts.requestTimeoutMs ?? searchConfig.requestTimeoutMs, 10_000, 10_000)
    };
    const recordError = (source, sourceUrl, error) => {
      metadata.errors.push({ source, url: sourceUrl, message: error?.message || String(error) });
    };
    const allJobs = [];
    const rootHtml = await getText(url, searchConfig, routedOpts);
    const discovered = portfolioCompanies(rootHtml, url);
    const maxCompanies = positiveLimit(searchConfig.maxCompanies, 30, 30);
    if (discovered.length > maxCompanies) budget.truncate('max_companies');
    const childConfig = { ...searchConfig };
    delete childConfig.fixture;
    delete childConfig.url;

    for (const company of discovered.slice(0, maxCompanies)) {
      if (budget.remainingMs() <= 0 || metadata.fetchedCount >= maxRequests) {
        budget.truncate(budget.remainingMs() <= 0 ? 'time_limit' : 'request_limit');
        break;
      }
      const directTarget = atsTarget(company.url);
      if (directTarget) {
        try {
          const adapter = getAdapter(directTarget.adapter);
          const jobs = await adapter.fetchJobs({ ...childConfig, handle: directTarget.handle, companyLabel: company.name }, routedOpts);
          allJobs.push(...jobs);
        } catch (error) {
          if (error instanceof DiscoveryLimitError) break;
          recordError(directTarget.adapter, company.url, error);
        }
        continue;
      }

      let parsed;
      try {
        const html = await getText(company.url, childConfig, routedOpts);
        parsed = parseCareerPage(html, company.url, { ...childConfig, companyLabel: company.name });
        allJobs.push(...parsed.jobs);
      } catch (error) {
        if (error instanceof DiscoveryLimitError) break;
        recordError('career-page', company.url, error);
        continue;
      }

      if (parsed.targets.length > 2) budget.truncate('per_company_ats_limit');
      for (const target of parsed.targets.slice(0, 2)) {
        try {
          const adapter = getAdapter(target.adapter);
          const jobs = await adapter.fetchJobs({ ...childConfig, handle: target.handle, companyLabel: company.name }, routedOpts);
          allJobs.push(...jobs);
        } catch (error) {
          if (error instanceof DiscoveryLimitError) break;
          recordError(target.adapter, target.url, error);
        }
      }
    }
    return { jobs: dedupeJobs(allJobs), metadata };
  }
};

export const adapters = { greenhouse, lever, ashby, 'career-page': careerPage, portfolio };

export function getAdapter(id) {
  const adapter = adapters[String(id || '').toLowerCase()];
  if (!adapter) throw Error(`Unknown discovery adapter: ${id}`);
  return adapter;
}
