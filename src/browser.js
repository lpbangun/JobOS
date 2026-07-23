import crypto from 'node:crypto';
import { constants as FS_CONSTANTS, promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { now, workspaceRoot } from './utils.js';

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SCRIPT_TIMEOUT_MS = 120_000;
const MAX_TEXT_LENGTH = 8_000;
const MAX_LINKS = 50;
const MAX_TITLE_LENGTH = 512;
const MAX_URL_LENGTH = 2_048;
const MAX_COOKIE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_SCRIPT_OUTCOME_BYTES = 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BLOCKED_STATUSES = new Set([403, 407, 429, 451]);
const INTERNAL_ERRORS = new WeakSet();

export const TRUSTED_SCRIPT_WARNING = 'Trusted local ESM code runs unsandboxed with full Node.js process privileges.';

export class BrowserError extends Error {
  constructor(code, message, { recovery = [], details, audit } = {}) {
    super(message);
    this.name = 'BrowserError';
    this.code = code;
    this.type = 'browser';
    this.exitCode = 1;
    if (recovery.length) this.recovery = [...recovery];
    if (details !== undefined) this.details = details;
    if (audit !== undefined) this.audit = audit;
  }
}

function browserError(code, message, options) {
  const error = new BrowserError(code, message, options);
  INTERNAL_ERRORS.add(error);
  return error;
}

function requireSafeName(value, label = 'browser name') {
  const name = String(value || '');
  if (!SAFE_NAME.test(name)) {
    throw browserError('browser_invalid_name', `${label} must be 1-64 characters using only letters, numbers, underscores, and hyphens.`);
  }
  return name;
}

function statePaths(workspace) {
  const root = workspaceRoot({ workspace });
  const state = path.join(root, '.jobos');
  const browser = path.join(state, 'browser');
  return {
    root,
    state,
    browser,
    profiles: path.join(browser, 'profiles'),
    scripts: path.join(browser, 'scripts'),
    mirror: path.join(root, 'jobos-workspace')
  };
}

function childPath(parent, name) {
  const target = path.join(parent, name);
  const relative = path.relative(parent, target);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw browserError('browser_invalid_path', 'Browser state path escaped its private root.');
  }
  return target;
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function ensureDirectory(directory, { chmod = true } = {}) {
  try {
    await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw browserError('browser_invalid_path', 'Browser state directories must not be symbolic links.');
    }
    if (chmod) await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    if (INTERNAL_ERRORS.has(error)) throw error;
    throw browserError('browser_invalid_path', 'Browser state requires real private directories beneath the workspace.');
  }
}

async function assertDirectory(directory) {
  let stat;
  try {
    stat = await fs.lstat(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw browserError('browser_state_error', 'Browser state could not be inspected.');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw browserError('browser_invalid_path', 'Browser state directories must not be symbolic links.');
  }
  return true;
}

async function ensureProfileParents(paths) {
  await ensureDirectory(paths.state);
  await ensureDirectory(paths.browser);
  await ensureDirectory(paths.profiles);
}

async function ensureScriptParents(paths) {
  await ensureDirectory(paths.state);
  await ensureDirectory(paths.browser);
  await ensureDirectory(paths.scripts);
}

async function privateParentsExist(paths, leaf) {
  for (const directory of [paths.state, paths.browser, leaf]) {
    if (!(await assertDirectory(directory))) return false;
  }
  return true;
}

function profileLocation(paths, name) {
  return childPath(paths.profiles, requireSafeName(name, 'profile name'));
}

function scriptLocations(paths, name) {
  const safeName = requireSafeName(name, 'script name');
  return {
    name: safeName,
    code: childPath(paths.scripts, `${safeName}.mjs`),
    manifest: childPath(paths.scripts, `${safeName}.json`)
  };
}

async function openRegularFile(file, { maxBytes } = {}) {
  const resolved = path.resolve(String(file || ''));
  if (!file) throw browserError('browser_invalid_path', 'An explicit file path is required.');
  let handle;
  try {
    const flags = FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0);
    handle = await fs.open(resolved, flags);
    const stat = await handle.stat();
    if (!stat.isFile()) throw browserError('browser_invalid_path', 'The explicit path must name a regular file.');
    if (maxBytes !== undefined && stat.size > maxBytes) {
      throw browserError('browser_invalid_file', 'The explicit file exceeds the allowed size.');
    }
    return { resolved, bytes: await handle.readFile() };
  } catch (error) {
    if (INTERNAL_ERRORS.has(error)) throw error;
    throw browserError('browser_invalid_path', 'The explicit file could not be read safely.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function writePrivateAtomic(file, bytes) {
  const directory = path.dirname(file);
  const temporary = childPath(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_EXCL | (FS_CONSTANTS.O_NOFOLLOW || 0);
    handle = await fs.open(temporary, flags, PRIVATE_FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(PRIVATE_FILE_MODE);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, PRIVATE_FILE_MODE);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    if (INTERNAL_ERRORS.has(error)) throw error;
    throw browserError('browser_state_error', 'Private browser state could not be written.');
  }
}

async function writeExplicitPrivateFile(file, bytes, paths) {
  const resolved = path.resolve(String(file || ''));
  if (!file) throw browserError('browser_invalid_path', 'Cookie export requires an explicit file path.');
  if (isWithin(paths.browser, resolved) || isWithin(paths.mirror, resolved)) {
    throw browserError('browser_invalid_path', 'Cookie exports cannot be written into browser state or the workspace mirror.');
  }

  let handle;
  try {
    const flags = FS_CONSTANTS.O_WRONLY | FS_CONSTANTS.O_CREAT | FS_CONSTANTS.O_TRUNC | (FS_CONSTANTS.O_NOFOLLOW || 0);
    handle = await fs.open(resolved, flags, PRIVATE_FILE_MODE);
    const stat = await handle.stat();
    if (!stat.isFile()) throw browserError('browser_invalid_path', 'Cookie export must target a regular file.');
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.chmod(PRIVATE_FILE_MODE);
    return resolved;
  } catch (error) {
    if (INTERNAL_ERRORS.has(error)) throw error;
    throw browserError('cookie_export_failed', 'Cookie export could not write the explicit file.');
  } finally {
    await handle?.close().catch(() => {});
  }
}

function cleanMetadata(raw, name, profilePath) {
  const metadata = {
    version: 1,
    name,
    path: profilePath,
    createdAt: typeof raw?.createdAt === 'string' ? raw.createdAt : now()
  };
  for (const field of ['updatedAt', 'lastLoginAt', 'lastUsedAt', 'lastOrigin']) {
    if (typeof raw?.[field] === 'string') metadata[field] = raw[field];
  }
  return metadata;
}

async function readProfileMetadata(profilePath, name) {
  const file = childPath(profilePath, 'profile.json');
  try {
    const { bytes } = await openRegularFile(file, { maxBytes: 64 * 1024 });
    return cleanMetadata(JSON.parse(bytes.toString('utf8')), name, profilePath);
  } catch (error) {
    if (error?.code === 'browser_invalid_path') {
      try {
        await fs.access(file);
      } catch (accessError) {
        if (accessError?.code === 'ENOENT') return cleanMetadata(null, name, profilePath);
      }
    }
    if (error instanceof SyntaxError) {
      throw browserError('browser_state_error', 'Browser profile metadata is invalid.');
    }
    if (INTERNAL_ERRORS.has(error)) throw error;
    throw browserError('browser_state_error', 'Browser profile metadata could not be read.');
  }
}

async function saveProfileMetadata(profilePath, metadata) {
  const file = childPath(profilePath, 'profile.json');
  const stored = { ...metadata };
  delete stored.path;
  await writePrivateAtomic(file, `${JSON.stringify(stored, null, 2)}\n`);
}

async function createProfile(paths, name) {
  const safeName = requireSafeName(name, 'profile name');
  await ensureProfileParents(paths);
  const profilePath = profileLocation(paths, safeName);
  await ensureDirectory(profilePath);
  const metadata = await readProfileMetadata(profilePath, safeName);
  await saveProfileMetadata(profilePath, metadata);
  return { profilePath, metadata };
}

async function existingProfile(paths, name) {
  const safeName = requireSafeName(name, 'profile name');
  const profilePath = profileLocation(paths, safeName);
  if (!(await privateParentsExist(paths, paths.profiles)) || !(await assertDirectory(profilePath))) {
    throw browserError('auth_required', `Browser profile ${safeName} has no authenticated state.`, {
      recovery: profileRecovery(safeName)
    });
  }
  try {
    await fs.chmod(paths.browser, PRIVATE_DIRECTORY_MODE);
    await fs.chmod(paths.profiles, PRIVATE_DIRECTORY_MODE);
    await fs.chmod(profilePath, PRIVATE_DIRECTORY_MODE);
  } catch {
    throw browserError('browser_state_error', 'Browser profile permissions could not be made private.');
  }
  return { profilePath, metadata: await readProfileMetadata(profilePath, safeName) };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function unavailableRecovery(name) {
  const commands = [
    'npm install playwright',
    'npx playwright install chromium'
  ];
  if (name && SAFE_NAME.test(name)) {
    commands.push(`npm run jobos -- browser cookies import ${name} --file ./storage-state.json`);
  }
  return commands;
}

function profileRecovery(name, url) {
  const commands = [];
  if (url) commands.push(`npm run jobos -- browser login ${name} --url ${shellQuote(url.origin)}`);
  commands.push(`npm run jobos -- browser cookies import ${name} --file ./storage-state.json`);
  return commands;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw browserError('browser_invalid_url', 'Browser URL must be an absolute HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw browserError('browser_invalid_url', 'Browser URL must be an absolute HTTP or HTTPS URL without embedded credentials.');
  }
  return url;
}

function navigationTimeout(value) {
  const timeout = Number(value);
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > SCRIPT_TIMEOUT_MS) {
    throw browserError('browser_invalid_timeout', 'Browser navigation timeout must be between 1 and 120000 milliseconds.');
  }
  return timeout;
}

function normalizePlaywright(candidate) {
  const api = candidate?.chromium ? candidate : candidate?.default;
  return api?.chromium?.launchPersistentContext ? api : null;
}

async function loadPlaywright(injected, { optional = false, profileName } = {}) {
  if (injected) {
    const api = normalizePlaywright(injected);
    if (api) return { api, injected: true };
    if (optional) return null;
    throw browserError('browser_unavailable', 'The injected Playwright implementation does not provide Chromium persistent contexts.', {
      recovery: unavailableRecovery(profileName)
    });
  }

  try {
    const api = normalizePlaywright(await import('playwright'));
    if (!api) throw new Error('invalid playwright module');
    return { api, injected: false };
  } catch {
    if (optional) return null;
    throw browserError('browser_unavailable', 'Playwright is optional and is not available for this browser command.', {
      recovery: unavailableRecovery(profileName)
    });
  }
}

async function launchPersistent(profilePath, profileName, { playwright, headless }) {
  const loaded = await loadPlaywright(playwright, { profileName });
  if (!headless && !loaded.injected && process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
    throw browserError('browser_unavailable', 'Headed browser login requires a display. Import cookies on this host or run login in a desktop session.', {
      recovery: unavailableRecovery(profileName)
    });
  }
  try {
    return await loaded.api.chromium.launchPersistentContext(profilePath, {
      acceptDownloads: false,
      headless
    });
  } catch {
    throw browserError('browser_unavailable', 'Chromium could not start for this browser command.', {
      recovery: unavailableRecovery(profileName)
    });
  }
}

async function closeContext(context) {
  try {
    await context?.close?.();
  } catch {
    // Browser shutdown failures must not expose Playwright state or replace the real result.
  }
}

async function pageForContext(context, { preferExisting = false, profileName } = {}) {
  if (preferExisting && typeof context.pages === 'function') {
    const [page] = context.pages();
    if (page) return page;
  }
  if (typeof context.newPage !== 'function') {
    throw browserError('browser_unavailable', 'Playwright did not provide a browser page.', {
      recovery: unavailableRecovery(profileName)
    });
  }
  return context.newPage();
}

function isTimeoutError(error) {
  return error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT' || /timeout/i.test(String(error?.name || ''));
}

async function navigate(page, url, timeoutMs, profileName) {
  try {
    return await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (error) {
    if (isTimeoutError(error)) {
      throw browserError('timeout', 'Browser navigation timed out.', {
        recovery: profileRecovery(profileName, url)
      });
    }
    throw browserError('browser_navigation_failed', 'Browser navigation failed without returning page data.', {
      recovery: profileRecovery(profileName, url)
    });
  }
}

function responseStatus(response) {
  try {
    return Number(response?.status?.()) || 0;
  } catch {
    return 0;
  }
}

function currentPageUrl(page, fallback) {
  try {
    return String(page?.url?.() || fallback.href);
  } catch {
    return fallback.href;
  }
}

function looksLikeCaptchaUrl(value) {
  try {
    const url = new URL(value);
    return /(?:^|\/)(?:captcha|challenge|checkpoint)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

function looksLikeLoginUrl(value) {
  try {
    const url = new URL(value);
    return /(?:^|\/)(?:login|log-in|signin|sign-in|sign_in|authenticate|auth)(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

async function inspectPage(page) {
  const url = currentPageUrl(page, new URL('https://invalid.local'));
  const fallback = {
    captcha: looksLikeCaptchaUrl(url),
    loginForm: looksLikeLoginUrl(url),
    blockedText: false
  };
  if (typeof page?.evaluate !== 'function') return fallback;

  try {
    const inspected = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').slice(0, 20_000).toLowerCase();
      const captchaSelector = [
        'iframe[src*="recaptcha" i]',
        'iframe[src*="hcaptcha" i]',
        '[id*="captcha" i]',
        '[class*="captcha" i]',
        'input[name*="captcha" i]',
        '[data-sitekey]',
        '[class*="cf-chl" i]'
      ].some(selector => document.querySelector(selector));
      const captchaText = /verify (?:that )?you are human|unusual traffic|complete the security check|checking your browser/.test(bodyText);
      const loginForm = [...document.forms].some(form => {
        const password = form.querySelector('input[type="password"]');
        if (!password) return false;
        const identity = form.querySelector('input[type="email"], input[name*="user" i], input[name*="login" i]');
        const hint = `${form.getAttribute('action') || ''} ${form.innerText || ''}`.toLowerCase();
        return Boolean(identity) || /log[ -]?in|sign[ -]?in|authenticate/.test(hint);
      });
      return {
        captcha: captchaSelector || captchaText,
        loginForm,
        blockedText: /access denied|request (?:was )?blocked|temporarily blocked|too many requests/.test(bodyText)
      };
    });
    return {
      captcha: fallback.captcha || inspected?.captcha === true,
      loginForm: fallback.loginForm || inspected?.loginForm === true,
      blockedText: inspected?.blockedText === true
    };
  } catch {
    return fallback;
  }
}

export async function assertPageAccessible(page, response, profileName, requestedUrl) {
  const state = await inspectPage(page);
  const finalUrl = currentPageUrl(page, requestedUrl);
  const status = responseStatus(response);
  if (state.captcha || looksLikeCaptchaUrl(finalUrl)) {
    throw browserError('captcha', 'CAPTCHA detected. JobOS will not bypass it; complete the challenge manually in a headed login.', {
      recovery: profileRecovery(profileName, requestedUrl)
    });
  }
  if (status === 401 || state.loginForm || looksLikeLoginUrl(finalUrl)) {
    throw browserError('auth_required', 'The saved browser session is not authenticated for this page.', {
      recovery: profileRecovery(profileName, requestedUrl)
    });
  }
  if (BLOCKED_STATUSES.has(status) || state.blockedText) {
    throw browserError('blocked', `The remote site blocked the browser request${status ? ` (HTTP ${status})` : ''}.`, {
      recovery: profileRecovery(profileName, requestedUrl),
      details: status ? { status } : undefined
    });
  }
}

async function cookieSecrets(context) {
  try {
    const cookies = await context.cookies();
    const secrets = new Set();
    for (const cookie of Array.isArray(cookies) ? cookies : []) {
      if (typeof cookie?.value !== 'string' || cookie.value.length === 0) continue;
      secrets.add(cookie.value);
      const encoded = encodeURIComponent(cookie.value);
      if (encoded !== cookie.value) secrets.add(encoded);
    }
    return secrets;
  } catch {
    return new Set();
  }
}

function redactString(value, secrets) {
  let redacted = String(value ?? '');
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function boundedString(value, limit, secrets = new Set()) {
  return redactString(value, secrets).slice(0, limit);
}

async function extractPage(page, selector, secrets) {
  let extracted;
  try {
    extracted = await page.evaluate(({ selector, maxText, maxLinks }) => {
      let root = document.body;
      if (selector) {
        root = document.querySelector(selector);
        if (!root) return { selectorFound: false };
      }
      const normalizedText = String(root?.innerText || root?.textContent || '').replace(/\s+/g, ' ').trim();
      const anchors = [...root.querySelectorAll('a[href]')];
      const links = [];
      for (const anchor of anchors) {
        if (links.length >= maxLinks) break;
        const href = String(anchor.href || '');
        if (!/^https?:\/\//i.test(href)) continue;
        links.push({
          text: String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
          href: href.slice(0, 2048)
        });
      }
      return {
        selectorFound: true,
        text: normalizedText.slice(0, maxText),
        textTruncated: normalizedText.length > maxText,
        links,
        linksTruncated: anchors.length > links.length
      };
    }, { selector: selector || null, maxText: MAX_TEXT_LENGTH, maxLinks: MAX_LINKS });
  } catch {
    throw browserError('browser_extract_failed', 'The browser page could not be safely extracted.');
  }

  if (!extracted?.selectorFound) {
    throw browserError('browser_selector_not_found', 'The requested selector was not found on the page.');
  }

  const links = [];
  for (const link of Array.isArray(extracted.links) ? extracted.links.slice(0, MAX_LINKS) : []) {
    try {
      const href = new URL(String(link?.href || ''));
      if (!['http:', 'https:'].includes(href.protocol) || href.username || href.password) continue;
      links.push({
        text: boundedString(link?.text, 300, secrets),
        href: boundedString(href.href, MAX_URL_LENGTH, secrets)
      });
    } catch {
      // Invalid or credential-bearing links are excluded rather than echoed.
    }
  }

  return {
    text: boundedString(extracted.text, MAX_TEXT_LENGTH, secrets),
    textTruncated: extracted.textTruncated === true,
    links,
    linksTruncated: extracted.linksTruncated === true || links.length >= MAX_LINKS
  };
}

function validateCookie(cookie, index) {
  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
    throw browserError('cookie_state_invalid', `Cookie ${index} must be an object.`);
  }
  if (typeof cookie.name !== 'string' || !cookie.name || typeof cookie.value !== 'string') {
    throw browserError('cookie_state_invalid', `Cookie ${index} requires string name and value fields.`);
  }
  const hasUrl = typeof cookie.url === 'string' && cookie.url.length > 0;
  const hasDomain = typeof cookie.domain === 'string' && cookie.domain.length > 0;
  if (hasUrl === hasDomain) {
    throw browserError('cookie_state_invalid', `Cookie ${index} must define either url or domain/path fields.`);
  }

  const normalized = { name: cookie.name, value: cookie.value };
  if (hasUrl) {
    try {
      normalized.url = parseHttpUrl(cookie.url).href;
    } catch {
      throw browserError('cookie_state_invalid', `Cookie ${index} has an invalid url field.`);
    }
  } else {
    if (/[\s\/@]/.test(cookie.domain) || cookie.domain.length > 253 || typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) {
      throw browserError('cookie_state_invalid', `Cookie ${index} has invalid domain/path fields.`);
    }
    normalized.domain = cookie.domain;
    normalized.path = cookie.path;
  }

  if (cookie.expires !== undefined) {
    if (!Number.isFinite(cookie.expires) || cookie.expires < -1) {
      throw browserError('cookie_state_invalid', `Cookie ${index} has an invalid expires field.`);
    }
    normalized.expires = cookie.expires;
  }
  for (const field of ['httpOnly', 'secure']) {
    if (cookie[field] !== undefined) {
      if (typeof cookie[field] !== 'boolean') throw browserError('cookie_state_invalid', `Cookie ${index} has an invalid ${field} field.`);
      normalized[field] = cookie[field];
    }
  }
  if (cookie.sameSite !== undefined) {
    if (!['Strict', 'Lax', 'None'].includes(cookie.sameSite)) {
      throw browserError('cookie_state_invalid', `Cookie ${index} has an invalid sameSite field.`);
    }
    normalized.sameSite = cookie.sameSite;
  }
  if (cookie.partitionKey !== undefined) {
    if (typeof cookie.partitionKey !== 'string') throw browserError('cookie_state_invalid', `Cookie ${index} has an invalid partitionKey field.`);
    normalized.partitionKey = cookie.partitionKey;
  }
  return normalized;
}

function validateOrigins(origins) {
  if (origins === undefined) return;
  if (!Array.isArray(origins)) throw browserError('cookie_state_invalid', 'Storage-state origins must be an array.');
  for (let index = 0; index < origins.length; index += 1) {
    const origin = origins[index];
    if (!origin || typeof origin !== 'object' || Array.isArray(origin) || typeof origin.origin !== 'string' || !Array.isArray(origin.localStorage)) {
      throw browserError('cookie_state_invalid', `Storage-state origin ${index} is invalid.`);
    }
    try {
      parseHttpUrl(origin.origin);
    } catch {
      throw browserError('cookie_state_invalid', `Storage-state origin ${index} has an invalid origin field.`);
    }
    for (const entry of origin.localStorage) {
      if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || typeof entry.value !== 'string') {
        throw browserError('cookie_state_invalid', `Storage-state origin ${index} has invalid localStorage entries.`);
      }
    }
  }
}

function parseCookieState(bytes) {
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw browserError('cookie_state_invalid', 'Cookie import must be valid JSON.');
  }
  const cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
  if (!Array.isArray(cookies)) {
    throw browserError('cookie_state_invalid', 'Cookie import must be a cookie array or Playwright storage-state object.');
  }
  if (!Array.isArray(parsed)) validateOrigins(parsed.origins);
  return cookies.map(validateCookie);
}

function executableInfo(loaded) {
  if (!loaded) return { executableAvailable: false };
  if (loaded.injected) return { executableAvailable: true };
  try {
    const executablePath = loaded.api.chromium.executablePath?.();
    return { executableAvailable: Boolean(executablePath), executablePath };
  } catch {
    return { executableAvailable: false };
  }
}

async function executableExists(info) {
  if (!info.executableAvailable) return false;
  if (!info.executablePath) return true;
  try {
    await fs.access(info.executablePath, FS_CONSTANTS.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function profileSummary(paths, name) {
  const profilePath = profileLocation(paths, name);
  if (!(await privateParentsExist(paths, paths.profiles)) || !(await assertDirectory(profilePath))) {
    return { name, path: profilePath, exists: false };
  }
  const metadata = await readProfileMetadata(profilePath, name);
  return { ...metadata, exists: true };
}

export async function browserStatus({ workspace, name, playwright } = {}) {
  const paths = statePaths(workspace);
  const safeName = name === undefined ? undefined : requireSafeName(name, 'profile name');
  const loaded = await loadPlaywright(playwright, { optional: true, profileName: safeName });
  const packageAvailable = Boolean(loaded);
  const executableAvailable = await executableExists(executableInfo(loaded));
  const result = {
    available: packageAvailable && executableAvailable,
    packageAvailable,
    executableAvailable,
    browser: 'chromium',
    stateRoot: paths.browser,
    recovery: packageAvailable && executableAvailable ? [] : unavailableRecovery(safeName)
  };

  if (safeName) {
    result.profile = await profileSummary(paths, safeName);
  } else {
    result.profiles = [];
    if (await privateParentsExist(paths, paths.profiles)) {
      const entries = await fs.readdir(paths.profiles, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory() && !entry.isSymbolicLink() && SAFE_NAME.test(entry.name)) {
          result.profiles.push(await profileSummary(paths, entry.name));
        }
      }
    }
  }
  return result;
}

export async function loginPersistentProfile({ workspace, name, url, playwright, waitForClose = true, navigationTimeoutMs = NAVIGATION_TIMEOUT_MS } = {}) {
  const profileName = requireSafeName(name, 'profile name');
  const requestedUrl = parseHttpUrl(url);
  const timeoutMs = navigationTimeout(navigationTimeoutMs);
  const paths = statePaths(workspace);
  const { profilePath, metadata } = await createProfile(paths, profileName);
  let context;
  let closed = false;
  let closePromise;
  try {
    context = await launchPersistent(profilePath, profileName, { playwright, headless: false });
    closePromise = new Promise(resolve => {
      if (typeof context.once === 'function') context.once('close', () => { closed = true; resolve(); });
      else if (typeof context.on === 'function') context.on('close', () => { closed = true; resolve(); });
      else resolve();
    });
    const page = await pageForContext(context, { preferExisting: true, profileName });
    await navigate(page, requestedUrl, timeoutMs, profileName);
    if (waitForClose) await closePromise;
    else await closeContext(context);
    closed = true;

    const timestamp = now();
    const updated = {
      ...metadata,
      updatedAt: timestamp,
      lastLoginAt: timestamp,
      lastUsedAt: timestamp,
      lastOrigin: requestedUrl.origin
    };
    await saveProfileMetadata(profilePath, updated);
    return {
      status: 'closed',
      profile: profileName,
      profilePath,
      loginOrigin: requestedUrl.origin,
      lastLoginAt: timestamp
    };
  } finally {
    if (!closed) await closeContext(context);
  }
}

export async function authenticatedFetch({ workspace, name, url, selector, playwright, navigationTimeoutMs = NAVIGATION_TIMEOUT_MS } = {}) {
  const profileName = requireSafeName(name, 'profile name');
  const requestedUrl = parseHttpUrl(url);
  const timeoutMs = navigationTimeout(navigationTimeoutMs);
  if (selector !== undefined && (typeof selector !== 'string' || selector.length > 2_000)) {
    throw browserError('browser_invalid_selector', 'Browser selector must be a CSS selector no longer than 2000 characters.');
  }
  const paths = statePaths(workspace);
  const { profilePath, metadata } = await existingProfile(paths, profileName);
  let context;
  try {
    context = await launchPersistent(profilePath, profileName, { playwright, headless: true });
    const page = await pageForContext(context, { profileName });
    const response = await navigate(page, requestedUrl, timeoutMs, profileName);
    await assertPageAccessible(page, response, profileName, requestedUrl);
    const secrets = await cookieSecrets(context);
    const extracted = await extractPage(page, selector, secrets);
    const title = typeof page.title === 'function' ? await page.title().catch(() => '') : '';
    const finalUrl = currentPageUrl(page, requestedUrl);
    const timestamp = now();
    await saveProfileMetadata(profilePath, {
      ...metadata,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
      lastOrigin: requestedUrl.origin
    });
    return {
      profile: profileName,
      title: boundedString(title, MAX_TITLE_LENGTH, secrets),
      finalUrl: boundedString(finalUrl, MAX_URL_LENGTH, secrets),
      ...extracted
    };
  } finally {
    await closeContext(context);
  }
}

export async function withAuthenticatedPage({
  workspace,
  name = 'default',
  url,
  playwright,
  headless = true,
  createIfMissing = false,
  navigationTimeoutMs = NAVIGATION_TIMEOUT_MS
} = {}, operation) {
  if (typeof operation !== 'function') throw browserError('browser_operation_required', 'A bounded browser operation is required.');
  const profileName = requireSafeName(name, 'profile name');
  const requestedUrl = parseHttpUrl(url);
  const timeoutMs = navigationTimeout(navigationTimeoutMs);
  const paths = statePaths(workspace);
  let profile;
  if (createIfMissing) {
    try {
      profile = await existingProfile(paths, profileName);
    } catch (error) {
      if (error?.code !== 'auth_required') throw error;
      profile = await createProfile(paths, profileName);
    }
  } else {
    profile = await existingProfile(paths, profileName);
  }
  let context;
  try {
    context = await launchPersistent(profile.profilePath, profileName, { playwright, headless });
    const page = await pageForContext(context, { profileName });
    const response = await navigate(page, requestedUrl, timeoutMs, profileName);
    await assertPageAccessible(page, response, profileName, requestedUrl);
    const result = await operation({ page, context, response, requestedUrl, profileName });
    await assertPageAccessible(page, response, profileName, requestedUrl);
    const timestamp = now();
    await saveProfileMetadata(profile.profilePath, {
      ...profile.metadata,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
      lastOrigin: requestedUrl.origin
    });
    return result;
  } finally {
    await closeContext(context);
  }
}

export async function importCookies({ workspace, name, file, playwright } = {}) {
  const profileName = requireSafeName(name, 'profile name');
  const input = await openRegularFile(file, { maxBytes: MAX_COOKIE_FILE_BYTES });
  const cookies = parseCookieState(input.bytes);
  const paths = statePaths(workspace);
  const { profilePath, metadata } = await createProfile(paths, profileName);
  let context;
  try {
    context = await launchPersistent(profilePath, profileName, { playwright, headless: true });
    try {
      await context.addCookies(cookies);
    } catch {
      throw browserError('cookie_import_failed', 'Playwright rejected the validated cookie state.', {
        recovery: profileRecovery(profileName)
      });
    }
    const timestamp = now();
    await saveProfileMetadata(profilePath, {
      ...metadata,
      updatedAt: timestamp,
      lastUsedAt: timestamp
    });
    return {
      profile: profileName,
      path: input.resolved,
      cookieCount: cookies.length
    };
  } finally {
    await closeContext(context);
  }
}

export async function exportCookies({ workspace, name, file, playwright } = {}) {
  const profileName = requireSafeName(name, 'profile name');
  const paths = statePaths(workspace);
  const { profilePath, metadata } = await existingProfile(paths, profileName);
  let context;
  let cookies;
  try {
    context = await launchPersistent(profilePath, profileName, { playwright, headless: true });
    try {
      cookies = await context.cookies();
    } catch {
      throw browserError('cookie_export_failed', 'Playwright could not read cookies from the private profile.');
    }
    if (!Array.isArray(cookies)) throw browserError('cookie_export_failed', 'Playwright returned invalid cookie state.');
    const output = `${JSON.stringify({ cookies, origins: [] }, null, 2)}\n`;
    const outputPath = await writeExplicitPrivateFile(file, output, paths);
    const timestamp = now();
    await saveProfileMetadata(profilePath, {
      ...metadata,
      updatedAt: timestamp,
      lastUsedAt: timestamp
    });
    return {
      profile: profileName,
      path: outputPath,
      cookieCount: cookies.length
    };
  } finally {
    cookies = undefined;
    await closeContext(context);
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function readManifest(location, name) {
  let bytes;
  try {
    ({ bytes } = await openRegularFile(location, { maxBytes: 64 * 1024 }));
  } catch {
    throw browserError('browser_script_not_found', `Registered browser script ${name} was not found.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw browserError('browser_script_invalid', `Registered browser script ${name} has an invalid manifest.`);
  }
  if (parsed?.version !== 1 || parsed?.name !== name || !SHA256.test(parsed?.scriptHash) || typeof parsed?.sideEffecting !== 'boolean') {
    throw browserError('browser_script_invalid', `Registered browser script ${name} has an invalid manifest.`);
  }
  return {
    version: 1,
    name,
    scriptHash: parsed.scriptHash,
    sideEffecting: parsed.sideEffecting,
    addedAt: typeof parsed.addedAt === 'string' ? parsed.addedAt : undefined,
    warning: TRUSTED_SCRIPT_WARNING
  };
}

export async function registerScript({ workspace, name, file, sideEffecting = false } = {}) {
  const scriptName = requireSafeName(name, 'script name');
  if (typeof sideEffecting !== 'boolean') {
    throw browserError('browser_invalid_script', 'sideEffecting must be a boolean.');
  }
  const source = await openRegularFile(file);
  const paths = statePaths(workspace);
  await ensureScriptParents(paths);
  const locations = scriptLocations(paths, scriptName);
  const scriptHash = sha256(source.bytes);
  const addedAt = now();
  const manifest = {
    version: 1,
    name: scriptName,
    scriptHash,
    sideEffecting,
    addedAt,
    warning: TRUSTED_SCRIPT_WARNING
  };
  await writePrivateAtomic(locations.code, source.bytes);
  await writePrivateAtomic(locations.manifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    name: scriptName,
    scriptHash,
    sideEffecting,
    path: locations.code,
    manifestPath: locations.manifest,
    warning: TRUSTED_SCRIPT_WARNING
  };
}

function hashesEqual(left, right) {
  if (!SHA256.test(left) || !SHA256.test(right)) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function sensitiveOutcomeKey(key) {
  return /^(?:code|input|cookies?|set-cookie|storageState|authorization)$/i.test(key) || /cookie/i.test(key);
}

function normalizeOutcome(value, secrets, stack = new WeakSet(), depth = 0) {
  if (depth > 30) throw browserError('browser_script_outcome_invalid', 'Browser script outcome exceeds the nesting limit.');
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return redactString(value, secrets);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw browserError('browser_script_outcome_invalid', 'Browser script outcome must contain finite JSON numbers.');
    return value;
  }
  if (typeof value !== 'object') {
    throw browserError('browser_script_outcome_invalid', 'Browser script outcome must be JSON-serializable.');
  }
  if (stack.has(value)) throw browserError('browser_script_outcome_invalid', 'Browser script outcome must not contain cycles.');
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => normalizeOutcome(item, secrets, stack, depth + 1));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw browserError('browser_script_outcome_invalid', 'Browser script outcome must use plain JSON objects.');
    }
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = sensitiveOutcomeKey(key) ? '[REDACTED]' : normalizeOutcome(value[key], secrets, stack, depth + 1);
    }
    return normalized;
  } finally {
    stack.delete(value);
  }
}

function captchaWatcher(page, profileName, requestedUrl, stopped) {
  return (async () => {
    while (!stopped.value) {
      await new Promise(resolve => setTimeout(resolve, 250));
      if (stopped.value) return;
      const inspected = await inspectPage(page);
      if (inspected.captcha) {
        throw browserError('captcha', 'CAPTCHA detected. JobOS stopped the registered script and will not bypass the challenge.', {
          recovery: profileRecovery(profileName, requestedUrl)
        });
      }
    }
  })();
}

function scriptTimeout(timeoutMs, profileName, requestedUrl) {
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(browserError('timeout', 'Registered browser script timed out after 120 seconds.', {
      recovery: profileRecovery(profileName, requestedUrl)
    })), timeoutMs);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

export async function runRegisteredScript({
  workspace,
  profile,
  url,
  script,
  input = null,
  allowSideEffects = false,
  playwright,
  navigationTimeoutMs = NAVIGATION_TIMEOUT_MS,
  scriptTimeoutMs = SCRIPT_TIMEOUT_MS
} = {}) {
  const profileName = requireSafeName(profile, 'profile name');
  const scriptName = requireSafeName(script, 'script name');
  const requestedUrl = parseHttpUrl(url);
  const navigationMs = navigationTimeout(navigationTimeoutMs);
  if (typeof allowSideEffects !== 'boolean') {
    throw browserError('browser_invalid_script', 'allowSideEffects must be a boolean.');
  }
  const timeoutMs = Number(scriptTimeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > SCRIPT_TIMEOUT_MS) {
    throw browserError('browser_invalid_script', 'Script timeout must be between 1 and 120000 milliseconds.');
  }

  const paths = statePaths(workspace);
  const locations = scriptLocations(paths, scriptName);
  if (!(await privateParentsExist(paths, paths.scripts))) {
    throw browserError('browser_script_not_found', `Registered browser script ${scriptName} was not found.`);
  }
  const manifest = await readManifest(locations.manifest, scriptName);
  let source;
  try {
    source = await openRegularFile(locations.code);
  } catch {
    throw browserError('browser_script_not_found', `Registered browser script ${scriptName} was not found.`);
  }
  const actualHash = sha256(source.bytes);
  if (!hashesEqual(actualHash, manifest.scriptHash)) {
    throw browserError('browser_script_hash_mismatch', `Registered browser script ${scriptName} failed hash verification. Re-register the trusted source before running it.`);
  }
  if (manifest.sideEffecting && !allowSideEffects) {
    throw browserError('browser_side_effects_required', `Registered browser script ${scriptName} is marked side-effecting and requires explicit allowSideEffects.`);
  }

  const { profilePath, metadata } = await existingProfile(paths, profileName);
  let context;
  const stopped = { value: false };
  let timeout;
  try {
    context = await launchPersistent(profilePath, profileName, { playwright, headless: true });
    const page = await pageForContext(context, { profileName });
    const response = await navigate(page, requestedUrl, navigationMs, profileName);
    await assertPageAccessible(page, response, profileName, requestedUrl);
    const secrets = await cookieSecrets(context);

    const moduleUrl = pathToFileURL(locations.code);
    moduleUrl.searchParams.set('sha256', manifest.scriptHash);
    moduleUrl.searchParams.set('run', crypto.randomUUID());
    const execution = (async () => {
      const loaded = await import(moduleUrl.href);
      const execute = typeof loaded.default === 'function' ? loaded.default : loaded.run;
      if (typeof execute !== 'function') {
        throw new TypeError('registered module must export a function');
      }
      return execute({ page, context, input });
    })();
    timeout = scriptTimeout(timeoutMs, profileName, requestedUrl);
    let rawOutcome;
    try {
      rawOutcome = await Promise.race([
        execution,
        timeout.promise,
        captchaWatcher(page, profileName, requestedUrl, stopped)
      ]);
    } catch (error) {
      if (INTERNAL_ERRORS.has(error)) throw error;
      throw browserError('browser_script_failed', `Registered browser script ${scriptName} failed. Its error was suppressed to protect browser credentials.`);
    } finally {
      stopped.value = true;
      timeout.cancel();
    }

    await assertPageAccessible(page, response, profileName, requestedUrl);
    for (const secret of await cookieSecrets(context)) secrets.add(secret);
    const outcome = normalizeOutcome(rawOutcome, secrets);
    const canonicalOutcome = JSON.stringify(outcome);
    if (Buffer.byteLength(canonicalOutcome) > MAX_SCRIPT_OUTCOME_BYTES) {
      throw browserError('browser_script_outcome_invalid', 'Browser script outcome exceeds 1 MiB.');
    }
    const outcomeHash = sha256(canonicalOutcome);
    const auditUrl = boundedString(requestedUrl.href, MAX_URL_LENGTH, secrets);
    const audit = {
      scriptName,
      scriptHash: manifest.scriptHash,
      url: auditUrl,
      allowSideEffects,
      outcomeHash,
      status: 'ok'
    };
    const timestamp = now();
    await saveProfileMetadata(profilePath, {
      ...metadata,
      updatedAt: timestamp,
      lastUsedAt: timestamp,
      lastOrigin: requestedUrl.origin
    });
    return { outcome, audit };
  } finally {
    stopped.value = true;
    timeout?.cancel();
    await closeContext(context);
  }
}
