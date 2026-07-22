import stripAnsiText from 'strip-ansi';
import stringWidth from 'string-width';
import sliceAnsi from 'slice-ansi';
import readline from 'node:readline';
import { buildTuiModel } from './tui-model.js';
import { callDomainTool, selectedJobContext } from './domain-tools.js';
import { all, one, reload } from './db.js';
import { AcpClient, agentBackendCatalog, jobosMcpServer } from './acp.js';
import { setNetworkIntent } from './profiles.js';
import { createResearchRun, executeResearchRun } from './research/runs.js';
import { suppressContact, promoteStakeholder } from './research/contacts.js';
import { validStatuses, appCreate, appUpdate } from './tracking.js';
import { reviewArtifact, ingestEditedArtifact } from './artifacts.js';
import { readinessPacketSummary } from './packets.js';
import { updateJobStatus } from './jobs.js';
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
  inverse: `${ESC}7m`
};
export const FILTERS = ['today', 'all', 'high', 'review', 'materials-ready', 'applied', 'interview'];
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
    ['j/k', 'select'], ['1', 'today'], ['2', 'all'], ['3', 'high'],
    ['4', 'review'], ['5', 'materials-ready'], ['6', 'applied'], ['7', 'interview'],
    ['p', 'pursue'], ['z', 'score'], ['d', 'daily'], ['a', 'agent'], ['i', 'prompt'],
    ['r', 'review'], ['l', 'log'], ['n', 'network'], ['o', 'docs'], ['q', 'answers'],
    ['s', 'sources'], ['?', 'system'], ['b', 'build-network'], [':', 'command'], ['Q', 'quit'],
    ['Tab', 'strip'], ['Enter', 'jump']
  ]),
  review: Object.freeze([['j/k', 'select'], ['Enter', 'open'], ['A', 'approve'], ['R', 'reject'], ['B', 'draft'], ['E', 'editor'], ['V', 'diff'], ['I', 'evidence'], ['Esc', 'close']]),
  docs: Object.freeze([['j/k', 'artifact'], ['A', 'approve'], ['R', 'reject'], ['B', 'draft'], ['E', 'editor'], ['V', 'diff'], ['I', 'evidence'], ['/', 'search'], ['n/N', 'match'], ['↑/↓', 'scroll'], ['Ctrl+A', 'focus'], ['Esc', 'close']]),
  discovery: Object.freeze([['j/k', 'select'], ['Enter', 'open'], ['A', 'accept'], ['X', 'archive'], ['d', 'daily'], ['Esc', 'close']]),
  network: Object.freeze([['j/k', 'select'], ['m', 'map'], ['A', 'approve'], ['X', 'suppress'], ['P', 'promote'], ['Esc', 'close']]),
  due: Object.freeze([['j/k', 'select'], ['1', 'all'], ['2', 'followup'], ['3', 'review'], ['Enter', 'jump'], ['Esc', 'close']]),
  stage: Object.freeze([['←/→', 'stage'], ['Enter', 'note'], ['Esc', 'cancel']])
});

/**
 * Atomic keys each KEYMAP binding expands to. Used by invariant tests so
 * advertised keys stay a subset of live handlers (no silent KEYMAP lies).
 * Tokens: plain char, 'up'|'down'|'left'|'right'|'return'|'escape', or 'ctrl+a'.
 */
export const TUI_HANDLED_KEYS = Object.freeze({
  global: Object.freeze(['j', 'k', '1', '2', '3', '4', '5', '6', '7', 'p', 'z', 'd', 'a', 'i', 'r', 'l', 'n', 'o', 'q', 's', '?', 'b', ':', 'Q', 'tab', 'return']),
  review: Object.freeze(['j', 'k', 'return', 'A', 'R', 'B', 'E', 'V', 'I', 'escape']),
  docs: Object.freeze(['j', 'k', 'A', 'R', 'B', 'E', 'V', 'I', '/', 'n', 'N', 'up', 'down', 'ctrl+a', 'escape', 'D', 'X']),
  discovery: Object.freeze(['j', 'k', 'return', 'A', 'X', 'd', 'escape']),
  network: Object.freeze(['j', 'k', 'm', 'A', 'X', 'P', 'escape']),
  due: Object.freeze(['j', 'k', '1', '2', '3', 'return', 'escape']),
  stage: Object.freeze(['left', 'right', 'h', 'l', 'return', 'escape'])
});

/** Expand a KEYMAP binding label into handler tokens from TUI_HANDLED_KEYS. */
export function expandKeymapBinding(binding) {
  const table = {
    'j/k': ['j', 'k'],
    'n/N': ['n', 'N'],
    '↑/↓': ['up', 'down'],
    '←/→': ['left', 'right', 'h', 'l'],
    'Ctrl+A': ['ctrl+a'],
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
  if (token === 'up' || token === 'down' || token === 'left' || token === 'right') {
    return { value: '', key: { name: token } };
  }
  if (token === 'N') return { value: 'N', key: { name: 'n', shift: true } };
  if (token === 'Q') return { value: 'Q', key: { name: 'q', shift: true } };
  if (token.length === 1 && token >= 'A' && token <= 'Z') {
    return { value: token, key: { name: token.toLowerCase(), shift: true } };
  }
  return { value: token, key: { name: token.length === 1 ? token.toLowerCase() : token } };
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

function panel(title, body, width, color) {
  const inner = Math.max(1, width - 2);
  const topLabel = ` ${title} `;
  const top = `┌${topLabel}${'─'.repeat(Math.max(0, inner - topLabel.length))}┐`;
  const rows = body.map(line => `│${fit(line, inner)}│`);
  return [paint(top, 'green', color), ...rows, paint(`└${'─'.repeat(inner)}┘`, 'green', color)];
}

function mergeColumns(columns, widths, color, separator = '│') {
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
  if (receiptState === 'none') return 'next submit externally, then :attest <rfc3339> (or :attest for now)';
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
  const lines = [
    paint(`READINESS ${status} · ${readiness?.readyForReview ? 'reviewable' : 'not reviewable'}${localApprovalComplete ? ' · locally approved' : ''}${packetState}`, status === 'approved' ? 'green' : (status === 'blocked' ? 'bad' : 'warn'), color),
    crop(`next ${typeof next === 'string' ? next : JSON.stringify(next)}`, width)
  ];
  if (blockers.length) lines.push(...wrap(`blockers ${blockers.length} · ${blockers[0].code || blockers[0]}`, width).slice(0, 1).map(line => paint(line, 'bad', color)));
  if (warnings.length) lines.push(...wrap(`warnings ${warnings.length} · ${warnings[0].code || warnings[0]}`, width).slice(0, 1).map(line => paint(line, 'warn', color)));
  return lines;
}

function policyLines(policy, width, color) {
  const values = Object.entries(policy || {});
  if (!values.length) return [paint('POLICY local review gate enforced', 'muted', color)];
  return [
    paint('POLICY', 'cyan', color),
    ...values.flatMap(([key, value]) => wrap(`${key} ${typeof value === 'string' ? value : JSON.stringify(value)}`, width)).slice(0, 2)
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
  const agentState = state.agentOn ? state.agentState : 'off';
  if (width < 140) {
    const profile = model.profile?.name || 'no profile';
    const compact = ` JOBOS · FX:OFF · A:${agentState} · O${model.counts.open} H${model.counts.high} D${model.counts.due} R${model.counts.drafts} IV${model.counts.interviews} · ${profile} `;
    return paint(fit(compact, width), 'green', color);
  }
  const profile = model.profile ? `${model.profile.name} (${model.profile.id})` : 'no profile';
  const counts = `open ${model.counts.open} · high ${model.counts.high} · due ${model.counts.due} · drafts ${model.counts.drafts} · iv ${model.counts.interviews}`;
  const left = ` JOBOS · ${profile} `;
  const right = ` ${counts} · review · log · agent:${agentState} · sources · system · side-effects:off `;
  const gap = Math.max(1, width - left.length - right.length);
  return paint(fit(`${left}${' '.repeat(gap)}${right}`, width), 'green', color);
}

function priorityLines(model, state, width, color) {
  const focused = state.stripIndex || 0;
  if (width < 100) {
    return model.priority.map((item, index) => paint(fit(`${index === focused ? '▶' : ' '}[${item.kind.toUpperCase()}] ${item.text}`, width), item.kind === 'failure' ? 'bad' : (item.kind === 'new' ? 'green' : 'warn'), color));
  }
  const gap = 1;
  const cardWidth = Math.floor((width - gap * 3) / 4);
  const cards = model.priority.map((item, index) => {
    const label = `${index === focused ? '▶ ' : ''}${item.kind.toUpperCase()}`;
    return [
      paint(`┌${fit(` ${label} `, cardWidth - 2, 'left')}┐`, item.kind === 'failure' ? 'bad' : 'green', color),
      `│${fit(item.text, cardWidth - 2)}│`,
      paint(`└${'─'.repeat(cardWidth - 2)}┘`, item.kind === 'failure' ? 'bad' : 'green', color)
    ];
  });
  return mergeColumns(cards, cards.map(() => cardWidth), color, ' ');
}

function listPanel(model, state, width, height, color) {
  const jobs = filteredJobs(model, state.filter);
  const filters = FILTERS.map(name => name === state.filter ? `[${name}]` : name).join(' · ');
  const body = wrap(filters, width - 4).map(line => paint(line, 'cyan', color));
  if (model.empty.noProfile) {
    body.push('', 'No profile yet.', 'Run:', 'jobos profile create "PM EdTech"', '', 'Then import a job or run daily.');
  } else if (!jobs.length) {
    body.push('', ...(model.empty.noJobs ? ['No jobs yet.', 'Workspace healthy and empty.'] : [`No jobs in filter: ${state.filter}`]), '', 'Press d for daily discovery', 'Import a job through CLI.');
  } else {
    const selectedId = model.selectedJobId;
    const maxCards = Math.max(1, Math.floor((height - 5) / 4));
    let start = Math.max(0, jobs.findIndex(job => job.id === selectedId) - Math.floor(maxCards / 2));
    start = Math.min(start, Math.max(0, jobs.length - maxCards));
    for (const job of jobs.slice(start, start + maxCards)) {
      const selected = job.id === selectedId;
      const fitScore = job.fitScore == null ? '—' : String(job.fitScore);
      const title = `${selected ? '▶' : ' '} ${job.title}`;
      body.push(paint(crop(`${title}  ${fitScore}${job.highFit ? ' high' : ''}`, width - 4), selected ? 'green' : 'reset', color));
      body.push(crop(`  ${job.company} · ${job.location || 'location —'} · live:${job.liveness?.status || 'uncertain'} · ${job.stageSource}:${job.stage}`, width - 4));
      body.push(paint(crop(`  next ${job.next?.title || 'No open task'}`, width - 4), job.next ? 'warn' : 'muted', color));
      body.push(paint(crop(`  ${job.signals.proofs} proofs · ${job.signals.artifacts} drafts · path ${job.signals.path}`, width - 4), 'muted', color));
    }
  }
  return panel(`JOBS · ${state.filter}`, body.slice(0, Math.max(1, height - 2)), width, color);
}

function detailPanel(model, width, height, color) {
  const item = model.selected;
  if (!item) return panel('SELECTED JOB', ['No job selected.', '', 'JobOS will show real local state here after import.'], width, color);
  const fitScore = item.fit?.overall ?? '—';
  const fitMeta = item.fit ? `${item.fit.mode} · ${item.fit.confidence || 'confidence —'}` : 'not scored';
  const next = item.next[0];
  const compensation = item.job.compensation?.text || 'compensation —';
  const employmentTypes = item.job.employmentTypes?.length ? item.job.employmentTypes.join(',') : 'type —';
  const proofs = item.proofs.length ? item.proofs.map(proof => `${proof.id} ${proof.summary}`) : ['No matched proof IDs yet'];
  const artifacts = item.docs.length ? item.docs.map(doc => `${doc.type} · ${doc.approvalStatus} · r${doc.revision} · ${doc.path}`) : ['No artifacts — pursue to stage drafts'];
  const stages = item.stages.map(stage => `${stage.name}:${stage.state}`).join('  ');
  const lines = [
    paint(`${item.job.title}`, 'green', color),
    `${item.job.company} · ${item.job.location || 'location —'} · ${item.job.id}`,
    `discovery:${item.job.discoveryStatus} · application:${item.job.applicationStatus || 'not-started'} · liveness:${item.liveness?.status || 'uncertain'}`,
    `${item.job.workModel || 'unknown'} · ${employmentTypes} · ${item.job.department || 'department —'} · ${compensation}`,
    paint(`FIT ${fitScore}/100 · ${fitMeta}${item.fit?.highFit ? ' · HIGH' : ''}`, 'cyan', color),
    ...wrap(item.narrative, width - 4).slice(0, 3),
    ...readinessLines(item.readiness, width - 4, color),
    '',
    ...policyLines(item.policy, width - 4, color),
    '',
    paint('NEXT', 'cyan', color),
    next ? `${next.title}${next.dueAt ? ` · ${next.dueAt}` : ''}` : 'No open task',
    '',
    paint('PROOFS', 'cyan', color),
    ...proofs.flatMap(value => wrap(value, width - 4)).slice(0, 4),
    '',
    paint('PATH', 'cyan', color),
    item.path ? `${item.path.strength} · ${item.path.channel || 'channel —'} · ${JSON.stringify(item.path.reasoning)}` : 'No warm path yet',
    '',
    paint('ARTIFACTS', 'cyan', color),
    ...artifacts.flatMap(value => wrap(value, width - 4)).slice(0, 4),
    '',
    paint('PURSUE STAGES', 'cyan', color),
    ...wrap(stages, width - 4).slice(0, 3),
    '',
    ...wrap(detailHints(), width - 4).map(line => paint(line, 'green', color))
  ];
  return panel('SELECTED JOB', lines.slice(0, Math.max(1, height - 2)), width, color);
}

function agentPanel(model, state, width, height, color) {
  const lines = [
    paint(`Hermes ACP · ${state.agentState}${state.sessionId ? ` · ${state.sessionId.slice(0, 8)}` : ''}`, state.agentState === 'ready' ? 'green' : (state.agentState === 'failed' || state.agentState === 'crashed' ? 'bad' : 'warn'), color),
    paint(`Context: ${model.selectedJobId || 'no job'} · tools: JobOS MCP · terminal/fs denied`, 'muted', color),
    ''
  ];
  const messages = state.messages.slice(-10);
  for (const message of messages) {
    const label = message.role === 'user' ? 'you' : (message.role === 'tool' ? 'tool' : 'hermes');
    lines.push(paint(`${label}>`, message.role === 'tool' ? 'warn' : 'cyan', color));
    lines.push(...wrap(message.text, width - 4).slice(-4));
  }
  if (state.agentState === 'offline' || !state.agentOn) lines.splice(1, 0, 'agent off');
  if (!messages.length) lines.push('Agent pane is on by default.', 'Press i to prompt. Press a to toggle.', 'Press c to reconnect after a failure.');
  if (state.mode === 'agent') lines.push('', paint(`> ${state.input}█`, 'green', color));
  else if (state.agentState === 'working') lines.push('', paint('working · navigation remains active · x cancels', 'warn', color));
  return panel('AGENT', lines.slice(Math.max(0, lines.length - (height - 2))), width, color);
}

function overlayItems(model, state) {
  if (state.overlay === 'review') return model.review;
  if (state.overlay === 'docs') return model.selected?.docs || [];
  if (state.overlay === 'profile') return model.profiles;
  if (state.overlay === 'log') return model.log;
  if (state.overlay === 'network') return networkOverlayItems(model);
  if (state.overlay === 'due') return dueOverlayTasks(model, state);
  if (state.overlay === 'build-network') return buildNetworkItems(model, state);
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
  if (state.overlay === 'review') {
    if (model.review.length) {
      const visible = visibleWindow(model.review, state.overlayIndex, height - 5);
      body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.title} · ${item.approvalStatus} · ${item.jobId || 'no job'}`);
    } else body = ['Review queue empty.', 'Drafts stay human-gated.'];
    body.push('', keyHints('review'));
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
      ...model.discovery.queue.map(item => `${item.id === state.selectedDiscoveryJobId ? '▶' : ' '} ${item.title} · ${item.company} · live ${item.liveness?.status || 'uncertain'} · fit ${item.fitScore ?? '—'}${item.highFit ? ' · high' : ''}`)
    ];
    if (!model.discovery.searches.length && !model.discovery.runs.length) body.splice(1, 0, 'No discovery searches configured.');
    if (!model.discovery.queue.length) body.push('No new jobs awaiting review.');
    body.push('', keyHints('discovery'));
  } else if (state.overlay === 'system') {
    body = [
      ...state.catalog.map(item => `${item.name} · ${item.available ? 'available' : 'unavailable'} · ${item.protocol} · ${item.role}`),
      'browser · optional/unavailable is honest on headless VPS',
      `side-effects · ${model.policy.sideEffects}`,
      `drafts · ${model.policy.drafts}`,
      '',
      'c reconnect ACP · x cancel turn · Esc closes'
    ];
  } else if (state.overlay === 'profile') {
    if (model.profiles.length) {
      const visible = visibleWindow(model.profiles, state.overlayIndex, height - 5);
      body = visible.items.map((item, offset) => `${visible.start + offset === state.overlayIndex ? '▶' : ' '} ${item.name} · ${item.id}`);
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
        body.push(`editing: ${state.networkDraft?._editingKey || ''} > ${state.input}█`);
        body.push('Enter commits · Esc cancels edit');
      } else {
        body.push('j/k move · Enter edit field/toggle · Enter on Save only saves · b Save and build · Esc closes');
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
        'Then submit externally, :attest <rfc3339>, and :receipt <reference> once confirmed.'
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
        'Esc closes · :packet refreshes · :packet create / :attest / :receipt run the trusted human mutations'
      ].filter(Boolean);
    }
    body.push('', 'Esc closes');
  }
  return panel(title, body.slice(0, Math.max(1, height - 2)), width, color);
}

function footerLines(width) {
  if (width >= 90) {
    return [
      ' j/k select · 1 today 2 all 3 high 4 review 5 materials-ready 6 applied 7 interview · p pursue z score d daily · a agent i prompt',
      ' r review l log · n network o docs q answers · s sources ? system · b build-network : command Q quit'
    ];
  }
  return [
    ' j/k select · 1 today · 2 all · 3 high',
    ' 4 review · 5 materials-ready · 6 applied · 7 interview',
    ' p pursue · z score · d daily · a agent · i prompt',
    ' r review · l log · n network · o docs · q answers',
    ' s sources · ? system · b build-network · : command · Q quit'
  ];
}
export function renderTui(model, state, { width = 140, height = 42, color = false } = {}) {
  const safeWidth = Math.max(60, width);
  const safeHeight = Math.max(20, height);
  const footers = footerLines(safeWidth);
  const inputModes = new Set(['command', 'review-note', 'stage-note', 'docs-search', 'suppress-reason']);
  const extraPrompt = inputModes.has(state.mode) || state.mode === 'stage' || Boolean(state.pendingConfirm);
  const lines = [headerLine(model, state, safeWidth, color), ...priorityLines(model, state, safeWidth, color)];
  const trailingRows = footers.length + 1 + (extraPrompt ? 1 : 0);
  const bodyHeight = Math.max(9, safeHeight - lines.length - trailingRows);
  if (state.overlay === 'docs' && safeWidth >= 116) {
    const sideWidth = Math.max(38, Math.floor(safeWidth * 0.36));
    const docsWidth = safeWidth - sideWidth - 1;
    const side = state.agentOn
      ? agentPanel(model, state, sideWidth, bodyHeight, color)
      : panel('AGENT', ['agent off', '', 'Chat/activity remains available when the agent is enabled.', 'Ctrl+A toggles shell/viewer focus.'], sideWidth, color);
    lines.push(...mergeColumns([
      side,
      docsPanel(model, state, docsWidth, bodyHeight, color)
    ], [sideWidth, docsWidth], color));
  } else if (state.overlay) {
    lines.push(...overlayPanel(model, state, safeWidth, bodyHeight, color));
  } else if (safeWidth >= 116 && state.agentOn) {
    const listWidth = Math.max(30, Math.floor(safeWidth * 0.27));
    const agentWidth = Math.max(32, Math.floor(safeWidth * 0.27));
    const detailWidth = safeWidth - listWidth - agentWidth - 2;
    lines.push(...mergeColumns([
      listPanel(model, state, listWidth, bodyHeight, color),
      detailPanel(model, detailWidth, bodyHeight, color),
      agentPanel(model, state, agentWidth, bodyHeight, color)
    ], [listWidth, detailWidth, agentWidth], color));
  } else if (safeWidth >= 90) {
    const agentHeight = state.agentOn ? Math.max(3, Math.floor(bodyHeight * 0.32)) : 0;
    const topHeight = bodyHeight - agentHeight;
    const listWidth = Math.max(32, Math.floor(safeWidth * 0.36));
    const detailWidth = safeWidth - listWidth - 1;
    lines.push(...mergeColumns([
      listPanel(model, state, listWidth, topHeight, color),
      detailPanel(model, detailWidth, topHeight, color)
    ], [listWidth, detailWidth], color));
    if (state.agentOn) lines.push(...agentPanel(model, state, safeWidth, agentHeight, color));
  } else {
    const listHeight = Math.max(3, Math.floor(bodyHeight * 0.3));
    const agentHeight = state.agentOn ? Math.max(3, Math.floor(bodyHeight * 0.3)) : 0;
    const detailHeight = bodyHeight - listHeight - agentHeight;
    lines.push(...listPanel(model, state, safeWidth, listHeight, color));
    lines.push(...detailPanel(model, safeWidth, detailHeight, color));
    if (state.agentOn) lines.push(...agentPanel(model, state, safeWidth, agentHeight, color));
  }
  if (state.pendingConfirm) {
    lines.push(paint(fit('Discard unsent review feedback? y/Enter confirm · n/Esc keep editing', safeWidth), 'warn', color));
  } else if (state.mode === 'stage') {
    lines.push(paint(fit(`Stage: ${stageOrder[state.stageIndex] || 'invalid'} · ${keyHints('stage')}`, safeWidth), 'green', color));
  } else if (inputModes.has(state.mode)) {
    const labels = { command: ':', 'review-note': 'Reject feedback', 'stage-note': 'Stage note (optional)', 'docs-search': 'Search', 'suppress-reason': 'Suppress reason (optional)' };
    lines.push(paint(fit(`${labels[state.mode]}: ${state.input}█`, safeWidth), 'green', color));
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
    docsEvidenceExpanded: false,
    focusTarget: 'shell',
    pendingAutoOpenArtifactId: null,
    editorActive: false,
    stageIndex: 0,
    stripIndex: 0,
    pendingConfirm: null,
    pendingSuppressContactId: null,
    packetDetail: null,
    mode: 'normal',
    input: '',
    status: 'starting JobOS host',
    error: null,
    busy: null,
    messages: [],
    catalog: [],
    networkDraft: null
  };
}

export class JobosTui {
  constructor(store, {
    stdin = process.stdin,
    stdout = process.stdout,
    profileId = null,
    connectAgent = true,
    color = stdout.isTTY
  } = {}) {
    this.store = store;
    this.stdin = stdin;
    this.stdout = stdout;
    this.state = { ...defaultTuiState(), profileId };
    this.model = buildTuiModel(store, { profileId });
    this.state.selectedJobId = this.model.selectedJobId;
    this.shouldConnectAgent = connectAgent;
    this.color = Boolean(color);
    this.client = null;
    this.refreshTimer = null;
    this.boundKeypress = (value, key) => this.onKeypress(value, key);
    this.boundResize = () => this.render();
    this.stopped = false;
    this.notedArtifactIds = new Set();
    this.parseEditorCommand = parseEditorCommand;
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

  render() {
    if (this.stopped || this.state.editorActive) return;
    const screen = renderTui(this.model, this.state, this.dimensions());
    this.stdout.write(`${ESC}H${ESC}2J${screen}`);
  }

  refresh({ disk = true } = {}) {
    if (this.state.editorActive) return false;
    const previousModel = this.model;
    const previousArtifactId = this.state.selectedArtifactId;
    const previousDocs = previousModel?.selected?.docs || [];
    const previousDocIndex = Math.max(0, previousDocs.findIndex(doc => doc.id === previousArtifactId));
    const previousReviewIndex = Math.max(0, previousModel?.review?.findIndex(item => item.id === previousArtifactId) ?? 0);
    const previousDiscoveryIndex = Math.max(0, previousModel?.discovery?.queue?.findIndex(item => item.id === this.state.selectedDiscoveryJobId) ?? 0);
    if (disk) reload(this.store);
    this.model = buildTuiModel(this.store, {
      profileId: this.state.profileId,
      selectedJobId: this.state.selectedJobId
    });
    this.state.profileId = this.model.profileId;
    this.state.selectedJobId = this.model.selectedJobId;

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
    this.render();
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
    this.state.input = '';
    if (name === 'build-network') {
      this.state.networkDraft = seedNetworkDraft(this.model);
      this.state.status = 'build-network editor · Enter edits fields · Esc closes';
    } else {
      if (name === 'docs') this.state.focusTarget = this.dimensions().width < 116 ? 'viewer' : 'shell';
      this.state.status = `${name} overlay · Esc closes`;
    }
    this.render();
  }

  closeTransient() {
    if (this.state.mode === 'build-network-field') {
      this.state.mode = 'normal';
      this.state.input = '';
      if (this.state.networkDraft) this.state.networkDraft._editingKey = null;
      this.state.status = 'edit cancelled';
      this.render();
      return true;
    }
    if (this.state.overlay) {
      this.state.overlay = null;
      this.state.overlayIndex = 0;
      this.state.mode = 'normal';
      this.state.input = '';
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
      const connected = await this.client.connect({ mcpServers: [jobosMcpServer(this.store.root)] });
      this.state.sessionId = connected.session.sessionId;
      this.state.agentState = 'ready';
      this.state.status = `Hermes ACP ready · session ${this.state.sessionId.slice(0, 8)} · JobOS tools mediated`;
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
      this.state.status = `${event.reason || 'cancelled'} ACP session quarantined · next prompt starts a clean guest`;
    } else if (event.type === 'session_recovery_started') {
      this.state.status = `restarting quarantined ACP session · JobOS state remains authoritative`;
    } else if (event.type === 'session_recovered') {
      this.state.sessionId = event.sessionId;
      this.state.status = `clean ACP session ${String(event.sessionId || '').slice(0, 8)} ready`;
    } else if (event.type === 'process_exit' && !event.intentional) {
      this.addMessage('tool', 'Hermes ACP exited. Press c to reconnect; JobOS state is intact.');
      this.state.agentState = 'crashed';
    } else if (event.type === 'protocol_error' || event.type === 'process_error') {
      this.state.error = event.message || event.error?.message || 'ACP protocol error';
    }
    this.render();
  }

  async promptAgent(text) {
    if (!this.client || this.client.state !== 'ready') {
      this.state.status = 'Agent is not ready. Press c to connect.';
      this.state.error = 'ACP not ready';
      this.render();
      return;
    }
    const jobId = this.state.selectedJobId;
    const context = jobId ? selectedJobContext(this.store, jobId) : null;
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
      this.state.input = '';
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
      this.state.input = '';
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
      this.state.input = '';
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
    const trimmed = String(value || '').trim();
    const [command] = trimmed.split(/\s+/);
    const argText = trimmed.slice((command || '').length).trim();
    this.state.mode = 'normal';
    this.state.input = '';
    if (!command) return this.render();
    const actions = { pursue: 'pursue', score: 'score', daily: 'daily', network: 'network' };
    if (actions[command]) return void this.runAction(actions[command]);
    if (command === 'review' || command === 'log' || command === 'docs' || command === 'answers' || command === 'system' || command === 'profile' || command === 'due') return this.openOverlay(command);
    if (command === 'build-network') return this.openOverlay('build-network');
    if (command === 'packet') {
      const sub = trimmed.split(/\s+/)[1]?.toLowerCase();
      if (!sub) return void this.showPacketSummary();
      if (sub === 'create') return void this.packetMutate('create');
    }
    if (command === 'attest') return void this.packetMutate('attest', argText);
    if (command === 'receipt') return void this.packetMutate('receipt', argText);
    if (command === 'answer') return void this.answerAdd(argText);
    if (command === 'prep') return void this.runPrep(argText);
    if (command === 'weekly') return void this.runWeeklyReview();
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
    this.state.status = 'Commands: pursue score daily network packet packet create attest receipt answer add prep weekly due review log docs answers system profile agent refresh reconnect quit';
    this.render();
  }

  cycleStripFocus() {
    const items = this.model.priority || [];
    if (!items.length) return;
    this.state.stripIndex = ((this.state.stripIndex || 0) + 1) % items.length;
    this.state.status = `Strip focus: ${items[this.state.stripIndex].kind} · Enter jumps to its job`;
    this.render();
  }

  jumpToStripJob() {
    const item = (this.model.priority || [])[this.state.stripIndex || 0];
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
    this.state.filter = 'all'; // load-bearing: the main list only renders filteredJobs
    this.state.selectedJobId = jobId;
    this.refresh({ disk: false });
    this.state.status = statusMessage;
    this.render();
  }

  async runPrep(argText) {
    const jobId = this.state.selectedJobId;
    if (!jobId) {
      this.state.status = 'Select a job before running interview prep.';
      this.render();
      return;
    }
    const app = one(this.store, 'SELECT id FROM applications WHERE job_id=? ORDER BY created_at DESC LIMIT 1', [jobId]);
    if (!app) {
      this.state.status = 'No application record for this job — create one first (pursue or jobos apply create).';
      this.render();
      return;
    }
    if (this.state.busy) return;
    this.state.busy = 'interview-prep';
    this.state.status = 'Interview prep running…';
    this.render();
    try {
      const result = await callDomainTool(this.store, 'interview_prep', { applicationId: app.id, stage: argText || 'interview' }, { source: 'tui' });
      this.state.error = null;
      this.refresh({ disk: false });
      this.state.status = `Interview prep draft created (${result.stage || 'interview'}) · review with r`;
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
      this.state.status = kind === 'create' ? `${done} · next: submit externally, then :attest <rfc3339>`
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
    this.state.input = '';
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
    this.state.input = '';
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
    this.state.input = '';
    this.state.status = 'Suppress reason (optional) · Enter marks do-not-use locally · Esc cancels';
    this.render();
    return true;
  }

  commitSuppressContact() {
    const contactId = this.state.pendingSuppressContactId;
    const reason = this.state.input.trim();
    this.state.mode = 'normal';
    this.state.input = '';
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
    this.state.input = '';
    this.state.status = 'Choose the human-tracked application stage.';
    this.render();
  }

  persistStage() {
    const status = stageOrder[this.state.stageIndex];
    const note = this.state.input.trim();
    this.state.mode = 'normal';
    this.state.input = '';
    try {
      if (!validStatuses.has(status)) throw Error(`Invalid status: ${status}`);
      const application = one(this.store, 'SELECT id FROM applications WHERE job_id=? AND profile_id=?', [this.state.selectedJobId, this.model.profileId]);
      if (application) {
        appUpdate(this.store, application.id, status, note || undefined);
      } else {
        appCreate(this.store, this.state.selectedJobId, status, note || undefined);
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
    this.state.input = '';
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
    this.stdout.write(`${ESC}?25h${ESC}?1049l`);
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
      this.stdout.write(`${ESC}?1049h${ESC}?25l`);
      if (this.stdin.isTTY) this.stdin.setRawMode(wasRaw);
      if (!wasPaused) this.stdin.resume?.();
      this.state.editorActive = false;
      this.refresh({ disk: false });
    }
  }

  onDocsKey(value, key) {
    if (key.name === 'escape') return this.closeTransient();
    if (value === 'j') return this.moveArtifactSelection(1);
    if (value === 'k') return this.moveArtifactSelection(-1);
    if (key.name === 'down') return this.scrollDocument(1);
    if (key.name === 'up') return this.scrollDocument(-1);
    if (key.name === 'pagedown') return this.scrollDocument(Math.max(1, this.dimensions().height - 12));
    if (key.name === 'pageup') return this.scrollDocument(-Math.max(1, this.dimensions().height - 12));
    if (value === '/') {
      this.state.mode = 'docs-search';
      this.state.input = '';
      this.render();
      return true;
    }
    if (value === 'n') return this.moveDocsMatch(1);
    if (value === 'N' || (key.shift && key.name === 'n')) return this.moveDocsMatch(-1);
    if (value === 'A') {
      this.state.mode = 'approve-confirm';
      this.state.input = '';
      this.state.status = 'Approve current artifact revision? (y/n)';
      this.render();
      return true;
    }
    if (value === 'R') return this.beginReject();
    if (value === 'X') {
      this.state.mode = 'reject-note';
      this.state.input = '';
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
      const doc = this.selectedDocument();
      this.state.status = this.state.docsView === 'diff'
        ? (doc?.previousDraft ? 'Previous draft comparison.' : 'First draft — no previous draft to compare.')
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
    return false;
  }

  onOverlayKey(value, key) {
    if (key.name === 'escape') return this.closeTransient();
    if (this.state.mode === 'build-network-field') return this.onInputKey(value, key);
    if (this.state.overlay === 'discovery') {
      if (key.name === 'return' || key.name === 'enter') return this.openDiscoverySelection();
      if (value === 'j') return this.moveDiscoverySelection(1);
      if (value === 'k') return this.moveDiscoverySelection(-1);
      if (value === 'A') return this.decideDiscovery('saved');
      if (value === 'X') return this.decideDiscovery('archived');
      if (value === 'd') {
        void this.runAction('daily');
        return true;
      }
    }
    if (value === 'r') return this.openOverlay('review');
    if (value === 'l') return this.openOverlay('log');
    if (value === 'n') return this.openOverlay('network');
    if (value === 'o') return this.openDocuments();
    if (value === 'q') return this.openOverlay('answers');
    if (value === 's') return this.openOverlay('discovery');
    if (value === '?') return this.openOverlay('system');
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
    if (this.state.overlay === 'discovery') {
      if (value === 'A') return this.decideDiscovery('saved');
      if (value === 'X') return this.decideDiscovery('archived');
    }
    const items = overlayItems(this.model, this.state);
    if (value === 'j' && items.length) this.state.overlayIndex = Math.min(items.length - 1, this.state.overlayIndex + 1);
    else if (value === 'k' && items.length) this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1);
    else if ((key.name === 'return' || key.name === 'enter') && this.state.overlay === 'profile' && items[this.state.overlayIndex]) {
      this.state.profileId = items[this.state.overlayIndex].id;
      this.state.selectedJobId = null;
      this.state.overlay = null;
      this.refresh({ disk: false });
      return true;
    } else if ((key.name === 'return' || key.name === 'enter') && this.state.overlay === 'review' && items[this.state.overlayIndex]) {
      this.openReviewDocument();
      return true;
    } else if ((key.name === 'return' || key.name === 'enter') && this.state.overlay === 'due') {
      const task = items[this.state.overlayIndex];
      if (task?.jobId) this.selectJobInMainList(task.jobId, 'Due task · job now selected in the main list.');
      else {
        this.state.status = 'This task has no linked job.';
        this.render();
      }
      return true;
    } else if (value === 'd' && this.state.overlay === 'discovery') {
      void this.runAction('daily');
      return true;
    } else if (this.state.overlay === 'build-network') {
      this.onBuildNetworkKey(value, key, items);
      return true;
    }
    this.render();
    return true;
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
      this.state.input = this.state.networkDraft?.[draftKey] || '';
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
      this.state.input = '';
      this.state.status = 'Rejection cancelled.';
      this.render();
      return true;
    }
    if (key.name === 'escape') return this.closeTransient();
    if (key.name === 'backspace') {
      this.state.input = this.state.input.slice(0, -1);
      this.render();
      return true;
    }
    if (key.name === 'return' || key.name === 'enter') {
      const text = this.state.input.trim();
      const mode = this.state.mode;
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
      this.state.input = '';
      if (mode === 'agent' && text) void this.promptAgent(text);
      else if (mode === 'command') this.executeCommand(text);
      else if (mode === 'build-network-field' && this.state.networkDraft) {
        const editKey = this.state.networkDraft._editingKey;
        if (editKey) this.state.networkDraft[editKey] = text;
        this.state.networkDraft._editingKey = null;
        this.state.status = `${editKey || 'field'} updated`;
      }
      this.render();
      return true;
    }
    if (!key.ctrl && !key.meta && value && /^[\x20-\x7e]$/.test(value)) {
      this.state.input += value;
      this.render();
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
      this.state.input = '';
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
      this.state.input = '';
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
        this.state.input = '';
        this.state.status = `Optional note for ${status}.`;
      }
    }
    this.render();
    return true;
  }

  onKeypress(value, key = {}) {
    if (key.ctrl && key.name === 'c') return void this.stop();
    if (value === 'Q' || (key.shift && key.name === 'q')) return void this.stop();
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
    if (['review-note', 'stage-note', 'docs-search', 'command', 'agent', 'approve-confirm', 'reject-confirm', 'reject-note', 'suppress-reason'].includes(this.state.mode)) return this.onInputKey(value, key);
    if (this.state.mode === 'stage') return this.onStageKey(value, key);
    if (this.docsViewerActive()) {
      const handled = this.onDocsKey(value, key);
      if (handled !== false) return handled;
    }
    if (this.state.overlay === 'docs' && ['A', 'R', 'B', 'E', 'V', 'I', 'D', 'X'].includes(value)) return this.onDocsKey(value, key);
    if (this.state.overlay === 'docs' && this.dimensions().width >= 116) {
      if (value === 'j') return this.moveSelection(1);
      if (value === 'k') return this.moveSelection(-1);
      if (value === 'n') return this.openOverlay('network');
    }
    if (this.state.overlay) return this.onOverlayKey(value, key);
    if (key.name === 'escape') return this.closeTransient();
    if (value === 'j') this.moveSelection(1);
    else if (value === 'k') this.moveSelection(-1);
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
      this.state.input = '';
      this.render();
    } else if (value === 'i') {
      this.state.agentOn = true;
      this.state.mode = 'agent';
      this.state.input = '';
      this.render();
    } else if (value === 't') this.beginStage();
    else if (value === 'r') this.openOverlay('review');
    else if (value === 'l') this.openOverlay('log');
    else if (value === 'n') this.openOverlay('network');
    else if (value === 'o') this.openDocuments();
    else if (value === 'q') this.openOverlay('answers');
    else if (value === 's') this.openOverlay('discovery');
    else if (value === '?') this.openOverlay('system');
    else if (value === 'v') this.openOverlay('profile');
    else if (value === 'b') this.openOverlay('build-network');
    else if (value === 'p') void this.runAction('pursue');
    else if (value === 'z') void this.runAction('score');
    else if (value === 'd') void this.runAction('daily');
    else if (value === 'g') {
      this.state.status = 'state refreshed from disk';
      this.refresh();
    } else if (value === 'c') void this.connectAgent();
    else if (value === 'x' && this.client?.state === 'working') {
      this.client.cancel();
      this.state.status = 'cancelling agent turn';
      this.render();
    } else if (key.name === 'tab') this.cycleStripFocus();
    else if (key.name === 'return' || key.name === 'enter') this.jumpToStripJob();
    return true;
  }

  async start() {
    if (!this.stdin.isTTY || !this.stdout.isTTY) throw Error('JobOS TUI requires a terminal. Use `jobos tui --snapshot` for a non-interactive state view.');
    readline.emitKeypressEvents(this.stdin);
    this.stdin.setRawMode(true);
    this.stdin.resume();
    this.stdin.on('keypress', this.boundKeypress);
    this.stdout.on('resize', this.boundResize);
    this.stdout.write(`${ESC}?1049h${ESC}?25l`);
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
    this.stdin.off('keypress', this.boundKeypress);
    this.stdout.off('resize', this.boundResize);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause?.();
    if (this.client) await this.client.stop();
    this.stdout.write(`${ESC}?25h${ESC}?1049l`);
    this.resolveStop?.();
  }
}

export async function startTui(store, options = {}) {
  const tui = new JobosTui(store, options);
  await tui.start();
  return tui;
}
