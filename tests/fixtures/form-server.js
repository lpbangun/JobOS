// tests/fixtures/form-server.js
//
// Deterministic localhost server for W02 live-form fixtures.
//
// Exports `startFormServer(t)` — a node:test-compatible helper that:
//   - binds 127.0.0.1 on an ephemeral port (port 0);
//   - serves only the HTML fixtures under tests/fixtures/forms;
//   - routes submit/verify/login outcomes deterministically via ?outcome=
//     without storing request bodies or submitted field values;
//   - records only route-hit/submit-count/outcome state;
//   - closes the server in t.after.
//
// Returns { baseUrl, url(pathname), state } where:
//   - baseUrl     -> `http://127.0.0.1:<port>`
//   - url(path)   -> absolute URL for a route path (leading slash optional)
//   - state       -> mutable object recording only hits/submits/outcomes:
//        {
//          hits:   Record<routePath, number>,     // GET route hit counts
//          submits: number,                       // total submit-boundary POSTs
//          outcomes: Record<'confirmed'|'failed-before-submit'|'uncertain', number>,
//          lastOutcome: null | 'confirmed' | 'failed-before-submit' | 'uncertain',
//          submitBoundaryCrossed: boolean         // true once a submit POST is accepted
//        }
//
// Routes match fixture basenames:
//   GET /application-main.html         -> application-main.html
//   GET /application-host.html         -> application-host.html (search + iframe)
//   GET /application-frame.html        -> application-frame.html
//   GET /application-changed.html      -> application-changed.html
//   GET /application-unsupported.html  -> application-unsupported.html
//   GET /application-opaque-frame.html -> application-opaque-frame.html
//   GET /captcha.html                  -> captcha.html
//   GET /login.html                    -> login.html
//   GET /confirmation.html             -> confirmation.html
//   GET /ambiguous.html                -> ambiguous.html
//
// Submit/outcome routes (no field values recorded):
//   POST /submit/application?outcome=confirmed               -> 303 /confirmation.html
//   POST /submit/application?outcome=failed-before-submit    -> 422 JSON { outcome, submitBoundaryCrossed:false }
//   POST /submit/application?outcome=uncertain               -> 303 /ambiguous.html
//   POST /submit/application                                 -> 303 /confirmation.html (default: confirmed)
//   POST /captcha/verify                                     -> 303 /application-main.html (deterministic solve)
//   POST /login                                              -> 303 /application-host.html
//
// Constraint: request bodies are NEVER read or stored. Only the route path and
// the `outcome` query value are inspected, and only counts/outcome enums are
// recorded in `state`.

import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { readFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FORMS_DIR = join(__dirname, 'forms');

// Route map: pathname -> fixture filename. Pathnames match fixture basenames.
const ROUTES = {
  '/application-main.html': 'application-main.html',
  '/application-host.html': 'application-host.html',
  '/application-frame.html': 'application-frame.html',
  '/application-changed.html': 'application-changed.html',
  '/application-unsupported.html': 'application-unsupported.html',
  '/application-configured.html': 'application-configured.html',
  '/application-iframe-configured.html': 'application-iframe-configured.html',
  '/application-login-confirmation.html': 'application-login-confirmation.html',
  '/application-uncertain.html': 'application-uncertain.html',
  '/application-preexisting.html': 'application-preexisting.html',
  '/application-prevented.html': 'application-prevented.html',
  '/application-unchanged.html': 'application-unchanged.html',
  '/application-unrelated.html': 'application-unrelated.html',
  '/application-secret-confirmation.html': 'application-secret-confirmation.html',
  '/application-post-422.html': 'application-post-422.html',
  '/application-secret-locators.html': 'application-secret-locators.html',
  '/application-opaque-frame.html': 'application-opaque-frame.html',
  '/captcha.html': 'captcha.html',
  '/login.html': 'login.html',
  '/login/complete': 'confirmation.html',
  '/confirmation.html': 'confirmation.html',
  '/confirmation-secret.html': 'confirmation-secret.html',
  '/ambiguous.html': 'ambiguous.html'
};

const VALID_OUTCOMES = new Set(['confirmed', 'login-confirmed', 'failed-before-submit', 'uncertain', 'unrelated', 'secret']);

/**
 * Start a deterministic localhost form-fixture server for a node:test context.
 *
 * @param {{ after?: (fn: () => unknown | Promise<unknown>) => void }} [t]
 *        A node:test scope (or any object with an `after` hook). If omitted,
 *        the caller is responsible for calling the returned `close()` method.
 * @returns {Promise<{
 *   baseUrl: string,
 *   url: (pathname: string) => string,
 *   state: {
 *     hits: Record<string, number>,
 *     submits: number,
 *     outcomes: Record<string, number>,
 *     lastOutcome: string|null,
 *     submitBoundaryCrossed: boolean
 *   },
 *   close: () => Promise<void>,
 *   server: import('node:http').Server
 * }>}
 */
export function startFormServer(t) {
  return new Promise((resolve, reject) => {
    const state = {
      hits: Object.create(null),
      submits: 0,
      outcomes: { confirmed: 0, 'failed-before-submit': 0, uncertain: 0 },
      lastOutcome: null,
      submitBoundaryCrossed: false
    };

    const server = createServer((req, res) => {
      const method = (req.method || 'GET').toUpperCase();
      // Parse pathname without query; do NOT read the body.
      const u = safeParseUrl(req.url || '/');
      const pathname = u.pathname;

      // ---- GET: serve fixture pages ------------------------------------
      if (method === 'GET' && ROUTES[pathname]) {
        recordHit(state, pathname);
        return serveFixture(res, ROUTES[pathname]);
      }

      // ---- POST /submit/application ------------------------------------
      // Records only outcome enum; never reads body/field values.
      if (method === 'POST' && pathname === '/submit/application') {
        const outcome = resolveOutcome(u.searchParams.get('outcome'));
        recordSubmit(state, outcome);
        if (outcome === 'failed-before-submit') {
          // Deliberately misleading payload after a received POST: product code
          // must keep its activation boundary monotonic and replay-block this.
          res.writeHead(422, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ outcome, submitBoundaryCrossed: false }));
          return;
        }
        const target = outcome === 'uncertain'
          ? '/ambiguous.html'
          : outcome === 'secret'
            ? '/confirmation-secret.html'
            : outcome === 'login-confirmed'
              ? '/login/complete'
              : '/confirmation.html';
        const location = outcome === 'unrelated'
          ? `http://localhost:${String(req.headers.host || '').split(':').at(-1)}${target}`
          : target;
        res.writeHead(303, { location });
        res.end();
        return;
      }

      // ---- POST /captcha/verify (deterministic solve) ------------------
      if (method === 'POST' && pathname === '/captcha/verify') {
        // Deterministic: always solves. No body read. No submit boundary.
        recordHit(state, '/captcha/verify');
        res.writeHead(303, { location: '/application-main.html' });
        res.end();
        return;
      }

      // ---- POST /login (deterministic auth recovery) -------------------
      if (method === 'POST' && pathname === '/login') {
        // Deterministic: always signs in. No credentials read/stored.
        recordHit(state, '/login');
        res.writeHead(303, { location: '/application-host.html' });
        res.end();
        return;
      }

      // ---- 404 for anything else ---------------------------------------
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    server.on('error', reject);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server did not bind to a TCP port'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      const url = (pathname) => `${baseUrl}${normalizePath(pathname)}`;
      const close = () => new Promise((res, rej) => {
        server.close((err) => err ? rej(err) : res());
      });

      if (t && typeof t.after === 'function') {
        t.after(() => close());
      }

      resolve({ baseUrl, url, state, close, server });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordHit(state, pathname) {
  state.hits[pathname] = (state.hits[pathname] || 0) + 1;
}

function recordSubmit(state, outcome) {
  state.submits += 1;
  state.outcomes[outcome] = (state.outcomes[outcome] || 0) + 1;
  state.lastOutcome = outcome;
  state.submitBoundaryCrossed = true;
}

function resolveOutcome(raw) {
  if (raw && VALID_OUTCOMES.has(raw)) return raw;
  return 'confirmed';
}

function safeParseUrl(reqUrl) {
  // Minimal URL parse using the WHATWG URL with a dummy base.
  try {
    return new URL(reqUrl, 'http://127.0.0.1');
  } catch {
    return new URL('/', 'http://127.0.0.1');
  }
}

function normalizePath(pathname) {
  if (!pathname) return '/';
  return pathname.startsWith('/') ? pathname : `/${pathname}`;
}

async function serveFixture(res, filename) {
  const safe = normalizeSafePath(filename);
  try {
    const body = await readFile(join(FORMS_DIR, safe));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`fixture error: ${err.code || err.message}`);
  }
}

function normalizeSafePath(filename) {
  // Prevent path traversal: keep only the basename.
  const normalized = normalize(filename).split(sep).pop() || '';
  if (!normalized || normalized.startsWith('..') || normalized.includes(sep)) {
    throw new Error(`unsafe fixture path: ${filename}`);
  }
  return normalized;
}