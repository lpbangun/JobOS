/**
 * React/Ink shell components for the locked Classic red IA. Pure
 * controlled components: everything renders from (model, state, actions,
 * theme, colorEnabled). The same tree is used by the TTY runtime (Root in
 * runtime.js) and by renderTui's synchronous static snapshot.
 */
import React from 'react';
import { Box, Text } from 'ink';
import { ThemeProvider, Spinner } from '@inkjs/ui';
import { CLASSIC_THEME, OVERLAY_BACKDROP, INKUI_THEME } from './theme.js';
import { MODAL_WIDTH, MODAL_PADDING_X, boardGeometry } from './layout.js';
import {
  SETUP_STEP_LABELS,
  SETUP_SUB_OVERLAYS,
  RESUME_SOURCE_CHOICES,
  JOB_SOURCE_CHOICES,
  railRows,
  actionChip,
  stageLabel,
  selectedJob,
  selectedDocs,
  selectedContacts,
  effectiveOverlay,
  isComposerActive,
  clockText,
  companyContext,
  statusLine,
  setupStepViews,
  completedRequiredCount,
  slashHits,
  chatLog,
  fitText,
  isEmptyModel,
  filesRows,
  trackerRows,
  TRACKER_CHIP_STAGES,
  reviewRows,
  peopleReviewRows,
  networkPeople,
  connectionPerson,
  outreachDraftRows
} from './model.js';

const h = React.createElement;

export const ThemeContext = React.createContext({ tokens: CLASSIC_THEME, color: false });

export function useTheme() {
  return React.useContext(ThemeContext);
}

/** Theme-aware text: every style token is gated on color support. */
export function Tx({ color, bg, bold, dim, wrap = 'wrap', children, ...rest }) {
  const { color: enabled } = useTheme();
  return h(Text, {
    ...rest,
    wrap,
    color: enabled && color ? color : undefined,
    backgroundColor: enabled && bg ? bg : undefined,
    bold: enabled && bold ? bold : undefined,
    dimColor: enabled && dim ? dim : undefined
  }, children);
}

/** Theme-aware box: background gated on color support. */
export function Bx({ bg, children, ...rest }) {
  const { color: enabled } = useTheme();
  return h(Box, { ...rest, backgroundColor: enabled && bg ? bg : undefined }, children);
}

/**
 * One prompt/entry line: typed text with a block caret at the cursor (default
 * end), or the placeholder dimmed so it can never be mistaken for typed text.
 * The caret renders in theme accent so the insertion point is visible on the
 * live TTY.
 */
function CaretEntry({ text, cursor = null, placeholder = '', prompt = '❯ ', paddingX = 2, marginTop = 0 }) {
  const value = String(text || '');
  const hasText = Boolean(value);
  const shown = hasText ? value : String(placeholder || '');
  const at = hasText && cursor != null
    ? Math.max(0, Math.min(value.length, Number(cursor) || 0))
    : value.length;
  return h(Bx, { flexDirection: 'row', paddingX, paddingY: 0, marginTop, bg: CLASSIC_THEME.panel },
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, prompt),
    h(Tx, { dim: !hasText, wrap: 'truncate-end' }, shown.slice(0, at)),
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, '█'),
    h(Tx, { dim: !hasText, wrap: 'truncate-end' }, shown.slice(at))
  );
}

function Cta({ label, primary }) {
  return h(Bx, { marginRight: 1 },
    h(Tx, {
      bold: true,
      color: primary ? CLASSIC_THEME.ink : CLASSIC_THEME.text,
      bg: primary ? CLASSIC_THEME.accent : undefined,
      wrap: 'truncate-end'
    }, ` ${label} `)
  );
}

function ModeSeg({ label, active, width }) {
  const { color } = useTheme();
  const marker = active && !color ? '●' : '';
  const raw = ` ${label}${marker} `;
  const content = raw.length > width ? raw.slice(0, width) : raw.padEnd(width, ' ');
  return h(Bx, {
    width,
    flexGrow: 0,
    flexShrink: 0,
    bg: active ? CLASSIC_THEME.accent : undefined
  },
    h(Tx, { bold: true, color: active ? CLASSIC_THEME.ink : CLASSIC_THEME.muted, wrap: 'truncate-end' }, content)
  );
}

function Header({ model, state, actions }) {
  const working = Boolean(state.working);
  const clock = clockText(model, state);
  const company = companyContext(model, state);
  // Header segments consume the same deterministic rectangles as hit testing.
  // Workspace 12 cells [W-19,W-8], Jobs 8 cells [W-7,W] — exactly 20 right-anchored cells.
  // Outer padding is left-only so right-anchored hitboxes [W-19..W] align exactly
  // with painted cells — no right padding shift. Left padding 1 preserves wordmark gap.
  return h(Bx, { flexDirection: 'row', alignItems: 'center', bg: CLASSIC_THEME.panel, paddingLeft: 1, paddingRight: 0, minHeight: 1 },
    h(Tx, { bold: true, color: CLASSIC_THEME.wordmark.job, wrap: 'truncate-end' }, 'Job'),
    h(Tx, { bold: true, color: CLASSIC_THEME.wordmark.os, wrap: 'truncate-end' }, 'OS'),
    h(Text, null, ' '),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, clock),
    working ? h(Spinner, { label: 'working' }) : null,
    h(Box, { flexGrow: 1 }),
    company ? h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, company) : null,
    h(Box, { flexDirection: 'row', marginLeft: 1 },
      h(ModeSeg, { label: 'Workspace', active: state.headerMode === 'workspace', width: 12 }),
      h(ModeSeg, { label: 'Jobs', active: state.headerMode === 'jobs', width: 8 })
    )
  );
}

function RailSeg({ label, active }) {
  const { color } = useTheme();
  const marker = active && !color ? ' ●' : '';
  return h(Bx, { flexGrow: 1, bg: active ? CLASSIC_THEME.accent : undefined },
    h(Tx, { bold: true, color: active ? CLASSIC_THEME.ink : CLASSIC_THEME.muted, wrap: 'truncate-end' }, ` ${label}${marker} `));
}

function Row({ row, chip, selected }) {
  return h(Bx, { flexDirection: 'column', paddingX: 1, bg: selected ? CLASSIC_THEME.selected : undefined },
    h(Tx, { bold: selected, wrap: 'truncate-end' }, row.title || 'Untitled role'),
    h(Box, { flexDirection: 'row', justifyContent: 'space-between' },
      h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, row.company || ''),
      chip ? h(Tx, { color: CLASSIC_THEME.accent, wrap: 'truncate-end' }, chip) : null
    )
  );
}

function LeftRail({ model, state, actions, width }) {
  const rows = railRows(model, state);
  const railWidth = width != null ? Math.max(1, Math.floor(Number(width) || 0)) : undefined;
  return h(Bx, {
    flexDirection: 'column',
    width: railWidth,
    flexGrow: 0,
    flexShrink: 0,
    minWidth: 0,
    minHeight: 0,
    bg: CLASSIC_THEME.panel
  },
    h(Box, { flexDirection: 'row' },
      h(RailSeg, { label: 'New', active: state.leftMode === 'new' }),
      h(RailSeg, { label: 'Jobs', active: state.leftMode === 'jobs' })
    ),
    h(Bx, { flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0 },
      rows.length
        ? rows.map((row, i) => h(Row, {
            key: row.id,
            row,
            chip: actionChip(model, row),
            selected: i === state.selectedIndex
          }))
        : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            state.leftMode === 'new'
              ? 'No new roles · /daily runs discovery'
              : 'No jobs yet · Add to Jobs from New'
          )
    )
  );
}

function PaneTab({ label, active }) {
  const { color } = useTheme();
  // Non-color active indicator: accent bg is gated on color, so add a dot
  const marker = active && !color ? '●' : '';
  const content = marker ? `${label}${marker}` : label;
  return h(Bx, { flexGrow: 0, flexShrink: 0, width: 10, bg: active ? CLASSIC_THEME.accent : undefined },
    h(Tx, { bold: true, color: active ? CLASSIC_THEME.ink : CLASSIC_THEME.muted, wrap: 'truncate-end' }, ` ${content} `));
}

function PaneBar({ model, state, actions }) {
  return h(Box, { flexDirection: 'row' },
    h(PaneTab, { label: 'Job', active: state.jobTab === 'job' }),
    h(PaneTab, { label: 'People', active: state.jobTab === 'people' }),
    h(PaneTab, { label: 'Chat', active: state.jobTab === 'chat' })
  );
}

function JobPane({ model, state, actions }) {
  const job = selectedJob(model, state);
  const isNew = state.leftMode === 'new';
  if (!job) {
    return h(Bx, { flexDirection: 'column', width: '100%', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, paddingX: 2, paddingY: 1 },
      h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, isEmptyModel(model)
        ? 'Welcome to JobOS. Start guided setup to add a profile and your first job.'
        : 'Pick a listing on the left.')
    );
  }
  const stage = isNew ? 'New' : (stageLabel(job) || 'Job');
  const fit = fitText(job);
  const meta = isNew
    ? [job.company, job.location, 'already scored in discovery'].filter(Boolean).join(' · ')
    : [job.company, job.location, fit, actionChip(model, job)].filter(Boolean).join(' · ');
  const docs = isNew ? [] : selectedDocs(model);
  return h(Bx, { flexDirection: 'column', width: '100%', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, paddingX: 2, paddingY: 1 },
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, String(stage).toUpperCase()),
    h(Tx, { bold: true, wrap: 'truncate-end' }, job.title || 'Untitled role'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, meta),
    h(Box, { flexDirection: 'row', marginTop: 1 },
      isNew
        ? h(Cta, { label: 'Add to Jobs', primary: true })
        : h(Cta, { label: 'Create files', primary: true }),
      isNew ? null : h(Cta, { label: 'Tracker' })
    ),
    docs.length
      ? docs.slice(0, 5).map(doc => h(Tx, { key: doc.id, color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
          `${doc.title || doc.type || 'draft'} · ${doc.approvalStatus || 'draft_needs_human_review'}`))
      : null,
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      isNew
        ? 'Enter adds this role to Jobs · Tab to Chat for / commands'
        : 'Tab to Chat, then type / like Claude Code. Menu sits on the prompt.')
  );
}

function PeoplePane({ model, state, actions }) {
  const job = selectedJob(model, state);
  const contacts = selectedContacts(model);
  return h(Bx, { flexDirection: 'column', width: '100%', flexGrow: 1, flexShrink: 1, minWidth: 0, minHeight: 0, paddingX: 2, paddingY: 1 },
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'PEOPLE · THIS JOB'),
    h(Tx, { bold: true, wrap: 'truncate-end' }, job?.company || 'People'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, 'This listing only. ↑/↓ choose · Enter opens the connection overlay.'),
    h(Box, { flexDirection: 'row', marginTop: 1 },
      h(Cta, { label: contacts.length ? 'Find more' : 'Find people', primary: true })
    ),
    contacts.length
      ? contacts.slice(0, 8).map((person, i) => h(Bx, {
          key: person.id,
          flexDirection: 'column',
          marginTop: 1,
          bg: i === state.peopleIndex ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { wrap: 'truncate-end' }, person.name || 'Unknown person'),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            [person.role, person.relevance, person.approved ? 'approved' : null].filter(Boolean).join(' · ') || 'contact')
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          'No contacts for this listing yet. /find-people stages them.')
  );
}

function SlashMenu({ hits, index }) {
  if (!hits.length) {
    return h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, 'No matching command');
  }
  return h(Bx, { flexDirection: 'column' },
    hits.map((item, i) => h(Bx, {
      key: item.id,
      flexDirection: 'row',
      justifyContent: 'space-between',
      bg: i === index ? CLASSIC_THEME.selected : undefined
    },
      h(Tx, { bold: i === index, wrap: 'truncate-end' }, item.label),
      h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, item.hint)
    ))
  );
}

function ChatPane({ model, state, actions, scope }) {
  // Pane content owns the full pane width without influencing board split.
  const job = selectedJob(model, state);
  const log = chatLog(state, scope, job?.id);
  const slashOpen = isComposerActive(state) && String(state.input || '').startsWith('/');
  const hits = slashOpen ? slashHits(state.input) : [];
  const placeholder = scope === 'workspace'
    ? 'Ask about the search…'
    : `Ask about ${job?.company || 'this job'}…`;
  return h(Bx, { flexDirection: 'column', flexGrow: 1, minHeight: 0, minWidth: 0, width: '100%' },
    h(Bx, { flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0, paddingX: 2, paddingY: 1 },
      log.length
        ? log.map((message, i) => h(Bx, { key: i, flexDirection: 'column', marginBottom: 1 },
            h(Tx, { color: message.kind === 'you' ? CLASSIC_THEME.muted : CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' },
              String(message.kind || 'you').toUpperCase()),
            h(Tx, { wrap: 'truncate-end' }, String(message.text || ''))
          ))
        : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            slashOpen
              ? 'Type to filter commands · Enter runs the highlighted one · Esc clears /'
              : scope === 'workspace'
                ? 'Workspace — the whole search, not one job. Slash works here: /review /network /find-people /daily. /jobs returns to the board.'
                : `Chat · ${job?.company || 'this job'}. /tracker /create-files /find-people, or ask about this listing.`
          )
    ),
    h(AgentBanner, { state }),
    slashOpen ? h(SlashMenu, { hits, index: state.slashIndex || 0 }) : null,
    h(CaretEntry, { text: state.input, cursor: state.inputCursor, placeholder })
  );
}

/** Honest assistant copy above the prompt: never an invented reply. */
function AgentBanner({ state }) {
  const agentState = state.agentState;
  let text = null;
  if (agentState === 'off') {
    text = 'Assistant is off · your messages stay local · run jobos tui without --agent off';
  } else if (agentState === 'unavailable') {
    text = 'Assistant unavailable · ACP backend not found · set JOBOS_ACP_COMMAND';
  } else if (agentState === 'failed' || agentState === 'timeout') {
    text = state.error ? `Assistant ${agentState} · ${state.error}` : `Assistant ${agentState}`;
  } else if (agentState === 'connecting') {
    text = 'Connecting assistant…';
  }
  if (!text) return null;
  return h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, text);
}

function Main({ model, state, actions }) {
  if (state.headerMode === 'workspace') {
    return h(ChatPane, { model, state, actions, scope: 'workspace' });
  }
  if (state.jobTab === 'chat') {
    return h(ChatPane, { model, state, actions, scope: 'job' });
  }
  if (state.jobTab === 'people') {
    return h(PeoplePane, { model, state, actions });
  }
  return h(JobPane, { model, state, actions });
}

/** Shared detail wrapper ensures pane content cannot alter board split. */
function DetailWrapper({ children }) {
  return h(Bx, {
    flexDirection: 'column',
    width: '100%',
    flexGrow: 1,
    flexShrink: 1,
    minWidth: 0,
    minHeight: 0
  }, children);
}

function StatusBar({ model, state }) {
  const line = statusLine(model, state);
  return h(Bx, { flexDirection: 'row', paddingX: 1, bg: CLASSIC_THEME.panel },
    h(Tx, { color: state.error ? CLASSIC_THEME.accent : CLASSIC_THEME.muted, wrap: 'truncate-end' }, line)
  );
}

function Footer({ model, state }) {
  // While the covering welcome overlay is open, the footer must not paint a
  // "New ... Jobs" line: the frozen B8 check treats any /New.*Jobs/ line
  // on first-run as a leaked left-rail strip. The New | Jobs hints return on
  // the dismissed board where the real rail is painted (B11 documents them).
  const welcomeOpen = effectiveOverlay(model, state) === 'welcome';
  return h(Bx, { flexDirection: 'row', paddingX: 1, bg: CLASSIC_THEME.panel },
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, '/'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' in Chat   '),
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'Tab'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' Job · People · Chat   '),
    welcomeOpen ? null : h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'n'),
    welcomeOpen ? null : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' New   '),
    welcomeOpen ? null : h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'j'),
    welcomeOpen ? null : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' Jobs   '),
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'G'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' Workspace   '),
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'Esc'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, ' closes')
  );
}

// ---------------------------------------------------------------------------
// Overlays (not panes). Each surface renders REAL model data; deep mutation
// controls (approve/reject/attest/import editors) are later-slice handlers.
// ---------------------------------------------------------------------------

function Modal({ kicker, children, hint }) {
  // Centered compact panel (classic.html .modal width min(440px, 92vw)): a
  // definite column width rather than a 78% fragment of the right column.
  // maxWidth 100% clamps it inside tiny frames; OverlaySurface owns the
  // full-shell backdrop and centering.
  return h(Bx, {
    flexDirection: 'column',
    width: MODAL_WIDTH,
    maxWidth: '100%',
    bg: CLASSIC_THEME.panel,
    paddingX: MODAL_PADDING_X,
    paddingY: 1
  },
    h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, String(kicker || '').toUpperCase()),
    children,
    hint ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, hint) : null
  );
}

function ChoiceRow({ label, detail, selected }) {
  return h(Bx, {
    flexDirection: 'column',
    marginTop: 1,
    bg: selected ? CLASSIC_THEME.selected : undefined
  },
    h(Tx, { bold: selected, wrap: 'truncate-end' }, label),
    detail ? h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, detail) : null
  );
}

/** Inline entry line for guided-setup input modes (renders in the owning overlay). */
function InlineEntry({ state, placeholder }) {
  return h(CaretEntry, { text: state.setupInput, placeholder, paddingX: 1, marginTop: 1 });
}

/** Truthful runtime probe detail for the optional provider/browser steps. */
function OptionalSetupDetail({ state, step }) {
  if (!step) return null;
  if (step.id === 'provider') {
    const agentState = state.agentState;
    const text = agentState === 'off' ? 'Assistant is off · messages stay local'
      : agentState === 'ready' ? 'Assistant ready · Hermes ACP'
        : agentState === 'connecting' ? 'Connecting assistant…'
          : agentState === 'unavailable' ? 'Unavailable · ACP backend not found (JOBOS_ACP_COMMAND)'
            : 'Not probed yet · run this step to connect';
    return h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, text);
  }
  if (step.id === 'browser') {
    const probe = state.setupBrowserProbe;
    const authenticated = Number(probe?.authenticatedProfileCount || 0);
    const text = !probe ? 'Not probed yet · run this step to check local Chromium'
      : authenticated > 0 ? `Ready · ${authenticated} authenticated profile${authenticated === 1 ? '' : 's'}`
        : probe.packageAvailable && probe.executableAvailable ? 'Available · no authenticated profile yet'
          : 'Unavailable · Chromium/playwright not installed';
    return h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, text);
  }
  return null;
}

function WelcomeOverlay({ model, state, actions }) {
  return h(Modal, {
    kicker: 'Welcome to JobOS',
    hint: 'Enter starts setup · Esc skips · 7 essential steps. Optional connections wait.'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, 'A private workspace for your job search'),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      'Short guided setup. You can change everything later. Nothing leaves this machine.'),
    h(Box, { flexDirection: 'row', marginTop: 1 },
      h(Cta, { label: 'Start guided setup', primary: true }),
      h(Cta, { label: 'Skip for now' })
    )
  );
}

function SetupRuler({ steps, index }) {
  const cells = steps.map(step => {
    if (step.status === 'complete') return '[✓]';
    if (step.id === (steps[index]?.id || steps[0]?.id)) return '[●]';
    return '[ ]';
  });
  return h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, `YOUR PROGRESS  ${cells.join(' ')}`);
}

function SetupOverlay({ model, state, actions }) {
  const steps = setupStepViews(model);
  const required = steps.filter(step => step.required);
  const done = completedRequiredCount(model);
  const index = Math.min(state.overlayIndex || 0, Math.max(0, steps.length - 1));
  const focused = steps[index] || steps[0];
  const mode = state.setupMode || '';
  const entryActive = mode === 'profile-name' || mode === 'network-intent';
  if (!focused) {
    return h(Modal, { kicker: 'Set up JobOS', hint: 'Esc to the board' },
      h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'Nothing to set up yet.'));
  }
  const buttons = [];
  if (focused.status === 'complete' && !SETUP_SUB_OVERLAYS[focused.id]) buttons.push({ label: 'Next', primary: false });
  else buttons.push({ label: 'Continue', primary: true });
  buttons.push({ label: 'Do this later', primary: false });
  return h(Modal, {
    kicker: `Set up JobOS — ${done}/${required.length} essential`,
    hint: entryActive
      ? 'Type · Enter submits · Esc cancels'
      : '↑/↓ move · Enter continues · Esc to the board'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, 'Guided setup'),
    h(SetupRuler, { steps, index }),
    steps.map((step, i) => {
      const mark = step.status === 'complete' ? '✓' : (step.required ? '·' : '–');
      return h(Bx, {
        key: step.id,
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 1,
        bg: i === index ? CLASSIC_THEME.selected : undefined
      },
        h(Tx, { wrap: 'truncate-end' }, `${mark} ${step.pos}  ${step.label}`),
        h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, step.status)
      );
    }),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      `${focused.label} — ${focused.summary}`),
    h(OptionalSetupDetail, { state, step: focused }),
    entryActive
      ? h(InlineEntry, { state, placeholder: mode === 'profile-name' ? 'Your name' : 'Target companies, comma-separated' })
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1 },
      buttons.map(button => h(Cta, { key: button.label, label: button.label, primary: button.primary }))
    )
  );
}

function SetupSourceOverlay({ model, state, actions, kind }) {
  const choices = kind === 'job' ? JOB_SOURCE_CHOICES : RESUME_SOURCE_CHOICES;
  const stepId = kind === 'job' ? 'intake' : 'resume';
  const step = (model?.onboarding?.steps || []).find(item => item.id === stepId);
  const mode = state.setupMode || '';
  const entryActive = kind === 'resume'
    ? mode === 'resume-paste' || mode === 'resume-path'
    : mode === 'job-paste' || mode === 'job-path' || mode === 'job-url';
  // Clamp the cursor so the highlight always sits on a real row; Enter then
  // acts on that same row (pickSetupSource clamps the same way).
  const index = Math.min(state.overlayIndex || 0, Math.max(0, choices.length - 1));
  return h(Modal, {
    kicker: `Setup · ${SETUP_STEP_LABELS[stepId]}`,
    hint: entryActive
      ? 'Type or paste · Enter imports · Esc cancels'
      : '↑/↓ choose · Enter selects · Esc back to setup'
  },
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, step?.summary || ''),
    choices.map((choice, i) => h(ChoiceRow, {
      key: choice.id,
      label: choice.label,
      detail: choice.detail,
      selected: i === index
    })),
    entryActive
      ? h(InlineEntry, { state, placeholder: kind === 'job' && mode === 'job-url' ? 'https://…' : `Paste ${kind === 'resume' ? 'resume' : 'posting'} text` })
      : null
  );
}

function SetupFileBrowserOverlay({ model, state, actions }) {
  const browse = state.setupBrowse || null;
  if (!browse) {
    return h(Modal, { kicker: 'Setup · Browse', hint: 'Esc back to source' },
      h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'No directory open.'));
  }
  const entries = browse.entries || [];
  const index = Math.min(browse.index || 0, Math.max(0, entries.length - 1));
  const visible = entries.slice(0, 12);
  return h(Modal, {
    kicker: `Setup · Browse ${browse.kind === 'resume' ? 'resume' : 'job description'}`,
    hint: '↑/↓ choose · Enter opens · Esc back to source'
  },
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, browse.dir),
    visible.length
      ? visible.map((entry, i) => h(Bx, {
          key: `${entry.name}:${i}`,
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 1,
          bg: i === index ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { bold: i === index, wrap: 'truncate-end' }, entry.isDir ? `${entry.name}/` : entry.name),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, entry.isDir ? 'dir' : 'file')
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          'No supported files in this directory.'),
    entries.length > visible.length
      ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, `${entries.length - visible.length} more entries…`)
      : null
  );
}

function SetupProofOverlay({ model, state, actions }) {
  const step = (model?.onboarding?.steps || []).find(item => item.id === 'proofs');
  const evidence = step?.evidence || {};
  const count = Number(evidence.proofCount || 0);
  const verified = Number(evidence.activeVerifiedCount || 0);
  const rows = state.setupProofRows || [];
  const index = Math.min(state.overlayIndex || 0, Math.max(0, rows.length - 1));
  const mode = state.setupMode || '';
  const entryActive = mode === 'proof-add' || mode === 'proof-edit' || mode === 'proof-drop';
  const hint = entryActive
    ? mode === 'proof-drop'
      ? 'Reason · Enter drops · Esc cancels'
      : mode === 'proof-edit'
        ? 'Edit the claim · Enter supersedes · Esc cancels'
        : 'Claim · Enter adds · Esc cancels'
    : '↑/↓ choose · v verify · e edit · d drop · a add · Esc continues';
  return h(Modal, {
    kicker: 'Setup · Validate experience highlights',
    hint
  },
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, step?.summary || ''),
    h(Tx, { marginTop: 1, wrap: 'truncate-end' },
      count ? `${verified} of ${count} proof points active and verified` : 'No proof points yet'),
    rows.length
      ? rows.slice(0, 8).map((item, i) => h(Bx, {
          key: item.id,
          flexDirection: 'column',
          marginTop: 1,
          bg: i === index ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { bold: i === index, wrap: 'truncate-end' }, item.summary || item.id),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            `${item.status === 'retired' ? 'retired' : `${item.verification_status} · active`}${item.evidence ? ` · ${item.evidence}` : ''}`)
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          'No imported proof points. a adds one in your own words.'),
    entryActive
      ? h(InlineEntry, { state, placeholder: mode === 'proof-drop' ? 'Reason…' : 'Claim…' })
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1 },
      rows.length ? h(Cta, { label: 'Verify (v)', primary: true }) : null,
      rows.length ? h(Cta, { label: 'Edit (e)', primary: false }) : null,
      rows.length ? h(Cta, { label: 'Drop (d)', primary: false }) : null,
      h(Cta, { label: 'Add (a)', primary: false })
    )
  );
}

function FilesOverlay({ model, state, actions }) {
  const job = selectedJob(model, state);
  const rows = filesRows(model, state);
  const index = Math.min(state.overlayIndex || 0, Math.max(0, rows.length - 1));
  const row = rows[index] || rows[0];
  const reason = state.filesReason || null;
  const content = row?.kind === 'questions'
    ? (state.questionsText || '')
    : (row?.kind === 'artifact' ? (row.doc?.content || '') : '');
  const contentLines = content.split('\n').filter(Boolean).slice(0, 10);
  const reviewable = Boolean(row?.kind === 'artifact' && row.doc?.approvalStatus === 'draft_needs_human_review');
  return h(Modal, {
    kicker: 'Files · this job',
    hint: reason
      ? 'Type a rejection reason · Enter rejects · Esc cancels'
      : '↑/↓ pick a file · a approve · r reject · Esc closes'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, job?.company || 'Files'),
    h(Box, { flexDirection: 'row', marginTop: 1, flexWrap: 'wrap' },
      rows.length
        ? rows.map((item, i) => h(Bx, { key: item.id, marginRight: 1, marginBottom: 1, bg: i === index ? CLASSIC_THEME.accent : undefined },
            h(Tx, { bold: i === index, color: i === index ? CLASSIC_THEME.ink : CLASSIC_THEME.muted, wrap: 'truncate-end' }, ` ${item.label} `)
          ))
        : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, 'No files yet.')
    ),
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, row?.label || ''),
    h(Tx, {
      color: CLASSIC_THEME.muted,
      wrap: row?.kind === 'questions' ? 'wrap' : 'truncate-end'
    },
      row?.kind === 'artifact'
        ? `revision ${row.doc?.revision || '?'} · ${row.doc?.approvalStatus || 'draft_needs_human_review'}`
        : row?.kind === 'missing'
          ? 'No draft yet · /create-files drafts resume + questions'
          : 'Application questions from the posting\nrestricted answers stay gated'),
    h(Bx, { flexDirection: 'column', marginTop: 1, paddingX: 1, bg: CLASSIC_THEME.panel },
      contentLines.length
        ? contentLines.map((line, i) => h(Tx, { key: i, color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, line))
        : h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            row?.kind === 'questions'
              ? 'No questions draft yet for this job. /create-files drafts them from the posting.'
              : row?.kind === 'missing'
                ? 'No resume draft yet for this job. /create-files drafts it from the posting.'
                : 'No content yet for this file.')
    ),
    reason
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, `Reason: ${reason.text || ''}`)
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1 },
      reviewable ? h(Cta, { label: 'Approve (a)', primary: true }) : null,
      reviewable ? h(Cta, { label: 'Reject (r)', primary: false }) : null,
      row?.kind === 'questions' ? h(Cta, { label: 'Reference copy', primary: false }) : null
    )
  );
}

function TrackerOverlay({ model, state, actions }) {
  const job = selectedJob(model, state);
  const readiness = model?.selected?.readiness;
  const packet = readiness?.packet || {};
  const rows = trackerRows(model, state);
  const index = Math.min(state.overlayIndex || 0, Math.max(0, rows.length - 1));
  const current = job?.applicationStatus || job?.discoveryStatus || '';
  return h(Modal, {
    kicker: 'Tracker · this job',
    hint: '1 saved · 2 researching · 3 applied · 4 waiting · ↑/↓ pick · Enter applies · f freeze · t attest · Esc closes'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, job?.company || 'Tracker'),
    h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, job?.title || ''),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      `STATUS · ${current || 'no application yet'}`),
    // Direct-select stage chips (spike tracker buttons). The four direct
    // stages render first on the first wrapped line — the frozen B11 cells
    // (51,11) (60,11) (73,11) (82,11) target exactly those four chips. Wrap
    // (like the original ACTIVE chip row) keeps the modal height identical so
    // the chips stay at the frozen row 11.
    h(Box, { flexDirection: 'row', marginTop: 1, flexWrap: 'wrap' },
      TRACKER_CHIP_STAGES.map(stage => h(Bx, {
        key: stage,
        marginRight: 1,
        marginBottom: 1,
        bg: stage === current ? CLASSIC_THEME.accent : undefined
      },
        h(Tx, {
          bold: stage === current,
          color: stage === current ? CLASSIC_THEME.ink : CLASSIC_THEME.muted,
          wrap: 'truncate-end'
        }, ` ${stage} `)
      ))
    ),
    rows.map((row, i) => h(Bx, {
      key: row.id,
      flexDirection: 'row',
      justifyContent: 'space-between',
      marginTop: 1,
      bg: i === index ? CLASSIC_THEME.selected : undefined
    },
      h(Tx, { bold: i === index, wrap: 'truncate-end' }, row.label),
      h(Tx, { color: row.disabled ? CLASSIC_THEME.line : CLASSIC_THEME.muted, wrap: 'truncate-end' },
        row.kind === 'status'
          ? (row.current ? 'current' : row.settable ? 'set' : 'attest only')
          : (row.detail || (row.id === 'attest-submitted' ? 'not eligible' : ''))
      )
    )),
    readiness
      ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          `Readiness · ${readiness.status || 'unknown'}${readiness.nextAction ? ` — ${readiness.nextAction}` : ''}`)
      : null,
    packet.currentPacketId
      ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          `Packet ${packet.currentPacketId} · ${packet.currency} · ${packet.receiptState}`)
      : null
  );
}

function ReviewOverlay({ model, state, actions }) {
  const next = model?.recommendedAction;
  const rows = reviewRows(model, state);
  const index = Math.min(state.overlayIndex || 0, Math.max(0, rows.length - 1));
  const weekly = state.weekly || null;
  const totals = weekly?.metrics?.totals || null;
  return h(Modal, {
    kicker: 'This morning',
    hint: '↑/↓ choose · Enter opens · w runs weekly · Esc to the board'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, 'Brief'),
    next
      ? h(Bx, { flexDirection: 'row', justifyContent: 'space-between', marginTop: 1 },
          h(Tx, { color: CLASSIC_THEME.accent, wrap: 'truncate-end' }, 'NEXT UP'),
          h(Tx, { wrap: 'truncate-end' }, next.label || '')
        )
      : null,
    rows.length
      ? rows.map((row, i) => h(Bx, {
          key: row.id,
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 1,
          bg: i === index ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { bold: i === index, wrap: 'truncate-end' }, row.label),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, row.detail || row.kind)
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'Nothing due · no drafts awaiting review.'),
    weekly
      ? h(Bx, { flexDirection: 'column', marginTop: 1, paddingX: 1, bg: CLASSIC_THEME.panel },
          h(Tx, { color: CLASSIC_THEME.accent, bold: true, wrap: 'truncate-end' }, 'WEEKLY READOUT'),
          totals
            ? h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
                `jobs ${totals.jobs || 0} · applications ${totals.applications || 0} · applied ${totals.applied || 0} · interviews ${totals.interviews || 0} · offers ${totals.offers || 0}`)
            : null,
          weekly.path ? h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, weekly.path) : null
        )
      : null
  );
}

function PeopleReviewOverlay({ model, state, actions }) {
  const rows = peopleReviewRows(model, state);
  const skipReason = state.peopleSkipReason || null;
  const keepNote = state.keepContactNote || null;
  const run = state.profileResearchRun || null;
  const hint = skipReason
    ? 'Type a suppression reason · Enter skips · Esc cancels'
    : keepNote
      ? 'Type a note · Enter keeps · Esc cancels'
      : '↑/↓ choose · k keep · x skip · Enter opens · Esc closes';
  return h(Modal, {
    kicker: 'Find people · profile',
    hint
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, rows.length ? 'Keep or skip' : 'Inbox clear'),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      rows.length
        ? `${rows.length} to review · profile research${run?.runId ? ` · run ${run.runId.slice(0, 8)} ${run.status || ''}` : ''}`
        : 'Kept people are in the Network overlay. Enter opens Network.'),
    rows.length
      ? rows.slice(0, 8).map((person, i) => h(Bx, {
          key: `${person.kind}:${person.id}`,
          flexDirection: 'column',
          marginTop: 1,
          bg: i === (state.overlayIndex || 0) ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { wrap: 'truncate-end' }, person.name || 'Unknown person'),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            `${person.kind} · ${person.detail || ''}`)
        ))
      : null,
    skipReason
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, `Reason: ${skipReason.text || ''}`)
      : null,
    keepNote
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, `Note: ${keepNote.text || ''}`)
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1 },
      rows.length ? h(Cta, { label: 'Keep (k)', primary: true }) : null,
      rows.length ? h(Cta, { label: 'Skip (x)', primary: false }) : null,
      h(Cta, { label: 'Open network', primary: false })
    )
  );
}

function NetworkOverlay({ model, state, actions }) {
  const setup = model?.networkSetup || {};
  const intent = setup.intent || {};
  const health = setup.health || { counts: { total: 0, strategic: 0, byWarmth: {} } };
  const counts = health.counts || {};
  const byWarmth = counts.byWarmth || {};
  const people = networkPeople(model, state);
  const graph = state.networkGraph || null;
  const personas = (intent.preferredPersonas || []).slice(0, 2).join(', ');
  const companies = (intent.targetCompanies || []).slice(0, 2).join(', ');
  const sources = Object.entries(intent.allowedSources || {})
    .filter(([, enabled]) => enabled)
    .map(([key]) => key)
    .slice(0, 2)
    .join(', ');
  const intentText = [personas, companies, sources].filter(Boolean).join(' · ') || 'not configured';
  return h(Modal, {
    kicker: 'Network · profile',
    hint: '↑/↓ choose · Enter opens connection · g queries graph · i Edit intent · Esc closes'
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, 'Graph'),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, `Intent · ${intentText}`),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      `total ${counts.total || 0} · strategic ${counts.strategic || 0} · hot ${byWarmth.hot || 0} warm ${byWarmth.warm || 0} cool ${byWarmth.cool || 0} cold ${byWarmth.cold || 0} unknown ${byWarmth.unknown || 0}`),
    // Edit-intent quick toggle (frozen B11 cell (55,22) at 140x42). Sits on
    // row 22 so the painted control aligns with the frozen click target.
    h(Tx, { bold: true, color: CLASSIC_THEME.accent, marginTop: 1, wrap: 'truncate-end' }, 'i Edit intent'),
    graph
      ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          `graph query · ${graph.pathCount || 0} paths · ${(graph.nodes || []).length} nodes · ${(graph.edges || []).length} edges`)
      : null,
    people.length
      ? people.slice(0, 8).map((person, i) => h(Bx, {
          key: `${person.kind}:${person.personId}`,
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 1,
          bg: i === (state.overlayIndex || 0) ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { wrap: 'truncate-end' }, person.name || 'Person'),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, `${person.detail || person.kind} · ${person.warmth}`)
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
          'No stored relationships yet. Configure intent i· or in Setup and run profile find-people.')
  );
}

function ConnectionOverlay({ model, state, actions }) {
  const person = connectionPerson(model, state);
  const note = state.recordContactNote || null;
  const markSent = state.markSent || null;
  const drafts = outreachDraftRows(model, state);
  if (!person) {
    return h(Modal, { kicker: 'Connection', hint: 'Esc back' },
      h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'No person selected.'));
  }
  const job = selectedJob(model, state);
  const isContact = person.kind === 'contact' || Boolean(person.contactId) || Boolean(person.type);
  const identity = isContact
    ? [person.role, person.type, person.approved ? 'approved' : 'not approved', person.suppressed ? 'suppressed' : null].filter(Boolean).join(' · ')
    : [person.detail || person.kind, `warmth ${person.warmth || 'unknown'}`, job?.company ? `job ${job.company}` : null].filter(Boolean).join(' · ');
  let hint = 'd draft outreach · a approve · r record contact · s mark sent · Esc back';
  if (note) hint = 'Type a note · Enter records human-confirmed contact · Esc cancels';
  else if (markSent && markSent.step === 'pick') hint = '↑/↓ pick an outreach draft · Enter chooses · Esc cancels';
  else if (markSent && markSent.step === 'channel') hint = 'Channel: email, linkedin, or other · Enter confirms · Esc cancels';
  else if (markSent && markSent.step === 'notes') hint = 'Notes (optional) · Enter marks sent · Esc cancels';
  const selectedDraft = drafts[markSent?.index || 0] || null;
  return h(Modal, {
    kicker: 'Connection · this job',
    hint
  },
    h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, person.name || 'Unknown person'),
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, identity || ''),
    note
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, `Note: ${note.text || ''}`)
      : null,
    markSent && markSent.step === 'pick' && drafts.length
      ? drafts.slice(0, 6).map((draft, i) => h(Bx, {
          key: draft.id,
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 1,
          bg: i === (markSent.index || 0) ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { wrap: 'truncate-end' }, draft.label),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' }, draft.detail)
        ))
      : null,
    markSent && markSent.step !== 'pick'
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' },
          `${selectedDraft ? `Artifact: ${selectedDraft.label} · ` : ''}${markSent.step === 'channel' ? `Channel: ${markSent.channel || ''}` : `Channel: ${markSent.channel || ''} · Notes: ${markSent.notes || ''}`}`)
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1, flexWrap: 'wrap' },
      h(Cta, { label: 'Draft outreach (d)', primary: true }),
      h(Cta, { label: 'Record contact (r)', primary: false }),
      isContact ? h(Cta, { label: 'Approve (a)', primary: false }) : null,
      h(Cta, { label: 'Mark sent (s)', primary: false })
    )
  );
}

function MemoryOverlay({ model, state, actions }) {
  const memory = model?.memory || { counts: { observations: 0, proposals: 0, active: 0 }, observations: [], proposals: [] };
  const counts = memory.counts || {};
  const brief = memory.careerBrief;
  const observations = memory.observations || [];
  const proposals = memory.proposals || [];
  const reason = state.memoryReason || null;
  const briefText = brief
    ? (brief.summary || brief.headline || (brief.title ? `Career brief · ${brief.title}` : ''))
    : '';
  const hint = reason
    ? `Type a ${reason.action === 'reject' ? 'rejection' : 'revocation'} reason · Enter ${reason.action}s · Esc cancels`
    : '↑/↓ choose · a accept · r reject · v revoke · Esc closes';
  return h(Modal, {
    kicker: 'Career memory',
    hint
  },
    h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' },
      `observations ${counts.observations || 0} · proposals ${counts.proposals || 0} · active ${counts.active || 0}`),
    briefText ? h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, briefText) : null,
    proposals.length
      ? proposals.slice(0, 8).map((proposal, i) => h(Bx, {
          key: proposal.id,
          flexDirection: 'column',
          marginTop: 1,
          bg: i === (state.overlayIndex || 0) ? CLASSIC_THEME.selected : undefined
        },
          h(Tx, { bold: i === (state.overlayIndex || 0), wrap: 'truncate-end' },
            `${proposal.status} · ${proposal.id} · ${proposal.ruleType || 'rule'} · ${proposal.scope || ''}`),
          h(Tx, { color: CLASSIC_THEME.muted, wrap: 'truncate-end' },
            `${proposal.rationale || proposal.id}${proposal.inactiveReason ? ` · ${proposal.inactiveReason}` : ''}${proposal.stale ? ' · evidence stale' : ''}`)
        ))
      : h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'No career-memory proposals yet.'),
    observations.length
      ? observations.slice(0, 3).map(observation => h(Tx, { key: observation.id, marginTop: 1, wrap: 'truncate-end' },
          `· ${observation.publicExplanation || observation.eventType || observation.id}`))
      : null,
    reason
      ? h(Tx, { bold: true, marginTop: 1, wrap: 'truncate-end' }, `Reason: ${reason.text || ''}`)
      : null,
    h(Box, { flexDirection: 'row', marginTop: 1 },
      proposals.length ? h(Cta, { label: 'Accept (a)', primary: true }) : null,
      proposals.length ? h(Cta, { label: 'Reject (r)', primary: false }) : null,
      proposals.length ? h(Cta, { label: 'Revoke (v)', primary: false }) : null
    )
  );
}

function overlayContent(overlay, { model, state, actions }) {
  switch (overlay) {
    case 'welcome': return h(WelcomeOverlay, { model, state, actions });
    case 'setup': return h(SetupOverlay, { model, state, actions });
    case 'setup-resume-source': return h(SetupSourceOverlay, { model, state, actions, kind: 'resume' });
    case 'setup-job-source': return h(SetupSourceOverlay, { model, state, actions, kind: 'job' });
    case 'setup-file-browser': return h(SetupFileBrowserOverlay, { model, state, actions });
    case 'setup-proof-review': return h(SetupProofOverlay, { model, state, actions });
    case 'files': return h(FilesOverlay, { model, state, actions });
    case 'tracker': return h(TrackerOverlay, { model, state, actions });
    case 'review': return h(ReviewOverlay, { model, state, actions });
    case 'people-review': return h(PeopleReviewOverlay, { model, state, actions });
    case 'network': return h(NetworkOverlay, { model, state, actions });
    case 'connection': return h(ConnectionOverlay, { model, state, actions });
    case 'memory': return h(MemoryOverlay, { model, state, actions });
    default: return h(Modal, { kicker: String(overlay || ''), hint: 'Esc closes' },
      h(Tx, { color: CLASSIC_THEME.muted, marginTop: 1, wrap: 'truncate-end' }, 'Overlay — not a pane.'));
  }
}

function OverlaySurface({ overlay, model, state, actions }) {
  const { color } = useTheme();
  // Covering overlay (classic.html [data-overlay] inset:0): grows to fill the
  // whole shell so the modal is centered and the last chrome row sits near the
  // bottom of the requested frame. No blank-line padding is injected.
  return h(Box, {
    width: '100%',
    flexGrow: 1,
    minHeight: 0,
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: color ? OVERLAY_BACKDROP : undefined
  }, overlayContent(overlay, { model, state, actions }));
}

/**
 * Root controlled component. Renders the full Classic shell (or a covering
 * overlay) inside a definite frame: width/height come from the caller
 * (snapshot: requested size; TTY: stdout.columns x stdout.rows, flags
 * override). A definite root height is what makes Yoga flexGrow fill the
 * frame instead of collapsing to content height.
 */
export function App({ model, state, actions, theme = CLASSIC_THEME, colorEnabled = false, interactive = false, width = null, height = null }) {
  const overlay = effectiveOverlay(model, state);
  const themeValue = { tokens: theme, color: Boolean(colorEnabled) };
  const frameWidth = width ? Math.max(1, Math.floor(Number(width) || 0)) : null;
  const frameHeight = height ? Math.max(1, Math.floor(Number(height) || 0)) : null;
  const viewportWidth = frameWidth || 140;
  const viewportHeight = frameHeight || 42;
  const geo = boardGeometry({ width: viewportWidth, height: viewportHeight });
  const main = overlay
    ? h(OverlaySurface, { overlay, model, state, actions })
    : h(Main, { model, state, actions });
  let body;
  if (overlay) {
    body = main;
  } else if (state.headerMode === 'workspace') {
    body = h(Box, {
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      minHeight: 0,
      width: '100%',
      overflow: 'hidden'
    }, main);
  } else if (geo.mode !== 'split') {
    // Compact: detail/composer clipped — render rail only so no off-screen pane tabs/composer appear
    body = h(Box, {
      flexDirection: 'column',
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      minHeight: 0,
      width: '100%',
      overflow: 'hidden'
    },
      h(LeftRail, { model, state, actions, width: geo.railWidth })
    );
  } else {
    const detail = h(Box, {
      flexDirection: 'column',
      width: geo.paneWidth,
      flexGrow: 1,
      flexShrink: 1,
      flexBasis: 0,
      minWidth: 0,
      minHeight: 0,
      overflow: 'hidden'
    },
      h(PaneBar, { model, state, actions }),
      h(DetailWrapper, null, main)
    );
    body = h(Box, {
      flexDirection: 'row',
      flexGrow: 1,
      flexShrink: 1,
      minWidth: 0,
      minHeight: 0,
      width: '100%',
      overflow: 'hidden'
    },
      h(LeftRail, { model, state, actions, width: geo.railWidth }),
      detail
    );
  }
  const tree = h(Box, {
    width: frameWidth || '100%',
    height: frameHeight || undefined,
    flexDirection: 'column',
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden'
  },
    h(Header, { model, state, actions }),
    body,
    h(StatusBar, { model, state }),
    h(Footer, { model, state })
  );
  return h(ThemeProvider, { theme: INKUI_THEME },
    h(ThemeContext.Provider, { value: themeValue }, tree)
  );
}

export { h };
