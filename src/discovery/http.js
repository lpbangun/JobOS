import { isIP } from 'node:net';

const UA = 'JobOS local discovery (+public career pages and ATS APIs)';

const MAX_REDIRECTS = 5;
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 10_000;
const FALLBACK_BACKOFF_MS = [250, 500];
const DEFAULT_MAX_REQUESTS = 90;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const RETRYABLE_STATUS = new Set([429, 503]);

class DiscoveryLimitError extends Error {
  constructor(reason, fields = {}) {
    super(fields.message || `Discovery limit reached: ${reason}`);
    this.name = 'DiscoveryLimitError';
    this.reason = reason;
    this.code = reason;
    this.stage = fields.stage || 'budget';
    this.retryable = false;
    this.url = fields.url || '';
    if (fields.source !== undefined) this.source = fields.source;
    if (fields.jobKey !== undefined) this.jobKey = fields.jobKey;
    this.details = fields.details || {};
  }
}

export { DiscoveryLimitError };

function typedError({ code, stage, message, retryable = false, url = '', source, jobKey, details = {} }) {
  if (code === 'request_limit' || code === 'time_limit') {
    return new DiscoveryLimitError(code, { stage, message, url, source, jobKey, details });
  }
  const error = new Error(message);
  error.name = 'DiscoveryError';
  error.code = code;
  error.stage = stage;
  error.retryable = retryable;
  error.url = url;
  if (source !== undefined) error.source = source;
  if (jobKey !== undefined) error.jobKey = jobKey;
  error.details = details;
  return error;
}

function positiveLimit(value, fallback, maximum) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function ipv4FromMapped(mapped) {
  if (isIP(mapped) === 4) return mapped;
  const parts = mapped.split(':');
  if (parts.length === 2) {
    const high = parseInt(parts[0], 16);
    const low = parseInt(parts[1], 16);
    if (Number.isFinite(high) && Number.isFinite(low)) {
      return `${(high >> 8) & 0xFF}.${high & 0xFF}.${(low >> 8) & 0xFF}.${low & 0xFF}`;
    }
  }
  return null;
}

export function isBlockedIp(value) {
  let address = String(value || '').split('%')[0].toLowerCase();
  if (address.startsWith('::ffff:')) {
    const mapped = address.slice(7);
    address = ipv4FromMapped(mapped) || mapped;
  }
  if (isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
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

export function publicUrl(value, base) {
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
  // Pre-flight DNS resolution rejects non-public hosts before the request.
  // This is a TOCTOU control, not DNS pinning: a rebinding attack between
  // resolution and the actual fetch is not prevented. The control preserves
  // the pre-W03 SSRF boundary (no private/loopback/link-local/documentation
  // addresses at resolution time) without claiming rebinding protection.
  // An explicit injected lookup must always run, even with an injected fetch.
  // The production global fetch must resolve and validate DNS for hostnames.
  if (opts.lookup) {
    const addresses = await opts.lookup(parsed.hostname, { all: true, verbatim: true });
    if (!Array.isArray(addresses) || addresses.length === 0) {
      throw typedError({
        code: 'dns_blocked',
        stage: 'dns',
        message: `Discovery URL resolved to a non-public host: ${parsed.hostname}`,
        url: parsed.href,
        details: { hostname: parsed.hostname }
      });
    }
    if (addresses.some(item => isBlockedIp(item.address))) {
      throw typedError({
        code: 'dns_blocked',
        stage: 'dns',
        message: `Discovery URL resolved to a non-public host: ${parsed.hostname}`,
        url: parsed.href,
        details: { hostname: parsed.hostname }
      });
    }
    return;
  }
  if (fetchImpl !== globalThis.fetch) return;
  if (isIP(parsed.hostname)) {
    if (isBlockedIp(parsed.hostname)) {
      throw typedError({
        code: 'dns_blocked',
        stage: 'dns',
        message: `Discovery URL resolved to a non-public host: ${parsed.hostname}`,
        url: parsed.href,
        details: { hostname: parsed.hostname }
      });
    }
    return;
  }
  const { lookup } = await import('node:dns/promises');
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(item => isBlockedIp(item.address))) {
    throw typedError({
      code: 'dns_blocked',
      stage: 'dns',
      message: `Discovery URL resolved to a non-public host: ${parsed.hostname}`,
      url: parsed.href,
      details: { hostname: parsed.hostname }
    });
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' ||
    /aborted/i.test(String(error?.message || '')) ||
    /timed out/i.test(String(error?.message || ''));
}

// Parse Retry-After per RFC 7231: non-negative integer delta-seconds, or IMF-fixdate.
// Returns { delayMs, valid } where valid=false means use fallback backoff.
export function parseRetryAfter(headerValue, nowMs) {
  const raw = String(headerValue ?? '').trim();
  if (raw === '') return { delayMs: null, valid: false };

  // Integer delta-seconds.
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return { delayMs: seconds * 1000, valid: true };
  }

  // IMF-fixdate: e.g. "Wed, 22 Jul 2026 00:00:03 GMT"
  if (/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(raw)) {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) {
      const delayMs = parsed - nowMs;
      if (delayMs <= 0) return { delayMs: null, valid: false };
      return { delayMs, valid: true };
    }
  }
  return { delayMs: null, valid: false };
}

export function createDiscoveryBudget(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const maxRequests = positiveLimit(options.maxRequests, DEFAULT_MAX_REQUESTS, DEFAULT_MAX_REQUESTS);
  const totalTimeoutMs = positiveLimit(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, DEFAULT_TOTAL_TIMEOUT_MS);
  const startedAt = Number(now());
  let requests = 0;
  let truncated = false;
  let reason = null;

  return {
    enter() {
      if (requests >= maxRequests) {
        truncated = true;
        if (!reason) reason = 'request_limit';
        throw new DiscoveryLimitError('request_limit');
      }
      if (this.remainingMs() <= 0) {
        truncated = true;
        if (!reason) reason = 'time_limit';
        throw new DiscoveryLimitError('time_limit');
      }
      requests += 1;
      return true;
    },
    remainingMs() {
      return Math.max(0, totalTimeoutMs - (Number(now()) - startedAt));
    },
    truncate(cause) {
      truncated = true;
      if (!reason) reason = cause;
    },
    snapshot() {
      return { requests, maxRequests, remainingMs: this.remainingMs(), truncated, reason, startedAt };
    }
  };
}

async function defaultSleep(ms) {
  if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms));
}

function userAgent(cfg, opts) {
  return opts.userAgent || cfg.userAgent || UA;
}

async function performRequest(parsed, cfg, opts, accept) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (!fetchImpl) throw typedError({ code: 'no_fetch', stage: 'transport', message: 'fetch is unavailable in this Node runtime', url: parsed.href });

  const remainingMs = opts.budget ? opts.budget.remainingMs() : DEFAULT_REQUEST_TIMEOUT_MS;
  if (remainingMs <= 0) {
    opts.budget?.truncate('time_limit');
    throw typedError({ code: 'time_limit', stage: 'budget', message: 'Discovery time budget exhausted', url: parsed.href });
  }
  const timeoutMs = Math.max(1, Math.min(
    positiveLimit(opts.requestTimeoutMs ?? cfg.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    remainingMs
  ));

  const controller = new AbortController();
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(typedError({
        code: 'timeout',
        stage: 'transport',
        message: `Request timed out after ${timeoutMs}ms fetching ${parsed.href}`,
        url: parsed.href,
        details: { timeoutMs }
      }));
    }, timeoutMs);
  });

  const request = (async () => {
    await assertPublicAddress(parsed, fetchImpl, opts);
    if (timedOut) {
      throw typedError({
        code: 'timeout',
        stage: 'transport',
        message: `Request timed out after ${timeoutMs}ms fetching ${parsed.href}`,
        url: parsed.href,
        details: { timeoutMs }
      });
    }
    return await fetchImpl(parsed.href, {
      headers: { accept, 'user-agent': userAgent(cfg, opts) },
      redirect: 'manual',
      signal: controller.signal
    });
  })();

  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (error?.code) throw error;
    if (opts.budget && opts.budget.remainingMs() <= 0) {
      opts.budget.truncate('time_limit');
      throw typedError({ code: 'time_limit', stage: 'budget', message: 'Discovery time budget exhausted', url: parsed.href });
    }
    if (isAbortError(error)) {
      throw typedError({
        code: 'timeout',
        stage: 'transport',
        message: error.message || `Request timed out fetching ${parsed.href}`,
        url: parsed.href,
        details: { timeoutMs }
      });
    }
    throw typedError({
      code: 'fetch_error',
      stage: 'transport',
      message: error?.message || String(error),
      url: parsed.href
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Safe shared GET for discovery and liveness.
 *
 * @param {string} url
 * @param {object} cfg  - adapter config (delayMs/requestTimeoutMs/userAgent fall back to it)
 * @param {object} opts - { fetch, lookup, sleep, now, budget, delayMs, requestTimeoutMs,
 *                          maxRedirects, accept, allowHttpErrors, source, jobKey }
 * @returns {Promise<{response, status, requestedUrl, finalUrl, redirects, attempts}>}
 */
export async function safeGet(url, cfg = {}, opts = {}) {
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const accept = opts.accept || 'application/json';
  const maxRedirects = positiveLimit(opts.maxRedirects ?? cfg.maxRedirects, MAX_REDIRECTS, MAX_REDIRECTS);
  const allowHttpErrors = opts.allowHttpErrors === true;
  const source = opts.source;
  const jobKey = opts.jobKey;

  const requestedUrl = String(url);
  let currentParsed;
  try {
    currentParsed = publicUrl(requestedUrl);
  } catch (error) {
    throw typedError({
      code: 'unsafe_url',
      stage: 'url',
      message: error.message,
      url: requestedUrl,
      source,
      jobKey,
      details: {}
    });
  }

  const redirects = [];
  let attempts = 0;
  let currentUrl = currentParsed.href;
  let lastResponse = null;
  let lastStatus = 0;

  // delayMs applies once before the first request of this safeGet.
  const delayMs = Math.max(0, Number(opts.delayMs ?? cfg.delayMs ?? 0) || 0);

  let done = false;
  for (let hop = 0; hop <= maxRedirects && !done; hop += 1) {
    // Apply the pre-request delay only once, before the first hop's first attempt.
    if (hop === 0 && delayMs > 0) {
      if (opts.budget && delayMs >= opts.budget.remainingMs()) {
        opts.budget.truncate('time_limit');
        throw typedError({ code: 'time_limit', stage: 'budget', message: 'Discovery time budget exhausted', url: currentUrl, source, jobKey });
      }
      await sleep(delayMs);
    }

    let redirected = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS && !redirected && !done; attempt += 1) {
      attempts += 1;

      // Budget enter (counts every fetch including redirects and retries).
      if (opts.budget) {
        try {
          opts.budget.enter();
        } catch (error) {
          throw typedError({
            code: error.reason === 'request_limit' ? 'request_limit' : 'time_limit',
            stage: 'budget',
            message: `Discovery limit reached: ${error.reason}`,
            url: currentUrl,
            source,
            jobKey
          });
        }
      }

      let response;
      try {
        const parsed = publicUrl(currentUrl);
        response = await performRequest(parsed, cfg, opts, accept);
      } catch (error) {
        // Transport/timeout/DNS/budget errors never retry.
        throw typedError({
          code: error.code || 'fetch_error',
          stage: error.stage || 'transport',
          message: error.message,
          retryable: false,
          url: currentUrl,
          source,
          jobKey,
          details: error.details || {}
        });
      }

      lastResponse = response;
      lastStatus = response.status == null && response.ok === true ? 200 : Number(response.status || 0);

      // Redirect handling.
      if (lastStatus >= 300 && lastStatus < 400) {
        const location = response.headers?.get?.('location');
        if (location) {
          if (hop >= maxRedirects) {
            throw typedError({
              code: 'too_many_redirects',
              stage: 'redirect',
              message: `Too many redirects fetching ${requestedUrl}`,
              retryable: false,
              url: currentUrl,
              source,
              jobKey,
              details: { redirects }
            });
          }
          let target;
          try {
            target = publicUrl(location, currentUrl);
          } catch (error) {
            throw typedError({
              code: 'unsafe_redirect',
              stage: 'redirect',
              message: error.message,
              retryable: false,
              url: currentUrl,
              source,
              jobKey,
              details: { location }
            });
          }
          // DNS validation for the redirect target happens on the next hop via assertPublicAddress.
          redirects.push({ from: currentUrl, to: target.href, status: lastStatus });
          currentUrl = target.href;
          redirected = true; // break the retry loop; continue the outer redirect loop
          break;
        }
      }

      // Retryable HTTP status (429/503).
      if (RETRYABLE_STATUS.has(lastStatus)) {
        if (attempt < MAX_ATTEMPTS) {
          const retryAfterRaw = response.headers?.get?.('retry-after');
          const { delayMs: parsedDelay, valid } = parseRetryAfter(retryAfterRaw, Number(now()));

          let sleepMs;
          if (valid && parsedDelay !== null) {
            if (parsedDelay > RETRY_AFTER_CAP_MS) {
              // Excessive Retry-After: never clamp into an early retry.
              if (allowHttpErrors) {
                done = true;
                break;
              }
              throw typedError({
                code: 'retry_after_exceeds_limit',
                stage: 'retry',
                message: `Retry-After delay ${parsedDelay}ms exceeds the ${RETRY_AFTER_CAP_MS}ms cap`,
                retryable: false,
                url: currentUrl,
                source,
                jobKey,
                details: { parsedDelayMs: parsedDelay, capMs: RETRY_AFTER_CAP_MS }
              });
            }
            if (opts.budget && parsedDelay >= opts.budget.remainingMs()) {
              opts.budget.truncate('time_limit');
              if (allowHttpErrors) {
                done = true;
                break;
              }
              throw typedError({
                code: 'time_limit',
                stage: 'budget',
                message: 'Discovery time budget exhausted before Retry-After delay',
                retryable: false,
                url: currentUrl,
                source,
                jobKey,
                details: { parsedDelayMs: parsedDelay, remainingMs: opts.budget.remainingMs() }
              });
            }
            sleepMs = parsedDelay;
          } else {
            // Invalid or past Retry-After: deterministic fallback backoff (no jitter).
            sleepMs = FALLBACK_BACKOFF_MS[attempt - 1] ?? FALLBACK_BACKOFF_MS[FALLBACK_BACKOFF_MS.length - 1];
            if (opts.budget && sleepMs >= opts.budget.remainingMs()) {
              opts.budget.truncate('time_limit');
              if (allowHttpErrors) {
                done = true;
                break;
              }
              throw typedError({
                code: 'time_limit',
                stage: 'budget',
                message: 'Discovery time budget exhausted before retry backoff',
                retryable: false,
                url: currentUrl,
                source,
                jobKey,
                details: { sleepMs, remainingMs: opts.budget.remainingMs() }
              });
            }
          }

          await sleep(sleepMs);
          continue; // retry the same hop
        }
        // Attempt cap reached for a retryable status.
        done = true;
        break;
      }

      // Non-retryable HTTP status (including 2xx, 4xx, 5xx other than 429/503).
      done = true;
      break;
    }
  }

  const finalUrl = currentUrl;
  const status = lastStatus;

  const isOk = lastResponse && (lastResponse.ok !== false) && status >= 200 && status < 300;

  if (!isOk) {
    if (allowHttpErrors) {
      return { response: lastResponse, status, requestedUrl, finalUrl, redirects, attempts };
    }
    throw typedError({
      code: 'http_error',
      stage: 'http',
      message: `HTTP ${status} fetching ${finalUrl}`,
      retryable: false,
      url: finalUrl,
      source,
      jobKey,
      details: { status, attempts }
    });
  }

  return { response: lastResponse, status, requestedUrl, finalUrl, redirects, attempts };
}