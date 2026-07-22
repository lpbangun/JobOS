import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { DiscoveryLimitError, publicUrl, safeGet } from './http.js';

const UA = 'JobOS local discovery (+public career pages and ATS APIs)';

function textFromHtml(value = '') {
  const $ = cheerio.load(String(value || ''));
  $('script,style,noscript').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

export function matchesFilters(job, cfg = {}, opts = {}) {
  const words = Array.isArray(cfg.keywords) ? cfg.keywords : String(cfg.keywords || '').split(',');
  const wanted = words.map(value => String(value).trim().toLowerCase()).filter(Boolean);
  const haystack = `${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.description || ''}`.toLowerCase();
  if (wanted.length && !wanted.some(value => haystack.includes(value))) return false;

  const location = String(cfg.location || '').trim().toLowerCase();
  if (location && !String(job.location || '').toLowerCase().includes(location)) return false;

  const postedWithinDays = Math.min(3650, Math.floor(Number(cfg.postedWithinDays)));
  if (Number.isFinite(postedWithinDays) && postedWithinDays > 0) {
    const nowValue = opts.now?.() ?? Date.now();
    const nowMs = typeof nowValue === 'string' ? Date.parse(nowValue) : Number(nowValue);
    const postedMs = Date.parse(String(job.postedDate || ''));
    const ageMs = nowMs - postedMs;
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= postedWithinDays * 86_400_000) return false;
  }

  const remoteOnly = cfg.remoteOnly === true || String(cfg.remoteOnly || '').toLowerCase() === 'true';
  if (remoteOnly && job.workModel !== 'remote') return false;

  const requestedTypes = normalizeEmploymentTypes(cfg.employmentTypes);
  if (requestedTypes.length && !requestedTypes.some(type => (job.employmentTypes || []).includes(type))) return false;
  return true;
}


function positiveLimit(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
}

function nativeText(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value).trim();
  if (value && typeof value === 'object') return String(value.name ?? value.label ?? value.value ?? value.text ?? '').trim();
  return '';
}

function metadataValue(metadata, names) {
  const wanted = names.map(name => name.toLowerCase());
  for (const item of arrayValue(metadata)) {
    const name = String(item?.name ?? item?.label ?? item?.key ?? '').trim().toLowerCase();
    if (wanted.includes(name)) return item?.value ?? item?.values ?? item?.text ?? null;
  }
  return null;
}

function canonicalWorkModel(value, location = '') {
  const text = arrayValue(value).map(nativeText).filter(Boolean).join(' ').toLowerCase();
  if (/\bhybrid\b/.test(text)) return 'hybrid';
  if (/\b(remote|telecommute|distributed)\b/.test(text)) return 'remote';
  if (/\b(on[ -]?site|in[ -]?person|office)\b/.test(text)) return 'onsite';
  return /\bremote\b/i.test(String(location || '')) ? 'remote' : 'unknown';
}

function canonicalEmploymentType(value) {
  const text = nativeText(value).toLowerCase().replace(/[_-]+/g, ' ');
  if (!text) return null;
  if (/\bfull\s*time\b/.test(text)) return 'full_time';
  if (/\bpart\s*time\b/.test(text)) return 'part_time';
  if (/\b(contract|contractor|freelance)\b/.test(text)) return 'contract';
  if (/\b(temp|temporary|seasonal)\b/.test(text)) return 'temporary';
  if (/\b(intern|internship|apprentice)\b/.test(text)) return 'internship';
  if (/\bvolunteer\b/.test(text)) return 'volunteer';
  return 'other';
}

export function normalizeEmploymentTypes(value) {
  return [...new Set(arrayValue(value).map(canonicalEmploymentType).filter(Boolean))];
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compensationInterval(value) {
  const text = String(value || '').toLowerCase();
  if (/\bhour/.test(text)) return 'hour';
  if (/\bday/.test(text)) return 'day';
  if (/\bweek/.test(text)) return 'week';
  if (/\bmonth/.test(text)) return 'month';
  if (/\b(year|annual|annum)/.test(text)) return 'year';
  return 'unknown';
}

function normalizeCompensation(value, displayText = '') {
  const first = arrayValue(value)[0];
  const quantitative = first?.value && typeof first.value === 'object' ? first.value : first;
  const cents = first && (Object.hasOwn(first, 'min_cents') || Object.hasOwn(first, 'max_cents'));
  const min = finiteNumber(quantitative?.min ?? quantitative?.minValue ?? quantitative?.minimum ?? quantitative?.min_cents);
  const max = finiteNumber(quantitative?.max ?? quantitative?.maxValue ?? quantitative?.maximum ?? quantitative?.max_cents);
  const adjustedMin = cents && min != null ? min / 100 : min;
  const adjustedMax = cents && max != null ? max / 100 : max;
  const currency = String(first?.currency ?? first?.currency_type ?? first?.currencyCode ?? '').trim().toUpperCase();
  const interval = compensationInterval(first?.interval ?? first?.unitText ?? first?.title ?? quantitative?.unitText);
  const text = String(displayText || first?.text || first?.summary || '').trim();
  return { text, min: adjustedMin, max: adjustedMax, currency, interval };
}

function normalizedJob(fields, native, hint) {
  const location = String(fields.location || '');
  const compensation = normalizeCompensation(native.compensation, fields.compensationText);
  return {
    version: 1,
    title: fields.title || 'Imported role',
    company: fields.company || 'Unknown company',
    location,
    url: fields.url || '',
    source: fields.source,
    sourceId: String(fields.sourceId || ''),
    description: fields.description || '',
    postedDate: fields.postedDate || '',
    compensation,
    workModel: canonicalWorkModel(native.workModel, location),
    employmentTypes: normalizeEmploymentTypes(native.employmentType),
    department: arrayValue(native.department).map(nativeText).filter(Boolean).join(' / '),
    sourceNativeFields: {
      compensation: native.compensation ?? null,
      workModel: native.workModel ?? null,
      employmentType: native.employmentType ?? null,
      department: native.department ?? null
    },
    livenessHint: hint
  };
}

function listingHint(kind, request, opts) {
  return { kind, observedAt: observedAt(opts), request };
}


function observedAt(opts = {}) {
  const value = opts.now?.() ?? Date.now();
  const date = new Date(typeof value === 'string' ? value : Number(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function fixtureRequest(url) {
  return { requestedUrl: String(url), finalUrl: String(url), httpStatus: 200 };
}

async function getJson(url, cfg, opts = {}) {
  if (cfg.fixture) return { value: JSON.parse(fs.readFileSync(cfg.fixture, 'utf8')), request: fixtureRequest(url) };
  const result = await safeGet(url, cfg, { ...opts, accept: 'application/json' });
  return { value: await result.response.json(), request: { requestedUrl: result.requestedUrl, finalUrl: result.finalUrl, httpStatus: result.status } };
}

async function getText(url, cfg, opts = {}) {
  if (cfg.fixture) return { value: fs.readFileSync(cfg.fixture, 'utf8'), request: fixtureRequest(url) };
  const result = await safeGet(url, cfg, { ...opts, accept: 'text/html,application/xhtml+xml' });
  return { value: await result.response.text(), request: { requestedUrl: result.requestedUrl, finalUrl: result.finalUrl, httpStatus: result.status } };
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
    const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
    const { value: data, request } = await getJson(endpoint, searchConfig, opts);
    const rows = Array.isArray(data?.jobs) ? data.jobs : [];
    const hint = listingHint('listed_in_public_ats', request, opts);
    return rows.map(row => {
      const location = row.location?.name || row.location || '';
      const compensation = row.pay_input_ranges ?? metadataValue(row.metadata, ['compensation', 'salary', 'pay range']);
      const workModel = row.workplace_type ?? row.work_model ?? metadataValue(row.metadata, ['workplace type', 'work model', 'remote']);
      const employmentType = row.employment_type ?? metadataValue(row.metadata, ['employment type', 'commitment']);
      const department = row.departments ?? row.department ?? metadataValue(row.metadata, ['department', 'team']);
      return normalizedJob({
        title: row.title,
        company: greenhouseCompany(searchConfig, row),
        location,
        url: row.absolute_url || row.url || '',
        source: 'greenhouse',
        sourceId: row.id,
        description: textFromHtml(row.content || row.description || ''),
        postedDate: row.updated_at || row.first_published || row.created_at || '',
        compensationText: metadataValue(row.metadata, ['compensation', 'salary', 'pay range'])
      }, { compensation, workModel, employmentType, department }, hint);
    }).filter(job => matchesFilters(job, searchConfig, opts));
  }
};

export const lever = {
  id: 'lever',
  label: 'Lever public postings',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const company = searchConfig.company || searchConfig.handle;
    if (!company && !searchConfig.fixture) throw Error('Lever search requires company');
    const endpoint = `https://api.lever.co/v0/postings/${encodeURIComponent(company)}?mode=json`;
    const { value: data, request } = await getJson(endpoint, searchConfig, opts);
    const rows = Array.isArray(data) ? data : [];
    const hint = listingHint('listed_in_public_ats', request, opts);
    return rows.map(row => {
      const location = row.categories?.location || row.location || '';
      const compensation = row.salaryRange ?? row.compensation ?? null;
      const workModel = row.workplaceType ?? row.workplace_type ?? row.categories?.workplaceType ?? null;
      const employmentType = row.categories?.commitment ?? row.employmentType ?? null;
      const department = row.categories?.department ?? row.categories?.team ?? row.department ?? row.team ?? null;
      return normalizedJob({
        title: row.text || row.title,
        company: searchConfig.companyLabel || searchConfig.company || searchConfig.handle || 'Unknown company',
        location,
        url: row.hostedUrl || row.applyUrl || row.url || '',
        source: 'lever',
        sourceId: row.id,
        description: textFromHtml([row.descriptionPlain || row.description || '', ...(row.lists || []).map(list => `${list.text || ''}\n${(list.content || '').replace(/<br\s*\/?>/gi, '\n')}`)].join('\n\n')),
        postedDate: row.createdAt ? new Date(Number(row.createdAt)).toISOString() : (row.updatedAt ? new Date(Number(row.updatedAt)).toISOString() : ''),
        compensationText: row.salaryDescription || row.compensationText || ''
      }, { compensation, workModel, employmentType, department }, hint);
    }).filter(job => matchesFilters(job, searchConfig, opts));
  }
};

export const ashby = {
  id: 'ashby',
  label: 'Ashby public job boards',
  async fetchJobs(searchConfig = {}, opts = {}) {
    const board = searchConfig.handle || searchConfig.boardToken || searchConfig.board_token || searchConfig.company;
    if (!board && !searchConfig.fixture) throw Error('Ashby search requires handle');
    const endpoint = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;
    const { value: data, request } = await getJson(endpoint, searchConfig, opts);
    const rows = Array.isArray(data?.jobs) ? data.jobs : [];
    const hint = listingHint('listed_in_public_ats', request, opts);
    return rows.filter(row => row?.isListed !== false).map(row => {
      const location = row.location || row.secondaryLocations?.map(item => item.location || item.name).filter(Boolean).join(', ') || '';
      const compensation = row.compensation ?? row.compensationTierSummary ?? row.salaryRange ?? null;
      const workModel = row.workplaceType ?? row.workModel ?? (row.isRemote === true ? 'remote' : null);
      const employmentType = row.employmentType ?? row.employmentTypes ?? null;
      const department = row.department ?? row.team ?? null;
      return normalizedJob({
        title: row.title,
        company: searchConfig.companyLabel || searchConfig.company || data?.organizationName || board || 'Unknown company',
        location,
        url: row.jobUrl || row.applyUrl || row.url || '',
        source: 'ashby',
        sourceId: row.id,
        description: textFromHtml(row.descriptionHtml || row.descriptionPlain || row.description || ''),
        postedDate: row.publishedAt || row.updatedAt || row.createdAt || '',
        compensationText: row.compensationTierSummary || row.compensationText || ''
      }, { compensation, workModel, employmentType, department }, hint);
    }).filter(job => matchesFilters(job, searchConfig, opts));
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

function parseCareerPage(html, pageUrl, searchConfig = {}, request = fixtureRequest(pageUrl), opts = {}) {
  const $ = cheerio.load(String(html || ''));
  const fallbackCompany = searchConfig.companyLabel || searchConfig.company || publicUrl(pageUrl).hostname.replace(/^www\./, '');
  const hint = listingHint('listed_on_career_page', request, opts);
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
        const location = locationFromPosting(posting);
        jobs.push(normalizedJob({
          title: posting.title || posting.name,
          company: searchConfig.companyLabel || searchConfig.company || (typeof organization === 'string' ? organization : organization?.name) || fallbackCompany,
          location,
          url: jobUrl,
          source: 'career-page',
          sourceId: typeof posting.identifier === 'object' ? posting.identifier?.value || posting.identifier?.name : posting.identifier || jobUrl,
          description: textFromHtml(posting.description || posting.responsibilities || posting.skills || ''),
          postedDate: posting.datePosted || posting.dateModified || '',
          compensationText: posting.baseSalary?.description || ''
        }, {
          compensation: posting.baseSalary ?? null,
          workModel: posting.jobLocationType ?? posting.workModel ?? null,
          employmentType: posting.employmentType ?? null,
          department: posting.department ?? null
        }, hint));
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
    const location = $(link).attr('data-location') || card.find('[class*="location"]').first().text().replace(/\s+/g, ' ').trim() || '';
    jobs.push(normalizedJob({
      title: titleFromLink($, link, parsed),
      company: fallbackCompany,
      location,
      url: parsed.href,
      source: 'career-page',
      sourceId: parsed.href,
      description: '',
      postedDate: ''
    }, {
      compensation: null,
      workModel: $(link).attr('data-workplace') || null,
      employmentType: $(link).attr('data-employment-type') || null,
      department: $(link).attr('data-department') || null
    }, hint));
  });
  return {
    jobs: dedupeJobs(jobs).filter(job => matchesFilters(job, searchConfig, opts)),
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
    const { value: html, request } = await getText(pageUrl, searchConfig, opts);
    return parseCareerPage(html, pageUrl, searchConfig, request, opts).jobs;
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
    const nowMs = () => {
      const value = opts.now?.() ?? Date.now();
      return typeof value === 'string' ? Date.parse(value) : Number(value);
    };
    const startedAt = nowMs();
    const totalTimeoutMs = positiveLimit(opts.totalTimeoutMs ?? searchConfig.totalTimeoutMs, 60_000, 60_000);
    const maxRequests = positiveLimit(opts.maxRequests ?? searchConfig.maxRequests, 90, 90);
    const localBudget = {
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
        return totalTimeoutMs - (nowMs() - startedAt);
      },
      truncate(reason) {
        metadata.truncated = true;
        if (!metadata.reason) metadata.reason = reason;
      }
    };
    const budget = opts.budget || localBudget;
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
    const { value: rootHtml } = await getText(url, searchConfig, routedOpts);
    const discovered = portfolioCompanies(rootHtml, url);
    const maxCompanies = positiveLimit(searchConfig.maxCompanies, 30, 30);
    if (discovered.length > maxCompanies) budget.truncate('max_companies');
    const childConfig = { ...searchConfig };
    delete childConfig.fixture;
    delete childConfig.url;

    for (const company of discovered.slice(0, maxCompanies)) {
      if (budget.remainingMs() <= 0 || (budget.snapshot?.().requests ?? metadata.fetchedCount) >= maxRequests) {
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
        const { value: html, request } = await getText(company.url, childConfig, routedOpts);
        parsed = parseCareerPage(html, company.url, { ...childConfig, companyLabel: company.name }, request, routedOpts);
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
    if (budget.snapshot) {
      const snapshot = budget.snapshot();
      metadata.fetchedCount = snapshot.requests;
      if (snapshot.truncated) {
        metadata.truncated = true;
        metadata.reason ||= snapshot.reason;
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
