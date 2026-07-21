import readline from 'node:readline';
import { buildTuiModel } from './tui-model.js';
import { callDomainTool, selectedJobContext } from './domain-tools.js';
import { reload } from './db.js';
import { AcpClient, agentBackendCatalog, jobosMcpServer } from './acp.js';

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
const FILTERS = ['today', 'all', 'high', 'review', 'materials-ready', 'applied', 'interview'];
export const TUI_DOMAIN_ACTIONS = Object.freeze({
  daily: 'daily_discovery',
  pursue: 'pursue_job',
  score: 'score_job',
  network: 'map_reachable_network'
});

function stripAnsi(value) {
  return String(value ?? '').replace(/\x1b\[[0-9;]*m/g, '');
}

function crop(value, width) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ');
  if (text.length <= width) return text;
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`;
}

function fit(value, width, align = 'left') {
  const text = crop(value, Math.max(0, width));
  const pad = Math.max(0, width - text.length);
  return align === 'right' ? `${' '.repeat(pad)}${text}` : `${text}${' '.repeat(pad)}`;
}

function paint(value, color, enabled) {
  return enabled ? `${COLORS[color] || ''}${value}${COLORS.reset}` : value;
}

function wrap(value, width) {
  const limit = Math.max(8, width);
  const paragraphs = String(value ?? '').split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let remaining = paragraph.trim();
    while (remaining.length > limit) {
      let split = remaining.lastIndexOf(' ', limit);
      if (split < Math.floor(limit / 2)) split = limit;
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
      const visible = stripAnsi(value);
      const pad = Math.max(0, widths[columnIndex] - visible.length);
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

function readinessLines(readiness, width, color) {
  const status = readiness?.status || 'blocked';
  const next = readiness?.nextAction || readiness?.next || readiness?.nextActions?.[0]?.action || 'Complete readiness checks';
  const blockers = Array.isArray(readiness?.blockers) ? readiness.blockers : [];
  const warnings = Array.isArray(readiness?.warnings) ? readiness.warnings : [];
  const localApprovalComplete = readiness?.localApprovalComplete || readiness?.review?.localApprovalComplete;
  const lines = [
    paint(`READINESS ${status} · ${readiness?.readyForReview ? 'reviewable' : 'not reviewable'}${localApprovalComplete ? ' · locally approved' : ''}`, status === 'approved' ? 'green' : (status === 'blocked' ? 'bad' : 'warn'), color),
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

function priorityLines(model, width, color) {
  if (width < 100) {
    return model.priority.map(item => paint(fit(`[${item.kind.toUpperCase()}] ${item.text}`, width), item.kind === 'failure' ? 'bad' : (item.kind === 'new' ? 'green' : 'warn'), color));
  }
  const gap = 1;
  const cardWidth = Math.floor((width - gap * 3) / 4);
  const cards = model.priority.map(item => {
    const label = item.kind.toUpperCase();
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
      body.push(crop(`  ${job.company} · ${job.location || 'location —'} · ${job.stage}`, width - 4));
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
  const proofs = item.proofs.length ? item.proofs.map(proof => `${proof.id} ${proof.summary}`) : ['No matched proof IDs yet'];
  const artifacts = item.docs.length ? item.docs.map(doc => `${doc.type} · ${doc.approvalStatus} · r${doc.revision} · ${doc.path}`) : ['No artifacts — pursue to stage drafts'];
  const stages = item.stages.map(stage => `${stage.name}:${stage.state}`).join('  ');
  const lines = [
    paint(`${item.job.title}`, 'green', color),
    `${item.job.company} · ${item.job.location || 'location —'} · ${item.job.id}`,
    '',
    paint(`FIT ${fitScore}/100 · ${fitMeta}${item.fit?.highFit ? ' · HIGH' : ''}`, 'cyan', color),
    ...wrap(item.narrative, width - 4).slice(0, 3),
    '',
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
    ...wrap('p pursue · z score · n network · o docs · q answers · i agent', width - 4).map(line => paint(line, 'green', color))
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
  return [];
}
function visibleWindow(items, selectedIndex, limit) {
  const size = Math.max(1, Math.min(items.length, limit));
  const start = Math.max(0, Math.min(items.length - size, selectedIndex - Math.floor(size / 2)));
  return { start, items: items.slice(start, start + size) };
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
    body.push('', 'j/k select · Enter opens job documents · Esc closes');
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
    body = selected?.path
      ? [`strength ${selected.path.strength}`, `channel ${selected.path.channel || '—'}`, JSON.stringify(selected.path.reasoning), ...selected.path.warnings.map(value => `warning ${value}`)]
      : ['No ranked warm path yet.', 'Press m to run the shared map_reachable_network tool.'];
    body.push('', 'm map/refresh · Esc closes');
  } else if (state.overlay === 'docs') {
    title = `DOCUMENTS · ${selected?.job.id || 'NO JOB'}`;
    const docs = selected?.docs || [];
    if (!docs.length) body = ['No documents for this job.', 'Run pursue to stage proof-grounded drafts.'];
    else {
      const index = Math.min(state.overlayIndex, docs.length - 1);
      const doc = docs[index];
      const visible = visibleWindow(docs, index, Math.min(7, Math.max(2, height - 14)));
      const previous = docs.find(item => item.id === doc.supersedesArtifactId)
        || docs.filter(item => item.seriesKey === doc.seriesKey && item.revision < doc.revision)
          .sort((left, right) => right.revision - left.revision)[0];
      const content = state.docsDiff && previous
        ? documentDiff(previous, doc, width - 4)
        : wrap(doc.content, Math.min(width - 4, 100));
      body = [
        ...visible.items.map((item, offset) => `${visible.start + offset === index ? '▶' : ' '} ${item.title} · r${item.revision} · ${item.approvalStatus}`),
        '',
        doc.path,
        `hash ${doc.contentHash || 'unavailable'} · series ${doc.seriesKey || 'unavailable'} · r${doc.revision}`,
        `history ${documentHistory(docs, doc).join(' · ')}`,
        ...(doc.evidence?.length ? [`evidence ${JSON.stringify(doc.evidence)}`] : ['evidence none recorded']),
        ...(doc.warnings?.length ? doc.warnings.map(value => `warning ${typeof value === 'string' ? value : JSON.stringify(value)}`) : []),
        ...(doc.reviewedAt ? [`reviewed ${doc.reviewedAt}${doc.reviewedBy ? ` by ${doc.reviewedBy}` : ''}${doc.reviewNote ? ` · ${doc.reviewNote}` : ''}`] : []),
        '',
        ...content.slice(0, Math.max(3, height - visible.items.length - 14))
      ];
      if (state.mode === 'approve-confirm') body.push('', `Approve r${doc.revision} locally? y commits · n/Esc cancels`);
      if (state.mode === 'reject-note') body.push('', `Rejection note: ${state.input}█`, 'Enter confirms · Esc cancels');
      if (state.mode === 'reject-confirm') body.push('', `Reject r${doc.revision} locally with this note? y commits · n/Esc cancels`);
    }
    body.push('', 'j/k choose · D diff · A approve · X reject · Esc closes');
  } else if (state.overlay === 'answers') {
    title = `ANSWERS · ${model.profileId || 'NO PROFILE'}`;
    body = [
      `verified reusable answers: ${model.answers.verified}`,
      `restricted answers hidden/blocked: ${model.answers.restricted}`,
      '',
      'Agent and TUI use answers_match only with explicit application questions.',
      'Restricted values are never displayed or auto-filled.'
    ];
  } else if (state.overlay === 'discovery') {
    body = [
      ...model.discovery.searches.map(item => `${item.name || item.id} · ${item.adapter} · last ${item.lastRunAt || item.last_run_at || 'never'}`),
      ...model.discovery.runs.slice(0, 8).map(item => `${item.startedAt || '—'} · ${item.actionId || 'run'} · ${item.status}${item.error ? ` · ${item.error}` : ''}`)
    ];
    if (!body.length) body = ['No discovery searches configured.', 'Create one with jobos searches create, then press d.'];
    body.push('', 'd runs daily discovery · Esc closes');
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
  }
  return panel(title, body.slice(0, Math.max(1, height - 2)), width, color);
}

function footerLines(width) {
  if (width >= 90) {
    return [
      ' j/k select · 1 today 2 all 3 high · p pursue z score d daily · a agent i prompt',
      ' r review l log · n network o docs (D diff A approve X reject) · q answers · : command Q quit'
    ];
  }
  return [
    ' j/k select · 1 today · 2 all · 3 high',
    ' p pursue · z score · d daily · a agent · i prompt',
    ' r review · l log · n network · o docs',
    ' docs: D diff A approve X reject · q answers',
    ' s sources · ? system · : command · Q quit'
  ];
}
export function renderTui(model, state, { width = 140, height = 42, color = false } = {}) {
  const safeWidth = Math.max(60, width);
  const safeHeight = Math.max(20, height);
  const footers = footerLines(safeWidth);
  const lines = [headerLine(model, state, safeWidth, color), ...priorityLines(model, safeWidth, color)];
  const trailingRows = footers.length + 1 + (state.mode === 'command' ? 1 : 0);
  const bodyHeight = Math.max(9, safeHeight - lines.length - trailingRows);
  if (state.overlay) {
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
  if (state.mode === 'command') lines.push(paint(fit(`: ${state.input}█`, safeWidth), 'green', color));
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
    agentOn: true,
    agentState: 'connecting',
    sessionId: null,
    overlay: null,
    overlayIndex: 0,
    docsDiff: false,
    mode: 'normal',
    input: '',
    status: 'starting JobOS host',
    error: null,
    busy: null,
    messages: [],
    catalog: []
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
    if (this.stopped) return;
    const screen = renderTui(this.model, this.state, this.dimensions());
    this.stdout.write(`${ESC}H${ESC}2J${screen}`);
  }

  refresh({ disk = true } = {}) {
    if (disk) reload(this.store);
    this.model = buildTuiModel(this.store, {
      profileId: this.state.profileId,
      selectedJobId: this.state.selectedJobId
    });
    this.state.profileId = this.model.profileId;
    this.state.selectedJobId = this.model.selectedJobId;
    this.syncDocumentSelection();
    this.render();
  }

  filtered() {
    return filteredJobs(this.model, this.state.filter);
  }

  moveSelection(delta) {
    const jobs = this.filtered();
    if (!jobs.length) return;
    let index = jobs.findIndex(job => job.id === this.state.selectedJobId);
    if (index < 0) index = 0;
    index = Math.max(0, Math.min(jobs.length - 1, index + delta));
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
    if (name === 'docs') this.syncDocumentSelection();
    this.state.status = `${name} overlay · Esc closes`;
    this.render();
  }

  closeTransient() {
    if (this.state.mode !== 'normal') {
      this.state.mode = 'normal';
      this.state.input = '';
      this.state.status = 'input cancelled';
      this.render();
      return true;
    }
    if (this.state.overlay) {
      this.state.overlay = null;
      this.state.overlayIndex = 0;
      this.state.docsDiff = false;
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
    this.state.busy = 'agent';
    this.state.status = `agent working on ${jobId || 'workspace'} · navigation stays active`;
    this.render();
    try {
      const result = await this.client.prompt(text, { context });
      this.refresh();
      this.state.status = result?.stopReason === 'cancelled'
        ? 'agent turn cancelled · late guest output quarantined · next prompt starts clean'
        : 'agent turn complete · authoritative state refreshed';
      this.state.error = null;
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `${error.message} · press c to reconnect or continue using JobOS directly`;
    } finally {
      this.state.busy = null;
      this.render();
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
    this.state.busy = name;
    this.state.status = `${name} running asynchronously`;
    this.state.error = null;
    this.render();
    try {
      await callDomainTool(this.store, tool, args, { source: 'tui' });
      this.refresh({ disk: false });
      this.state.status = `${name} complete · local state refreshed`;
    } catch (error) {
      if (error?.code === 'stale_snapshot') {
        reload(this.store);
        this.state.status = `${name} stopped: workspace changed; refreshed safely, retry when ready`;
      } else {
        this.state.status = `${name} failed: ${error.message}`;
      }
      this.state.error = error.message;
      this.refresh({ disk: false });
    } finally {
      this.state.busy = null;
      this.render();
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
      this.state.status = `${decision} locally · queue, readiness, and audit log refreshed`;
      this.refresh({ disk: false });
    } catch (error) {
      this.state.error = error.message;
      this.state.status = `${decision} failed: ${error.message}`;
      this.render();
    } finally {
      this.state.busy = null;
      this.render();
    }
  }

  executeCommand(value) {
    const [command] = String(value || '').trim().split(/\s+/);
    this.state.mode = 'normal';
    this.state.input = '';
    if (!command) return this.render();
    const actions = { pursue: 'pursue', score: 'score', daily: 'daily', network: 'network' };
    if (actions[command]) return void this.runAction(actions[command]);
    if (command === 'review' || command === 'log' || command === 'docs' || command === 'answers' || command === 'system' || command === 'profile') return this.openOverlay(command);
    if (command === 'agent') {
      this.state.agentOn = !this.state.agentOn;
      this.state.status = `agent ${this.state.agentOn ? 'on' : 'off'}`;
      if (this.state.agentOn && !this.client) void this.connectAgent();
      return this.render();
    }
    if (command === 'refresh') return this.refresh();
    if (command === 'reconnect') return void this.connectAgent();
    if (command === 'quit') return void this.stop();
    this.state.error = `Unknown command: ${command}`;
    this.state.status = 'Commands: pursue score daily network review log docs answers system profile agent refresh reconnect quit';
    this.render();
  }

  onOverlayKey(value, key) {
    if (key.name === 'escape') return this.closeTransient();
    if (this.state.overlay === 'docs') {
      const docs = this.model.selected?.docs || [];
      if (value === 'j' && docs.length) {
        this.state.overlayIndex = Math.min(docs.length - 1, this.state.overlayIndex + 1);
        this.state.selectedArtifactId = docs[this.state.overlayIndex].id;
        this.state.docsDiff = false;
      } else if (value === 'k' && docs.length) {
        this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1);
        this.state.selectedArtifactId = docs[this.state.overlayIndex].id;
        this.state.docsDiff = false;
      } else if (value === 'D') {
        this.state.docsDiff = !this.state.docsDiff;
      } else if (value === 'A' && this.selectedDocument()) {
        this.state.mode = 'approve-confirm';
      } else if (value === 'X' && this.selectedDocument()) {
        this.state.mode = 'reject-note';
        this.state.input = '';
      }
      this.render();
      return true;
    }
    if (value === 'r') return this.openOverlay('review');
    if (value === 'l') return this.openOverlay('log');
    if (value === 'n') return this.openOverlay('network');
    if (value === 'o') return this.openDocuments();
    if (value === 'q') return this.openOverlay('answers');
    if (value === 's') return this.openOverlay('discovery');
    if (value === '?') return this.openOverlay('system');
    const items = overlayItems(this.model, this.state);
    if (value === 'j' && items.length) this.state.overlayIndex = Math.min(items.length - 1, this.state.overlayIndex + 1);
    else if (value === 'k' && items.length) this.state.overlayIndex = Math.max(0, this.state.overlayIndex - 1);
    else if ((key.name === 'return' || key.name === 'enter') && this.state.overlay === 'review' && items[this.state.overlayIndex]) {
      const artifact = items[this.state.overlayIndex];
      this.state.selectedJobId = artifact.jobId;
      this.state.selectedArtifactId = artifact.id;
      this.refresh({ disk: false });
      this.openDocuments(artifact.id);
      return true;
    } else if ((key.name === 'return' || key.name === 'enter') && this.state.overlay === 'profile' && items[this.state.overlayIndex]) {
      this.state.profileId = items[this.state.overlayIndex].id;
      this.state.selectedJobId = null;
      this.state.overlay = null;
      this.refresh({ disk: false });
      return true;
    } else if (value === 'm' && this.state.overlay === 'network') {
      void this.runAction('network');
      return true;
    } else if (value === 'd' && this.state.overlay === 'discovery') {
      void this.runAction('daily');
      return true;
    }
    this.render();
    return true;
  }

  onInputKey(value, key) {
    if (key.name === 'escape') return this.closeTransient();
    if (this.state.mode === 'approve-confirm' || this.state.mode === 'reject-confirm') {
      if (value === 'y') {
        void this.commitArtifactReview(this.state.mode === 'approve-confirm' ? 'approved' : 'rejected');
        return true;
      }
      if (value === 'n') {
        this.state.mode = 'normal';
        this.state.input = '';
        this.state.status = 'review decision cancelled';
        this.render();
        return true;
      }
      // Ignore other keys (Enter, backspace, etc.) so they do not silently cancel the confirmation.
      this.render();
      return true;
    }
    if (this.state.mode === 'reject-note') {
      if (key.name === 'backspace') this.state.input = this.state.input.slice(0, -1);
      else if (key.name === 'return' || key.name === 'enter') {
        this.state.mode = 'reject-confirm';
        this.render();
        return true;
      } else if (!key.ctrl && !key.meta && value && /^[\x20-\x7e]$/.test(value)) this.state.input += value;
      this.render();
      return true;
    }
    if (key.name === 'backspace') this.state.input = this.state.input.slice(0, -1);
    else if (key.name === 'return' || key.name === 'enter') {
      const text = this.state.input.trim();
      const mode = this.state.mode;
      this.state.mode = 'normal';
      this.state.input = '';
      if (mode === 'agent' && text) void this.promptAgent(text);
      else if (mode === 'command') this.executeCommand(text);
      return true;
    } else if (!key.ctrl && !key.meta && value && /^[\x20-\x7e]$/.test(value)) {
      this.state.input += value;
    }
    this.render();
    return true;
  }


  onKeypress(value, key = {}) {
    if (key.ctrl && key.name === 'c') return void this.stop();
    if (this.state.mode !== 'normal') return this.onInputKey(value, key);
    if (this.state.overlay) return this.onOverlayKey(value, key);
    if (key.name === 'escape') return this.closeTransient();
    if (value === 'Q' || (key.shift && key.name === 'q')) return void this.stop();
    if (value === 'j') this.moveSelection(1);
    else if (value === 'k') this.moveSelection(-1);
    else if (value === '1') { this.state.filter = 'today'; this.refresh({ disk: false }); }
    else if (value === '2') { this.state.filter = 'all'; this.refresh({ disk: false }); }
    else if (value === '3') { this.state.filter = 'high'; this.refresh({ disk: false }); }
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
    } else if (value === 'r') this.openOverlay('review');
    else if (value === 'l') this.openOverlay('log');
    else if (value === 'n') this.openOverlay('network');
    else if (value === 'o') this.openDocuments();
    else if (value === 'q') this.openOverlay('answers');
    else if (value === 's') this.openOverlay('discovery');
    else if (value === '?') this.openOverlay('system');
    else if (value === 'v') this.openOverlay('profile');
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
    }
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
      if (!this.state.busy) {
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
