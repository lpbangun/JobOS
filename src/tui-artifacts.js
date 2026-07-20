import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { diffLines } from 'diff';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import stripAnsi from 'strip-ansi';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';

// ── CLIpping helpers ──────────────────────────────────────────────────────────

function clipAnsiLine(line, width) {
  if (stringWidth(line) <= width) return line;
  return sliceAnsi(line, 0, Math.max(0, width));
}

const style = codes => value => `\x1b[${codes}m${value}\x1b[0m`;
const identity = value => value;
const styleNames = ['code', 'blockquote', 'html', 'heading', 'firstHeading', 'hr', 'listitem', 'table', 'paragraph', 'strong', 'em', 'codespan', 'del', 'link', 'href'];
const plainStyles = Object.fromEntries(styleNames.map(name => [name, identity]));
const colorStyles = {
  ...plainStyles,
  code: style('33'),
  blockquote: style('3;90'),
  html: style('90'),
  heading: style('1;32'),
  firstHeading: style('1;4;35'),
  strong: style('1'),
  em: style('3'),
  codespan: style('33'),
  del: style('2;9;90'),
  link: style('34'),
  href: style('4;34')
};

// ── terminal-text sanitizer ───────────────────────────────────────────────────

/**
 * Remove OSC/CSI/ESC sequences, BEL (`\x07`), DEL (`\x7f`), and all C0
 * control characters except HT (`\x09`) and LF (`\x0a`).
 */
export function sanitizeTerminalText(value) {
  return String(value ?? '')
    // OSC: ESC ] ... ( ST \x1b\\ | BEL \x07 )
    .replace(/\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*(?:\x07|\x1b\\|$)/gs, '')
    // CSI: ESC [ parameter-bytes? intermediate-bytes? final-byte
    .replace(/\x1b\[[ -?]*[@-~]/g, '')
    // Unknown or stray ESC bytes are removed without dropping printable text
    .replace(/\x1b/g, '')
    // C0 controls except HT(09)/LF(0a), plus DEL(7f)
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

// ── markdown rendering ────────────────────────────────────────────────────────

/**
 * Render sanitized Markdown as color-capable terminal text using `marked` and
 * `marked-terminal`.
 *
 * @param {string}  content        Raw markdown content (will be sanitised first).
 * @param {object}  [options]
 * @param {number}  [options.width=80]  Terminal width for reflow/wrapping.
 * @param {boolean} [options.color=true]  When `false` the result is plain text.
 * @returns {string} Rendered terminal-safe string.
 */
export function renderArtifactMarkdown(content, { width = 80, color = true } = {}) {
  const text = sanitizeTerminalText(content);
  if (!text) return '';

  try {
    const md = new Marked();
    md.use(markedTerminal({
      width,
      reflowText: true,
      ...(color ? colorStyles : plainStyles)
    }));
    const result = md.parse(text, { async: false });
    const rendered = typeof result === 'string' ? result : '';
    return color ? rendered : stripAnsi(rendered);
  } catch {
    return text;
  }
}

// ── diff rendering ────────────────────────────────────────────────────────────

/**
 * Produce a terminal-safe line-diff between two text strings.
 *
 * Each line in the returned `lines` array is prefixed with `+ ` (green),
 * `- ` (red), or `  ` (context).  Lines are ANSI-aware clipped to `width`.
 *
 * @param {string}  previous        Previous draft content (may be empty).
 * @param {string}  current         Current draft content.
 * @param {object}  [options]
 * @param {number}  [options.width=80]   Terminal width for clipping.
 * @param {boolean} [options.color=true] When `false` ANSI codes are stripped.
 * @returns {{ lines: string[], added: number, removed: number }}
 */
export function renderArtifactDiff(previous, current, { width = 80, color = true } = {}) {
  const prev = sanitizeTerminalText(previous);
  const curr = sanitizeTerminalText(current);

  if (!prev && !curr) return { lines: [], added: 0, removed: 0 };

  const changes = diffLines(prev, curr);
  const lines = [];
  let added = 0;
  let removed = 0;

  const GREEN = '\x1b[32m';
  const RED = '\x1b[31m';
  const RESET = '\x1b[0m';

  for (const part of changes) {
    const isAdd = !!part.added;
    const isRemove = !!part.removed;
    const raw = String(part.value ?? '');
    if (!raw) continue;

    // Split on newline; discard trailing empty segment from trailing \n
    const split = raw.endsWith('\n') ? raw.split('\n').slice(0, -1) : raw.split('\n');

    if (isAdd) added += split.length;
    else if (isRemove) removed += split.length;

    for (const line of split) {
      let rendered;
      if (isRemove) {
        rendered = color ? `${RED}- ${line}${RESET}` : `- ${line}`;
      } else if (isAdd) {
        rendered = color ? `${GREEN}+ ${line}${RESET}` : `+ ${line}`;
      } else {
        rendered = `  ${line}`;
      }
      lines.push(clipAnsiLine(rendered, width));
    }
  }

  return { lines, added, removed };
}

// ── editor-command parser ────────────────────────────────────────────────────

/**
 * Parse a shell-like editor command string into an argument array.
 *
 * Supports whitespace separation, single & double quotes, backslash escapes,
 * and arguments containing `=`.  Rejects empty input and unclosed quotes.
 *
 * @param {string} value  Raw command string (e.g. `"nvim --cmd 'set nu'"`).
 * @returns {string[]}     Parsed argv array.
 * @throws {Error}         On empty/unclosed input.
 */
export function parseEditorCommand(value) {
  const input = String(value ?? '');
  const args = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escape = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escape) {
      current += ch;
      escape = false;
      continue;
    }

    if (ch === '\\' && !inSingle) {
      escape = true;
      continue;
    }

    if (inSingle) {
      if (ch === "'") { inSingle = false; continue; }
      current += ch;
      continue;
    }

    if (inDouble) {
      if (ch === '"') { inDouble = false; continue; }
      current += ch;
      continue;
    }

    // Not inside any quote
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === ' ' || ch === '\t') {
      if (current) { args.push(current); current = ''; }
      continue;
    }

    current += ch;
  }

  if (escape) throw new Error('Unclosed escape sequence');
  if (inSingle) throw new Error('Unclosed single quote');
  if (inDouble) throw new Error('Unclosed double quote');
  if (current) args.push(current);
  if (!args.length) throw new Error('Empty editor command');

  return args;
}

// ── editor lifecycle ──────────────────────────────────────────────────────────

/**
 * Resolve an artifact's path on disk, validating it is a regular file inside the
 * workspace, and that no symlink escapes the workspace boundary.
 *
 * Returns the resolved absolute path on success, or an error descriptor.
 *
 * @param {object} store          Store with `p.ws` workspace root.
 * @param {object} artifact       Artifact row with a `path` field (relative).
 * @param {object} [fs_]          Injected filesystem (defaults to `fs`).
 * @returns {{ path: string } | { error: string }}
 */
export function resolveArtifactPath(store, artifact, fs_ = fs) {
  const lexicalRoot = path.resolve(store.p.ws);
  const fullPath = path.resolve(lexicalRoot, String(artifact.path ?? ''));
  let realRoot;
  try {
    realRoot = fs_.realpathSync(lexicalRoot);
  } catch {
    return { error: 'Workspace root not found on disk' };
  }
  const wsRoot = realRoot + path.sep;

  if (fullPath !== lexicalRoot && !fullPath.startsWith(lexicalRoot + path.sep)) {
    return { error: 'Path is outside the workspace' };
  }

  let resolved;
  try {
    resolved = fs_.realpathSync(fullPath);
  } catch {
    return { error: 'Artifact file not found on disk' };
  }

  if (!resolved.startsWith(wsRoot)) {
    return { error: 'Symlink in artifact path escapes the workspace' };
  }

  let stat;
  try {
    stat = fs_.statSync(resolved);
  } catch {
    return { error: 'Cannot stat artifact path' };
  }

  if (!stat.isFile()) {
    return { error: 'Artifact path is not a regular file' };
  }

  return { path: resolved };
}

/**
 * Open an external editor for an artifact file.
 *
 * The editor binary is resolved from `$VISUAL`, then `$EDITOR`, then a platform
 * default (`notepad` on Windows, `vi` elsewhere).  The command string is parsed
 * through {@link parseEditorCommand}.
 *
 * The file is validated to be a regular file inside the workspace with no symlink
 * escapes.  The editor is spawned with `shell: false` and inherited stdio so it
 * uses the terminal directly.
 *
 * **No database mutation occurs** — the caller is responsible for calling
 * `ingestEditedArtifact` when `changed` is returned.
 *
 * @param {object} store              Store with `p.ws` workspace root.
 * @param {object} artifact           Artifact row with `path`, `id`, `job_id`, etc.
 * @param {object} [deps]
 * @param {Function} [deps.spawnImpl]  Spawn function (default: `child_process.spawn`).
 * @param {object}   [deps.fsImpl]     Filesystem module (default: `node:fs`).
 * @param {Function} [deps.readFileImpl]  File reader `(path) => string`, may be async.
 * @param {object}   [deps.env]        Environment variables (default: `process.env`).
 * @param {string}   [deps.platform]   Platform identifier (default: `process.platform`).
 * @param {Function} [deps.onSuspend]  Callback before spawn for terminal suspension.
 * @param {Function} [deps.onResume]   Callback in `finally` for terminal restoration.
 * @returns {Promise<{ unchanged: true } | { changed: true, content: string } | { exitCode: number } | { error: string }>}
 */
export async function openArtifactEditor(store, artifact, deps = {}) {
  const {
    spawnImpl,
    fsImpl,
    readFileImpl,
    env,
    platform,
    onSuspend,
    onResume,
  } = deps;

  const fs_ = fsImpl || fs;
  const readFile_ = readFileImpl || ((p) => fs_.readFileSync(p, 'utf8'));
  const env_ = env || process.env;
  const platform_ = platform || process.platform;

  // 1. Validate path
  const pathResult = resolveArtifactPath(store, artifact, fs_);
  if (pathResult.error) return pathResult;
  const resolved = pathResult.path;

  // 2. Resolve editor command
  const editorStr = String(env_.VISUAL || env_.EDITOR || (platform_ === 'win32' ? 'notepad' : 'vi')).trim();

  let editorArgs;
  try {
    editorArgs = parseEditorCommand(editorStr);
  } catch (e) {
    return { error: `Invalid editor command: ${e.message}` };
  }

  // 3. Snapshot content before edit
  let before;
  try {
    before = await Promise.resolve(readFile_(resolved));
  } catch {
    return { error: 'Cannot read artifact file before editing' };
  }

  // 4. Spawn editor with terminal lifecycle
  let suspended = false;
  let exitCode = null;
  const [cmd, ...args] = editorArgs;

  try {
    if (onSuspend) { onSuspend(); suspended = true; }

    const spawn_ = spawnImpl || spawn;
    const child = await Promise.resolve(spawn_(cmd, [...args, resolved], {
      shell: false,
      stdio: 'inherit',
      env: env_,
      cwd: path.dirname(resolved),
    }));
    if (typeof child === 'number') {
      exitCode = child;
    } else if (child && typeof child.exitCode === 'number') {
      exitCode = child.exitCode;
    } else if (child && typeof child.status === 'number') {
      exitCode = child.status;
    } else {
      exitCode = await new Promise((resolve, reject) => {
        child.on('exit', resolve);
        child.on('error', reject);
      });
    }
  } catch (e) {
    return { error: `Editor launch failed: ${e.message}`, exitCode };
  } finally {
    if (suspended && onResume) { try { onResume(); } catch { /* swallow resume error */ } }
  }

  if (exitCode !== 0) return { exitCode };

  // 5. Read content after edit
  let after;
  try {
    after = await Promise.resolve(readFile_(resolved));
  } catch {
    return { error: 'Cannot read artifact file after editing' };
  }

  if (after === before) return { unchanged: true };
  return { changed: true, content: after };
}
