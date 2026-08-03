import stripAnsiText from 'strip-ansi';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { buildTuiModel } from './tui-model.js';
import { callDomainTool, DOMAIN_TOOLS, selectedJobContext } from './domain-tools.js';
import { all, one, reload } from './db.js';
import { AcpClient, agentBackendCatalog, jobosMcpServer, readPersistedAcpSession, writePersistedAcpSession } from './acp.js';
import {
  addProof,
  createProfile,
  importResumeProofCandidates,
  listProofs,
  rejectProof,
  retireProof,
  setNetworkIntent,
  structuredProofs,
  supersedeProof,
  verifyProof
} from './profiles.js';
import { createResumeRevision, parseResumeText, readResumeFile, validateResumeDocument } from './resumes.js';
import { importNormalized, importText, importUrl, parseJob } from './jobs.js';
import { createResearchRun, executeResearchRun } from './research/runs.js';
import { suppressContact, promoteStakeholder } from './research/contacts.js';
import { validStatuses, appCreate, appUpdate } from './tracking.js';
import { rescheduleApplicationNextAction } from './lifecycle.js';
import { reviewArtifact, ingestEditedArtifact } from './artifacts.js';
import { readinessPacketSummary } from './packets.js';
import { updateJobStatus } from './jobs.js';
import { getInterviewDebrief } from './interview.js';
import { transitionMemoryProposal, undoMemoryTransition } from './career-memory-proposals.js';
import { refreshMemoryProjection } from './career-memory-projections.js';
import { createSearch } from './discovery.js';
import {
  openArtifactEditor as runArtifactEditor,
  parseEditorCommand,
  renderArtifactDiff,
  renderArtifactMarkdown,
  sanitizeTerminalText
} from './tui-artifacts.js';

const ESC = '\x1b[';
const COLORS = {
  reset: `${ESC}0m`,
  green: `${ESC}38;5;149m`,
  cyan: `${ESC}38;5;116m`,
  muted: `${ESC}38;5;243m`,
  warn: `${ESC}38;5;221m`,
  bad: `${ESC}38;5;203m`,
  inverse: `${ESC}7m`,
  header: `${ESC}48;5;234m${ESC}38;5;159m${ESC}1m`,
  surface: `${ESC}48;5;233m${ESC}38;5;252m`,
  selected: `${ESC}48;5;23m${ESC}38;5;159m${ESC}1m`
};
export const FILTERS = ['today', 'all', 'high', 'review', 'materials-ready', 'applied', 'interview'];
const FILTER_LABELS = {
  'materials-ready': 'ready'
};
const TASK_FILTERS = ['all', 'followup', 'review'];
export const TUI_DOMAIN_ACTIONS = Object.freeze({
  daily: 'daily_discovery',
  pursue: 'pursue_job',
  score: 'score_job',
  network: 'map_reachable_network'
});

export const stageOrder = Array.from(validStatuses);
export const TUI_KEYMAP = Object.freeze({
  global: Object.freeze([
    ['↑/↓', 'select'], ['j/k', 'select'], ['1', 'today'], ['2', 'all'], ['3', 'high'],
    ['4', 'review'], ['5', 'materials-ready'], ['6', 'applied'], ['7', 'interview'],
    ['p', 'pursue'], ['z', 'score'], ['d', 'daily'], ['a', 'agent'], ['i', 'prompt'], ['t', 'stage'], ['c', 'reconnect'], ['x', 'cancel'],
    ['r', 'review'], ['l', 'log'], ['m', 'memory'], ['n', 'network'], ['o', 'docs'], ['q', 'answers'], ['e', 'details'],
    ['s', 'sources'], ['g', 'setup'], ['?', 'help'], ['b', 'build-network'], ['v', 'profile'], [':', 'command'], ['/', 'slash'], ['Q', 'quit'],
    ['Tab', 'focus-chat'], ['←/→', 'priority'], ['Enter', 'jump']
  ]),
  review: Object.freeze([['↑/↓', 'select'], ['j/k', 'select'], ['Enter', 'open'], ['A', 'approve'], ['R', 'reject'], ['B', 'draft'], ['E', 'editor'], ['V', 'diff'], ['I', 'evidence'], ['Esc', 'close']]),
  docs: Object.freeze([['↑/↓', 'artifact'], ['j/k', 'artifact'], ['A', 'approve'], ['R', 'reject'], ['B', 'draft'], ['E', 'editor'], ['V', 'diff'], ['I', 'evidence'], ['/', 'search'], ['n/N', 'match'], ['PgUp/PgDn', 'scroll'], ['Ctrl+A', 'focus'], ['Esc', 'close']]),
  discovery: Object.freeze([['↑/↓', 'select'], ['j/k', 'select'], ['Enter', 'open'], ['A', 'accept'], ['X', 'archive'], ['d', 'daily'], ['Esc', 'close']]),
  network: Object.freeze([['↑/↓', 'select'], ['j/k', 'select'], ['m', 'map'], ['A', 'approve'], ['X', 'suppress'], ['P', 'promote'], ['Esc', 'close']]),
  due: Object.freeze([['↑/↓', 'select'], ['j/k', 'select'], ['1', 'all'], ['2', 'followup'], ['3', 'review'], ['Enter', 'jump'], ['Esc', 'close']]),
  stage: Object.freeze([['←/→', 'stage'], ['Enter', 'note'], ['Esc', 'cancel']]),
  memory: Object.freeze([['1', 'observations'], ['2', 'proposals'], ['3', 'career brief'], ['4', 'voice guide'], ['↑/↓', 'select'], ['j/k', 'select'], ['Esc', 'close']]),
  setup: Object.freeze([['↑/↓', 'step'], ['j/k', 'step'], ['Tab', 'next'], ['Shift+Tab', 'back'], ['1–7', 'required step'], ['Enter', 'action'], ['c', 'change'], ['r', 'refresh'], ['?', 'help'], ['Esc', 'close']])
});

/**
 * Atomic keys each KEYMAP binding expands to. Used by invariant tests so
 * advertised keys stay a subset of live handlers (no silent KEYMAP lies).
 * Tokens: plain char, 'up'|'down'|'left'|'right'|'return'|'escape', or 'ctrl+a'.
 */
export const TUI_HANDLED_KEYS = Object.freeze({
  global: Object.freeze(['up', 'down', 'j', 'k', 'h', '1', '2', '3', '4', '5', '6', '7', 'p', 'z', 'd', 'a', 'i', 't', 'c', 'x', 'r', 'l', 'm', 'n', 'o', 'q', 'e', 's', 'g', '?', 'b', 'v', ':', '/', 'Q', 'tab', 'left', 'right', 'return']),
  review: Object.freeze(['up', 'down', 'j', 'k', 'return', 'A', 'R', 'B', 'E', 'V', 'I', 'escape']),
  docs: Object.freeze(['up', 'down', 'j', 'k', 'A', 'R', 'B', 'E', 'V', 'I', '/', 'n', 'N', 'pageup', 'pagedown', 'ctrl+a', 'escape', 'D', 'X']),
  discovery: Object.freeze(['up', 'down', 'j', 'k', 'return', 'A', 'X', 'd', 'escape']),
  network: Object.freeze(['up', 'down', 'j', 'k', 'm', 'A', 'X', 'P', 'escape']),
  due: Object.freeze(['up', 'down', 'j', 'k', '1', '2', '3', 'return', 'escape']),
  stage: Object.freeze(['left', 'right', 'h', 'l', 'return', 'escape']),
  memory: Object.freeze(['1', '2', '3', '4', 'up', 'down', 'j', 'k', 'escape']),
  setup: Object.freeze(['j', 'k', 'up', 'down', 'tab', 'shift+tab', '1', '2', '3', '4', '5', '6', '7', 'return', 'c', 'r', '?', 'escape'])
});

/** Expand a KEYMAP binding label into handler tokens from TUI_HANDLED_KEYS. */
export function expandKeymapBinding(binding) {
  const table = {
    'j/k': ['j', 'k'],
    'n/N': ['n', 'N'],
    '↑/↓': ['up', 'down'],
    '←/→': ['left', 'right', 'h', 'l'],
    '1–7': ['1', '2', '3', '4', '5', '6', '7'],
    'Shift+Tab': ['shift+tab'],
    'Ctrl+A': ['ctrl+a'],
    'PgUp/PgDn': ['pageup', 'pagedown'],
    Enter: ['return'],
    Esc: ['escape'],
    Tab: ['tab'],
    Q: ['Q'],
    ':': [':'],
    '?': ['?'],
    '/': ['/']
  };
  if (table[binding]) return table[binding];
  if (binding.length === 1) return [binding];
  return [binding];
}

/** Keypress args for one handler token (for automated KEYMAP drills). */
export function keypressForToken(token) {
  if (token === 'ctrl+a') return { value: 'a', key: { name: 'a', ctrl: true } };
  if (token === 'return') return { value: '', key: { name: 'return' } };
  if (token === 'escape') return { value: '', key: { name: 'escape' } };
  if (token === 'tab') return { value: '', key: { name: 'tab' } };
  if (token === 'shift+tab') return { value: '', key: { name: 'tab', shift: true } };
  if (['up', 'down', 'left', 'right', 'pageup', 'pagedown', 'home', 'end', 'delete'].includes(token)) {
    return { value: '', key: { name: token } };
  }
  if (token === 'N') return { value: 'N', key: { name: 'n', shift: true } };
  if (token === 'Q') return { value: 'Q', key: { name: 'q', shift: true } };
  if (token.length === 1 && token >= 'A' && token <= 'Z') {
    return { value: token, key: { name: token.toLowerCase(), shift: true } };
  }
  return { value: token, key: { name: token.length === 1 ? token.toLowerCase() : token } };
}

export function parseSgrMouse(value) {
  const events = [];
  const pattern = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  for (const match of String(value || '').matchAll(pattern)) {
    events.push({
      button: Number(match[1]),
      x: Math.max(0, Number(match[2]) - 1),
      y: Math.max(0, Number(match[3]) - 1),
      pressed: match[4] === 'M'
    });
  }
  return events;
}

/**
 * Split raw terminal input before readline sees it. Readline decodes an SGR
 * mouse report as a series of ordinary keys (including its numeric
 * coordinates), so mouse reports must never enter its keypress parser.
 */
export function splitRawInput(value) {
  const input = String(value || '');
  const segments = [];
  const pattern = /\x1b\[<\d+;\d+;\d+[Mm]/g;
  let cursor = 0;
  for (const match of input.matchAll(pattern)) {
    if (match.index > cursor) segments.push({ type: 'key', value: input.slice(cursor, match.index) });
    segments.push({ type: 'mouse', value: match[0] });
    cursor = match.index + match[0].length;
  }
  const tail = input.slice(cursor);
  const partialIndex = tail.lastIndexOf('\x1b[');
  const partial = partialIndex >= 0 ? tail.slice(partialIndex) : '';
  if (partial && /^\x1b\[<?(?:\d*(?:;\d*){0,2})?$/.test(partial)) {
    if (partialIndex > 0) segments.push({ type: 'key', value: tail.slice(0, partialIndex) });
    return { segments, remainder: partial };
  }
  if (tail) segments.push({ type: 'key', value: tail });
  return { segments, remainder: '' };
}

const SETUP_STEP_LABELS = Object.freeze({
  workspace: 'Workspace ready',
  profile: 'About you',
  resume: 'Your resume',
  proofs: 'Experience highlights',
  intake: 'Add a job',
  decision: 'Check the fit',
  materials: 'Application drafts',
  source: 'Job discovery',
  calibration: 'Your preferences',
  provider: 'AI assistant',
  browser: 'Web applications',
  network: 'Connections'
});

const RESUME_SOURCE_CHOICES = Object.freeze([
  { id: 'paste', label: 'Paste resume text', detail: 'Best for copying from any document.' },
  { id: 'browse', label: 'Browse this computer', detail: 'Choose TXT, Markdown, JSON, YAML, or YML.' },
  { id: 'path', label: 'Enter a file path', detail: 'Use a full or relative path.' }
]);

const JOB_SOURCE_CHOICES = Object.freeze([
  { id: 'paste', label: 'Paste a job description', detail: 'Copy the complete posting text.' },
  { id: 'url', label: 'Import a job URL', detail: 'JobOS fetches the page you choose.' },
  { id: 'browse', label: 'Browse this computer', detail: 'Choose a TXT or Markdown file.' },
  { id: 'path', label: 'Enter a file path', detail: 'Use a full or relative path.' },
  { id: 'discovery', label: 'Set up job discovery', detail: 'Watch a company careers page.' }
]);

const RESUME_FILE_EXTENSIONS = new Set(['.txt', '.md', '.json', '.yaml', '.yml']);
const JOB_FILE_EXTENSIONS = new Set(['.txt', '.md']);

function friendlySetupText(value) {
  return String(value || '')
    .replace(/\bcanonical\b/gi, 'saved')
    .replace(/\bderived\b/gi, 'calculated')
    .replace(/\brecompute(?:d)?\b/gi, 'refresh')
    .replace(/\boptional_incomplete\b/gi, 'available later')
    .replace(/\bSQLite\b/g, 'local')
    .replace(/\bblocked\b/gi, 'needs action');
}

function setupStepLabel(id) {
  return SETUP_STEP_LABELS[id] || String(id || 'Next step').replace(/[_-]+/g, ' ');
}

function firstActionableSetupIndex(onboarding) {
  const items = onboarding?.steps || [];
  const actionId = onboarding?.nextAction?.id;
  const actionIndex = actionId ? items.findIndex(item => item.actions?.some(action => action.id === actionId)) : -1;
  if (actionIndex >= 0) return actionIndex;
  const blockedIndex = items.findIndex(item => item.status !== 'complete' && item.actions?.length);
  return blockedIndex >= 0 ? blockedIndex : Math.max(0, items.findIndex(item => item.status !== 'complete'));
}

function redraftCliHint(artifact, profileId) {
  const jobId = artifact?.jobId || artifact?.job_id || '<job-id>';
  const profile = profileId || '<profile-id>';
  const type = artifact?.type === 'cover_letter' ? 'cover-letter' : 'resume';
  return `jobos tailor ${type} --job ${jobId} --profile ${profile} --json`;
}

function stripAnsi(value) {
  return stripAnsiText(String(value ?? ''));
}
function readStructuredJsonFile(file) {
  let value;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON file ${file}: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid JSON file ${file}: expected an object`);
  }
  return value;
}


function crop(value, width) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (stringWidth(text) <= width) return text;
  return width <= 1 ? sliceAnsi(text, 0, Math.max(0, width)) : `${sliceAnsi(text, 0, width - 1)}…`;
}

function fit(value, width, align = 'left') {
  const text = crop(value, Math.max(0, width));
  const pad = Math.max(0, width - stringWidth(text));
  return align === 'right' ? `${' '.repeat(pad)}${text}` : `${text}${' '.repeat(pad)}`;
}

function paint(value, color, enabled) {
  return enabled ? `${COLORS[color] || ''}${value}${COLORS.reset}` : value;
}

function wrap(value, width) {
  const limit = Math.max(8, width);
  const paragraphs = sanitizeTerminalText(value).split('\n');
  const lines = [];
  for (const paragraph of paragraphs) {
    let remaining = paragraph.trim();
    if (!remaining) {
      lines.push('');
      continue;
    }
    while (stringWidth(remaining) > limit) {
      const clipped = sliceAnsi(remaining, 0, limit);
      let split = clipped.lastIndexOf(' ');
      if (split < Math.floor(clipped.length / 2)) split = clipped.length;
      lines.push(remaining.slice(0, split).trimEnd());
      remaining = remaining.slice(split).trimStart();
    }
    lines.push(remaining);
  }
  return lines.length ? lines : [''];
}

function editableInput(state, color) {
  const input = String(state.input || '').replace(/\r?\n/g, ' ↵ ');
  const cursor = Math.max(0, Math.min(input.length, Number(state.inputCursor ?? input.length)));
  const anchor = state.inputAnchor == null ? cursor : Math.max(0, Math.min(input.length, Number(state.inputAnchor)));
  const start = Math.min(cursor, anchor);
  const end = Math.max(cursor, anchor);
  if (start !== end) {
    return `${input.slice(0, start)}${paint(input.slice(start, end), 'inverse', color)}${input.slice(end)}█`;
  }
  return `${input.slice(0, cursor)}█${input.slice(cursor)}`;
}

function panel(title, body, width, color) {
  const inner = Math.max(1, width - 2);
  const topLabel = ` ${crop(title, Math.max(1, inner - 2))} `;
  const top = `┌${topLabel}${'─'.repeat(Math.max(0, inner - stringWidth(topLabel)))}┐`;
  const rows = body.map(line => {
    const row = `│${fit(line, inner)}│`;
    return paint(row, String(line).includes('▶') ? 'selected' : 'surface', color);
  });
  return [paint(top, 'header', color), ...rows, paint(`└${'─'.repeat(inner)}┘`, 'header', color)];
}

function fixedPanel(title, body, width, height, color) {
  const room = Math.max(1, height - 2);
  const rows = body.slice(0, room);
  while (rows.length < room) rows.push('');
  return panel(title, rows, width, color);
}

function modalPanel(title, body, width, color) {
  const inner = Math.max(1, width - 2);
  const topLabel = ` ${crop(title, Math.max(1, inner - 2))} `;
  const top = `╔${topLabel}${'═'.repeat(Math.max(0, inner - stringWidth(topLabel)))}╗`;
  const rows = body.map(line => {
    const row = `║${fit(line, inner)}║`;
    return paint(row, String(line).includes('▶') ? 'selected' : 'surface', color);
  });
  return [paint(top, 'header', color), ...rows, paint(`╚${'═'.repeat(inner)}╝`, 'header', color)];
}

function mergeColumns(columns, widths, color, separator = ' ') {
  const rows = Math.max(...columns.map(column => column.length));
  const output = [];
  for (let index = 0; index < rows; index++) {
    const parts = columns.map((column, columnIndex) => {
      const value = column[index] || '';
      const pad = Math.max(0, widths[columnIndex] - stringWidth(value));
      return `${value}${' '.repeat(pad)}`;
    });
    output.push(parts.join(paint(separator, 'green', color)));
  }
  return output;
}

function composeModal(background, modal, width, bodyStart, bodyHeight) {
  const output = [...background];
  const modalWidth = Math.min(width, Math.max(1, ...modal.map(line => stringWidth(line))));
  const top = bodyStart + Math.max(0, Math.floor((bodyHeight - modal.length) / 2));
  const left = Math.max(0, Math.floor((width - modalWidth) / 2));
  for (let index = 0; index < modal.length && index < bodyHeight; index++) {
    const row = top + index;
    const backdrop = fit(output[row] || '', width);
    output[row] = `${sliceAnsi(backdrop, 0, left)}${modal[index]}${sliceAnsi(backdrop, left + modalWidth, width)}`;
  }
  return output;
}

function fitLabel(fit) {
  if (!fit) return 'unscored';
  if (fit.contract === 'legacy_unversioned') return fit.overall == null ? 'legacy unknown' : `legacy ${fit.overall}/100`;
  if (fit.overall == null) return 'unknown';
  return `${fit.overall}/100${fit.scoreStatus === 'review_required' ? ' review' : ''}`;
}

function filteredJobs(model, filter) {
  if (filter === 'all') return model.jobs;
  if (filter === 'today') return model.jobs.filter(job => job.next || ['new', 'imported', 'interview'].includes(job.stage));
  if (filter === 'high') return model.jobs.filter(job => job.highFit);
  if (filter === 'review') return model.jobs.filter(job => model.review.some(item => item.jobId === job.id));
  return model.jobs.filter(job => job.stage === filter);
}

function packetCtaLine(row) {
  const currency = row?.currency || 'none';
  const receiptState = row?.receiptState || 'none';
  if (currency !== 'current') return 'next :packet create — freeze a packet from the approved materials';
  if (receiptState === 'none') return `next :form assist ${row?.id || '<packet-id>'} (configured fill), or submit manually; configured submit requires a read-back checkpoint`;
  if (receiptState === 'attested') return 'next :receipt <external-reference> once the site confirms receipt';
  return 'receipt confirmed · follow-ups only (outreach, interview prep)';
}

function readinessLines(readiness, width, color) {
  const status = readiness?.status || 'blocked';
  const next = readiness?.nextAction || readiness?.next || readiness?.nextActions?.[0]?.action || 'Review the readiness details above.';
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const warnings = Array.isArray(readiness?.warnings) ? readiness.warnings : [];
  const localApprovalComplete = readiness?.localApprovalComplete || readiness?.review?.localApprovalComplete;
  const packet = readiness?.packet;
  const packetState = packet?.currentPacketId ? ` · packet ${packet.currency}/${packet.receiptState}` : '';
  const lineTone = status === 'approved' ? 'green' : (status === 'blocked' ? 'bad' : 'warn');
  const lines = [
    ...wrap(`READINESS ${status} · ${readiness?.readyForReview ? 'reviewable' : 'not reviewable'}${localApprovalComplete ? ' · locally approved' : ''}${packetState}`, width)
      .map(line => paint(line, lineTone, color)),
    ...wrap(`next ${typeof next === 'string' ? next : JSON.stringify(next)}`, width)
  ];
  blockers.forEach((blocker, index) => {
    const text = typeof blocker === 'string' ? blocker : JSON.stringify(blocker);
    lines.push(...wrap(`blocker ${index + 1}/${blockers.length} · ${text}`, width).map(line => paint(line, 'bad', color)));
  });
  warnings.forEach((warning, index) => {
    const text = typeof warning === 'string' ? warning : JSON.stringify(warning);
    lines.push(...wrap(`warning ${index + 1}/${warnings.length} · ${text}`, width).map(line => paint(line, 'warn', color)));
  });
  return lines;
}

function policyLines(policy, width, color) {
  const values = Object.entries(policy || {});
  if (!values.length) return [paint('POLICY local review gate enforced', 'muted', color)];
  return [
    paint('POLICY', 'cyan', color),
    ...values.flatMap(([key, value]) => (
      wrap(`${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`, width)
    ))
  ];
}

function documentHistory(docs, doc) {
  return docs
    .filter(item => item.seriesKey === doc.seriesKey)
    .sort((left, right) => Number(left.revision) - Number(right.revision))
    .map(item => `r${item.revision} ${item.approvalStatus}${item.id === doc.id ? ' · current' : ''}`);
}

function documentDiff(before, after, width) {
  const beforeLines = String(before?.content || '').split(/\r?\n/);
  const afterLines = String(after?.content || '').split(/\r?\n/);
  const lines = [`DIFF r${before?.revision || 0} → r${after.revision}`];
  const limit = Math.max(3, Math.floor(width / 16));
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length) && lines.length <= limit; index++) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] != null) lines.push(`- ${beforeLines[index]}`);
    if (afterLines[index] != null) lines.push(`+ ${afterLines[index]}`);
  }
  return lines.length === 1 ? [...lines, 'No textual changes from previous revision.'] : lines;
}

function headerLine(model, state, width, color) {
  const profile = model.profile?.name || 'no profile';
  if (width < 100) {
    return paint(fit(` JOBOS · ${profile} `, width), 'header', color);
  }
  const left = ` JOBOS · ${profile}`;
  const right = 'local workspace ';
  const gap = Math.max(1, width - stringWidth(left) - stringWidth(right));
  return paint(fit(`${left}${' '.repeat(gap)}${right}`, width), 'header', color);
}

function priorityLines(model, state, width, color) {
  const focused = Math.max(0, Math.min(model.priority.length - 1, state.stripIndex || 0));
  const item = model.priority[focused];
  if (!item) return [];
  const tone = item.kind === 'failure' ? 'bad' : (item.kind === 'new' ? 'green' : 'warn');
  if (width < 90) {
    return wrap(` ▶ ${item.text} · Enter opens · ${focused + 1}/${model.priority.length} · ←/→`, width)
      .slice(0, 2)
      .map(line => paint(fit(line, width), tone, color));
  }
  return [
    paint(fit(` NEXT UP  ${focused + 1} of ${model.priority.length}  ·  use ←/→ to review`, width), 'header', color),
    paint(fit(` ▶ ${item.text}  ·  Enter opens`, width), tone, color)
  ];
}

function dashboardFilterLabel(filter) {
  return FILTER_LABELS[filter] || filter;
}

function dashboardFilterText(activeFilter) {
  return FILTERS
    .map(filter => filter === activeFilter ? `[${dashboardFilterLabel(filter)}]` : dashboardFilterLabel(filter))
    .join(' ');
}

function listPanel(model, state, width, height, color) {
  const jobs = filteredJobs(model, state.filter);
  const body = wrap(dashboardFilterText(state.filter), width - 4).map(line => paint(line, 'cyan', color));
  if (model.empty.noProfile) {
    body.push('', 'No profile yet.', 'Press g to finish setup.');
  } else if (!jobs.length) {
    body.push(
      '',
      ...(model.empty.noJobs ? ['No jobs yet.'] : [`No jobs in filter: ${state.filter}`]),
      '',
      model.empty.noJobs ? 'Next: press g to add your first job.' : 'Next: choose another filter.'
    );
  } else {
    const selectedId = model.selectedJobId;
    const available = Math.max(1, height - 2 - body.length);
    const coreRows = 3;
    const maxCards = Math.max(1, Math.floor(available / coreRows));
    let start = Math.max(0, jobs.findIndex(job => job.id === selectedId) - Math.floor(maxCards / 2));
    start = Math.min(start, Math.max(0, jobs.length - maxCards));
    for (const job of jobs.slice(start, start + maxCards)) {
      const selected = job.id === selectedId;
      body.push(
        ...wrap(`${selected ? '▶' : ' '} ${job.title}`, width - 4).slice(0, 2),
        paint(`  FIT ${fitLabel(job.fit)}${job.highFit ? ' · HIGH' : ''}`, selected ? 'selected' : 'cyan', color)
      );
    }
  }
  return fixedPanel('JOBS', body, width, height, color);
}

function fitDimensionLines(fit, width) {
  if (!fit?.dimensions) return ['No fit dimensions are stored.'];
  const summary = Object.entries(fit.dimensions).map(([key, dimension]) => {
    const value = dimension.status === 'unknown' ? 'unknown' : `${dimension.score}/100`;
    return `${key}: ${value}`;
  }).join(' · ');
  return wrap(summary, width);
}

function constraintLines(fit, width) {
  if (!fit?.constraints?.length) return wrap('CANDIDATE CONSTRAINTS · none recorded', width);
  const summary = fit.constraints.map(value => `${value.kind}/${value.status}: ${value.reason}`).join(' · ');
  return wrap(`CANDIDATE CONSTRAINTS · ${summary}`, width);
}

function postingStatusLines(item, width) {
  const posting = item.postingLiveness;
  const status = posting
    ? `${posting.status} · ${posting.reasonCodes?.join(', ') || 'no reason codes'}`
    : 'uncertain · not checked';
  const risks = item.fit?.postingRisks?.length
    ? item.fit.postingRisks.flatMap(value => {
        const label = String(value.code || 'posting risk').replace(/^posting_risk_/, '').replaceAll('_', ' ');
        return wrap(`${label} (${value.status}): ${value.reason}`, width);
      })
    : [];
  return [
    ...wrap(`POSTING STATUS / LEGITIMACY · ${status}${risks.length ? '' : ' · no static risks observed'}`, width),
    ...risks
  ];
}
function detailSummaryLines(model, state, width, height, color) {
  const item = model.selected;
  const fitScore = fitLabel(item.fit);
  const recommended = item.recommendedAction || model.recommendedAction;
  const readinessStatus = item.readiness?.status === 'approved'
    ? 'ready'
    : item.readiness?.readyForReview ? 'ready for review' : 'needs attention';
  const hint = state.detailsExpanded
    ? (state.focusTarget === 'details' ? 'e hide details · Esc jobs · ↑/↓ scroll' : 'e focus details · p prepare · i ask')
    : 'e details · p prepare · z score · i ask';
  const room = Math.max(1, height - 2);
  if (room <= 13) {
    const leading = [
      paint(`▶ ${item.job.title}`, 'selected', color),
      ...(room >= 7 ? [`${item.job.company} · ${item.job.location || 'location not listed'}`] : []),
      paint(`FIT ${fitScore} · READINESS ${readinessStatus}`, readinessStatus === 'ready' ? 'green' : 'warn', color)
    ];
    const nextRows = wrap(`▶ NEXT · ${recommended?.label || 'Review this job and choose your next step'}`, width)
      .slice(0, Math.max(1, room - leading.length - 1));
    return [...leading, ...nextRows, paint(hint, 'green', color)].slice(0, room);
  }
  return [
    paint(`▶ ${item.job.title}`, 'selected', color),
    `${item.job.company} · ${item.job.location || 'location not listed'}`,
    '',
    paint(`FIT ${fitScore}${item.fit?.highFit ? ' · HIGH' : ''}`, 'cyan', color),
    paint(`READINESS ${readinessStatus}`, readinessStatus === 'ready' ? 'green' : 'warn', color),
    '',
    paint('▶ NEXT', 'selected', color),
    ...wrap(recommended?.label || 'Review this job and choose your next step', width).slice(0, 3),
    '',
    paint(hint, 'green', color)
  ];
}

function naturalListPanelHeight(model, state, width, availableHeight) {
  const jobs = filteredJobs(model, state.filter);
  const contentWidth = Math.max(8, width - 4);
  const filterRows = wrap(dashboardFilterText(state.filter), contentWidth).length;
  if (!jobs.length) return Math.min(availableHeight, 2 + filterRows + 4);
  let rows = filterRows;
  for (let index = 0; index < jobs.length; index++) {
    const cardRows = 3;
    if (rows + cardRows > availableHeight - 2) break;
    rows += cardRows;
  }
  return Math.min(availableHeight, Math.max(5, rows + 2));
}

function naturalDetailPanelHeight(model, state, width, availableHeight, color) {
  if (!model.selected) return Math.min(availableHeight, 7);
  const contentWidth = Math.max(8, width - 4);
  const summary = detailSummaryLines(model, state, contentWidth, availableHeight, color);
  const complete = appendVisibleSections(
    [...summary],
    decisionOverviewSections(model.selected, contentWidth, color),
    Math.max(1, availableHeight - 2)
  );
  const identityHeight = availableHeight >= 9 ? 9 : 7;
  return Math.min(availableHeight, Math.max(identityHeight, complete.length + 2));
}

function naturalDashboardHeight(model, state, listWidth, detailWidth, availableHeight, color) {
  if (state.detailsExpanded) return availableHeight;
  return Math.max(
    naturalListPanelHeight(model, state, listWidth, availableHeight),
    naturalDetailPanelHeight(model, state, detailWidth, availableHeight, color)
  );
}

function decisionOverviewSections(item, width, color) {
  const structured = [item.workModel, item.compensation].filter(value => (
    value && !/^(unknown|not (listed|specified|provided)|n\/a)$/i.test(String(value).trim())
  ));
  const storedDescription = String(item.postingText || '').trim();
  const descriptionLines = storedDescription.split(/\r?\n/);
  const firstSection = descriptionLines.findIndex(line => /^#{1,6}\s+\S/.test(line.trim()));
  const roleDescription = descriptionLines
    .slice(0, firstSection < 0 ? descriptionLines.length : firstSection)
    .map(line => line.trim())
    .filter(line => line && !/^(title|company|location)\s*:/i.test(line))
    .join(' ');
  const descriptionKnown = roleDescription && storedDescription !== 'No description is stored for this job.';
  const sections = [];
  if (structured.length) {
    sections.push({
      heading: paint('ROLE DETAILS', 'cyan', color),
      rows: wrap(structured.join(' · '), width).slice(0, 3)
    });
  } else if (descriptionKnown) {
    sections.push({
      heading: paint('ROLE DESCRIPTION', 'cyan', color),
      rows: wrap(roleDescription, width).slice(0, 4)
    });
  }
  if (item.requirements?.length) {
    sections.push({
      heading: paint('KEY REQUIREMENTS', 'cyan', color),
      rows: item.requirements.slice(0, 3).flatMap(value => wrap(`• ${value}`, width))
    });
  }
  return sections;
}

function appendVisibleSections(body, sections, room) {
  for (const section of sections) {
    const rows = section.rows.filter(row => String(stripAnsi(row)).trim());
    if (!rows.length) continue;
    const separator = body.length && body[body.length - 1] !== '' ? [''] : [];
    const available = room - body.length;
    if (available < separator.length + 1 + rows.length) break;
    body.push(...separator, section.heading, ...rows);
  }
  return body;
}

function technicalDetailLines(item, state, width, color) {
  const fitMeta = item.fit ? `${item.fit.mode} · ${item.fit.scoreStatus} · coverage ${item.fit.evidenceCoverage ?? '—'}%` : 'not scored';
  const proofs = item.proofs.length ? item.proofs.map(proof => `${proof.id} ${proof.summary}`) : ['No matched proof IDs yet'];
  const artifacts = item.docs.length ? item.docs.map(doc => `${doc.type} · ${doc.approvalStatus} · r${doc.revision} · ${doc.path}`) : ['No drafts yet'];
  return [
    '',
    paint('TECHNICAL DETAILS', 'cyan', color),
    ...wrap(`JOB ID ${item.job.id}`, width),
    ...wrap(`RUNTIME FX off · side effects off · agent ${state.agentState}${state.sessionId ? ` · session ${state.sessionId}` : ''}`, width),
    ...wrap(`FIT DETAILS ${fitMeta}`, width),
    ...fitDimensionLines(item.fit, width),
    ...constraintLines(item.fit, width).map(line => paint(line, 'cyan', color)),
    ...postingStatusLines(item, width).map((line, index) => paint(line, index === 0 ? 'cyan' : 'reset', color)),
    paint('POSTING TEXT', 'cyan', color),
    ...wrap(item.postingText || item.narrative || 'No description is stored for this job.', width),
    paint('POSTING REQUIREMENTS', 'cyan', color),
    ...(item.requirements?.length
      ? item.requirements.flatMap(value => wrap(value, width))
      : ['No structured requirements are stored.']),
    ...readinessLines(item.readiness, width, color),
    ...policyLines(item.policy, width, color),
    paint('MATCHED PROOFS', 'cyan', color),
    ...proofs.flatMap(value => wrap(value, width)),
    paint('ARTIFACTS', 'cyan', color),
    ...artifacts.flatMap(value => wrap(value, width)),
    paint('PURSUE STAGES', 'cyan', color),
    ...item.stages.flatMap(stage => wrap(`${stage.name}:${stage.state}`, width))
  ];
}

const TECHNICAL_DETAIL_HEADINGS = new Set([
  '▶ NEXT',
  'TECHNICAL DETAILS',
  'POSTING TEXT',
  'POSTING REQUIREMENTS',
  'POLICY',
  'MATCHED PROOFS',
  'ARTIFACTS',
  'PURSUE STAGES'
]);

function detailPanel(model, state, width, height, color) {
  const item = model.selected;
  if (!item) {
    return fixedPanel('SELECTED JOB', ['No job selected.', '', 'Next: choose a job to see its fit and recommended action.'], width, height, color);
  }
  const contentWidth = Math.max(8, width - 4);
  const room = Math.max(1, height - 2);
  const summary = detailSummaryLines(model, state, contentWidth, height, color);
  if (!state.detailsExpanded) {
    const body = appendVisibleSections([...summary], decisionOverviewSections(item, contentWidth, color), room);
    return fixedPanel('SELECTED JOB', body, width, height, color);
  }
  const body = [...summary, ...technicalDetailLines(item, state, contentWidth, color)];
  const scrollMax = Math.max(0, body.length - room);
  const scroll = Math.max(0, Math.min(scrollMax, Number(state.detailsScroll || 0)));
  const end = Math.min(body.length, scroll + room);
  const visible = body.slice(scroll, end);
  if (TECHNICAL_DETAIL_HEADINGS.has(stripAnsi(visible[visible.length - 1]).trim())) visible.pop();
  const focused = state.focusTarget === 'details';
  const title = `SELECTED JOB · DETAILS${focused ? ' · FOCUSED' : ''} · rows ${scroll + 1}-${end}/${body.length}`;
  return fixedPanel(title, visible, width, height, color);
}

function agentPanel(model, state, width, height, color) {
  const selectedTitle = model.selected?.job.title || 'your workspace';
  const header = [
    paint(`Assistant ${state.agentState === 'ready' ? 'ready' : state.agentState}`, state.agentState === 'ready' ? 'green' : (state.agentState === 'failed' || state.agentState === 'crashed' ? 'bad' : 'warn'), color),
    paint(`Focused on ${selectedTitle}`, 'muted', color),
    ''
  ];
  if (state.detailsExpanded) {
    header.push(paint(`Technical: ${model.selectedJobId || 'no job'} · JobOS MCP · terminal/filesystem denied${state.sessionId ? ` · ${state.sessionId}` : ''}`, 'muted', color), '');
  }
  if (state.agentState === 'offline' || !state.agentOn) header.splice(1, 0, 'Assistant is off.');
  const history = [];
  for (const message of state.messages.slice(-80)) {
    const label = message.role === 'user' ? 'you' : (message.role === 'tool' ? 'tool' : 'assistant');
    history.push(paint(`${label}>`, message.role === 'tool' ? 'warn' : 'cyan', color));
    history.push(...wrap(message.text, width - 4));
  }
  if (!history.length) history.push(
    'Ask JobOS in plain language.',
    '',
    'Try:',
    '• What should I work on next?',
    '• Compare this role with my experience.',
    '• Help me prepare this application.',
    '',
    'Press i to type. Tab returns to the dashboard.'
  );
  const composer = [];
  if (state.mode === 'agent') composer.push('', paint(`> ${editableInput(state, color)}`, 'green', color));
  else if (state.agentState === 'working') composer.push('', paint('working · navigation remains active · x cancels', 'warn', color));
  const room = Math.max(1, height - 2 - header.length - composer.length);
  const maxScroll = Math.max(0, history.length - room);
  const scroll = Math.min(maxScroll, Math.max(0, state.agentScroll || 0));
  const end = history.length - scroll;
  const visible = history.slice(Math.max(0, end - room), end);
  const body = [...header, ...visible, ...composer];
  while (body.length < Math.max(1, height - 2)) body.push('');
  return panel(`${state.focusTarget === 'agent' ? 'ASSISTANT · FOCUSED' : 'ASSISTANT'}${scroll ? ` · scroll ↑${scroll}` : ''}`, body.slice(0, Math.max(1, height - 2)), width, color);
}

function overlayItems(model, state) {
  if (state.overlay === 'setup') return model.onboarding?.steps || [];
  if (state.overlay === 'setup-action-picker') return state.setupActionItems || [];
  if (state.overlay === 'setup-profile-picker') return model.profiles || [];
  if (state.overlay === 'setup-job-picker') return model.jobs || [];
  if (state.overlay === 'setup-resume-source') return RESUME_SOURCE_CHOICES;
  if (state.overlay === 'setup-job-source') return JOB_SOURCE_CHOICES;
  if (state.overlay === 'setup-file-browser') return state.setupFileItems || [];
  if (state.overlay === 'setup-proof-review') return state.setupProofItems || [];
  if (state.overlay === 'review') return model.review;
  if (state.overlay === 'docs') return model.selected?.docs || [];
  if (state.overlay === 'profile') return model.profiles;
  if (state.overlay === 'log') return model.log;
  if (state.overlay === 'network') return networkOverlayItems(model);
  if (state.overlay === 'due') return dueOverlayTasks(model, state);
  if (state.overlay === 'build-network') return buildNetworkItems(model, state);
  if (state.overlay === 'memory') {
    if (state.memoryView === 'proposals') return model.memory?.proposals || [];
    if (state.memoryView === 'observations') return model.memory?.observations || [];
  }
  return [];
}

function dueOverlayTasks(model, state) {
  const tasks = model.dueTasks || [];
  return state.taskFilter && state.taskFilter !== 'all'
    ? tasks.filter(task => task.type === state.taskFilter)
    : tasks;
}
// Network overlay rows: discovered contact points first (human-gated via A/X),
// then person candidates (promotable via P). Suppressed values are already
// nulled by the model (listNetworkContacts redacts do_not_use rows).
function networkOverlayItems(model) {
  const selected = model.selected;
  if (!selected) return [];
  const contacts = (selected.contacts || []).map(contact => ({
    kind: 'contact',
    id: contact.id,
    label: `[contact] ${contact.name || 'unnamed'} · ${contact.role || 'role —'} · ${contact.type}${contact.value ? ` ${contact.value}` : ''} · tier ${contact.evidenceTier || '—'}${contact.approved ? ' · approved' : ''}${contact.suppressed ? ' · suppressed' : ''}`
  }));
  const candidates = (selected.candidates || []).map(candidate => ({
    kind: 'candidate',
    id: candidate.id,
    label: `[candidate] ${candidate.name || 'unnamed'} · ${candidate.role || 'role —'} · ${candidate.status}${candidate.relevance ? ` · ${candidate.relevance}` : ''}`
  }));
  return [...contacts, ...candidates];
}
// Build-network editor: a sequential, keyboard-usable setup editor.
// The draft (state.networkDraft) holds editable copies seeded from the model on open.
// Field kinds: 'list' (comma-separated text, Enter to edit), 'toggle' (Enter to flip),
// 'static' (read-only display), 'action' (Enter/b to trigger).
const PERSONA_OPTIONS = ['recruiter', 'hiring_manager', 'peer', 'executive', 'alumni'];
function buildNetworkItems(model, state) {
  const ns = model.networkSetup || {};
  const draft = state.networkDraft;
  if (!model.profileId) return [];
  if (!draft) return [{ key: '_notice', label: 'Open build-network to edit', value: '', type: 'static' }];
  const items = [];
  items.push({ key: 'status', label: 'Setup status', value: ns.status || 'not_started', type: 'static' });
  items.push({ key: 'schools', label: 'Schools/programs', value: draft.schools || 'none', type: 'list', affType: 'school' });
  items.push({ key: 'employers', label: 'Former employers/roles', value: draft.employers || 'none', type: 'list', affType: 'employer' });
  items.push({ key: 'communities', label: 'Communities', value: draft.communities || 'none', type: 'list', affType: 'community' });
  items.push({ key: 'targetRoles', label: 'Target roles', value: draft.targetRoles || 'none', type: 'list' });
  items.push({ key: 'targetCompanies', label: 'Target companies', value: draft.targetCompanies || 'none', type: 'list' });
  items.push({ key: 'personas', label: 'Preferred personas', value: draft.personas || 'none', type: 'list' });
  items.push({ key: 'relTypes', label: 'Relationship types', value: draft.relTypes || 'none', type: 'list' });
  items.push({ key: 'exclusions', label: 'Exclusions', value: draft.exclusions || 'none', type: 'list' });
  items.push({ key: 'sourcePublic', label: 'Public web source', value: draft.sourcePublic ? 'on' : 'off', type: 'toggle' });
  items.push({ key: 'sourceLinkedin', label: 'LinkedIn import source', value: draft.sourceLinkedin ? 'on' : 'off', type: 'toggle' });
  items.push({ key: 'sourceXai', label: 'xAI X Search source', value: ns.xaiState || 'off', type: 'static' });
  items.push({ key: 'connCount', label: 'Imported connections', value: String(ns.importedConnectionCount || 0), type: 'static' });
  items.push({ key: 'latestRun', label: 'Latest profile research run', value: ns.latestProfileRun ? `${ns.latestProfileRun.status} · ${ns.latestProfileRun.id?.slice(0, 12)}` : 'none', type: 'static' });
  items.push({ key: '_sep', label: '', value: '', type: 'separator' });
  items.push({ key: 'saveOnly', label: '[Save only]', value: 'default: save network setup', type: 'action', action: 'saveOnly' });
  items.push({ key: 'saveBuild', label: '[Save and build]', value: 'save and start network research', type: 'action', action: 'saveBuild' });
  return items;
}
function seedNetworkDraft(model) {
  const ns = model.networkSetup || {};
  const intent = ns.intent || {};
  const rows = ns.affiliationRows || [];
  const groupFor = type => rows.filter(row => row.type === type && row.status !== 'rejected')
    .map(row => row.roleOrProgram ? `${row.organization} (${row.roleOrProgram})` : row.organization)
    .join(', ');
  return {
    schools: groupFor('school'),
    employers: groupFor('employer'),
    communities: groupFor('community'),
    targetRoles: (intent.targetRoles || []).join(', '),
    targetCompanies: (intent.targetCompanies || []).join(', '),
    personas: (intent.preferredPersonas || []).join(', '),
    relTypes: (intent.comfortableRelationshipTypes || []).join(', '),
    exclusions: (intent.exclusions || []).join(', '),
    sourcePublic: intent.allowedSources?.publicWeb !== false,
    sourceLinkedin: Boolean(intent.allowedSources?.linkedinImport),
    sourceXai: Boolean(intent.allowedSources?.xai)
  };
}
function parseList(value) {
  return [...new Set(String(value || '').split(',').map(part => part.trim()).filter(Boolean))];
}
function buildIntentFromDraft(draft) {
  return {
    version: 1,
    targetCompanies: parseList(draft.targetCompanies),
    targetRoles: parseList(draft.targetRoles),
    preferredPersonas: parseList(draft.personas).filter(p => PERSONA_OPTIONS.includes(p)),
    comfortableRelationshipTypes: parseList(draft.relTypes),
    exclusions: parseList(draft.exclusions),
    allowedSources: {
      publicWeb: draft.sourcePublic !== false,
      linkedinImport: Boolean(draft.sourceLinkedin),
      xai: Boolean(draft.sourceXai)
    }
  };
}
function buildAffiliationsFromDraft(draft) {
  const affiliations = [];
  const addGroup = (text, type) => {
    for (const entry of parseList(text)) {
      // support "Org (role/program)" shorthand
      const match = entry.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
      affiliations.push({
        type,
        organization: match ? match[1].trim() : entry,
        role_or_program: match ? match[2].trim() : '',
        status: 'confirmed',
        source: 'manual',
        confidence: 'high'
      });
    }
  };
  addGroup(draft.schools, 'school');
  addGroup(draft.employers, 'employer');
  addGroup(draft.communities, 'community');
  return affiliations;
}
function visibleWindow(items, selectedIndex, limit) {
  const size = Math.max(1, Math.min(items.length, limit));
  const start = Math.max(0, Math.min(items.length - size, selectedIndex - Math.floor(size / 2)));
  return { start, items: items.slice(start, start + size) };
}

function centeredRows(rows, width) {
  const rowWidth = Math.min(width, Math.max(1, ...rows.map(row => stringWidth(row))));
  const left = Math.max(0, Math.floor((width - rowWidth) / 2));
  return rows.map(row => fit(`${' '.repeat(left)}${row}`, width));
}

function centeredSurface(rows, width, height, color) {
  const visible = rows.slice(0, height);
  const top = Math.max(0, Math.floor((height - visible.length) / 3));
  const output = Array.from({ length: top }, () => paint(fit('', width), 'surface', color));
  output.push(...centeredRows(visible, width));
  while (output.length < height) output.push(paint(fit('', width), 'surface', color));
  return output.slice(0, height);
}

function setupChoiceRows(items, selectedIndex, width) {
  return items.flatMap((item, index) => {
    const prefix = index === selectedIndex ? '▶ ' : '  ';
    const line = `${prefix}${item.label}  ·  ${item.detail}`;
    return wrap(line, width).map((part, lineIndex) => lineIndex === 0 ? part : `    ${part}`);
  });
}

function setupRecommendation(item, width) {
  if (!item) return ['Choose an item, then press Enter.'];
  if (item.actions?.[0]) return wrap(`Press Enter to ${friendlySetupText(item.actions[0].label).toLowerCase()}.`, width);
  if (item.status === 'complete') return ['This task is done. Press Down to move to the next task.'];
  const blocker = item.blockers?.[0];
  if (blocker) {
    const reason = friendlySetupText(blocker.message || item.summary);
    const recovery = friendlySetupText(blocker.recovery || blocker.remediation || '');
    return wrap(`${reason}${recovery ? ` Next: ${recovery}` : ''}`, width);
  }
  return wrap(friendlySetupText(item.summary || 'This optional task can wait.'), width);
}

function welcomePanel(model, width, height, color) {
  const noProfile = model.empty.noProfile;
  const body = noProfile
    ? [
        paint('A private workspace for your job search.', 'green', color),
        '',
        'Start with a short guided setup. You can change everything later.',
        '',
        paint('g  Start guided setup', 'selected', color),
        'Your information stays in this local workspace.',
        '',
        'No profile yet.',
        'CLI option: jobos profile create "Your focus"'
      ]
    : [
        paint('Your workspace is ready.', 'green', color),
        '',
        'Add one role to see fit, evidence, drafts, and next steps here.',
        '',
        paint('g  Add your first job', 'selected', color),
        'd  Run daily discovery',
        '',
        'No jobs yet.',
        'Workspace healthy and empty.'
      ];
  const panelWidth = Math.min(width, 84);
  return centeredSurface(modalPanel(noProfile ? 'WELCOME TO JOBOS' : 'START YOUR JOB SEARCH', body, panelWidth, color), width, height, color);
}

function keyHints(scope) {
  return (TUI_KEYMAP[scope] || TUI_KEYMAP.global).map(([key, label]) => `${key} ${label}`).join(' · ');
}

/**
 * Curated action hint for the SELECTED JOB panel. Labels are derived from
 * TUI_KEYMAP.global at render time so the hint cannot drift from the bindings
 * (the old hardcoded line mislabeled `i` as "agent").
 */
export const DETAIL_HINT_KEYS = Object.freeze(['p', 'z', 'n', 'o', 'q', 'a', 'i']);
function detailHints() {
  return DETAIL_HINT_KEYS.map(key => {
    const entry = TUI_KEYMAP.global.find(([binding]) => binding === key);
    if (!entry) throw new Error(`DETAIL_HINT_KEYS advertises "${key}" but TUI_KEYMAP.global lacks it`);
    return `${key} ${entry[1]}`;
  }).join(' · ');
}

function selectedDoc(model, state) {
  const docs = model.selected?.docs || [];
  const index = Math.max(0, state.selectedArtifactId
    ? docs.findIndex(doc => doc.id === state.selectedArtifactId)
    : Math.min(state.overlayIndex || 0, Math.max(0, docs.length - 1)));
  return { docs, index, doc: docs[index] || null };
}

function renderedLines(value) {
  if (Array.isArray(value)) return value.map(String);
  if (value && Array.isArray(value.lines)) return value.lines.map(String);
  if (value && typeof value.text === 'string') return value.text.split(/\r?\n/);
  return String(value ?? '').split(/\r?\n/);
}

function evidenceLines(doc, width) {
  if (!doc) return [];
  const lines = ['', 'EVIDENCE'];
  if (!doc.evidence?.length) lines.push('No evidence stored for this artifact.');
  for (const item of doc.evidence || []) {
    if (item?.missing) {
      lines.push(`Missing proof: ${item.proofPointId}`);
      continue;
    }
    if (item?.proofPointId) {
      lines.push(`Proof ${item.proofPointId}`);
      if (item.summary) lines.push(...wrap(`Summary: ${item.summary}`, width));
      if (item.evidence) lines.push(...wrap(`Evidence: ${item.evidence}`, width));
      if (item.metrics?.length) lines.push(`Metrics: ${item.metrics.join(', ')}`);
      continue;
    }
    if (item?.url) lines.push(...wrap(`Source: ${item.label || item.type || 'URL'} ${item.url}`, width));
    else lines.push(...wrap(`Source: ${JSON.stringify(item)}`, width));
  }
  if (doc.warnings?.length) lines.push('', 'WARNINGS', ...doc.warnings.flatMap(value => wrap(String(value), width)));
  return lines;
}

function documentLines(doc, state, width, color) {
  if (!doc) return ['No documents for this job.', 'Run pursue to stage proof-grounded drafts.'];
  let lines;
  if (state.docsView === 'diff') {
    if (!doc.previousDraft) {
      lines = ['First draft — no previous draft to compare.'];
    } else {
      const rendered = renderArtifactDiff(doc.previousDraft.content, doc.content, { width, color });
      lines = [`DIFF r${doc.previousDraft.revision} → r${doc.revision} · +${rendered.added} -${rendered.removed}`, ...renderedLines(rendered)];
    }
  } else {
    lines = renderedLines(renderArtifactMarkdown(doc.content, { width, color }));
  }
  if (state.docsEvidenceExpanded) lines.push(...evidenceLines(doc, width));
  return lines;
}

function docsPanel(model, state, width, height, color) {
  const { docs, index, doc } = selectedDoc(model, state);
  const title = `DOCUMENTS · ${model.selected?.job.id || 'NO JOB'} · ${state.docsView === 'diff' ? 'DIFF' : 'DOCUMENT'}`;
  if (!doc) return panel(title, ['No documents for this job.', 'Run pursue to stage proof-grounded drafts.', '', keyHints('docs')], width, color);
  const innerWidth = Math.min(width - 4, 110);
  const content = documentLines(doc, state, innerWidth, color);
  const scroll = state.docsView === 'diff' ? state.docsDiffScroll : state.docsScroll;
  const meta = [
    docs.map((item, itemIndex) => `${itemIndex === index ? '▶' : ' '} ${item.title}`).join('  ·  '),
    `${index + 1}/${docs.length} · ${doc.title} · ${doc.approvalStatus}`,
    `${doc.path}`,
    `hash ${doc.contentHash}`,
    `history ${doc.previousDraft ? `r${doc.previousDraft.revision} → r${doc.revision}` : 'r1'}`
  ];
  const evidence = doc.evidence.length ? [`evidence ${doc.evidence.map(e => e.summary || e.proofPointId || 'unknown').join(' · ')}`] : [];
  const warnings = doc.warnings.length ? doc.warnings.map(w => `warning ${w}`) : [];
  const header = [
    ...meta,
    '',
    ...evidence,
    ...warnings,
    ...(evidence.length || warnings.length ? [''] : [])
  ];
  const footer = ['', keyHints('docs')];
  const available = Math.max(1, height - 2 - header.length - footer.length);
  const body = [
    ...header,
    ...content.slice(Math.max(0, scroll), Math.max(0, scroll) + available),
    ...footer
  ];
  return panel(title, body.slice(0, Math.max(1, height - 2)), width, color);
}

function overlayPanel(model, state, width, height, color) {
  const selected = model.selected;
  let title = String(state.overlay || 'overlay').toUpperCase();
  let body = [];
  if (state.overlay === 'setup') {
    const setup = model.onboarding;
    title = `SET UP JOBOS · ${setup?.completedRequired || 0}/${setup?.totalRequired || 7} ESSENTIAL STEPS DONE`;
    const items = setup?.steps || [];
    const required = items.filter(item => item.required);
    const requiredIndex = new Map(required.map((item, index) => [item.id, index + 1]));
    const ruler = required.map(item => {
      const selectedStep = items[state.overlayIndex]?.id === item.id;
      return selectedStep ? '[●]' : (item.status === 'complete' ? '[✓]' : '[ ]');
    }).join('─');
    const visible = visibleWindow(items, state.overlayIndex, Math.max(2, height - 13));
    body = [
      `YOUR PROGRESS  ${ruler}`,
      '✓ done · ! needs attention · optional steps can wait',
      '↑/↓ move · Enter opens · ? help',
      ...wrap(`RECOMMENDED NEXT · ${friendlySetupText(setup?.recommendedAction?.label || 'Continue guided setup')}`, width - 4),
      '',
      ...visible.items.map((item, offset) => {
        const selectedStep = visible.start + offset === state.overlayIndex;
        const marker = item.status === 'complete' ? '✓' : (item.status === 'blocked' ? '!' : '·');
        const position = item.required ? String(requiredIndex.get(item.id)) : 'later';
        const status = item.status === 'complete' ? 'done'
          : item.status === 'blocked' ? 'needs action'
            : item.status === 'optional_ready' ? 'set up'
              : item.status === 'optional_incomplete' ? 'optional'
                : ['unavailable', 'misconfigured'].includes(item.status) ? 'unavailable'
                  : 'ready';
        return `${selectedStep ? '▶' : ' '} ${marker} ${position}  ${setupStepLabel(item.id)}  ·  ${status}`;
      })
    ];
    const focused = items[state.overlayIndex];
    if (focused) {
      body.push('', `SELECTED STEP · ${setupStepLabel(focused.id)}`);
      if (focused.blockers[0]) {
        const recovery = focused.blockers[0].recovery || focused.blockers[0].remediation || focused.blockers[0].message;
        body.push(...wrap(`Do this: ${friendlySetupText(recovery)}`, width - 4).slice(0, 2));
      } else if (focused.actions[0]) {
        body.push(`ENTER · ${friendlySetupText(focused.actions[0].label)}`);
      } else {
        body.push(focused.status === 'complete' ? 'Finished. Move down to continue.' : friendlySetupText(focused.summary));
      }
    }
    body.push('', setup?.coreReady ? 'Essential setup is complete. Optional connections can wait.' : 'Finish the highlighted tasks. You can change them later.');
  } else if (state.overlay === 'setup-action-picker') {
    title = `SET UP JOBOS · CHOOSE HOW TO ${setupStepLabel(state.setupActionStepId).toUpperCase()}`;
    const items = state.setupActionItems || [];
    const visible = visibleWindow(items, state.overlayIndex, Math.max(2, height - 5));
    body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${friendlySetupText(item.label)}`);
    body.push('', '↑/↓ choose  ·  Enter continue  ·  Esc go back');
  } else if (state.overlay === 'setup-profile-picker') {
    title = 'SET UP JOBOS · CHOOSE YOUR PROFILE';
    const visible = visibleWindow(model.profiles, state.overlayIndex, Math.max(2, height - 5));
    body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.name}${state.detailsExpanded ? ` · ${item.id}` : ''}`);
    body.push('', '↑/↓ choose  ·  Enter continue  ·  Esc go back');
  } else if (state.overlay === 'setup-job-picker') {
    title = 'SET UP JOBOS · CHOOSE A JOB';
    const visible = visibleWindow(model.jobs, state.overlayIndex, Math.max(2, height - 5));
    body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.title} · ${item.company}`);
    body.push('', '↑/↓ choose  ·  Enter continue  ·  Esc go back');
  } else if (state.overlay === 'setup-resume-source') {
    title = 'SET UP JOBOS · ADD YOUR RESUME';
    body = [
      ...wrap('Choose the easiest way to bring in your resume.', width - 4),
      ...wrap('Supported: TXT, Markdown, JSON, YAML, and YML. For PDF or DOCX, copy and paste the text.', width - 4),
      '',
      ...setupChoiceRows(RESUME_SOURCE_CHOICES, state.overlayIndex, width - 4),
      '',
      '↑/↓ choose  ·  Enter continue  ·  Esc go back'
    ];
  } else if (state.overlay === 'setup-job-source') {
    title = 'SET UP JOBOS · ADD A JOB';
    body = [
      ...wrap('Add a posting now or set up discovery for later.', width - 4),
      '',
      ...setupChoiceRows(JOB_SOURCE_CHOICES, state.overlayIndex, width - 4),
      '',
      '↑/↓ choose  ·  Enter continue  ·  Esc go back'
    ];
  } else if (state.overlay === 'setup-file-browser') {
    title = `SET UP JOBOS · CHOOSE A ${state.setupFilePurpose === 'resume' ? 'RESUME' : 'JOB'} FILE`;
    const items = state.setupFileItems || [];
    const visible = visibleWindow(items, state.overlayIndex, Math.max(3, height - 8));
    body = [
      ...wrap(`Folder: ${state.setupBrowseCwd || homedir()}`, width - 4).slice(0, 2),
      state.setupFilePurpose === 'resume'
        ? 'Supported: TXT, Markdown, JSON, YAML, YML.'
        : 'Supported: TXT and Markdown.',
      `Showing ${visible.start + 1}–${visible.start + visible.items.length} of ${items.length}`,
      '',
      ...visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.quick ? 'Quick' : item.kind === 'directory' ? 'Folder' : 'File'}  ${item.label}`),
      '',
      '↑/↓ choose · Enter opens · Esc goes back'
    ];
  } else if (state.overlay === 'setup-resume-preview') {
    const preview = state.setupResumePreview || {};
    const document = preview.document || {};
    const claims = preview.claims || [];
    title = 'SET UP JOBOS · CHECK YOUR RESUME';
    body = [
      `Source: ${preview.label || 'pasted text'}`,
      `Name: ${document.identity?.name || 'not found'}  ·  Roles found: ${document.experience?.length || 0}  ·  Education: ${document.education?.length || 0}`,
      `Experience highlights found: ${claims.length}`,
      ...(preview.validation?.warnings || []).slice(0, 2).map(item => `Please check: ${friendlySetupText(item.message)}`),
      '',
      'PREVIEW',
      ...claims.slice(0, Math.max(2, height - 11)).map(item => `• ${item.summary}`),
      ...(claims.length ? [] : ['No achievement-style claims were found. You can add them after import.']),
      '',
      'Enter confirms import  ·  Esc changes the source'
    ];
  } else if (state.overlay === 'setup-proof-review') {
    const items = state.setupProofItems || [];
    const visible = visibleWindow(items, state.overlayIndex, Math.max(2, height - 7));
    title = 'SET UP JOBOS · REVIEW YOUR EXPERIENCE HIGHLIGHTS';
    body = [
      ...wrap('Confirm only claims you can support. JobOS will never invent achievements.', width - 4),
      ...wrap('Enter/V verify  ·  E edit  ·  R reject  ·  A add another  ·  Esc continue', width - 4),
      '',
      ...(items.length
        ? visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.verification_status === 'verified' ? '✓' : '!'} ${item.summary}`)
        : ['No extracted claims remain. Press A to add one in your own words.'])
    ];
  } else if (state.overlay === 'review') {
    if (model.review.length) {
      const visible = visibleWindow(model.review, state.overlayIndex, height - 5);
      body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.title} · ${item.approvalStatus} · ${item.jobId || 'no job'}`);
    } else body = ['Review queue empty.', 'Drafts stay human-gated.'];
    body.push('', keyHints('review'));
  } else if (state.overlay === 'interviews') {
    const interviews = model.interviews || {};
    const counts = interviews.counts || {};
    const application = interviews.selectedApplication;
    const pack = application?.pack;
    const debriefs = application?.debriefs?.items || [];
    const stories = interviews.stories || [];
    title = `INTERVIEWS · ${(model.profile?.name || 'NO PROFILE').toUpperCase()}`;
    body = [
      `stories ${counts.stories || 0} · verified ${counts.verified || 0} · stale ${counts.stale || 0} · draft/ineligible ${counts.draftIneligible || 0}`,
      `debriefs ${counts.debriefs || 0} · current revisions ${counts.currentDebriefRevisions || 0}`,
      application
        ? `selected application ${application.applicationId} · job ${application.jobId}`
        : 'selected application none',
      pack
        ? `pack ${pack.stage}/${pack.audience} · covered ${pack.coveredCount} · gaps ${pack.gapCount} · items ${pack.itemCount}`
        : 'pack none · run :prep <stage> [audience]',
      '',
      `STORIES (${stories.length})`
    ];
    body.push(...stories.map(story => {
      const revision = story.currentRevision;
      return `${revision.title} · ${story.id} · r${revision.revision} · ${revision.state}/${story.eligibility}`;
    }));
    const story = stories[0]?.currentRevision;
    if (story) {
      body.push(
        '',
        `STORY DETAIL · ${story.title}`,
        `S ${story.situation}`,
        `T ${story.task}`,
        `A ${story.action}`,
        `R ${story.result}`,
        `Reflection ${story.reflection}`
      );
    }
    body.push('', `SELECTED APPLICATION DEBRIEFS (${debriefs.length})`);
    if (debriefs.length) {
      body.push(...debriefs.map(debrief => (
        `${debrief.id} · r${debrief.currentRevision.revision} · ${debrief.interviewStage}/${debrief.audience} · outcome ${debrief.currentRevision.observedOutcome.type}`
      )));
      const debrief = debriefs[0].currentRevision;
      body.push(`DEBRIEF DETAIL · ${debrief.notes || 'no private notes'} · ${debrief.observedQuestions.length} observed questions`);
    } else {
      body.push('No debrief recorded for the selected application.');
    }
    body.push(
      '',
      ':interviews',
      ':prep <stage> [audience]',
      ':story-verify <story-id> <revision> | <confirmed-fields-csv>',
      ':story-retire <story-id> | <reason>',
      ':debrief <json-file>',
      ':debrief-correct <debrief-id> | <json-file> | <reason>',
      'Esc closes'
    );
  } else if (state.overlay === 'memory') {
    const memory = model.memory || {};
    const view = state.memoryView || 'observations';
    const labels = { observations: 'OBSERVATIONS', proposals: 'PROPOSALS', 'career-brief': 'CAREER BRIEF', 'voice-guide': 'VOICE GUIDE' };
    title = `CAREER MEMORY · ${labels[view]}`;
    body = [
      `Profile: ${memory.profileId || 'none'} · observations ${memory.counts?.observations || 0} · proposals ${memory.counts?.proposals || 0} · active ${memory.counts?.active || 0}`,
      '1 observations · 2 proposals · 3 career brief · 4 voice guide',
      '',
    ];
    if (view === 'observations') {
      const rows = memory.observations || [];
      const visible = visibleWindow(rows, state.overlayIndex, Math.max(3, height - 8));
      body.push(...visible.items.map((item, offset) => {
        const source = item.sourceEntity || {};
        return `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.eventType} · ${item.id} · ${source.type || 'source'}:${source.id || '—'}@${source.versionId || '—'} · private:${item.hasPrivateNote ? 'yes' : 'no'}`;
      }));
      if (!rows.length) body.push('No current observations for this profile.');
    } else if (view === 'proposals') {
      const rows = memory.proposals || [];
      const visible = visibleWindow(rows, state.overlayIndex, Math.max(3, height - 9));
      body.push(...visible.items.flatMap((item, offset) => [
        `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.id} · ${item.status} · ${item.confidenceBand}/${item.confidenceMilli} · conflict:${item.conflictState} · ${item.stale ? 'stale' : 'fresh'}`,
        `  ${item.domain}/${item.scope}/${item.ruleType} · ${item.active ? 'active' : `inactive:${item.inactiveReason}`}`,
        `  evidence ${(item.evidence || []).map(evidence => `${evidence.observationSchema}:${evidence.observationId}@${evidence.sourceEntity?.versionId || '—'}`).join(', ') || 'none'}`,
      ]));
      if (!rows.length) body.push('No proposals for this profile.');
      body.push('', ':memory accept <proposal-id>', ':memory reject <proposal-id> | <reason>', ':memory revoke <proposal-id> | <reason>', ':memory undo <transition-id> | <reason>');
    } else if (view === 'career-brief') {
      const brief = memory.careerBrief;
      body.push(
        `source state ${brief?.sourceStateHash || '—'} · revision ${brief?.revision ?? 'live'}`,
        `targets ${JSON.stringify(brief?.canonicalTargets || {})}`,
        `active guidance ${(brief?.activeGuidance || []).map(item => item.ruleId).join(', ') || 'none'}`,
        `citations ${(brief?.citations || []).length}`,
        ...(brief?.citations || []).slice(0, 4).map(citation => `  ${citation.sourceKind}:${citation.sourceId}@${citation.sourceVersionId || '—'}`),
      );
    } else {
      const guide = memory.voiceGuide;
      body.push(
        `source state ${guide?.sourceStateHash || '—'} · revision ${guide?.revision ?? 'live'}`,
        `baseline ${JSON.stringify(guide?.baseline || {})}`,
        `active rules ${(guide?.activeRuleIds || []).join(', ') || 'none'}`,
        `citations ${(guide?.citations || []).length} · proofs remain factual authority`,
        ...(guide?.citations || []).slice(0, 4).map(citation => `  ${citation.sourceKind}:${citation.sourceId}@${citation.sourceVersionId || '—'}`),
      );
    }
    body.push('', `${keyHints('memory')} · :memory refresh`);
  } else if (state.overlay === 'log') {
    if (model.log.length) {
      const visible = visibleWindow(model.log, state.overlayIndex, Math.max(3, height - 9));
      body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.createdAt.slice(0, 19)} ${item.action} ${item.entityType}:${item.entityId} (${item.externalSideEffect})`);
      const current = model.log[state.overlayIndex];
      body.push('', `payload ${JSON.stringify(current?.payload || {})}`);
    } else body = ['No audit events yet.'];
    body.push('', 'j/k scroll · payloads are secret-redacted · Esc closes');
  } else if (state.overlay === 'network') {
    title = `NETWORK · ${selected?.job.company || 'NO JOB'}`;
    const ns = model.networkSetup || {};
    const run = selected?.latestJobRun || ns.latestProfileRun;
    const xaiState = ns.xaiState || 'off';
    body = [];
    if (run) {
      const budget = run.budget || {};
      const usage = run.usage || {};
      body.push(`Run: ${run.id?.slice(0, 12)} · ${run.status}`);
      body.push(`Budget: q=${budget.maxQueries || '—'} c=${budget.maxCandidates || '—'} ms=${budget.maxDurationMs || '—'}`);
      body.push(`Usage: ${usage.queries || 0}q ${usage.modelCalls || 0}mc ${usage.sourceChars || 0}ch`);
      if (run.warnings?.length) body.push(...run.warnings.map(w => `warning: ${w}`));
      if (run.error) body.push(`error: ${run.error}`);
      body.push(`xAI: ${xaiState}${xaiState === 'available' ? '' : ' · never key'}`);
    } else {
      body.push('No research run yet.', 'Open build-network (b) to set up and start research.');
    }
    if (selected?.path) {
      body.push('', `Path: ${selected.path.strength} · ${selected.path.channel || '—'}`);
      body.push(...wrap(JSON.stringify(selected.path.reasoning), width - 4).slice(0, 2));
    }
    const contactItems = networkOverlayItems(model);
    if (contactItems.length) {
      body.push('', `Contacts & candidates · human gates (${contactItems.length}):`);
      const visible = visibleWindow(contactItems, state.overlayIndex, Math.max(3, height - body.length - 4));
      body.push(...visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${fit(item.label, width - 4)}`));
    } else {
      body.push('', 'No discovered contacts yet — b build-network, then m map/refresh.');
    }
    body.push('', keyHints('network'));
  } else if (state.overlay === 'docs') {
    return docsPanel(model, state, width, height, color);
  } else if (state.overlay === 'answers') {
    title = `ANSWERS · ${model.profileId || 'NO PROFILE'}`;
    body = [
      `verified reusable answers: ${model.answers.verified}`,
      `restricted answers hidden/blocked: ${model.answers.restricted}`,
      '',
      'Agent and TUI use answers_match only with explicit application questions.',
      'Restricted values are never displayed or auto-filled.'
    ];
    const openQuestions = model.answers.questions || [];
    if (openQuestions.length) {
      body.push('', `Open questions for the selected job (${openQuestions.length}):`);
      body.push(...openQuestions.slice(0, Math.max(1, height - body.length - 4)).map(q =>
        fit(`${q.status === 'blocked' ? '⚠' : '·'} [${q.category}] ${q.question}${q.status === 'blocked' ? ' · restricted — direct input required' : ' · unmatched'}`, width - 4)));
      body.push('', ':answer add [category] | <exact question> | <your answer>');
    }
  } else if (state.overlay === 'due') {
    title = 'DUE · tasks';
    const tasks = dueOverlayTasks(model, state);
    body = [`Filter: ${TASK_FILTERS.map((filter, index) => `${index + 1} ${filter === state.taskFilter ? `[${filter}]` : filter}`).join(' · ')}`];
    if (tasks.length) {
      body.push(`TASKS (${tasks.length}):`);
      const visible = visibleWindow(tasks, state.overlayIndex, Math.max(3, height - 10));
      body.push(...visible.items.map((task, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${String(task.dueAt).slice(0, 10)} · [${task.type || 'task'}/${task.source || 'system'}] ${task.title}${task.jobId ? ` · ${task.jobId}` : ' · no job'}`));
    } else {
      body.push('No tasks due for this filter.');
    }
    body.push('', keyHints('due'), 'Enter jumps to the selected task’s job');
  } else if (state.overlay === 'discovery') {
    body = [
      'SAVED SEARCHES / RUNS',
      ...model.discovery.searches.map(item => `${item.name || item.id} · ${item.adapter} · last ${item.lastRunAt || item.last_run_at || 'never'}`),
      ...model.discovery.runs.slice(0, 8).map(item => `${item.startedAt || '—'} · ${item.actionId || 'run'} · ${item.status}${item.error ? ` · ${item.error}` : ''}`),
      '',
      'NEW JOB REVIEW',
      ...model.discovery.queue.map(item => `${item.id === state.selectedDiscoveryJobId ? '▶' : ' '} ${item.title} · ${item.company} · posting ${item.postingLiveness?.status || 'uncertain'} · fit ${fitLabel(item.fit)}${item.highFit ? ' · high' : ''}`)
    ];
    if (!model.discovery.searches.length && !model.discovery.runs.length) body.splice(1, 0, 'No discovery searches configured.');
    if (!model.discovery.queue.length) body.push('No new jobs awaiting review.');
    body.push('', keyHints('discovery'));
  } else if (state.overlay === 'help') {
    const context = state.helpContextOverlay || 'dashboard';
    const scope = context === 'dashboard' ? 'global'
      : context.startsWith('setup') ? 'setup'
        : (TUI_KEYMAP[context] ? context : 'global');
    const setupItem = model.onboarding?.steps?.[state.helpContextIndex || 0];
    title = state.helpFull ? 'HELP · ALL SHORTCUTS' : `HELP · ${context === 'dashboard' ? 'DASHBOARD' : setupStepLabel(context.replace(/^setup-/, ''))}`;
    body = state.helpFull
      ? Object.entries(TUI_KEYMAP).flatMap(([name, bindings]) => [
          name.toUpperCase(),
          ...wrap(bindings.map(([key, label]) => `${key} ${label}`).join('  ·  '), width - 4),
          ''
        ])
      : [
          'RECOMMENDED NEXT ACTION',
          ...(context.startsWith('setup') && setupItem
            ? setupRecommendation(setupItem, width - 4)
            : ['Use ↑/↓ to choose an item, then press Enter.']),
          '',
          'CONTROLS FOR THIS SCREEN',
          ...wrap(keyHints(scope), width - 4),
          '',
          'Press ? again to see every shortcut  ·  Esc returns'
        ];
  } else if (state.overlay === 'system') {
    body = [
      ...state.catalog.map(item => `${item.name} · ${item.available ? 'available' : 'unavailable'} · ${item.protocol} · ${item.role}`),
      'browser · optional/unavailable is honest on headless VPS',
      `side-effects · ${model.policy.sideEffects}`,
      `drafts · ${model.policy.drafts}`,
      '',
      'PRIMARY CONTROLS',
      ...wrap(keyHints('global'), width - 4),
      '',
      'c reconnect ACP · x cancel turn · Esc closes'
    ];
  } else if (state.overlay === 'profile') {
    if (model.profiles.length) {
      const visible = visibleWindow(model.profiles, state.overlayIndex, height - 5);
      body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.name}${state.detailsExpanded ? ` · ${item.id}` : ''}`);
    } else body = ['No profiles yet.', 'Create one through the CLI.'];
    body.push('', 'j/k select · Enter switches · Esc closes');
  } else if (state.overlay === 'build-network') {
    const items = overlayItems(model, state);
    if (!items.length || (items.length === 1 && items[0].type === 'static')) {
      body = ['No profile selected.', 'Create a profile first.'];
    } else {
      const visible = visibleWindow(items, state.overlayIndex, Math.max(3, height - 7));
      body = visible.items.map((item, offset) => {
        const idx = visible.start + offset;
        const selected = idx === state.overlayIndex;
        const prefix = selected ? '▶' : ' ';
        if (item.type === 'separator') return '';
        if (item.type === 'toggle') {
          const mark = item.value === 'on' ? '[x]' : '[ ]';
          return `${prefix} ${item.label}: ${mark}`;
        }
        if (item.type === 'action') return `${prefix} ${item.label} — ${item.value}`;
        return `${prefix} ${item.label}: ${item.value}`;
      });
      const profileId = model.profileId || '—';
      const scope = state.selectedJobId ? `job:${state.selectedJobId?.slice(0, 8)}` : 'profile';
      body.push('', `Profile: ${profileId} · Proposed scope: ${scope}`);
      if (state.mode === 'build-network-field') {
        body.push(`editing: ${state.networkDraft?._editingKey || ''} > ${editableInput(state, color)}`);
        body.push('Left/Right, Home/End, Shift+arrows, Delete · Enter saves · Esc cancels');
      } else {
        body.push('↑/↓ or j/k move · Enter edits/selects · b saves and builds · Esc closes');
      }
    }
  } else if (state.overlay === 'packet') {
    title = `PACKET · ${selected?.job.id || 'NO JOB'}`;
    const detail = state.packetDetail;
    const meta = selected?.readiness?.packet;
    if (detail?.empty || (!detail && !meta?.currentPacketId)) {
      body = [
        'No application packet is frozen for this job.',
        'Freeze one once readiness is approved:',
        ':packet create',
        `CLI parity: jobos apply packet create --job ${selected?.job.id || '<job-id>'} --profile ${model.profileId || '<profile-id>'} --json`,
        '',
        'Then inspect/fill/checkpoint with :form, submit manually or through separately configured :form submit, and record receipt evidence.'
      ];
    } else {
      const row = detail && !detail.empty ? detail : meta;
      body = [
        `id ${row.id || row.currentPacketId || '—'}`,
        `currency ${row.currency || '—'} · receipt ${row.receiptState || '—'}`,
        `attempt ${row.attemptNumber ?? '—'} · revision ${row.revision ?? '—'}`,
        `contentHash ${String(row.contentHash || '').slice(0, 16) || '—'}…`,
        `attestable ${row.attestable == null ? '—' : row.attestable}`,
        row.resumeArtifactId ? `resume ${row.resumeArtifactId}` : (meta ? `packet summary from readiness` : ''),
        row.applicationId ? `application ${row.applicationId}` : '',
        '',
        packetCtaLine(row),
        'Esc closes · :form inspect/assist/checkpoint/submit runs the packet-bound bridge · :attest/:receipt record manual evidence'
      ].filter(Boolean);
    }
    body.push('', 'Esc closes');
  }
  const setupModal = String(state.overlay || '').startsWith('setup');
  const box = setupModal ? modalPanel : panel;
  const visibleBody = setupModal
    ? body.flatMap(line => wrap(line, width - 2)).slice(0, Math.max(1, height - 2))
    : body.slice(0, Math.max(1, height - 2));
  return box(title, visibleBody, width, color);
}

function footerLines(width, state) {
  if (state.focusTarget === 'details') {
    if (width >= 90) {
      return [
        ' DETAILS FOCUSED · ↑/↓ or j/k scroll · PgUp/PgDn page · e hide · Esc jobs · Tab chat',
        ' g setup · ? help · Q quit'
      ];
    }
    return [
      ' DETAILS FOCUSED · ↑/↓ scroll · e hide · Esc jobs',
      ' Tab chat · g setup · ? help · Q quit'
    ];
  }
  if (state.focusTarget === 'agent') {
    if (width >= 90) {
      return [
        ' CHAT FOCUSED · ↑/↓ or j/k scroll · i type · x cancel · c reconnect · Tab/Esc dashboard · ? help · Q quit'
      ];
    }
    return [
      ' CHAT · ↑/↓ scroll · i type · x cancel',
      ' Tab/Esc dashboard · c reconnect · Q quit'
    ];
  }
  if (width >= 120) {
    return [
      ' ↑/↓ or j/k jobs · ←/→ priority · Enter jump · Tab focus chat · i prompt · p pursue · d discover',
      ' r review · o documents · g setup · ? help · Q quit'
    ];
  }
  if (width >= 90) {
    return [
      ' ↑/↓ or j/k jobs · ←/→ priority · Enter jump · Tab chat · i prompt · p pursue',
      ' d discover · r review · o docs · g setup · ? help · Q quit'
    ];
  }
  return [
    ' ↑/↓ jobs · ←/→ next · Enter open · Tab chat',
    ' i ask · p pursue · g setup · ? help · Q quit'
  ];
}
export function renderTui(model, state, { width = 140, height = 42, color = false } = {}) {
  const measuredWidth = Math.max(1, Math.floor(Number(width) || 140));
  const measuredHeight = Math.max(1, Math.floor(Number(height) || 42));
  if (measuredWidth < 60 || measuredHeight < 20) {
    const resize = [
      'JobOS needs a larger terminal.',
      `Current: ${measuredWidth}×${measuredHeight} · minimum: 60×20`,
      'Resize the window; your workspace is unchanged.'
    ];
    return resize.slice(0, measuredHeight).map(line => fit(line, measuredWidth)).join('\n');
  }
  const safeWidth = measuredWidth;
  const safeHeight = measuredHeight;
  const inputModes = new Set([
    'command', 'review-note', 'stage-note', 'docs-search', 'suppress-reason',
    'setup-profile', 'setup-file', 'setup-proof', 'setup-calibration',
    'setup-resume-path', 'setup-resume-paste', 'setup-job-path', 'setup-job-paste',
    'setup-job-url', 'setup-discovery'
  ]);
  const setupWorkspace = String(state.overlay || '').startsWith('setup')
    || (state.overlay === 'help' && String(state.helpContextOverlay || '').startsWith('setup'));
  const extraPrompt = inputModes.has(state.mode) || state.mode === 'stage' || Boolean(state.pendingConfirm);
  if (setupWorkspace) {
    const setupFooters = safeWidth >= 76
      ? [' ↑/↓ choose  ·  Enter continue  ·  ? help  ·  Esc back  ·  Q quit']
      : [' ↑/↓ choose  ·  Enter continue  ·  Esc back', ' ? help  ·  Q quit'];
    const promptLines = state.pendingConfirm
      ? ['Review this action · Enter/y confirms · n/Esc cancels']
      : inputModes.has(state.mode)
        ? (() => {
            const labels = {
              'setup-profile': 'Your name',
              'setup-file': 'Local file path',
              'setup-resume-path': 'Resume file path',
              'setup-resume-paste': 'Resume text',
              'setup-job-path': 'Job file path',
              'setup-job-paste': 'Job description',
              'setup-job-url': 'Job URL',
              'setup-discovery': 'Company | careers page URL',
              'setup-proof': 'Highlight | supporting source',
              'setup-calibration': 'Preference details'
            };
            return wrap(`${labels[state.mode] || 'Input'}: ${editableInput(state, color)}`, safeWidth).slice(0, 2);
          })()
        : [];
    const statusLines = wrap(friendlySetupText(state.status || 'ready'), safeWidth).slice(0, 2);
    const trailingRows = setupFooters.length + promptLines.length + statusLines.length;
    const bodyHeight = Math.max(4, safeHeight - trailingRows - 2);
    const compactHeader = safeWidth < 76;
    const panelWidths = new Set(['setup-resume-source', 'setup-job-source', 'setup-action-picker', 'setup-profile-picker', 'setup-job-picker']);
    const preferredWidth = panelWidths.has(state.overlay) ? 82
      : ['setup-file-browser', 'setup-resume-preview', 'setup-proof-review'].includes(state.overlay) ? 104 : 96;
    const panelWidth = Math.min(safeWidth, preferredWidth);
    const setupPanel = overlayPanel(model, state, panelWidth, bodyHeight, color);
    const lines = [
      paint(fit(compactHeader ? ' JOBOS / GUIDED SETUP · LOCAL & PRIVATE ' : ' JOBOS  /  GUIDED SETUP · LOCAL AND PRIVATE ', safeWidth), 'header', color),
      paint(fit(compactHeader ? ' One clear task at a time. ' : ' One clear task at a time. Your dashboard waits behind this screen. ', safeWidth), 'muted', color),
      ...centeredSurface(setupPanel, safeWidth, bodyHeight, color),
      ...promptLines.map(line => paint(fit(line, safeWidth), state.pendingConfirm ? 'warn' : 'selected', color)),
      ...statusLines.map(line => paint(fit(line, safeWidth), state.error ? 'bad' : 'muted', color)),
      ...setupFooters.map(footer => paint(fit(footer, safeWidth), 'header', color))
    ];
    return lines.slice(0, safeHeight).join('\n');
  }
  const footers = footerLines(safeWidth, state);
  const emptyDashboard = !state.overlay && (model.empty.noProfile || model.empty.noJobs);
  const lines = [headerLine(model, state, safeWidth, color), ...(emptyDashboard ? [] : priorityLines(model, state, safeWidth, color))];
  const trailingRows = footers.length + 1 + (extraPrompt ? 1 : 0);
  const bodyHeight = Math.max(4, safeHeight - lines.length - trailingRows);
  if (emptyDashboard) {
    lines.push(...welcomePanel(model, safeWidth, bodyHeight, color));
  } else if (state.overlay === 'docs' && safeWidth >= 116) {
    const sideWidth = Math.max(38, Math.floor(safeWidth * 0.36));
    const docsWidth = safeWidth - sideWidth - 1;
    const side = state.agentOn
      ? agentPanel(model, state, sideWidth, bodyHeight, color)
      : fixedPanel('ASSISTANT', ['Assistant is off.', '', 'Press a from the dashboard to enable it.'], sideWidth, bodyHeight, color);
    lines.push(...mergeColumns([
      side,
      docsPanel(model, state, docsWidth, bodyHeight, color)
    ], [sideWidth, docsWidth], color));
  } else if (state.overlay) {
    lines.push(...overlayPanel(model, state, safeWidth, bodyHeight, color));
  } else if (state.agentOn && state.focusTarget === 'agent') {
    if (safeWidth >= 90) {
      const contextWidth = Math.max(34, Math.floor(safeWidth * 0.3));
      const agentWidth = safeWidth - contextWidth - 1;
      lines.push(...mergeColumns([
        detailPanel(model, state, contextWidth, bodyHeight, color),
        agentPanel(model, state, agentWidth, bodyHeight, color)
      ], [contextWidth, agentWidth], color));
    } else {
      lines.push(...agentPanel(model, state, safeWidth, bodyHeight, color));
    }
  } else if (safeWidth >= 90) {
    const listWidth = Math.max(42, Math.floor(safeWidth * 0.44));
    const detailWidth = safeWidth - listWidth - 1;
    const contentHeight = naturalDashboardHeight(model, state, listWidth, detailWidth, bodyHeight, color);
    lines.push(...mergeColumns([
      listPanel(model, state, listWidth, contentHeight, color),
      detailPanel(model, state, detailWidth, contentHeight, color)
    ], [listWidth, detailWidth], color));
  } else {
    const listHeight = state.detailsExpanded
      ? Math.max(5, Math.min(Math.floor(bodyHeight * 0.36), bodyHeight - 9))
      : naturalListPanelHeight(model, state, safeWidth, Math.max(5, bodyHeight - 7));
    const detailHeight = state.detailsExpanded
      ? bodyHeight - listHeight
      : naturalDetailPanelHeight(model, state, safeWidth, bodyHeight - listHeight, color);
    lines.push(...listPanel(model, state, safeWidth, listHeight, color));
    lines.push(...detailPanel(model, state, safeWidth, detailHeight, color));
  }
  while (lines.length < safeHeight - trailingRows) lines.push(fit('', safeWidth));

  if (state.pendingConfirm) {
    const guided = String(state.pendingConfirm.kind || '').startsWith('setup-');
    lines.push(paint(fit(guided ? 'Guided trusted action · y/Enter confirm · n/Esc cancel' : 'Discard unsent review feedback? y/Enter confirm · n/Esc keep editing', safeWidth), 'warn', color));
  } else if (state.mode === 'stage') {
    lines.push(paint(fit(`Stage: ${stageOrder[state.stageIndex] || 'invalid'} · ${keyHints('stage')}`, safeWidth), 'green', color));
  } else if (inputModes.has(state.mode)) {
    const labels = { command: state.commandPrefix || ':', 'review-note': 'Reject feedback', 'stage-note': 'Stage note (optional)', 'docs-search': 'Search', 'suppress-reason': 'Suppress reason (optional)' };
    lines.push(paint(fit(`${labels[state.mode] || 'Input'}: ${editableInput(state, color)}`, safeWidth), 'selected', color));
  }
  lines.push(paint(fit(crop(state.status || 'ready', safeWidth), safeWidth), state.error ? 'bad' : 'muted', color));
  lines.push(...footers.map(footer => paint(fit(footer, safeWidth), 'green', color)));
  return lines.slice(0, safeHeight).join('\n');
}
export function defaultTuiState() {
  return {
    filter: 'today',
    selectedJobId: null,
    selectedArtifactId: null,
    profileId: null,
    selectedDiscoveryJobId: null,
    agentOn: true,
    agentState: 'connecting',
    sessionId: null,
    overlay: null,
    overlayIndex: 0,
    taskFilter: 'all',
    docsScroll: 0,
    docsDiffScroll: 0,
    docsQuery: '',
    docsMatchIndex: 0,
    docsView: 'document',
    detailsScroll: 0,
    docsEvidenceExpanded: false,
    detailsExpanded: false,
    focusTarget: 'shell',
    agentScroll: 0,
    pendingAutoOpenArtifactId: null,
    editorActive: false,
    stageIndex: 0,
    stripIndex: 0,
    pendingConfirm: null,
    pendingSuppressContactId: null,
    setupActionItems: [],
    setupActionStepId: null,
    setupProofId: null,
    setupProofItems: [],
    setupFileItems: [],
    setupFilePurpose: null,
    setupBrowseCwd: null,
    setupResumePreview: null,
    setupJobPreview: null,
    helpContextOverlay: null,
    helpContextIndex: 0,
    helpFull: false,
    helpReturnMode: 'normal',
    packetDetail: null,
    mode: 'normal',
    commandPrefix: ':',
    input: '',
    inputCursor: null,
    inputAnchor: null,
    status: 'Ready · local workspace',
    error: null,
    busy: null,
    messages: [],
    catalog: [],
    networkDraft: null,
    memoryView: 'observations'
  };
}

export class JobosTui {
  constructor(store, {
    stdin = process.stdin,
    stdout = process.stdout,
    profileId = null,
    selectedJobId = null,
    initialOverlay = null,
    connectAgent = true,
    mouse = false,
    color = stdout.isTTY,
    now = () => new Date()
  } = {}) {
    this.store = store;
    this.stdin = stdin;
    this.stdout = stdout;
    this.now = now;
    this.state = { ...defaultTuiState(), profileId, setupProfileId: profileId, setupJobId: selectedJobId };
    this.model = buildTuiModel(store, { profileId, selectedJobId, at: this.now().toISOString() });
    this.state.selectedJobId = selectedJobId || this.model.selectedJobId;
    this.state.overlay = initialOverlay || (this.model.empty.noProfile ? 'setup' : null);
    if (this.state.overlay === 'setup') this.state.overlayIndex = firstActionableSetupIndex(this.model.onboarding);
    this.shouldConnectAgent = connectAgent;
    this.mouseEnabled = Boolean(mouse);
    this.color = Boolean(color);
    this.client = null;
    this.sessionPersistence = Promise.resolve();
    this.refreshTimer = null;
    this.boundKeypress = (value, key) => this.onKeypress(value, key);
    this.boundMouseData = chunk => this.onMouseData(chunk);
    this.boundRawInput = chunk => this.onRawInput(chunk);
    this.boundResize = () => this.render();
    this.stopped = false;
    this.notedArtifactIds = new Set();
    this.parseEditorCommand = parseEditorCommand;
    this.lastScreen = null;
    this.keypressInput = null;
    this.mouseInputBuffer = '';
  }
  selectedDocument() {
    const docs = this.model.selected?.docs || [];
    return docs[this.state.overlayIndex] || null;
  }

  syncDocumentSelection() {
    const docs = this.model.selected?.docs || [];
    const index = docs.findIndex(item => item.id === this.state.selectedArtifactId);
    if (index >= 0) this.state.overlayIndex = index;
    else if (docs.length) {
      this.state.overlayIndex = Math.min(this.state.overlayIndex, docs.length - 1);
      this.state.selectedArtifactId = docs[this.state.overlayIndex].id;
    } else {
      this.state.overlayIndex = 0;
      this.state.selectedArtifactId = null;
    }
  }

  dimensions() {
    return {
      width: this.stdout.columns || 140,
      height: this.stdout.rows || 42,
      color: this.color
    };
  }

  setInput(value = '') {
    this.state.input = String(value);
    this.state.inputCursor = this.state.input.length;
    this.state.inputAnchor = null;
  }

  focusNextSetupAction() {
    this.state.overlayIndex = firstActionableSetupIndex(this.model.onboarding);
    return this.state.overlayIndex;
  }

  openHelp() {
    if (this.state.overlay === 'help') {
      this.state.helpFull = !this.state.helpFull;
      this.render();
      return true;
    }
    this.state.helpContextOverlay = this.state.overlay || 'dashboard';
    this.state.helpContextIndex = this.state.overlayIndex;
    this.state.helpReturnMode = this.state.mode;
    this.state.overlay = 'help';
    this.state.helpFull = false;
    this.state.mode = 'normal';
    this.state.status = 'Help for this screen · ? shows every shortcut · Esc returns';
    this.render();
    return true;
  }

  closeHelp() {
    this.state.overlay = this.state.helpContextOverlay === 'dashboard' ? null : this.state.helpContextOverlay;
    this.state.overlayIndex = this.state.helpContextIndex || 0;
    this.state.mode = this.state.helpReturnMode || 'normal';
    this.state.helpFull = false;
    this.render();
    return true;
  }

  setupFiles(directory = this.state.setupBrowseCwd || homedir(), purpose = this.state.setupFilePurpose) {
    const supported = purpose === 'resume' ? RESUME_FILE_EXTENSIONS : JOB_FILE_EXTENSIONS;
    const resolved = path.resolve(directory);
    const entries = readdirSync(resolved, { withFileTypes: true })
      .filter(entry => !entry.name.startsWith('.'))
      .map(entry => ({
        id: path.join(resolved, entry.name),
        label: entry.name,
        kind: entry.isDirectory() ? 'directory' : 'file',
        supported: entry.isDirectory() || supported.has(path.extname(entry.name).toLowerCase())
      }))
      .filter(entry => entry.kind === 'directory' || entry.supported)
      .sort((left, right) => left.kind === right.kind ? left.label.localeCompare(right.label) : (left.kind === 'directory' ? -1 : 1));
    const home = homedir();
    const quickLocations = [
      { id: home, label: 'Home' },
      { id: path.join(home, 'Documents'), label: 'Documents' },
      { id: path.join(home, 'Downloads'), label: 'Downloads' },
      { id: process.cwd(), label: 'Working directory' }
    ]
      .filter(item => existsSync(item.id))
      .map(item => ({ ...item, kind: 'directory', supported: true, quick: true }));
    if (path.dirname(resolved) !== resolved) entries.unshift({ id: path.dirname(resolved), label: '..', kind: 'directory', supported: true });
    entries.unshift(...quickLocations);
    this.state.setupBrowseCwd = resolved;
    this.state.setupFileItems = entries;
    this.state.overlayIndex = 0;
    return entries;
  }

  refreshSetupProofItems() {
    const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
    this.state.setupProofItems = profileId
      ? listProofs(this.store, profileId).filter(item => item.status === 'active' && item.verification_status !== 'rejected')
      : [];
    this.state.overlayIndex = Math.min(this.state.overlayIndex, Math.max(0, this.state.setupProofItems.length - 1));
    return this.state.setupProofItems;
  }

  toggleAgentFocus() {
    if (this.state.overlay) return false;
    if (this.state.focusTarget === 'agent') {
      this.state.focusTarget = 'shell';
      this.state.status = 'Dashboard focus restored.';
    } else {
      this.state.agentOn = true;
      this.state.focusTarget = 'agent';
      this.state.status = 'Chat focused · Tab or Esc returns to the dashboard.';
      if (!this.client && this.shouldConnectAgent) void this.connectAgent();
    }
    this.render();
    return true;
  }

  scrollAgent(delta) {
    this.state.agentScroll = Math.max(0, (this.state.agentScroll || 0) + delta);
    this.state.status = this.state.agentScroll ? `Chat history · ${this.state.agentScroll} lines from latest` : 'Chat history · latest';
    this.render();
    return true;
  }

  scrollDetails(delta) {
    const section = this.lastFrame?.sections?.details;
    const scrollMax = Math.max(0, Number(section?.scrollMax || 0));
    this.state.detailsScroll = Math.max(0, Math.min(scrollMax, Number(this.state.detailsScroll || 0) + delta));
    this.state.status = this.state.detailsScroll
      ? `Technical details · row ${this.state.detailsScroll + 1}`
      : 'Technical details · top';
    this.render();
    return true;
  }

  leaveDetailsFocus() {
    this.state.focusTarget = 'shell';
    this.state.status = 'Dashboard job navigation restored · e returns to technical details.';
    this.render();
    return true;
  }

  onRawInput(chunk) {
    const { segments, remainder } = splitRawInput(`${this.mouseInputBuffer}${String(chunk || '')}`);
    this.mouseInputBuffer = remainder;
    for (const segment of segments) {
      if (segment.type === 'mouse') this.onMouseData(segment.value);
      else this.keypressInput?.write(segment.value);
    }
  }

  onMouseData(chunk) {
    for (const event of parseSgrMouse(chunk)) {
      const frame = this.lastFrame;
      const details = frame?.sections?.details;
      const overDetails = Boolean(details
        && event.y >= details.y && event.y <= details.bottom
        && event.x >= details.x && event.x < details.x + details.width);
      if (event.button === 64 || event.button === 65) {
        const delta = event.button === 64 ? -1 : 1;
        if (this.state.overlay && overlayItems(this.model, this.state).length) {
          const items = overlayItems(this.model, this.state);
          this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + delta));
          this.render();
        } else if (this.state.focusTarget === 'agent') {
          this.scrollAgent(event.button === 64 ? 3 : -3);
        } else if (this.state.detailsExpanded && overDetails) {
          this.state.focusTarget = 'details';
          this.scrollDetails(delta * 3);
        } else {
          if (this.state.focusTarget === 'details') this.state.focusTarget = 'shell';
          this.moveSelection(delta);
        }
        continue;
      }
      if (!event.pressed || event.button !== 0) continue;
      const overlayHit = frame?.overlayHits?.find(hit => (
        hit.y === event.y && event.x >= hit.x && event.x < hit.x + hit.width
      ));
      if (this.state.overlay && overlayHit) {
        if (overlayHit.discoveryJobId) {
          this.state.selectedDiscoveryJobId = overlayHit.discoveryJobId;
        } else {
          this.state.overlayIndex = overlayHit.index;
          if (this.state.overlay === 'docs') this.setSelectedArtifact(overlayHit.id, { reset: false });
        }
        this.onKeypress('', { name: 'return' });
        continue;
      }
      const filterHit = frame?.filterHits?.find(hit => event.y === hit.y && event.x >= hit.x && event.x < hit.x + hit.width);
      if (filterHit) {
        if (filterHit.kind === 'due') {
          this.state.taskFilter = filterHit.filter;
          this.state.overlayIndex = 0;
          this.render();
        } else if (filterHit.kind === 'memory') {
          this.state.memoryView = filterHit.filter;
          this.state.overlayIndex = 0;
          this.render();
        } else {
          this.state.focusTarget = 'shell';
          this.state.filter = filterHit.filter;
          this.refresh({ disk: false });
        }
        continue;
      }
      if (this.state.overlay) continue;
      if (this.state.detailsExpanded && overDetails) {
        this.state.focusTarget = 'details';
        this.state.status = 'Technical details focused · ↑/↓ or mouse wheel scrolls; Esc restores job navigation.';
        this.render();
        continue;
      }
      const priority = frame?.sections?.priority;
      if (priority && event.y >= priority.y && event.y <= priority.bottom) {
        this.jumpToStripJob();
        continue;
      }
      if (frame?.sections.footer && event.y >= frame.sections.footer.y) {
        const footerIndex = event.y - frame.sections.footer.y;
        const footer = frame.sections.footer.lines[footerIndex] || '';
        if (footer.includes('Tab')) this.toggleAgentFocus();
        continue;
      }
      const jobHit = frame?.sections.jobs?.hits?.find((hit, index, hits) => {
        const nextY = hits[index + 1]?.y ?? frame.sections.jobs.bottom;
        return event.y >= hit.y && event.y < nextY;
      });
      if (jobHit && this.state.focusTarget !== 'agent') {
        this.selectJobInMainList(jobHit.id, `Selected ${jobHit.title}.`);
        continue;
      }
    }
  }

  render() {
    if (this.stopped || this.state.editorActive) return false;
    const dimensions = this.dimensions();
    const previousDimensions = this.lastRenderDimensions;
    const screen = renderTui(this.model, this.state, dimensions);
    const plain = stripAnsiText(screen).split('\n');
    const jobsY = plain.findIndex(line => line.includes('┌ JOBS'));
    const jobsBottom = jobsY < 0 ? -1 : plain.findIndex((line, index) => index > jobsY && line.startsWith('└'));
    const detailsY = plain.findIndex(line => line.includes('┌ SELECTED JOB'));
    const detailsX = detailsY < 0 ? -1 : plain[detailsY].indexOf('┌ SELECTED JOB');
    const detailsRight = detailsX < 0 ? -1 : plain[detailsY].indexOf('┐', detailsX);
    const detailsBottom = detailsY < 0 || detailsX < 0
      ? -1
      : plain.findIndex((line, index) => index > detailsY && line[detailsX] === '└');
    const detailsRange = detailsY < 0 ? null : plain[detailsY].match(/rows (\d+)-(\d+)\/(\d+)/);
    const detailsSection = detailsY < 0 ? null : {
      y: detailsY,
      x: detailsX,
      width: Math.max(1, (detailsRight < 0 ? dimensions.width : detailsRight + 1) - detailsX),
      bottom: detailsBottom < 0 ? dimensions.height - 1 : detailsBottom,
      scrollMax: detailsRange ? Math.max(0, Number(detailsRange[3]) - (Number(detailsRange[2]) - Number(detailsRange[1]) + 1)) : 0
    };
    const jobs = filteredJobs(this.model, this.state.filter);
    const hits = jobsY < 0 ? [] : jobs.map(job => ({
      id: job.id,
      title: job.title,
      y: plain.findIndex((line, index) => index > jobsY && (jobsBottom < 0 || index < jobsBottom) && line.includes(job.title))
    })).filter(hit => hit.y >= 0);
    const currentOverlayItems = this.state.overlay === 'discovery'
      ? this.model.discovery.queue
      : overlayItems(this.model, this.state);
    const termFor = item => {
      if (this.state.overlay === 'setup') return setupStepLabel(item.id);
      if (this.state.overlay === 'setup-action-picker') return friendlySetupText(item.label);
      if (this.state.overlay === 'setup-file-browser') return item.label;
      if (this.state.overlay === 'setup-proof-review') return item.summary;
      if (this.state.overlay === 'network') return crop(item.label, 24);
      if (this.state.overlay === 'build-network') return item.label;
      return item.title || item.name || item.summary || item.label || item.id || item.entityId || '';
    };
    const overlayHits = currentOverlayItems.map((item, index) => {
      const term = termFor(item);
      const y = term ? plain.findIndex(line => line.includes(term)) : -1;
      const x = y < 0 ? -1 : plain[y].indexOf(term);
      return {
        index,
        id: item.id,
        discoveryJobId: this.state.overlay === 'discovery' ? item.id : null,
        label: term,
        y,
        x,
        width: Math.max(1, term.length)
      };
    }).filter(hit => hit.y >= 0 && hit.x >= 0);
    const dashboardFilterHits = FILTERS.map(filter => {
      const label = dashboardFilterLabel(filter);
      const y = plain.findIndex((line, index) => index > jobsY && (jobsBottom < 0 || index < jobsBottom) && line.includes(label));
      return {
        kind: 'dashboard',
        filter,
        y,
        x: y < 0 ? -1 : plain[y].indexOf(label),
        width: label.length
      };
    }).filter(hit => hit.y >= 0 && hit.x >= 0);
    const overlayFilters = this.state.overlay === 'due'
      ? TASK_FILTERS.map(filter => ({ kind: 'due', filter }))
      : this.state.overlay === 'memory'
        ? ['observations', 'proposals', 'career-brief', 'voice-guide'].map(filter => ({ kind: 'memory', filter }))
        : [];
    const filterHits = [
      ...dashboardFilterHits,
      ...overlayFilters.map(hit => {
        const label = hit.filter.replace('-', ' ');
        const y = plain.findIndex(line => line.includes(label));
        return { ...hit, y, x: y < 0 ? -1 : plain[y].indexOf(label), width: label.length };
      }).filter(hit => hit.y >= 0 && hit.x >= 0)
    ];
    const footers = footerLines(dimensions.width, this.state);
    const renderedPriority = priorityLines(this.model, this.state, dimensions.width, false);
    const priorityVisible = renderedPriority.length > 0
      && renderedPriority.every((line, index) => plain[index + 1] === line);
    const prioritySection = priorityVisible
      ? { y: 1, bottom: renderedPriority.length }
      : null;
    this.lastFrame = {
      width: dimensions.width,
      height: dimensions.height,
      overlayHits,
      filterHits,
      sections: {
        jobs: jobsY < 0 ? null : { y: jobsY, bottom: jobsBottom < 0 ? dimensions.height : jobsBottom, hits },
        priority: prioritySection,
        details: detailsSection,
        footer: { y: Math.max(0, plain.length - footers.length), lines: footers }
      }
    };
    if (screen === this.lastScreen) return false;
    const previous = this.lastScreen;
    this.lastScreen = screen;
    this.lastRenderDimensions = { width: dimensions.width, height: dimensions.height };
    if (previous == null || previousDimensions?.width !== dimensions.width || previousDimensions?.height !== dimensions.height) {
      this.stdout.write(`${ESC}H${ESC}2J${screen}`);
      return true;
    }
    const oldLines = previous.split('\n');
    const newLines = screen.split('\n');
    const updates = [];
    for (let index = 0; index < Math.max(oldLines.length, newLines.length); index++) {
      if (oldLines[index] === newLines[index]) continue;
      updates.push(`${ESC}${index + 1};1H${ESC}2K${newLines[index] || ''}`);
    }
    if (updates.length) this.stdout.write(updates.join(''));
    return updates.length > 0;
  }

  refresh({ disk = true, render = true } = {}) {
    if (this.state.editorActive) return false;
    const previousModel = this.model;
    const previousArtifactId = this.state.selectedArtifactId;
    const previousDocs = previousModel?.selected?.docs || [];
    const previousDocIndex = Math.max(0, previousDocs.findIndex(doc => doc.id === previousArtifactId));
    const previousReviewIndex = Math.max(0, previousModel?.review?.findIndex(item => item.id === previousArtifactId) ?? 0);
    const previousDiscoveryIndex = Math.max(0, previousModel?.discovery?.queue?.findIndex(item => item.id === this.state.selectedDiscoveryJobId) ?? 0);
    if (disk) reload(this.store);
    const setupSurface = String(this.state.overlay || '').startsWith('setup')
      || (this.state.overlay === 'help' && String(this.state.helpContextOverlay || '').startsWith('setup'))
      || String(this.state.mode || '').startsWith('setup-');
    this.model = buildTuiModel(this.store, {
      profileId: setupSurface ? this.state.setupProfileId : this.state.profileId,
      selectedJobId: setupSurface ? this.state.setupJobId : this.state.selectedJobId,
      at: this.now().toISOString()
    });
    if (!setupSurface) {
      this.state.profileId = this.model.profileId;
      this.state.selectedJobId = this.model.selectedJobId;
    }
    this.state.stripIndex = Math.max(0, Math.min(this.state.stripIndex || 0, Math.max(0, this.model.priority.length - 1)));
    if (previousModel?.selectedJobId !== this.model.selectedJobId) this.state.detailsScroll = 0;

    const docs = this.model.selected?.docs || [];
    const shouldClampArtifact = Boolean(this.state.selectedArtifactId) || this.state.overlay === 'review' || this.state.overlay === 'docs';
    if (shouldClampArtifact && !docs.some(doc => doc.id === this.state.selectedArtifactId)) {
      const candidates = this.state.overlay === 'review' ? this.model.review : docs;
      const index = this.state.overlay === 'review' ? previousReviewIndex : previousDocIndex;
      this.setSelectedArtifact(candidates[Math.min(index, Math.max(0, candidates.length - 1))]?.id || null);
    }
    const queue = this.model.discovery.queue;
    if (!queue.some(item => item.id === this.state.selectedDiscoveryJobId)) {
      this.state.selectedDiscoveryJobId = queue[Math.min(previousDiscoveryIndex, Math.max(0, queue.length - 1))]?.id || null;
    }
    if (this.state.overlay === 'review') this.state.overlayIndex = Math.max(0, this.model.review.findIndex(item => item.id === this.state.selectedArtifactId));
    if (this.state.overlay === 'docs') {
      this.state.overlayIndex = Math.max(0, docs.findIndex(doc => doc.id === this.state.selectedArtifactId));
      if (this.dimensions().width < 116) this.state.focusTarget = 'viewer';
    }
    this.applyPendingAutoOpen();
    if (render) this.render();
  }

  setSelectedArtifact(artifactId, { reset = true } = {}) {
    const changed = this.state.selectedArtifactId !== artifactId;
    this.state.selectedArtifactId = artifactId || null;
    if (changed && reset) {
      this.state.docsScroll = 0;
      this.state.docsDiffScroll = 0;
      this.state.docsMatchIndex = 0;
      this.state.docsQuery = '';
    }
  }

  selectedDocument() {
    return selectedDoc(this.model, this.state).doc;
  }

  moveArtifactSelection(delta) {
    let docs = this.model.selected?.docs || [];
    let index = docs.findIndex(doc => doc.id === this.state.selectedArtifactId);
    if (index < 0 && this.state.selectedArtifactId) {
      const artifact = one(this.store, 'SELECT job_id FROM artifacts WHERE id=?', [this.state.selectedArtifactId]);
      if (artifact?.job_id && artifact.job_id !== this.state.selectedJobId) {
        this.state.selectedJobId = artifact.job_id;
        this.refresh({ disk: false });
        docs = this.model.selected?.docs || [];
        index = docs.findIndex(doc => doc.id === this.state.selectedArtifactId);
      }
    }
    if (!docs.length) return;
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(docs.length - 1, index + delta));
    this.setSelectedArtifact(docs[index].id);
    this.state.overlayIndex = index;
    this.render();
  }

  moveReviewSelection(delta) {
    const items = this.model.review;
    if (!items.length) return;
    let index = items.findIndex(item => item.id === this.state.selectedArtifactId);
    if (index < 0) index = this.state.overlayIndex || 0;
    index = Math.max(0, Math.min(items.length - 1, index + delta));
    this.state.overlayIndex = index;
    this.setSelectedArtifact(items[index].id, { reset: false });
    this.render();
  }

  moveDiscoverySelection(delta) {
    const items = this.model.discovery.queue;
    if (!items.length) return;
    let index = items.findIndex(item => item.id === this.state.selectedDiscoveryJobId);
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(items.length - 1, index + delta));
    this.state.selectedDiscoveryJobId = items[index].id;
    this.render();
  }

  docsViewerActive() {
    return this.state.overlay === 'docs' && (this.dimensions().width < 116 || this.state.focusTarget === 'viewer');
  }

  artifactSnapshot() {
    return all(this.store, 'SELECT id,path,job_id AS jobId,created_at AS createdAt,title FROM artifacts ORDER BY created_at,id');
  }

  applyPendingAutoOpen() {
    const artifactId = this.state.pendingAutoOpenArtifactId;
    if (!artifactId || this.state.mode !== 'normal' || this.state.pendingConfirm || this.state.busy || this.state.editorActive) return false;
    const row = one(this.store, 'SELECT id,job_id FROM artifacts WHERE id=?', [artifactId]);
    this.state.pendingAutoOpenArtifactId = null;
    if (!row || row.job_id !== this.state.selectedJobId) return false;
    this.setSelectedArtifact(row.id);
    this.state.overlay = 'docs';
    this.state.focusTarget = this.dimensions().width < 116 ? 'viewer' : 'shell';
    return true;
  }

  noteArtifactChanges(before = [], after = []) {
    const beforeIds = new Set(before.map(item => item.id));
    const beforePaths = new Set(before.map(item => `${item.jobId || item.job_id}\0${item.path}`));
    const changed = after
      .filter(item => !beforeIds.has(item.id) && !this.notedArtifactIds.has(item.id))
      .filter(item => (item.jobId || item.job_id) === this.state.selectedJobId)
      .sort((a, b) => String(a.createdAt || a.created_at).localeCompare(String(b.createdAt || b.created_at)) || String(a.id).localeCompare(String(b.id)));
    for (const item of changed) {
      this.notedArtifactIds.add(item.id);
      const row = one(this.store, 'SELECT title FROM artifacts WHERE id=?', [item.id]);
      const kind = beforePaths.has(`${item.jobId || item.job_id}\0${item.path}`) ? 'Updated' : 'Created';
      this.addMessage('tool', `${kind}: ${row?.title || item.title || item.path} (Press Ctrl+A to focus viewer).`);
    }
    const newest = changed.at(-1);
    if (!newest) return [];
    if (this.state.mode === 'normal' && !this.state.pendingConfirm && !this.state.busy && !this.state.editorActive) {
      this.setSelectedArtifact(newest.id);
      this.state.overlay = 'docs';
      this.state.focusTarget = this.dimensions().width < 116 ? 'viewer' : 'shell';
    } else {
      this.state.pendingAutoOpenArtifactId = newest.id;
    }
    this.render();
    return changed;
  }

  filtered() {
    return filteredJobs(this.model, this.state.filter);
  }

  moveSelection(delta) {
    const jobs = this.filtered();
    if (!jobs.length) return;
    let index = jobs.findIndex(job => job.id === this.state.selectedJobId);
    if (index < 0) index = 0;
    index = (index + delta + jobs.length) % jobs.length;
    this.state.selectedJobId = jobs[index].id;
    this.state.detailsScroll = 0;
    this.refresh({ disk: false });
  }

  openDocuments(artifactId = null) {
    this.state.selectedArtifactId = artifactId || this.state.selectedArtifactId;
    this.openOverlay('docs');
    this.syncDocumentSelection();
    this.render();
  }

  openOverlay(name) {
    this.state.overlay = name;
    this.state.overlayIndex = 0;
    this.state.docsDiff = false;
    this.state.mode = 'normal';
    this.setInput('');
    if (name === 'build-network') {
      this.state.networkDraft = seedNetworkDraft(this.model);
      this.state.status = 'build-network editor · Enter edits fields · Esc closes';
    } else {
      if (name === 'memory') this.state.memoryView = 'observations';
      if (name === 'docs') this.state.focusTarget = this.dimensions().width < 116 ? 'viewer' : 'shell';
      this.state.status = `${name} overlay · Esc closes`;
    }
    this.render();
  }

  openSetupOverlay() {
    const shellProfileId = this.model.profiles.some(profile => profile.id === this.state.profileId) ? this.state.profileId : null;
    if (shellProfileId) this.state.setupProfileId = shellProfileId;
    else if (this.model.profiles.length === 1) this.state.setupProfileId = this.model.profiles[0].id;
    const selectedJob = this.model.jobs.find(job => job.id === this.state.selectedJobId);
    this.state.setupJobId = selectedJob && this.state.setupProfileId === this.state.profileId ? selectedJob.id : null;
    this.state.overlay = 'setup';
    this.state.mode = 'normal';
    this.setInput('');
    this.refresh({ disk: false });
    this.focusNextSetupAction();
    this.state.status = 'Start with the highlighted task · Esc returns to the dashboard';
    this.render();
    return true;
  }

  closeTransient() {
    if (this.state.overlay === 'help') return this.closeHelp();
    if (this.state.mode === 'build-network-field') {
      this.state.mode = 'normal';
      this.setInput('');
      if (this.state.networkDraft) this.state.networkDraft._editingKey = null;
      this.state.status = 'edit cancelled';
      this.render();
      return true;
    }
    if (this.state.overlay) {
      this.state.overlay = null;
      this.state.overlayIndex = 0;
      this.state.mode = 'normal';
      this.setInput('');
      this.state.networkDraft = null;
      this.state.status = 'overlay closed';
      this.render();
      return true;
    }
    return false;
  }

  addMessage(role, text, { append = false } = {}) {
    const value = String(text || '');
    const last = this.state.messages[this.state.messages.length - 1];
    if (append && last?.role === role) last.text += value;
    else this.state.messages.push({ role, text: value });
    if (this.state.messages.length > 80) this.state.messages.splice(0, this.state.messages.length - 80);
  }

  async connectAgent() {
    if (!this.state.agentOn || this.client?.state === 'working') return;
    if (this.client) await this.client.stop();
    this.state.agentState = 'connecting';
    this.state.status = 'connecting Hermes ACP guest';
    this.render();
    try {
      this.state.catalog = await agentBackendCatalog({ root: this.store.root });
      this.client = new AcpClient({ root: this.store.root });
      this.client.on('state', event => {
        this.state.agentState = event.state;
        this.state.sessionId = event.sessionId || this.state.sessionId;
        this.state.error = ['failed', 'crashed', 'timeout', 'unavailable'].includes(event.state) ? (event.error || event.state) : null;
        this.render();
      });
      this.client.on('event', event => this.onAgentEvent(event));
      await this.sessionPersistence;
      const mcpServers = [jobosMcpServer(this.store.root)];
      const persistedSessionId = await readPersistedAcpSession(this.store.root, this.model.profileId);
      let resumed = Boolean(persistedSessionId);
      let connected;
      try {
        connected = await this.client.connect({ mcpServers, sessionId: persistedSessionId });
      } catch (error) {
        if (!persistedSessionId) throw error;
        resumed = false;
        await this.persistAgentSession(null);
        connected = await this.client.connect({ mcpServers });
      }
      this.state.sessionId = connected.session.sessionId;
      await this.persistAgentSession(this.state.sessionId);
      this.state.agentState = 'ready';
      this.state.status = `Hermes ACP ${resumed ? 'resumed' : 'ready'} · session ${this.state.sessionId.slice(0, 8)} · JobOS tools mediated`;
      this.state.error = null;
    } catch (error) {

      this.state.agentState = 'failed';
      this.state.error = error.message;
      this.state.status = `ACP unavailable: ${error.message} · press c to retry; CLI/TUI state remains usable`;
    }
    this.render();
  }

  onAgentEvent(event) {
    if (event.type === 'user_message') this.addMessage('user', event.text);
    else if (event.type === 'agent_message') this.addMessage('assistant', event.text, { append: true });
    else if (event.type === 'tool_start') {
      this.addMessage('tool', `→ ${event.title} ${JSON.stringify(event.rawInput || {})}`);
      this.state.status = `agent tool ${event.title}`;
    } else if (event.type === 'tool_update') {
      this.addMessage('tool', `← ${event.status || 'update'} ${event.title}`);
      if (event.status === 'completed' || event.status === 'failed') {
        try {
          this.refresh();
        } catch (error) {

          this.state.error = error.message;
          this.state.status = `refresh failed: ${error.message} · press g to retry`;
        }
      }
    } else if (event.type === 'agent_thought') {
      this.state.status = crop(`agent thinking · ${event.text}`, 120);
    } else if (event.type === 'permission_denied' || event.type === 'client_method_denied') {
      this.addMessage('tool', `blocked by JobOS host policy: ${event.toolCall?.title || event.method || 'permission request'}`);
      this.state.status = 'guest terminal/filesystem permission denied';
    } else if (event.type === 'session_quarantined') {
      void this.persistAgentSession(null).catch(() => {});
      this.state.status = `${event.reason || 'cancelled'} ACP session quarantined · next prompt starts a clean guest`;
    } else if (event.type === 'session_recovery_started') {
      this.state.status = `restarting quarantined ACP session · JobOS state remains authoritative`;
    } else if (event.type === 'session_recovered') {
      this.state.sessionId = event.sessionId;
      void this.persistAgentSession(event.sessionId).catch(() => {});
      this.state.status = `clean ACP session ${String(event.sessionId || '').slice(0, 8)} ready`;
    } else if (event.type === 'process_exit' && !event.intentional) {
      this.addMessage('tool', 'Hermes ACP exited. Press c to reconnect; JobOS state is intact.');
      this.state.agentState = 'crashed';
    } else if (event.type === 'protocol_error' || event.type === 'process_error') {
      this.state.error = event.message || event.error?.message || 'ACP protocol error';
    }
    this.render();
  }

  persistAgentSession(sessionId) {
    this.sessionPersistence = this.sessionPersistence
      .catch(() => {})
      .then(() => writePersistedAcpSession(this.store.root, this.model.profileId, sessionId));
    return this.sessionPersistence.catch(error => {
      this.state.error = error.message;
      this.render();
      throw error;
    });
  }

  async promptAgent(text) {
    if (!this.client || this.client.state !== 'ready') {
      this.state.status = 'Agent is not ready. Press c to connect.';
      this.state.error = 'ACP not ready';
      this.render();
      return;
    }
    const jobId = this.state.selectedJobId;
    const context = jobId ? selectedJobContext(this.store, jobId, this.model.profileId) : null;
    const before = this.artifactSnapshot();
    this.state.busy = 'agent';
    this.state.status = `agent working on ${jobId || 'workspace'} · navigation stays active`;
    this.render();
    try {
      const result = await this.client.prompt(text, { context });
      this.state.status = result?.stopReason === 'cancelled'
        ? 'agent turn cancelled · late guest output quarantined · next prompt starts clean'
        : 'agent turn complete · authoritative state refreshed';
      this.state.error = null;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `${error.message} · press c to reconnect or continue using JobOS directly`;
    } finally {
      this.state.busy = null;
      try {
        this.refresh();
        this.noteArtifactChanges(before, this.artifactSnapshot());
      } catch (error) {

        this.state.error = error.message;
        this.state.status = `refresh failed: ${error.message}`;
        this.render();
      }
    }
  }

  async runAction(name) {
    if (this.state.busy) {
      this.state.status = `${this.state.busy} is active; navigation and overlays remain available`;
      this.render();
      return;
    }
    const setupAction = String(this.state.overlay || '').startsWith('setup');
    let succeeded = false;
    const profileId = this.model.profileId;
    const jobId = this.state.selectedJobId;
    if ((name !== 'daily') && !jobId) {
      this.state.error = 'No job selected';
      this.state.status = 'No job selected. Import a job or run daily.';
      this.render();
      return;
    }
    if (!profileId) {
      this.state.error = 'No profile';
      this.state.status = 'Create a profile before running workflows.';
      this.render();
      return;
    }
    const tool = TUI_DOMAIN_ACTIONS[name];
    const args = name === 'daily'
      ? { profileId }
      : (name === 'network' ? { jobId } : { jobId, profileId });
    if (!tool) return;
    const before = this.artifactSnapshot();
    this.state.busy = name;
    this.state.status = `${name} running asynchronously`;
    this.state.error = null;
    this.render();
    try {
      await callDomainTool(this.store, tool, args, { source: 'tui' });
      succeeded = true;
      this.state.status = `${name} complete · local state refreshed`;
    } catch (error) {

      if (error?.code === 'stale_snapshot') {
        reload(this.store);
        this.state.status = `${name} stopped: workspace changed; refreshed safely, retry when ready`;
      } else {
        this.state.status = `${name} failed: ${error.message}`;
      }
      this.state.error = error.message;
    } finally {
      this.state.busy = null;
      this.refresh({ disk: false });
      if (succeeded && setupAction) {
        this.state.overlay = 'setup';
        this.focusNextSetupAction();
        this.state.status = `${name === 'score' ? 'Fit check' : 'Application draft'} complete · the next task is highlighted`;
      }
      this.noteArtifactChanges(before, this.artifactSnapshot());
    }
  }

  async commitArtifactReview(decision) {
    const artifact = this.selectedDocument();
    if (!artifact || this.state.busy) return;
    const tool = decision === 'approved' ? 'approve_artifact' : 'reject_artifact';
    const args = decision === 'approved'
      ? { artifactId: artifact.id }
      : { artifactId: artifact.id, note: this.state.input.trim() };
    this.state.busy = tool;
    this.state.error = null;
    this.state.status = `${decision} r${artifact.revision} locally`;
    this.render();
    try {
      await callDomainTool(this.store, tool, args, { source: 'tui' });
      this.state.mode = 'normal';
      this.setInput('');
      this.refresh({ disk: false });
      this.state.busy = null;
      if (decision === 'rejected') {
        const hint = redraftCliHint(
          { ...artifact, jobId: artifact.jobId || this.state.selectedJobId, job_id: this.state.selectedJobId },
          this.model.profileId
        );
        if (this.client?.state === 'ready' && !this.state.busy) {
          this.state.status = `rejected · agent redraft requested · or CLI: ${hint}`;
          this.render();
          await this.promptAgent(
            `Revise artifact ${artifact.id} (${artifact.path || artifact.type}) for job ${this.state.selectedJobId} using only stored proof points. Human rejection feedback: ${args.note || ''}`
          );
        } else {
          this.state.status = `rejected · redraft next: ${hint}`;
        }
      } else {
        this.state.status = `${decision} locally · queue, readiness, and audit log refreshed`;
      }
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `${decision} failed: ${error.message}`;
      this.render();
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async buildNetworkSaveOnly() {
    this.state.busy = 'research';
    this.state.status = 'saving network setup';
    this.state.error = null;
    this.state.overlay = null;
    this.render();
    try {
      const profileId = this.model.profileId;
      if (!profileId) {
        this.state.error = 'No profile';
        this.state.status = 'Create a profile first.';
        return;
      }
      const draft = this.state.networkDraft || seedNetworkDraft(this.model);
      setNetworkIntent(this.store, {
        profileId,
        intent: buildIntentFromDraft(draft),
        affiliations: buildAffiliationsFromDraft(draft)
      });
      this.state.networkDraft = null;
      this.refresh();
      this.state.status = 'network setup saved · affiliations confirmed · run jobos network import to add connections';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `save failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async buildNetworkSaveAndBuild() {
    this.state.busy = 'research';
    this.state.status = 'building network map · saving and starting research';
    this.state.error = null;
    this.state.overlay = null;
    this.render();
    try {
      const profileId = this.model.profileId;
      if (!profileId) {
        this.state.error = 'No profile';
        this.state.status = 'Create a profile first.';
        return;
      }
      const draft = this.state.networkDraft || seedNetworkDraft(this.model);
      const scope = this.state.selectedJobId ? 'job' : 'profile';
      const jobId = this.state.selectedJobId || undefined;
      setNetworkIntent(this.store, {
        profileId,
        intent: buildIntentFromDraft(draft),
        affiliations: buildAffiliationsFromDraft(draft)
      });
      this.state.networkDraft = null;
      this.refresh({ disk: true });
      const runId = createResearchRun(this.store, {
        profileId,
        scope,
        jobId,
        depth: 'standard'
      });
      const result = await executeResearchRun(this.store, runId);
      this.refresh();
      this.state.status = `network research ${result.status} · ${result.runId?.slice(0, 12) || ''}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `research failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async showPacketSummary() {
    const jobId = this.state.selectedJobId;
    const profileId = this.model.profileId;
    const meta = this.model.selected?.readiness?.packet;
    if (!jobId) {
      this.state.error = 'No job selected';
      this.state.status = 'Select a job before inspecting its application packet.';
      this.render();
      return;
    }
    if (!meta?.currentPacketId) {
      this.state.packetDetail = { empty: true, jobId, profileId };
      this.state.overlay = 'packet';
      this.state.mode = 'normal';
      this.setInput('');
      this.state.status = `No packet · freeze with :packet create (or CLI: jobos apply packet create --job ${jobId} --profile ${profileId || '<profile>'} --json)`;
      this.render();
      return;
    }
    this.state.busy = 'packet_show';
    this.state.error = null;
    this.state.status = `Loading packet ${meta.currentPacketId}`;
    this.render();
    try {
      const detail = await callDomainTool(this.store, 'application_packet_show', { packetId: meta.currentPacketId }, { source: 'tui' });
      this.state.packetDetail = detail;
      this.state.overlay = 'packet';
      this.state.mode = 'normal';
      this.setInput('');
      this.state.status = `Packet ${detail.id} · ${detail.currency}/${detail.receiptState} · ${packetCtaLine(detail).replace(/^next /, 'next: ')}`;
    } catch (error) {
      this.state.packetDetail = { ...meta, id: meta.currentPacketId, fallback: true };
      this.state.overlay = 'packet';
      this.state.error = error.message;
      this.state.status = `Packet summary from readiness (${error.message})`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  executeCommand(value) {
    const raw = String(value || '').trim();
    const slash = raw.startsWith('/');
    const trimmed = raw.replace(/^[:/]/, '').trim();
    const [command] = trimmed.split(/\s+/);
    const argText = trimmed.slice((command || '').length).trim();
    this.state.mode = 'normal';
    this.setInput('');
    if (!command) return this.render();
    if (slash && DOMAIN_TOOLS.some(tool => tool.name === command)) {
      let args = {};
      if (argText) {
        try {
          args = JSON.parse(argText);
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw Error('expected an object');
        } catch (error) {
          this.state.error = error.message;
          this.state.status = `Usage: /${command} <json-object>`;
          return this.render();
        }
      }
      return void this.runDomainSlashCommand(command, args);
    }
    const actions = { pursue: 'pursue', score: 'score', daily: 'daily', network: 'network' };
    if (actions[command]) return void this.runAction(actions[command]);
    if (command === 'review' || command === 'log' || command === 'docs' || command === 'answers' || command === 'system' || command === 'profile' || command === 'due') return this.openOverlay(command);
    if (command === 'memory') {
      if (!argText) return this.openOverlay('memory');
      return this.executeMemoryCommand(argText);
    }
    if (command === 'interviews') return this.openOverlay('interviews');
    if (command === 'build-network') return this.openOverlay('build-network');
    if (command === 'packet') {
      const sub = trimmed.split(/\s+/)[1]?.toLowerCase();
      if (!sub) return void this.showPacketSummary();
      if (sub === 'create') return void this.packetMutate('create');
    }
    if (command === 'form') return void this.formAction(argText);
    if (command === 'attest') return void this.packetMutate('attest', argText);
    if (command === 'receipt') return void this.packetMutate('receipt', argText);
    if (command === 'answer') return void this.answerAdd(argText);
    if (command === 'prep') return void this.runPrep(argText);
    if (command === 'story-verify') return void this.verifyInterviewStory(argText);
    if (command === 'story-retire') return void this.retireInterviewStory(argText);
    if (command === 'debrief') return void this.recordInterviewDebrief(argText);
    if (command === 'debrief-correct') return void this.correctInterviewDebrief(argText);
    if (command === 'weekly') return void this.runWeeklyReview();
    if (command === 'reschedule') return void this.rescheduleSelectedAction(argText);
    if (command === 'agent') {
      this.state.agentOn = !this.state.agentOn;
      this.state.status = `agent ${this.state.agentOn ? 'on' : 'off'}`;
      if (this.state.agentOn && !this.client) void this.connectAgent();
      return this.render();
    }
    if (command === 'refresh') return this.refresh();
    if (command === 'reconnect') return void this.connectAgent();
    if (command === 'quit') return void this.stop();
    this.state.error = `Unknown command: ${trimmed}`;
    this.state.status = 'Use : for friendly host commands or /<domain_tool> <json-object> for every callable function. Run jobos agent-guide --json for the full catalog.';
    this.render();
  }

  async runDomainSlashCommand(name, suppliedArgs) {
    if (this.state.busy) return;
    const tool = DOMAIN_TOOLS.find(item => item.name === name);
    if (!tool) return;
    const args = { ...suppliedArgs };
    if (tool.inputSchema?.properties?.profileId && args.profileId === undefined && this.model.profileId) args.profileId = this.model.profileId;
    if (tool.inputSchema?.properties?.jobId && args.jobId === undefined && this.state.selectedJobId) args.jobId = this.state.selectedJobId;
    const before = this.artifactSnapshot();
    this.state.busy = name;
    this.state.error = null;
    this.state.status = `${name} running`;
    this.render();
    try {
      const result = await callDomainTool(this.store, name, args, { source: 'tui' });
      this.state.status = `${name} complete · ${Array.isArray(result) ? `${result.length} result(s)` : 'authoritative state refreshed'}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `${name} failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.refresh({ disk: false });
      this.noteArtifactChanges(before, this.artifactSnapshot());
    }
  }

  executeMemoryCommand(argText) {
    const text = String(argText || '').trim();
    const parts = text.split('|').map(part => part.trim());
    const [head, reasonPart = ''] = parts;
    const [action, target, ...extra] = head.split(/\s+/).filter(Boolean);
    const reason = reasonPart.trim();
    const usage = 'Usage: :memory accept <proposal-id> | :memory reject|revoke <proposal-id> | <reason> | :memory undo <transition-id> | <reason> | :memory refresh';
    if (action === 'refresh' && !target) return this.refreshMemoryWorkspace();
    if (parts.length > 2 || !['accept', 'reject', 'revoke', 'undo'].includes(action) || !target || extra.length
      || (['reject', 'revoke', 'undo'].includes(action) && !reason)) {
      this.state.status = usage;
      this.render();
      return;
    }
    if (this.state.setupCalibrationReview && ['accept', 'reject'].includes(action)) {
      this.state.pendingConfirm = { kind: 'setup-memory-transition', argText: text };
      this.state.status = `Confirm explicit calibration proposal ${action}: ${target}? (y/n)`;
      this.render();
      return;
    }
    const profileId = this.model.profileId;
    if (!profileId || this.state.busy) return;
    const count = Number(one(this.store, 'SELECT COUNT(*) AS count FROM career_memory_proposal_transitions WHERE profile_id=?', [profileId])?.count || 0);
    const referenceId = `tui-memory:${profileId}:${action}:${target}:${count + 1}`;
    try {
      const result = action === 'undo'
        ? undoMemoryTransition(this.store, {
            profileId,
            transitionId: target,
            reason,
            referenceId,
            actor: 'user',
            source: 'tui',
            nowDate: this.now(),
          })
        : transitionMemoryProposal(this.store, {
            profileId,
            proposalId: target,
            action,
            reason,
            referenceId,
            actor: 'user',
            source: 'tui',
            nowDate: this.now(),
          });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.overlay = 'memory';
      this.state.memoryView = 'proposals';
      this.state.status = `Memory ${action} complete · ${result.toStatus} · ${target}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Memory ${action} failed: ${error.message}`;
    }
    this.render();
  }

  refreshMemoryWorkspace() {
    const profileId = this.model.profileId;
    if (!profileId || this.state.busy) return;
    try {
      const asOf = this.now();
      refreshMemoryProjection(this.store, { profileId, projectionType: 'career_brief', asOf, actor: 'user', source: 'tui' });
      refreshMemoryProjection(this.store, { profileId, projectionType: 'voice_positioning_guide', asOf, actor: 'user', source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.overlay = 'memory';
      this.state.status = 'Career Memory projections refreshed deterministically.';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Memory refresh failed: ${error.message}`;
    }
    this.render();
  }

  cycleStripFocus(delta = 1) {
    const items = this.model.priority || [];
    if (!items.length) return;
    this.state.stripIndex = ((this.state.stripIndex || 0) + delta + items.length) % items.length;
    this.state.status = `Priority: ${items[this.state.stripIndex].kind} · Enter opens it`;
    this.render();
  }

  jumpToStripJob() {
    const item = (this.model.priority || [])[this.state.stripIndex || 0];
    if (item?.source === 'setup' && item.actionId) {
      this.openSetupOverlay();
      const setupItem = this.model.onboarding?.steps?.find(step => (
        step.actions?.some(action => action.id === item.actionId)
      ));
      const setupAction = setupItem?.actions?.find(action => action.id === item.actionId);
      if (setupItem && setupAction) {
        this.state.overlayIndex = this.model.onboarding.steps.indexOf(setupItem);
        return this.openSetupAction(setupItem, setupAction);
      }
      return;
    }
    if (item?.target === 'log') {
      this.openOverlay('log');
      return;
    }
    if (!item?.jobId) {
      this.state.status = `No linked job on the ${item?.kind || 'strip'} card.`;
      this.render();
      return;
    }
    this.selectJobInMainList(item.jobId, `Strip ${item.kind} · job now selected in the main list.`);
  }

  selectJobInMainList(jobId, statusMessage) {
    const row = one(this.store, 'SELECT id FROM jobs WHERE id=?', [jobId]);
    if (!row) {
      this.refresh({ disk: false });
      this.state.status = 'Linked job no longer exists; state refreshed.';
      this.render();
      return;
    }
    this.state.overlay = null;
    this.state.focusTarget = 'shell';
    this.state.detailsScroll = 0;
    this.state.filter = 'all'; // load-bearing: the main list only renders filteredJobs
    this.state.selectedJobId = jobId;
    this.refresh({ disk: false });
    this.state.status = statusMessage;
    this.render();
  }

  rescheduleSelectedAction(argText) {
    const usage = 'Usage: :reschedule <RFC3339> | <reason>';
    const separator = String(argText || '').indexOf('|');
    const dueAt = separator >= 0 ? argText.slice(0, separator).trim() : '';
    const reason = separator >= 0 ? argText.slice(separator + 1).trim() : '';
    const action = this.model.selected?.nextAction;
    if (!dueAt || !reason) {
      this.state.status = usage;
      this.render();
      return;
    }
    if (!action || !this.model.profileId) {
      this.state.status = 'Selected job has no open W06 action to reschedule.';
      this.render();
      return;
    }
    try {
      const result = rescheduleApplicationNextAction(this.store, {
        taskId: action.id,
        profileId: this.model.profileId,
        dueAt,
        reason,
        actor: 'user',
        source: 'tui',
      });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Rescheduled ${result.title} · ${result.dueAt} · ${result.manualRescheduleReason}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Reschedule failed: ${error.message}`;
    }
    this.render();
  }

  selectedInterviewApplication() {
    const application = this.model.interviews?.selectedApplication;
    if (!application
      || application.profileId !== this.model.profileId
      || application.jobId !== this.state.selectedJobId) {
      return null;
    }
    return application;
  }

  async verifyInterviewStory(argText) {
    const usage = 'Usage: :story-verify <story-id> <revision> | <confirmed-fields-csv>';
    const separator = String(argText || '').indexOf('|');
    const target = separator >= 0 ? argText.slice(0, separator).trim().split(/\s+/) : [];
    const confirmedFields = separator >= 0
      ? argText.slice(separator + 1).split(',').map(field => field.trim()).filter(Boolean)
      : [];
    const revision = Number(target[1]);
    if (target.length !== 2 || !Number.isInteger(revision) || revision < 1) {
      this.state.status = usage;
      this.render();
      return;
    }
    if (!this.model.profileId || this.state.busy) return;
    this.state.busy = 'story-verify';
    try {
      const result = await callDomainTool(this.store, 'verify_interview_story', {
        profileId: this.model.profileId,
        storyId: target[0],
        revision,
        confirmedFields,
        actor: 'user'
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Story verified · ${result.id} r${result.currentRevision.revision}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Story verification failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async retireInterviewStory(argText) {
    const usage = 'Usage: :story-retire <story-id> | <reason>';
    const separator = String(argText || '').indexOf('|');
    const storyId = separator >= 0 ? argText.slice(0, separator).trim() : '';
    const reason = separator >= 0 ? argText.slice(separator + 1).trim() : '';
    if (!storyId || storyId.includes(' ') || !reason) {
      this.state.status = usage;
      this.render();
      return;
    }
    if (!this.model.profileId || this.state.busy) return;
    this.state.busy = 'story-retire';
    try {
      const result = await callDomainTool(this.store, 'retire_interview_story', {
        profileId: this.model.profileId,
        storyId,
        reason,
        actor: 'user'
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Story retired · ${result.id} · ${reason}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Story retirement failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async recordInterviewDebrief(argText) {
    const usage = 'Usage: :debrief <json-file>';
    const file = String(argText || '').trim();
    if (!file) {
      this.state.status = usage;
      this.render();
      return;
    }
    const application = this.selectedInterviewApplication();
    if (!application) {
      this.state.status = 'Select a profile-owned application before recording a debrief.';
      this.render();
      return;
    }
    if (this.state.busy) return;
    this.state.busy = 'debrief-record';
    try {
      const payload = readStructuredJsonFile(file);
      const result = await callDomainTool(this.store, 'record_interview_debrief', {
        ...payload,
        profileId: application.profileId,
        jobId: undefined,
        applicationId: application.applicationId,
        debriefId: undefined,
        targetRevision: undefined,
        reason: undefined
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Debrief recorded · ${result.id} r${result.currentRevision.revision}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = error.message.startsWith('Invalid JSON file')
        ? error.message
        : `Debrief failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async correctInterviewDebrief(argText) {
    const usage = 'Usage: :debrief-correct <debrief-id> | <json-file> | <reason>';
    const parts = String(argText || '').split('|').map(part => part.trim());
    if (parts.length !== 3 || parts.some(part => !part)) {
      this.state.status = usage;
      this.render();
      return;
    }
    const application = this.selectedInterviewApplication();
    if (!application) {
      this.state.status = 'Select a profile-owned application before correcting a debrief.';
      this.render();
      return;
    }
    if (this.state.busy) return;
    this.state.busy = 'debrief-correct';
    try {
      const [debriefId, file, reason] = parts;
      const payload = readStructuredJsonFile(file);
      let current;
      try {
        current = getInterviewDebrief(this.store, {
          profileId: application.profileId,
          debriefId,
          includeHistory: false
        });
      } catch {
        throw new Error('Interview debrief does not belong to the selected profile/application.');
      }
      if (current.applicationId !== application.applicationId || current.jobId !== application.jobId) {
        throw new Error('Interview debrief does not belong to the selected profile/application.');
      }
      const result = await callDomainTool(this.store, 'correct_interview_debrief', {
        ...payload,
        profileId: application.profileId,
        debriefId: current.id,
        jobId: current.jobId,
        applicationId: current.applicationId,
        interviewStage: current.interviewStage,
        audience: current.audience,
        referenceId: current.referenceId,
        targetRevision: current.currentRevision.revision,
        reason
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Debrief corrected · ${result.id} r${result.currentRevision.revision}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = error.message.startsWith('Invalid JSON file')
        ? error.message
        : `Debrief correction failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async runPrep(argText) {
    const args = String(argText || '').trim().split(/\s+/).filter(Boolean);
    const usage = 'Usage: :prep <stage> [audience]';
    if (args.length > 2) {
      this.state.status = usage;
      this.render();
      return;
    }
    const application = this.selectedInterviewApplication();
    if (!application) {
      this.state.status = this.state.selectedJobId
        ? 'No application record for this job — create one first (pursue or jobos apply create).'
        : 'Select a job before running interview prep.';
      this.render();
      return;
    }
    if (this.state.busy) return;
    const stage = args[0] || 'interview';
    const audience = args[1] || undefined;
    this.state.busy = 'interview-prep';
    this.state.status = 'Interview prep running…';
    this.render();
    try {
      const result = await callDomainTool(this.store, 'interview_prep', {
        applicationId: application.applicationId,
        stage,
        audience
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Interview prep draft created (${result.stage} · ${result.audience}) · review with r`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Interview prep failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async runWeeklyReview() {
    const profileId = this.model.profileId;
    if (!profileId) {
      this.state.status = 'Create a profile before running the weekly review.';
      this.render();
      return;
    }
    if (this.state.busy) return;
    this.state.busy = 'weekly-review';
    this.state.status = 'Weekly review running…';
    this.render();
    try {
      const result = await callDomainTool(this.store, 'weekly_review', { profileId }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Weekly review written · ${result.path}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Weekly review failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async answerAdd(argText) {
    const usage = 'Usage: :answer add [category] | <exact question> | <your answer> · restricted categories auto-redact';
    const parts = String(argText || '').split('|').map(part => part.trim());
    const head = (parts[0] || '').split(/\s+/).filter(Boolean);
    if (head[0] !== 'add' || parts.length !== 3 || !parts[1] || !parts[2]) {
      this.state.status = usage;
      this.render();
      return;
    }
    const category = head[1] || 'other';
    const profileId = this.model.profileId;
    if (!profileId) {
      this.state.status = 'Create a profile before adding answers.';
      this.render();
      return;
    }
    if (this.state.busy) return;
    this.state.busy = 'answer-add';
    this.state.status = 'Saving answer…';
    this.render();
    try {
      await callDomainTool(this.store, 'answers_add', {
        profileId,
        category,
        question: parts[1],
        answer: parts[2],
        sourceRef: this.state.selectedJobId ? `job:${this.state.selectedJobId}` : 'user_input'
      }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      // Never echo the answer value back: restricted values stay redacted everywhere.
      this.state.status = `Answer saved (${category}) · restricted values stay redacted and never auto-fill`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Answer add failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async formAction(argText = '') {
    if (this.state.busy) return;
    const [action, first, second, third] = String(argText || '').trim().split(/\s+/);
    const jobId = this.state.selectedJobId;
    const profileId = this.model.profileId;
    const usage = 'Usage: :form inspect <url> | :form assist <packet-id> [browser-profile] | :form checkpoint <packet-id> <fill-run-id> [field-key,...] | :form submit <packet-id> <checkpoint-id> [browser-profile]';
    if (!jobId || !profileId) {
      this.state.error = 'No job/profile selected';
      this.state.status = 'Select a job and profile before form actions.';
      return this.render();
    }
    if (!['inspect', 'assist', 'checkpoint', 'submit'].includes(action)
      || !first
      || (['checkpoint', 'submit'].includes(action) && !second)) {
      this.state.error = 'Invalid form command';
      this.state.status = usage;
      return this.render();
    }
    this.state.busy = `form_${action}`;
    this.state.error = null;
    this.state.status = `Running form ${action}…`;
    this.render();
    try {
      let result;
      if (action === 'inspect') {
        result = await callDomainTool(this.store, 'inspect_application_form', { jobId, profileId, url: first, browserProfile: 'default' }, { source: 'tui' });
      } else if (action === 'assist') {
        result = await callDomainTool(this.store, 'assist_application_form', { packetId: first, browserProfile: second || 'default', allowSideEffects: true }, { source: 'tui' });
      } else if (action === 'checkpoint') {
        result = await callDomainTool(this.store, 'checkpoint_application_form', {
          packetId: first,
          fillRunId: second,
          confirmedFieldKeys: third ? third.split(',').map(value => value.trim()).filter(Boolean) : []
        }, { source: 'tui' });
      } else {
        result = await callDomainTool(this.store, 'submit_application_form', {
          packetId: first,
          checkpointId: second,
          browserProfile: third || 'default',
          allowSubmit: true
        }, { source: 'tui' });
      }
      this.refresh({ disk: false });
      this.state.status = action === 'inspect'
        ? `form inspected · snapshot ${result.snapshotId}`
        : action === 'assist'
          ? `form filled and read back · run ${result.fillRunId} · checkpoint required`
          : action === 'checkpoint'
            ? `human checkpoint accepted · ${result.checkpointId}`
            : result.status === 'confirmed'
              ? `configured submission confirmed · receipt ${result.receipt?.id || 'recorded'}`
              : `configured submission outcome uncertain · do not retry automatically`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `form ${action} failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  async packetMutate(kind, argText = '') {
    if (this.state.busy) return;
    const jobId = this.state.selectedJobId;
    const profileId = this.model.profileId;
    if (!jobId) {
      this.state.error = 'No job selected';
      this.state.status = 'Select a job before packet actions.';
      return this.render();
    }
    if (kind === 'receipt' && !argText) {
      this.state.error = 'Missing reference';
      this.state.status = 'Usage: :receipt <external-reference> — a confirmation id or URL from the job site.';
      return this.render();
    }
    this.state.busy = `packet_${kind}`;
    this.state.error = null;
    this.state.status = kind === 'create' ? `Freezing packet for ${jobId}`
      : kind === 'attest' ? `Attesting submission for ${jobId}`
        : `Confirming receipt for ${jobId}`;
    this.render();
    try {
      let done;
      if (kind === 'create') {
        await callDomainTool(this.store, 'create_application_packet', { jobId, profileId }, { source: 'tui' });
        done = 'packet frozen';
      } else {
        const summary = readinessPacketSummary(this.store, { jobId, profileId });
        if (!summary?.currentPacketId) throw new Error('no frozen packet for this job yet — run :packet create first');
        const packetId = summary.currentPacketId;
        if (kind === 'attest') {
          const submittedAt = argText || new Date().toISOString();
          await callDomainTool(this.store, 'attest_application_submitted', { packetId, submittedAt, note: '' }, { source: 'tui' });
          done = `submission attested at ${submittedAt}`;
        } else {
          await callDomainTool(this.store, 'confirm_application_receipt', { packetId, reference: argText, note: '' }, { source: 'tui' });
          done = `receipt confirmed (${argText})`;
        }
      }
      this.refresh({ disk: false });
      if (this.state.overlay === 'packet') await this.showPacketSummary();
      this.state.status = kind === 'create' ? `${done} · next: :form assist ${readinessPacketSummary(this.store, { jobId, profileId }).currentPacketId} or submit manually`
        : kind === 'attest' ? `${done} · next: :receipt <external-reference> once the site confirms`
          : `${done} · application loop complete locally`;
    } catch (error) {
      if (error?.code === 'stale_snapshot') {
        reload(this.store);
        this.state.status = `packet ${kind} stopped: workspace changed; refreshed safely, retry when ready`;
      } else {
        this.state.status = `packet ${kind} failed: ${error.message}`;
      }
      this.state.error = error.message;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  currentReviewItem() {
    if (this.state.overlay === 'review') return this.model.review[this.state.overlayIndex] || null;
    return this.model.review.find(item => item.id === this.state.selectedArtifactId) || null;
  }

  reviewCurrentArtifact(approvalStatus, note = '') {
    const artifactId = this.currentReviewItem()?.id || this.state.selectedArtifactId;
    if (!artifactId) {
      this.state.error = 'No artifact selected';
      this.state.status = 'No artifact selected.';
      this.render();
      return null;
    }
    const previousIndex = Math.max(0, this.model.review.findIndex(item => item.id === artifactId));
    try {
      const reviewed = reviewArtifact(this.store, { artifactId, approvalStatus, note, source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      if (this.state.overlay === 'review') {
        const next = this.model.review[Math.min(previousIndex, Math.max(0, this.model.review.length - 1))];
        this.setSelectedArtifact(next?.id || null, { reset: false });
        this.state.overlayIndex = Math.max(0, this.model.review.findIndex(item => item.id === this.state.selectedArtifactId));
      } else {
        this.setSelectedArtifact(artifactId, { reset: false });
      }
      this.state.status = `Artifact ${approvalStatus}.`;
      this.render();
      return reviewed;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Artifact review failed: ${error.message}`;
      this.render();
      return null;
    }
  }

  beginReject() {
    const item = this.currentReviewItem();
    const artifactId = item?.id || this.state.selectedArtifactId;
    if (!artifactId) return;
    this.setSelectedArtifact(artifactId, { reset: false });
    this.state.mode = 'review-note';
    this.setInput('');
    this.state.status = 'Rejection feedback is required before saving.';
    this.render();
  }

  async submitReviewNote() {
    const note = this.state.input.trim();
    if (!note) {
      this.state.status = 'Rejection feedback is required.';
      this.render();
      return;
    }
    const artifactId = this.state.selectedArtifactId;
    const row = one(this.store, 'SELECT id,job_id,path,type FROM artifacts WHERE id=?', [artifactId]);
    this.state.mode = 'normal';
    this.setInput('');
    const reviewed = this.reviewCurrentArtifact('rejected', note);
    if (!reviewed || !row) return;
    const hint = redraftCliHint(
      { type: row.type, jobId: row.job_id, job_id: row.job_id, path: row.path },
      this.model.profileId
    );
    if (this.client?.state === 'ready' && !this.state.busy) {
      this.state.status = `rejected · agent redraft requested · or CLI: ${hint}`;
      this.render();
      await this.promptAgent(`Revise artifact ${row.id} (${row.path}) for job ${row.job_id} using only stored proof points. Human rejection feedback: ${note}`);
    } else {
      this.state.status = `Rejection saved · redraft next: ${hint}`;
      this.applyPendingAutoOpen();
      this.render();
    }
  }

  openReviewDocument() {
    const item = this.currentReviewItem();
    if (!item) return;
    this.state.selectedJobId = item.jobId;
    this.refresh({ disk: false });
    this.setSelectedArtifact(item.id);
    this.state.docsView = 'document';
    this.state.docsScroll = 0;
    this.state.docsDiffScroll = 0;
    this.state.docsQuery = '';
    this.state.docsMatchIndex = 0;
    this.state.overlay = 'docs';
    this.state.overlayIndex = Math.max(0, (this.model.selected?.docs || []).findIndex(doc => doc.id === item.id));
    this.state.focusTarget = this.dimensions().width < 116 ? 'viewer' : 'shell';
    this.state.status = `Documents · ${item.title}`;
    this.render();
  }

  networkGateItem() {
    return networkOverlayItems(this.model)[this.state.overlayIndex] || null;
  }

  async approveContactSelection() {
    const item = this.networkGateItem();
    if (!item) { this.state.status = 'No contact or candidate selected.'; this.render(); return; }
    if (item.kind !== 'contact') { this.state.status = 'A approves a contact row · P promotes a candidate row.'; this.render(); return; }
    if (this.state.busy) return;
    this.state.busy = 'contact-gate';
    this.state.status = `Approving ${item.id}…`;
    this.render();
    try {
      await callDomainTool(this.store, 'approve_contact', { contactId: item.id }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = 'Contact approved for human-reviewed use · JobOS sends nothing.';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Approve failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  beginSuppressContact() {
    const item = this.networkGateItem();
    if (!item) { this.state.status = 'No contact or candidate selected.'; this.render(); return true; }
    if (item.kind !== 'contact') { this.state.status = 'X suppresses a contact row · P promotes a candidate row.'; this.render(); return true; }
    this.state.pendingSuppressContactId = item.id;
    this.state.mode = 'suppress-reason';
    this.setInput('');
    this.state.status = 'Suppress reason (optional) · Enter marks do-not-use locally · Esc cancels';
    this.render();
    return true;
  }

  commitSuppressContact() {
    const contactId = this.state.pendingSuppressContactId;
    const reason = this.state.input.trim();
    this.state.mode = 'normal';
    this.setInput('');
    this.state.pendingSuppressContactId = null;
    if (!contactId) { this.render(); return; }
    try {
      suppressContact(this.store, { contactId, reason });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = 'Contact suppressed locally · value now hidden · nothing was sent.';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Suppress failed: ${error.message}`;
    }
    this.render();
  }

  async promoteCandidateSelection() {
    const item = this.networkGateItem();
    if (!item) { this.state.status = 'No contact or candidate selected.'; this.render(); return; }
    if (item.kind !== 'candidate') { this.state.status = 'P promotes a candidate row · A/X gate contact rows.'; this.render(); return; }
    if (this.state.busy) return;
    this.state.busy = 'contact-gate';
    this.state.status = `Promoting ${item.id}…`;
    this.render();
    try {
      const result = promoteStakeholder(this.store, { candidateId: item.id });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Candidate promoted → stakeholder ${result.id} · outreach not_contacted · nothing was sent.`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Promote failed: ${error.message}`;
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  openDiscoverySelection() {
    const jobId = this.state.selectedDiscoveryJobId;
    const row = jobId ? one(this.store, 'SELECT id,status FROM jobs WHERE id=?', [jobId]) : null;
    if (!row || row.status !== 'new') {
      this.refresh();
      this.state.status = 'Discovery selection is stale; queue refreshed without changes.';
      this.render();
      return;
    }
    try {
      updateJobStatus(this.store, jobId, 'saved');
      this.state.error = null;
      this.state.overlay = null;
      this.state.filter = 'all';
      this.state.selectedJobId = jobId;
      this.refresh({ disk: false });
      this.state.status = 'Discovery job saved · now selected in the main list.';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Discovery open failed: ${error.message}`;
    }
    this.render();
  }

  decideDiscovery(status) {
    const jobId = this.state.selectedDiscoveryJobId;
    const row = jobId ? one(this.store, 'SELECT id,status FROM jobs WHERE id=?', [jobId]) : null;
    if (!row || row.status !== 'new') {
      this.refresh();
      this.state.status = 'Discovery selection is stale; queue refreshed without changes.';
      this.render();
      return;
    }
    try {
      updateJobStatus(this.store, jobId, status);
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = status === 'saved' ? 'Discovery job accepted and saved.' : 'Discovery job archived.';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Discovery decision failed: ${error.message}`;
    }
    this.render();
  }

  beginStage() {
    if (!this.state.selectedJobId) {
      this.state.error = 'No job selected';
      this.state.status = 'Select a job before changing its application stage.';
      this.render();
      return;
    }
    const current = this.model.selected?.job.applicationStatus;
    const index = stageOrder.indexOf(current);
    this.state.stageIndex = index >= 0 ? index : 0;
    this.state.mode = 'stage';
    this.setInput('');
    this.state.status = 'Choose the human-tracked application stage.';
    this.render();
  }

  persistStage() {
    const status = stageOrder[this.state.stageIndex];
    const note = this.state.input.trim();
    this.state.mode = 'normal';
    this.setInput('');
    try {
      if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
      const application = one(this.store, 'SELECT id FROM applications WHERE job_id=? AND profile_id=?', [this.state.selectedJobId, this.model.profileId]);
      if (application) {
        appUpdate(this.store, application.id, status, note || undefined, { actor: 'user', source: 'tui' });
      } else {
        appCreate(this.store, this.state.selectedJobId, status, note || undefined, { actor: 'user', source: 'tui' });
      }
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = status === 'applied'
        ? 'Tracking only — JobOS did not submit this application.'
        : `Application stage tracked as ${status}.`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Application stage failed: ${error.message}`;
      this.refresh({ disk: false });
    }
    this.applyPendingAutoOpen();
    this.render();
  }

  currentDocumentLines() {
    const doc = this.selectedDocument();
    return documentLines(doc, this.state, Math.max(20, this.dimensions().width - 6), false).map(stripAnsi);
  }

  scrollDocument(delta) {
    const field = this.state.docsView === 'diff' ? 'docsDiffScroll' : 'docsScroll';
    const page = Math.max(1, this.dimensions().height - 12);
    const maximum = Math.max(0, this.currentDocumentLines().length - page);
    this.state[field] = Math.max(0, Math.min(maximum, this.state[field] + delta));
    this.render();
  }

  commitDocsSearch() {
    const query = sanitizeTerminalText(this.state.input).trim();
    this.state.docsQuery = query;
    this.state.mode = 'normal';
    this.setInput('');
    if (!query) {
      this.state.docsMatchIndex = 0;
      this.state.status = 'Search cleared.';
      this.render();
      return;
    }
    const matches = this.currentDocumentLines()
      .map((line, index) => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? index : -1)
      .filter(index => index >= 0);
    if (!matches.length) {
      this.state.docsMatchIndex = -1;
      this.state.status = `no match for "${query}".`;
    } else {
      this.state.docsMatchIndex = 0;
      const field = this.state.docsView === 'diff' ? 'docsDiffScroll' : 'docsScroll';
      this.state[field] = matches[0];
      this.state.status = `Match 1/${matches.length} for "${query}".`;
    }
    this.render();
  }

  moveDocsMatch(delta) {
    if (!this.state.docsQuery) {
      this.state.status = 'Press / to search this artifact.';
      this.render();
      return;
    }
    const matches = this.currentDocumentLines()
      .map((line, index) => line.toLocaleLowerCase().includes(this.state.docsQuery.toLocaleLowerCase()) ? index : -1)
      .filter(index => index >= 0);
    if (!matches.length) {
      this.state.docsMatchIndex = -1;
      this.state.status = `no match for "${this.state.docsQuery}".`;
    } else {
      const current = this.state.docsMatchIndex < 0 ? 0 : this.state.docsMatchIndex;
      this.state.docsMatchIndex = (current + delta + matches.length) % matches.length;
      const field = this.state.docsView === 'diff' ? 'docsDiffScroll' : 'docsScroll';
      this.state[field] = matches[this.state.docsMatchIndex];
      this.state.status = `Match ${this.state.docsMatchIndex + 1}/${matches.length} for "${this.state.docsQuery}".`;
    }
    this.render();
  }

  async openArtifactEditor(store = this.store, artifactId = this.state.selectedArtifactId, options = {}) {
    const row = one(store, 'SELECT * FROM artifacts WHERE id=?', [artifactId]);
    if (!row) {
      const error = `Unknown artifact: ${artifactId}`;
      this.state.error = error;
      this.state.status = `Editor failed: ${error}`;
      this.render();
      return { error };
    }
    const wasRaw = Boolean(this.stdin.isRaw);
    const wasPaused = this.stdin.isPaused?.() ?? true;
    this.state.editorActive = true;
    this.stdout.write(`${this.mouseEnabled ? `${ESC}?1000l${ESC}?1006l` : ''}${ESC}?25h${ESC}?1049l`);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause?.();
    let editorReadCount = 0;
    const injectedRead = options.readFile || options.readFileImpl;
    const readFileImpl = injectedRead
      ? file => editorReadCount++ === 0 ? row.content : injectedRead(file)
      : undefined;
    try {
      const result = await runArtifactEditor(store, row, {
        ...options,
        fsImpl: options.fs || options.fsImpl,
        readFileImpl,
        env: options.editor
          ? { ...(options.env || process.env), VISUAL: Array.isArray(options.editor) ? options.editor.join(' ') : String(options.editor) }
          : options.env
      });
      const exitCode = result?.exitCode ?? result?.status ?? 0;
      if (exitCode !== 0 || result?.error) {
        const message = typeof result?.error === 'string' ? result.error : (result?.error?.message || `Editor exited with status ${exitCode}`);
        this.state.error = message;
        this.state.status = `Editor failed: ${message}`;
        return result;
      }
      if (result?.changed && typeof result.content === 'string') {
        const edited = ingestEditedArtifact(store, { artifactId, content: result.content, source: 'tui' });
        this.setSelectedArtifact(edited.id);
        this.state.status = `Edited draft ingested: ${edited.title}`;
      } else {
        this.state.status = 'Editor closed with no artifact changes.';
      }
      this.state.error = null;
      return result;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Editor failed: ${error.message}`;
      return { error: error.message };
    } finally {
      this.stdout.write(`${ESC}?1049h${ESC}?25l${this.mouseEnabled ? `${ESC}?1000h${ESC}?1006h` : ''}`);
      if (this.stdin.isTTY) this.stdin.setRawMode(wasRaw);
      if (!wasPaused) this.stdin.resume?.();
      this.state.editorActive = false;
      this.refresh({ disk: false });
    }
  }

  onDocsKey(value, key) {
    if (key.name === 'escape') return this.closeTransient();
    if (key.name === 'down') return this.state.focusTarget === 'viewer' ? this.scrollDocument(1) : this.moveArtifactSelection(1);
    if (key.name === 'up') return this.state.focusTarget === 'viewer' ? this.scrollDocument(-1) : this.moveArtifactSelection(-1);
    if (value === 'j') return this.moveArtifactSelection(1);
    if (value === 'k') return this.moveArtifactSelection(-1);
    if (key.name === 'pagedown') return this.scrollDocument(Math.max(1, this.dimensions().height - 12));
    if (key.name === 'pageup') return this.scrollDocument(-Math.max(1, this.dimensions().height - 12));
    if (value === '/') {
      this.state.mode = 'docs-search';
      this.setInput('');
      this.render();
      return true;
    }
    if (value === 'n') return this.moveDocsMatch(1);
    if (value === 'N' || (key.shift && key.name === 'n')) return this.moveDocsMatch(-1);
    if (value === 'A') {
      this.state.mode = 'approve-confirm';
      this.setInput('');
      this.state.status = 'Approve current artifact revision? (y/n)';
      this.render();
      return true;
    }
    if (value === 'R') return this.beginReject();
    if (value === 'X') {
      this.state.mode = 'reject-note';
      this.setInput('');
      this.state.status = 'Reject: type feedback, then Enter to confirm.';
      this.render();
      return true;
    }
    if (value === 'B') return this.reviewCurrentArtifact('draft_needs_human_review');
    if (value === 'E') {
      void this.openArtifactEditor();
      return true;
    }
    if (value === 'V' || value === 'D') {
      this.state.docsView = this.state.docsView === 'diff' ? 'document' : 'diff';
      this.state.docsDiff = this.state.docsView === 'diff';
      const doc = selectedDoc(this.model, this.state).doc;
      this.state.status = this.state.docsView === 'diff'
        ? (doc?.previousDraft ? 'Previous draft diff.' : 'First draft · no previous draft.')
        : 'Document view.';
      this.render();
      return true;
    }
    if (value === 'I') {
      this.state.docsEvidenceExpanded = !this.state.docsEvidenceExpanded;
      this.state.status = this.state.docsEvidenceExpanded ? 'Evidence and warnings expanded.' : 'Evidence and warnings collapsed.';
      this.render();
      return true;
    }
    if (value === 'r') return this.openOverlay('review');
    return false;
  }

  beginSetupSource(kind) {
    this.state.overlay = kind === 'resume' ? 'setup-resume-source' : 'setup-job-source';
    this.state.overlayIndex = 0;
    this.state.mode = 'normal';
    this.setInput('');
    this.state.error = null;
    this.state.status = kind === 'resume'
      ? 'Choose a resume source above.'
      : 'Choose how you want to add jobs.';
    this.render();
    return true;
  }

  previewSetupResume({ filePath = '', sourceText = '', label = '' } = {}) {
    try {
      const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
      if (!profileId) throw new Error('Create your profile before adding a resume.');
      let input;
      if (filePath) {
        const extension = path.extname(filePath).toLowerCase();
        if (!RESUME_FILE_EXTENSIONS.has(extension)) {
          throw new Error('That file type is not supported. Use TXT, Markdown, JSON, YAML, or YML; paste text from PDF or DOCX.');
        }
        input = readResumeFile(profileId, filePath);
      } else {
        input = { sourceText: String(sourceText), document: parseResumeText(profileId, sourceText) };
      }
      const validation = validateResumeDocument(input.document);
      this.state.setupResumePreview = {
        ...input,
        filePath,
        label: label || filePath || 'pasted resume text',
        validation,
        claims: structuredProofs(profileId, input.sourceText, label || filePath || 'pasted resume')
      };
      this.state.overlay = 'setup-resume-preview';
      this.state.overlayIndex = 0;
      this.state.mode = 'normal';
      this.setInput('');
      this.state.error = validation.valid ? null : 'Resume details need attention';
      this.state.status = validation.valid
        ? 'Review the extraction preview · Enter imports · Esc chooses another source'
        : `Resume cannot be imported yet · ${friendlySetupText(validation.blockers[0]?.message)}`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = error.message;
    }
    this.render();
    return true;
  }

  confirmSetupResume() {
    const preview = this.state.setupResumePreview;
    if (!preview?.validation?.valid) {
      this.state.error = 'Resume details need attention';
      this.state.status = friendlySetupText(preview?.validation?.blockers?.[0]?.message || 'Choose another source and try again.');
      this.render();
      return true;
    }
    try {
      const profileId = this.state.setupProfileId || this.model.onboarding.profileId;
      createResumeRevision(this.store, {
        profileId,
        document: preview.document,
        sourceText: preview.sourceText
      });
      importResumeProofCandidates(this.store, profileId, preview.sourceText, preview.label);
      this.state.mode = 'normal';
      this.setInput('');
      this.refresh({ disk: false, render: false });
      this.refreshSetupProofItems();
      this.state.overlay = 'setup-proof-review';
      this.state.overlayIndex = 0;
      this.state.error = null;
      this.state.status = this.state.setupProofItems.length
        ? 'Resume imported · review each extracted highlight now'
        : 'Resume imported · no highlights were extracted, so press A to add one';
      this.render();
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Resume import failed: ${friendlySetupText(error.message)}`;
      this.render();
    }
    return true;
  }

  finishSetupJobImport(result, label = 'Job') {
    this.state.setupJobId = result.job.id;
    this.state.selectedJobId = result.job.id;
    this.state.mode = 'normal';
    this.setInput('');
    this.refresh({ disk: false, render: false });
    this.state.overlay = 'setup';
    this.focusNextSetupAction();
    this.state.error = null;
    this.state.status = `${label} added · the next task is highlighted`;
    this.render();
    return true;
  }

  importSetupJobText(sourceText, label = 'Pasted job') {
    try {
      const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
      const parsed = parseJob(sourceText);
      const result = importNormalized(this.store, {
        profileId,
        job: { ...parsed, description: sourceText, source: 'manual', url: '' },
        source: 'manual',
        status: 'imported'
      });
      return this.finishSetupJobImport(result, label);
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Could not add this job: ${error.message}`;
      this.render();
      return true;
    }
  }

  importSetupJobFile(filePath) {
    try {
      if (!JOB_FILE_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
        throw new Error('Choose a TXT or Markdown job description.');
      }
      const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
      const result = importText(this.store, { profileId, filePath });
      return this.finishSetupJobImport(result, 'Job file');
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Could not add this job file: ${error.message}`;
      this.render();
      return true;
    }
  }

  async importSetupJobUrl(url) {
    this.state.busy = 'job import';
    this.state.error = null;
    this.state.status = 'Reading the job page you provided…';
    this.render();
    try {
      const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
      const result = await importUrl(this.store, { profileId, url });
      this.finishSetupJobImport(result, 'Job URL');
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Could not import that URL: ${error.message}`;
      this.render();
    } finally {
      this.state.busy = null;
    }
    return true;
  }

  saveSetupDiscovery(value) {
    try {
      const [company, ...urlParts] = String(value).split('|').map(part => part.trim());
      const url = urlParts.join('|').trim();
      if (!company || !/^https?:\/\//i.test(url)) throw new Error('Enter a company name, then |, then its full careers page URL.');
      const profileId = this.state.setupProfileId || this.model.onboarding?.profileId;
      createSearch(this.store, {
        name: `${company} roles`,
        profileId,
        adapter: 'career-page',
        config: { url, companyLabel: company }
      });
      this.state.overlay = 'setup';
      this.state.mode = 'normal';
      this.setInput('');
      this.refresh({ disk: false });
      this.focusNextSetupAction();
      this.state.error = null;
      this.state.status = `Discovery saved for ${company} · press d from the dashboard whenever you want to search`;
      this.render();
    } catch (error) {
      this.state.error = error.message;
      this.state.status = error.message;
      this.render();
    }
    return true;
  }

  onOverlayKey(value, key) {
    const isEnter = key.name === 'return' || key.name === 'enter';
    const moveDelta = value === 'j' || key.name === 'down' || (key.name === 'tab' && !key.shift)
      ? 1
      : value === 'k' || key.name === 'up' || (key.name === 'tab' && key.shift) ? -1 : null;

    if (this.state.overlay === 'help') {
      if (value === '?') return this.openHelp();
      if (key.name === 'escape') return this.closeHelp();
      return true;
    }

    if (this.state.overlay === 'setup-resume-source' || this.state.overlay === 'setup-job-source') {
      const kind = this.state.overlay === 'setup-resume-source' ? 'resume' : 'job';
      const choices = kind === 'resume' ? RESUME_SOURCE_CHOICES : JOB_SOURCE_CHOICES;
      if (key.name === 'escape') {
        this.state.overlay = 'setup';
        this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === (kind === 'resume' ? 'resume' : 'intake'));
      } else if (moveDelta !== null) {
        this.state.overlayIndex = Math.max(0, Math.min(choices.length - 1, this.state.overlayIndex + moveDelta));
      } else if (isEnter) {
        const choice = choices[this.state.overlayIndex];
        if (choice?.id === 'browse') {
          this.state.setupFilePurpose = kind;
          this.setupFiles(this.state.setupBrowseCwd || homedir(), kind);
          this.state.overlay = 'setup-file-browser';
          this.state.status = 'Choose a folder or supported file';
        } else if (choice?.id === 'paste') {
          this.state.mode = kind === 'resume' ? 'setup-resume-paste' : 'setup-job-paste';
          this.setInput('');
          this.state.status = `Paste the ${kind === 'resume' ? 'resume text' : 'job description'} · Enter continues`;
        } else if (choice?.id === 'path') {
          this.state.mode = kind === 'resume' ? 'setup-resume-path' : 'setup-job-path';
          this.setInput('');
          this.state.status = 'Enter a full or relative file path · Enter continues';
        } else if (choice?.id === 'url') {
          this.state.mode = 'setup-job-url';
          this.setInput('');
          this.state.status = 'Paste the full job posting URL · Enter imports it';
        } else if (choice?.id === 'discovery') {
          this.state.mode = 'setup-discovery';
          this.setInput('');
          this.state.status = 'Enter company name | full careers page URL';
        }
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (this.state.overlay === 'setup-file-browser') {
      const items = this.state.setupFileItems || [];
      if (key.name === 'escape') return this.beginSetupSource(this.state.setupFilePurpose);
      if (moveDelta !== null && items.length) {
        this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
      } else if (isEnter) {
        const item = items[this.state.overlayIndex];
        if (item?.kind === 'directory') {
          try {
            this.setupFiles(item.id, this.state.setupFilePurpose);
            this.state.status = `Folder: ${item.id}`;
          } catch (error) {
            this.state.error = error.message;
            this.state.status = `Cannot open that folder: ${error.message}`;
          }
        } else if (item?.supported) {
          if (this.state.setupFilePurpose === 'resume') return this.previewSetupResume({ filePath: item.id, label: item.label });
          return this.importSetupJobFile(item.id);
        }
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (this.state.overlay === 'setup-resume-preview') {
      if (key.name === 'escape') return this.beginSetupSource('resume');
      if (isEnter) return this.confirmSetupResume();
      if (value === '?') return this.openHelp();
      return true;
    }

    if (this.state.overlay === 'setup-proof-review') {
      const items = this.state.setupProofItems || [];
      const item = items[this.state.overlayIndex];
      if (key.name === 'escape') {
        this.refresh({ disk: false, render: false });
        this.state.overlay = 'setup';
        this.focusNextSetupAction();
        this.state.status = 'Experience highlights reviewed · the next task is highlighted';
        this.render();
        return true;
      }
      if (moveDelta !== null && items.length) {
        this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
      } else if ((isEnter || value === 'V') && item) {
        verifyProof(this.store, item.id);
        this.refresh({ disk: false, render: false });
        this.refreshSetupProofItems();
        this.state.overlay = 'setup-proof-review';
        this.state.status = 'Highlight verified · review another, add one, or press Esc to continue';
      } else if (value === 'R' && item) {
        rejectProof(this.store, item.id);
        this.refresh({ disk: false, render: false });
        this.refreshSetupProofItems();
        this.state.overlay = 'setup-proof-review';
        this.state.status = 'Highlight rejected and excluded';
      } else if (value === 'E' && item) {
        this.state.mode = 'setup-proof';
        this.state.setupFormAction = 'replace_proof';
        this.state.setupProofId = item.id;
        this.state.setupReturnOverlay = 'setup-proof-review';
        this.setInput(`${item.summary} | ${item.evidence || ''}`);
        this.state.status = 'Edit the claim and supporting source · Enter saves';
      } else if (value === 'A') {
        this.state.mode = 'setup-proof';
        this.state.setupFormAction = 'add_proof';
        this.state.setupProofId = null;
        this.state.setupReturnOverlay = 'setup-proof-review';
        this.setInput('');
        this.state.status = 'Add an experience highlight | supporting source · Enter saves';
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (this.state.overlay === 'setup-action-picker') {
      const items = overlayItems(this.model, this.state);
      if (key.name === 'escape') {
        const stepId = this.state.setupActionStepId;
        this.state.overlay = 'setup';
        this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === stepId);
      } else if (moveDelta !== null && items.length) {
        this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
      } else if (isEnter && items[this.state.overlayIndex]) {
        const step = this.model.onboarding.steps.find(item => item.id === this.state.setupActionStepId);
        this.state.overlay = 'setup';
        return this.openSetupAction(step, items[this.state.overlayIndex]);
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (this.state.overlay === 'setup-profile-picker' || this.state.overlay === 'setup-job-picker') {
      const picker = this.state.overlay;
      const items = overlayItems(this.model, this.state);
      if (key.name === 'escape') {
        this.state.overlay = 'setup';
        this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === (picker === 'setup-profile-picker' ? 'profile' : 'decision'));
      } else if (moveDelta !== null && items.length) {
        this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
      } else if (isEnter && items[this.state.overlayIndex]) {
        if (picker === 'setup-profile-picker') {
          this.state.setupProfileId = items[this.state.overlayIndex].id;
          this.state.profileId = items[this.state.overlayIndex].id;
          this.state.setupJobId = null;
          this.state.selectedJobId = null;
        } else {
          this.state.setupJobId = items[this.state.overlayIndex].id;
          this.state.selectedJobId = items[this.state.overlayIndex].id;
        }
        this.refresh({ disk: false, render: false });
        this.state.overlay = 'setup';
        this.focusNextSetupAction();
        this.state.status = 'Selection saved · the next task is highlighted';
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (this.state.overlay === 'setup') {
      const items = this.model.onboarding?.steps || [];
      if (key.name === 'escape') return this.closeTransient();
      if (moveDelta !== null && items.length) {
        this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
      } else if (/^[1-7]$/.test(value)) {
        const target = items.filter(item => item.required)[Number(value) - 1];
        if (target) this.state.overlayIndex = items.indexOf(target);
      } else if (value === 'r') {
        this.refresh();
        this.focusNextSetupAction();
        this.state.status = 'Setup refreshed · the next task is highlighted';
        return true;
      } else if (value === 'c') {
        return this.openSetupCorrection(items[this.state.overlayIndex]);
      } else if (isEnter) {
        return this.openSetupAction(items[this.state.overlayIndex]);
      } else if (value === '?') return this.openHelp();
      this.render();
      return true;
    }

    if (key.name === 'escape') return this.closeTransient();
    if (value === '?') return this.openHelp();
    if (this.state.mode === 'build-network-field') return this.onInputKey(value, key);
    if (this.state.overlay === 'memory' && ['1', '2', '3', '4'].includes(value)) {
      this.state.memoryView = ['observations', 'proposals', 'career-brief', 'voice-guide'][Number(value) - 1];
      this.state.overlayIndex = 0;
      this.state.status = `Career Memory · ${this.state.memoryView}`;
      this.render();
      return true;
    }
    if (this.state.overlay === 'discovery') {
      if (isEnter) return this.openDiscoverySelection();
      if (moveDelta === 1) return this.moveDiscoverySelection(1);
      if (moveDelta === -1) return this.moveDiscoverySelection(-1);
      if (value === 'A') return this.decideDiscovery('saved');
      if (value === 'X') return this.decideDiscovery('archived');
      if (value === 'd') {
        void this.runAction('daily');
        return true;
      }
    }
    if (this.state.overlay === 'due' && ['1', '2', '3'].includes(value)) {
      this.state.taskFilter = TASK_FILTERS[Number(value) - 1];
      this.state.overlayIndex = 0;
      this.state.status = `Due task filter: ${this.state.taskFilter}`;
      this.render();
      return true;
    }
    if (this.state.overlay === 'review') {
      if (value === 'A') return this.reviewCurrentArtifact('approved');
      if (value === 'R') return this.beginReject();
      if (value === 'B') return this.reviewCurrentArtifact('draft_needs_human_review');
      if (value === 'E') {
        this.openReviewDocument();
        void this.openArtifactEditor();
        return true;
      }
      if (value === 'V' || value === 'I') {
        this.openReviewDocument();
        return this.onDocsKey(value, key);
      }
    }
    if (this.state.overlay === 'network') {
      if (value === 'm') {
        void this.runAction('network');
        return true;
      }
      if (value === 'A') return void this.approveContactSelection();
      if (value === 'X') return this.beginSuppressContact();
      if (value === 'P') return void this.promoteCandidateSelection();
    }
    const items = overlayItems(this.model, this.state);
    if (moveDelta !== null && items.length) {
      this.state.overlayIndex = Math.max(0, Math.min(items.length - 1, this.state.overlayIndex + moveDelta));
    } else if (isEnter && this.state.overlay === 'profile' && items[this.state.overlayIndex]) {
      this.state.profileId = items[this.state.overlayIndex].id;
      this.state.selectedJobId = null;
      this.state.overlay = null;
      this.refresh({ disk: false });
      return true;
    } else if (isEnter && this.state.overlay === 'review' && items[this.state.overlayIndex]) {
      this.openReviewDocument();
      return true;
    } else if (isEnter && this.state.overlay === 'due') {
      const task = items[this.state.overlayIndex];
      if (task?.jobId) this.selectJobInMainList(task.jobId, 'Due task · job now selected in the main list.');
      else {
        this.state.status = 'This task has no linked job.';
        this.render();
      }
      return true;
    } else if (this.state.overlay === 'build-network') {
      this.onBuildNetworkKey(value, key, items);
      return true;
    }
    this.render();
    return true;
  }

  openSetupCorrection(item) {
    const actionId = item?.actions?.[0]?.id;
    if (['resume', 'proofs', 'intake'].includes(item?.id) || (item?.id === 'profile' && actionId === 'create_profile')) {
      return this.openSetupAction(item);
    }
    const overlays = {
      profile: 'setup-profile-picker',
      intake: 'discovery',
      source: 'discovery',
      materials: 'review',
      calibration: 'memory',
      network: 'build-network',
      provider: 'system',
      browser: 'system'
    };
    const target = overlays[item?.id];
    if (target) return this.openOverlay(target);
    this.state.status = item?.actions?.[0]?.command
      ? `Correction is human-owned · ${item.actions[0].command}`
      : `No correction is needed for ${item?.id || 'this step'}.`;
    this.render();
    return true;
  }

  openSetupAction(item, selectedAction = null) {
    const action = selectedAction || item?.actions?.[0];
    const actionId = action?.id;
    if (!actionId) {
      this.state.status = `${setupStepLabel(item?.id)} has no pending action`;
      this.render();
      return true;
    }
    if (!selectedAction && item.actions.length > 1) {
      this.state.overlay = 'setup-action-picker';
      this.state.overlayIndex = 0;
      this.state.setupActionItems = item.actions;
      this.state.setupActionStepId = item.id;
      this.state.status = `Choose how to continue with ${setupStepLabel(item.id)}.`;
      this.render();
      return true;
    }
    if (actionId === 'select_profile') return this.openOverlay('setup-profile-picker');
    if (actionId === 'select_job' || actionId === 'select_current_job') return this.openOverlay('setup-job-picker');
    if (actionId === 'record_calibration') {
      this.state.mode = 'setup-calibration';
      this.setInput('');
      this.state.status = 'Describe one job decision so JobOS can preview what it learned · Enter previews';
      this.render();
      return true;
    }
    if (actionId === 'derive_calibration') {
      this.state.pendingConfirm = { kind: 'setup-calibration-derive' };
      this.state.status = 'Create preference suggestions from your saved feedback? (y/n)';
      this.render();
      return true;
    }
    if (actionId === 'review_calibration') {
      this.openOverlay('memory');
      this.state.memoryView = 'proposals';
      this.state.setupCalibrationReview = true;
      return true;
    }
    if (!selectedAction && ['verify_proof', 'replace_proof', 'retire_proof'].includes(actionId)) {
      this.state.overlay = 'setup-proof-review';
      this.state.overlayIndex = 0;
      this.refreshSetupProofItems();
      this.state.status = 'Review each experience highlight in context';
      this.render();
      return true;
    }
    if (selectedAction && actionId === 'verify_proof') {
      const proofId = String(action.command || '').match(/proof verify\s+(\S+)/)?.[1] || null;
      this.state.pendingConfirm = { kind: 'setup-proof-verify', proofId };
      this.state.status = 'Verify this experience highlight? (y/n)';
      this.render();
      return true;
    }
    if (actionId === 'score_job' || actionId === 'pursue_job') {
      this.state.pendingConfirm = { kind: 'setup-domain-action', action: actionId === 'score_job' ? 'score' : 'pursue' };
      this.state.status = `Confirm ${actionId === 'score_job' ? 'the fit check' : 'creating your local application drafts'}? (y/n)`;
      this.render();
      return true;
    }
    if (actionId === 'create_profile') {
      this.state.mode = 'setup-profile';
      this.setInput('');
      this.state.setupFormAction = actionId;
      this.state.status = 'What should JobOS call this profile? · Enter saves · Esc cancels';
      this.render();
      return true;
    }
    if (actionId === 'import_resume' || actionId === 'replace_resume') return this.beginSetupSource('resume');
    if (actionId === 'import_local_job') return this.beginSetupSource('job');
    if (['add_proof', 'replace_proof', 'retire_proof'].includes(actionId)) {
      const proofId = String(action.command).match(/proof (?:supersede|retire)\s+(\S+)/)?.[1] || null;
      this.state.mode = 'setup-proof';
      this.setInput('');
      this.state.setupFormAction = actionId;
      this.state.setupProofId = proofId;
      this.state.setupReturnOverlay = 'setup';
      this.state.status = actionId === 'retire_proof'
        ? 'Why should this highlight be removed? · Enter saves'
        : actionId === 'replace_proof'
          ? 'Edit the experience highlight | supporting source · Enter saves'
          : 'Add an experience highlight | supporting source · Enter saves';
      this.render();
      return true;
    }
    this.state.status = action?.command
      ? `Open the related screen to continue: ${friendlySetupText(action.label)}`
      : `Nothing else is needed for ${setupStepLabel(item?.id)}.`;
    this.render();
    return true;
  }

  commitSetupForm() {
    const actionId = this.state.setupFormAction;
    const input = this.state.input.trim();
    if (!input) {
      this.state.error = 'Input is required';
      this.state.status = 'Please enter a value before continuing.';
      this.render();
      return true;
    }
    try {
      if (actionId === 'create_profile') {
        const result = createProfile(this.store, input);
        this.state.setupProfileId = result.profile.id;
        this.state.profileId = result.profile.id;
      } else if (actionId === 'add_proof') {
        const [summary, ...evidenceParts] = input.split('|').map(part => part.trim());
        if (!summary) throw new Error('An experience highlight is required.');
        addProof(this.store, this.state.setupProfileId || this.model.onboarding.profileId, summary, evidenceParts.join(' | '), []);
      } else if (actionId === 'replace_proof') {
        const [summary, ...evidenceParts] = input.split('|').map(part => part.trim());
        supersedeProof(this.store, this.state.setupProofId, { summary, evidence: evidenceParts.join(' | ') });
      } else if (actionId === 'retire_proof') {
        retireProof(this.store, this.state.setupProofId, input);
      }
      const returnOverlay = this.state.setupReturnOverlay;
      this.state.mode = 'normal';
      this.setInput('');
      this.state.setupFormAction = null;
      this.state.setupProofId = null;
      this.state.setupReturnOverlay = null;
      this.state.error = null;
      this.state.overlay = returnOverlay || 'setup';
      this.refresh({ disk: false, render: false });
      if (this.state.overlay === 'setup-proof-review') this.refreshSetupProofItems();
      else this.focusNextSetupAction();
      this.state.status = `${friendlySetupText(actionId).replaceAll('_', ' ')} complete · continue with the highlighted task`;
      this.render();
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Could not save: ${friendlySetupText(error.message)} · correct the input and retry`;
      this.render();
    }
    return true;
  }

  async previewSetupCalibration() {
    try {
      const parsed = JSON.parse(this.state.input);
      const profileId = this.state.setupProfileId || this.model.onboarding.profileId;
      const jobId = String(parsed.jobId || this.state.setupJobId || '');
      const sequence = Number(one(this.store, 'SELECT COUNT(*) AS count FROM career_memory_observations WHERE profile_id=?', [profileId])?.count || 0) + 1;
      const feedback = {
        schema: 'jobos.job-feedback-input.v1',
        decision: parsed.decision,
        reasonCodes: parsed.reasonCodes,
        signals: parsed.signals || [],
        publicExplanation: parsed.publicExplanation || '',
        privateNote: parsed.privateNote || '',
        referenceId: `tui-setup-calibration:${profileId}:${jobId}:${sequence}`,
        occurredAt: this.now().toISOString()
      };
      await callDomainTool(this.store, 'record_job_feedback', { profileId, jobId, feedback, validateOnly: true }, { source: 'tui' });
      this.state.pendingConfirm = { kind: 'setup-calibration-feedback', profileId, jobId, feedback };
      this.state.mode = 'normal';
      this.state.error = null;
      this.state.status = `Preview · job ${jobId} · ${feedback.decision} · reasons ${feedback.reasonCodes.join(',')} · private note ${feedback.privateNote ? 'present' : 'absent'} · confirm? (y/n)`;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Calibration preview failed: ${error.message} · correct the JSON and retry`;
    }
    this.render();
  }

  async commitSetupCalibration(confirm) {
    try {
      await callDomainTool(this.store, 'record_job_feedback', {
        profileId: confirm.profileId, jobId: confirm.jobId, feedback: confirm.feedback, validateOnly: false
      }, { source: 'tui' });
      this.state.error = null;
      this.state.overlay = 'setup';
      this.refresh({ disk: false });
      this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === 'calibration');
      this.state.status = 'Calibration feedback recorded · proposal derivation remains explicit';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Calibration recording failed: ${error.message}`;
      this.render();
    }
  }

  async deriveSetupCalibration() {
    try {
      const profileId = this.state.setupProfileId || this.model.onboarding.profileId;
      await callDomainTool(this.store, 'derive_memory_proposals', {
        profileId, asOf: this.now().toISOString(), dryRun: false
      }, { source: 'tui' });
      this.state.error = null;
      this.state.overlay = 'setup';
      this.refresh({ disk: false });
      this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === 'calibration');
      this.state.status = 'Preference suggestions are ready · review each one before accepting';
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `Could not create preference suggestions: ${error.message}`;
      this.render();
    }
  }

  onBuildNetworkKey(value, key, items) {
    const item = items[this.state.overlayIndex];
    if (!item) return this.render();
    const isEnter = key.name === 'return' || key.name === 'enter';
    // b always triggers save-and-build from anywhere in the overlay
    if (value === 'b') return void this.buildNetworkSaveAndBuild();
    if (!isEnter) return this.render();
    if (item.type === 'toggle') {
      const draft = this.state.networkDraft;
      if (draft) {
        const field = item.key === 'sourcePublic' ? 'sourcePublic' : item.key === 'sourceLinkedin' ? 'sourceLinkedin' : 'sourceXai';
        draft[field] = !draft[field];
        this.state.status = `${item.label} ${draft[field] ? 'on' : 'off'}`;
      }
      this.render();
      return;
    }
    if (item.type === 'list') {
      // Enter edit mode: seed input with current value
      const draftKey = item.key;
      this.state.mode = 'build-network-field';
      this.setInput(this.state.networkDraft?.[draftKey] || '');
      if (this.state.networkDraft) this.state.networkDraft._editingKey = draftKey;
      this.state.status = `editing ${item.label} · Enter commits · Esc cancels`;
      this.render();
      return;
    }
    if (item.type === 'action' && item.action === 'saveOnly') return void this.buildNetworkSaveOnly();
    if (item.type === 'action' && item.action === 'saveBuild') return void this.buildNetworkSaveAndBuild();
    this.render();
  }

  onInputKey(value, key) {
    if (this.state.mode === 'approve-confirm') {
      if (value === 'y') { void this.commitArtifactReview('approved'); return true; }
      this.state.mode = 'normal';
      this.state.status = 'Approval cancelled.';
      this.render();
      return true;
    }
    if (this.state.mode === 'reject-confirm') {
      if (value === 'y') { void this.commitArtifactReview('rejected'); return true; }
      this.state.mode = 'normal';
      this.setInput('');
      this.state.status = 'Rejection cancelled.';
      this.render();
      return true;
    }

    const input = String(this.state.input || '');
    let cursor = Math.max(0, Math.min(input.length, Number(this.state.inputCursor ?? input.length)));
    let anchor = this.state.inputAnchor == null ? null : Math.max(0, Math.min(input.length, Number(this.state.inputAnchor)));
    const selection = () => anchor == null || anchor === cursor ? null : [Math.min(anchor, cursor), Math.max(anchor, cursor)];
    const replaceSelection = replacement => {
      const range = selection() || [cursor, cursor];
      this.state.input = `${this.state.input.slice(0, range[0])}${replacement}${this.state.input.slice(range[1])}`;
      this.state.inputCursor = range[0] + replacement.length;
      this.state.inputAnchor = null;
    };
    const moveCursor = target => {
      const bounded = Math.max(0, Math.min(this.state.input.length, target));
      if (key.shift) {
        if (this.state.inputAnchor == null) this.state.inputAnchor = cursor;
      } else {
        this.state.inputAnchor = null;
      }
      this.state.inputCursor = bounded;
    };

    if (key.name === 'escape') {
      if (String(this.state.mode).startsWith('setup-')) {
        const returnOverlay = this.state.setupReturnOverlay;
        this.state.mode = 'normal';
        this.state.setupFormAction = null;
        this.state.setupProofId = null;
        this.state.setupReturnOverlay = null;
        this.setInput('');
        if (returnOverlay) this.state.overlay = returnOverlay;
        this.state.status = 'Edit cancelled · choose another option';
        this.render();
        return true;
      }
      return this.closeTransient();
    }
    if (key.ctrl && key.name === 'a') {
      this.state.inputAnchor = 0;
      this.state.inputCursor = this.state.input.length;
      this.render();
      return true;
    }
    if (key.name === 'left') {
      const range = selection();
      moveCursor(!key.shift && range ? range[0] : cursor - 1);
      this.render();
      return true;
    }
    if (key.name === 'right') {
      const range = selection();
      moveCursor(!key.shift && range ? range[1] : cursor + 1);
      this.render();
      return true;
    }
    if (key.name === 'home') {
      moveCursor(0);
      this.render();
      return true;
    }
    if (key.name === 'end') {
      moveCursor(this.state.input.length);
      this.render();
      return true;
    }
    if (key.name === 'backspace') {
      if (selection()) replaceSelection('');
      else if (cursor > 0) {
        this.state.input = `${this.state.input.slice(0, cursor - 1)}${this.state.input.slice(cursor)}`;
        this.state.inputCursor = cursor - 1;
        this.state.inputAnchor = null;
      }
      this.render();
      return true;
    }
    if (key.name === 'delete') {
      if (selection()) replaceSelection('');
      else if (cursor < this.state.input.length) {
        this.state.input = `${this.state.input.slice(0, cursor)}${this.state.input.slice(cursor + 1)}`;
        this.state.inputCursor = cursor;
        this.state.inputAnchor = null;
      }
      this.render();
      return true;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const text = this.state.input.trim();
      const mode = this.state.mode;
      if (['setup-profile', 'setup-proof'].includes(mode)) return this.commitSetupForm();
      if (mode === 'setup-resume-path') return this.previewSetupResume({ filePath: text, label: path.basename(text) });
      if (mode === 'setup-resume-paste') return this.previewSetupResume({ sourceText: this.state.input, label: 'pasted resume text' });
      if (mode === 'setup-job-path') return this.importSetupJobFile(text);
      if (mode === 'setup-job-paste') return this.importSetupJobText(this.state.input);
      if (mode === 'setup-job-url') {
        void this.importSetupJobUrl(text);
        return true;
      }
      if (mode === 'setup-discovery') return this.saveSetupDiscovery(this.state.input);
      if (mode === 'setup-calibration') {
        void this.previewSetupCalibration();
        return true;
      }
      if (mode === 'review-note') {
        void this.submitReviewNote();
        return true;
      }
      if (mode === 'reject-note') {
        if (!text) {
          this.state.status = 'Rejection feedback is required.';
          this.render();
          return true;
        }
        this.state.mode = 'reject-confirm';
        this.state.status = 'Confirm rejection? (y/n)';
        this.render();
        return true;
      }
      if (mode === 'stage-note') {
        this.persistStage();
        return true;
      }
      if (mode === 'docs-search') {
        this.commitDocsSearch();
        return true;
      }
      if (mode === 'suppress-reason') {
        this.commitSuppressContact();
        return true;
      }
      this.state.mode = 'normal';
      this.setInput('');
      if (mode === 'agent' && text) void this.promptAgent(text);
      else if (mode === 'command') this.executeCommand(`${this.state.commandPrefix || ':'}${text}`);
      else if (mode === 'build-network-field' && this.state.networkDraft) {
        const editKey = this.state.networkDraft._editingKey;
        if (editKey) this.state.networkDraft[editKey] = text;
        this.state.networkDraft._editingKey = null;
        this.state.status = `${editKey || 'field'} updated`;
      }
      this.render();
      return true;
    }
    if (!key.ctrl && !key.meta && value) {
      const multiline = ['setup-resume-paste', 'setup-job-paste'].includes(this.state.mode);
      const inserted = String(value)
        .replace(/\r\n?/g, '\n')
        .split('')
        .filter(character => character === '\n' ? multiline : character >= ' ')
        .join('');
      if (inserted) {
        replaceSelection(inserted);
        this.render();
      }
    }
    return true;
  }

  onConfirmKey(value, key) {
    const confirm = this.state.pendingConfirm;
    if (!confirm) return false;
    if (value === 'n' || key.name === 'escape') {
      this.state.pendingConfirm = null;
      this.state.status = 'Discard cancelled; feedback preserved.';
      this.render();
      return true;
    }
    if (value === 'y' || key.name === 'return' || key.name === 'enter') {
      this.state.pendingConfirm = null;
      this.state.mode = 'normal';
      this.setInput('');
      if (confirm.kind === 'setup-domain-action') {
        void this.runAction(confirm.action);
        return true;
      }
      if (confirm.kind === 'setup-calibration-feedback') {
        void this.commitSetupCalibration(confirm);
        return true;
      }
      if (confirm.kind === 'setup-calibration-derive') {
        void this.deriveSetupCalibration();
        return true;
      }
      if (confirm.kind === 'setup-proof-verify') {
        try {
          verifyProof(this.store, confirm.proofId);
          this.state.overlay = 'setup';
          this.refresh({ disk: false });
          this.state.overlayIndex = this.model.onboarding.steps.findIndex(step => step.id === 'proofs');
          this.state.error = null;
          this.state.status = `Experience highlight verified · setup refreshed`;
        } catch (error) {
          this.state.error = error.message;
          this.state.status = `Proof verification failed: ${error.message}`;
          this.render();
        }
        return true;
      }
      if (confirm.kind === 'setup-memory-transition') {
        const guided = this.state.setupCalibrationReview;
        this.state.setupCalibrationReview = false;
        this.executeMemoryCommand(confirm.argText);
        this.state.setupCalibrationReview = guided;
        return true;
      }
      if (confirm.kind === 'editor-with-note' || confirm.next === 'editor') void this.openArtifactEditor();
      else this.applyPendingAutoOpen();
      this.state.status = confirm.kind === 'editor-with-note' ? 'Feedback discarded; opening editor.' : 'Feedback discarded.';
      this.render();
      return true;
    }
    return true;
  }

  onStageKey(value, key) {
    if (key.name === 'escape') {
      this.state.mode = 'normal';
      this.setInput('');
      this.state.status = 'Stage change cancelled.';
      this.applyPendingAutoOpen();
      this.render();
      return true;
    }
    if (key.name === 'left' || value === 'h') this.state.stageIndex = (this.state.stageIndex - 1 + stageOrder.length) % stageOrder.length;
    else if (key.name === 'right' || value === 'l') this.state.stageIndex = (this.state.stageIndex + 1) % stageOrder.length;
    else if (key.name === 'return' || key.name === 'enter') {
      const status = stageOrder[this.state.stageIndex];
      if (!validStatuses.has(status)) {
        this.state.mode = 'normal';
        this.state.error = `Invalid status: ${status}`;
        this.state.status = `Invalid status: ${status}`;
      } else {
        this.state.mode = 'stage-note';
        this.setInput('');
        this.state.status = `Optional note for ${status}.`;
      }
    }
    this.render();
    return true;
  }

  onKeypress(value, key = {}) {
    if (key.ctrl && key.name === 'c') return void this.stop();
    if (value === 'Q' || (key.shift && key.name === 'q')) return void this.stop();
    if (!this.state.overlay && this.state.focusTarget === 'details' && this.state.mode === 'normal') {
      if (key.name === 'escape') return this.leaveDetailsFocus();
      if (value === 'e') {
        this.state.detailsExpanded = false;
        this.state.detailsScroll = 0;
        this.state.focusTarget = 'shell';
        this.state.status = 'Technical details hidden.';
        this.render();
        return true;
      }
      if (key.name === 'up' || value === 'k') return this.scrollDetails(-1);
      if (key.name === 'down' || value === 'j') return this.scrollDetails(1);
      if (key.name === 'pageup') return this.scrollDetails(-Math.max(1, this.dimensions().height - 12));
      if (key.name === 'pagedown') return this.scrollDetails(Math.max(1, this.dimensions().height - 12));
    }
    if (!this.state.overlay && this.state.focusTarget === 'agent' && this.state.mode === 'normal') {
      if (key.name === 'escape' || key.name === 'tab') return this.toggleAgentFocus();
      if (key.name === 'up' || key.name === 'pageup' || value === 'k') return this.scrollAgent(key.name === 'pageup' ? 10 : 1);
      if (key.name === 'down' || key.name === 'pagedown' || value === 'j') return this.scrollAgent(key.name === 'pagedown' ? -10 : -1);
    }
    if (this.state.overlay === 'docs' && key.ctrl && key.name === 'a') {
      if (this.dimensions().width >= 116) {
        this.state.focusTarget = this.state.focusTarget === 'viewer' ? 'shell' : 'viewer';
        this.state.status = `Artifact focus: ${this.state.focusTarget}.`;
      } else {
        this.state.focusTarget = 'viewer';
      }
      this.render();
      return true;
    }
    if (this.state.pendingConfirm) return this.onConfirmKey(value, key);
    if (this.state.mode === 'review-note' && key.ctrl && key.name === 'e' && this.state.input) {
      this.state.pendingConfirm = { kind: 'editor-with-note', next: 'editor' };
      this.render();
      return true;
    }
    if ([
      'review-note', 'stage-note', 'docs-search', 'command', 'agent', 'approve-confirm',
      'reject-confirm', 'reject-note', 'suppress-reason', 'build-network-field',
      'setup-profile', 'setup-file', 'setup-proof', 'setup-calibration',
      'setup-resume-path', 'setup-resume-paste', 'setup-job-path', 'setup-job-paste',
      'setup-job-url', 'setup-discovery'
    ].includes(this.state.mode)) return this.onInputKey(value, key);
    if (this.state.mode === 'stage') return this.onStageKey(value, key);
    if (this.docsViewerActive()) {
      const handled = this.onDocsKey(value, key);
      if (handled !== false) return handled;
    }
    if (this.state.overlay === 'docs' && (
      ['j', 'k'].includes(value) || ['up', 'down'].includes(key.name)
      || ['A', 'R', 'B', 'E', 'V', 'I', 'D', 'X'].includes(value)
    )) return this.onDocsKey(value, key);
    if (this.state.overlay) return this.onOverlayKey(value, key);
    if (key.name === 'escape') return this.closeTransient();
    if (value === 'h') this.cycleStripFocus(-1);
    else if (value === 'j' || key.name === 'down') this.moveSelection(1);
    else if (value === 'k' || key.name === 'up') this.moveSelection(-1);
    else if (value === '1') { this.state.filter = 'today'; this.refresh({ disk: false }); }
    else if (value === '2') { this.state.filter = 'all'; this.refresh({ disk: false }); }
    else if (value === '3') { this.state.filter = 'high'; this.refresh({ disk: false }); }
    else if (value === '4') { this.state.filter = 'review'; this.refresh({ disk: false }); }
    else if (value === '5') { this.state.filter = 'materials-ready'; this.refresh({ disk: false }); }
    else if (value === '6') { this.state.filter = 'applied'; this.refresh({ disk: false }); }
    else if (value === '7') { this.state.filter = 'interview'; this.refresh({ disk: false }); }
    else if (value === 'a') {
      this.state.agentOn = !this.state.agentOn;
      this.state.status = `agent ${this.state.agentOn ? 'on' : 'off'} · Esc never hides it`;
      if (this.state.agentOn && !this.client) void this.connectAgent();
      this.render();
    } else if (value === ':') {
      this.state.mode = 'command';
      this.state.commandPrefix = ':';
      this.setInput('');
      this.render();
    } else if (value === '/') {
      this.state.mode = 'command';
      this.state.commandPrefix = '/';
      this.setInput('');
      this.render();
    } else if (value === 'i') {
      this.state.agentOn = true;
      this.state.focusTarget = 'agent';
      this.state.agentScroll = 0;
      this.state.mode = 'agent';
      this.setInput('');
      this.render();
    } else if (value === 't') this.beginStage();
    else if (value === 'r') this.openOverlay('review');
    else if (value === 'l') this.openOverlay('log');
    else if (value === 'm') this.openOverlay('memory');
    else if (value === 'n') this.openOverlay('network');
    else if (value === 'o') this.openDocuments();
    else if (value === 'q') this.openOverlay('answers');
    else if (value === 's') this.openOverlay('discovery');
    else if (value === '?') this.openHelp();
    else if (value === 'v') this.openOverlay('profile');
    else if (value === 'b') this.openOverlay('build-network');
    else if (value === 'e') {
      if (this.state.detailsExpanded) {
        this.state.focusTarget = 'details';
        this.state.status = 'Technical details focused · ↑/↓ scrolls; Esc restores job navigation.';
      } else {
        this.state.detailsExpanded = true;
        this.state.detailsScroll = 0;
        this.state.focusTarget = 'details';
        this.state.status = 'Technical details shown and focused · ↑/↓ scrolls; Esc restores job navigation.';
      }
      this.render();
    }
    else if (value === 'p') void this.runAction('pursue');
    else if (value === 'z') void this.runAction('score');
    else if (value === 'd') void this.runAction('daily');
    else if (value === 'g') this.openSetupOverlay();
    else if (value === 'c') void this.connectAgent();
    else if (value === 'x' && this.client?.state === 'working') {
      this.client.cancel();
      void this.persistAgentSession(null).catch(() => {});
      this.state.status = 'cancelling agent turn';
      this.render();
    } else if (key.name === 'tab') this.toggleAgentFocus();
    else if (key.name === 'left') this.cycleStripFocus(-1);
    else if (key.name === 'right') this.cycleStripFocus(1);
    else if (key.name === 'return' || key.name === 'enter') this.jumpToStripJob();
    return true;
  }

  async start() {
    if (!this.stdin.isTTY || !this.stdout.isTTY) throw Error('JobOS TUI requires a terminal. Use `jobos tui --snapshot` for a non-interactive state view.');
    if (this.mouseEnabled) {
      this.keypressInput = new PassThrough();
      readline.emitKeypressEvents(this.keypressInput);
      this.keypressInput.on('keypress', this.boundKeypress);
      this.stdin.on('data', this.boundRawInput);
    } else {
      readline.emitKeypressEvents(this.stdin);
      this.stdin.on('keypress', this.boundKeypress);
    }
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdout.on('resize', this.boundResize);
    this.stdout.write(`${ESC}?1049h${ESC}?25l${this.mouseEnabled ? `${ESC}?1000h${ESC}?1006h` : ''}`);
    this.render();
    this.refreshTimer = setInterval(() => {
      if (!this.state.busy && !this.state.editorActive) {
        try { this.refresh(); } catch (error) {

          this.state.error = error.message;
          this.state.status = `refresh failed: ${error.message}`;
          this.render();
        }
      }
    }, 2500);
    this.refreshTimer.unref?.();
    if (this.shouldConnectAgent) void this.connectAgent();
    else {
      this.state.agentState = 'offline';
      this.state.status = 'agent connection disabled for this launch';
      this.render();
    }
    await new Promise(resolve => { this.resolveStop = resolve; });
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.refreshTimer);
    if (this.mouseEnabled) {
      this.stdin.off('data', this.boundRawInput);
      this.keypressInput?.off('keypress', this.boundKeypress);
      this.keypressInput?.destroy();
      this.keypressInput = null;
    } else {
      this.stdin.off('keypress', this.boundKeypress);
    }
    this.stdout.off('resize', this.boundResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause?.();
    if (this.client) await this.client.stop();
    await this.sessionPersistence.catch(() => {});
    this.stdout.write(`${this.mouseEnabled ? `${ESC}?1000l${ESC}?1006l` : ''}${ESC}?25h${ESC}?1049l`);
    this.resolveStop?.();
  }
}

export async function startTui(store, options = {}) {
  const tui = new JobosTui(store, options);
  await tui.start();
  return tui;
}
