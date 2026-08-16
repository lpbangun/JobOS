/**
 * JobOS TUI facade — the single export surface consumed by src/cli.js and the
 * TUI test suite. The legacy custom box-drawing renderer is retired; the
 * product shell is now the Ink + React 19 tree in src/tui/.
 *
 * Contract exports:
 *   defaultTuiState()                      locked state vocabulary
 *   renderTui(model, state, opts)          synchronous bounded snapshot
 *   JobosTui                               controller (start/stop/render/handleKey)
 *   startTui(store, options)               Ink TTY runtime entry
 *   TUI_DOMAIN_ACTIONS                     slash-id -> domain tool map
 */
export { CLASSIC_THEME, INKUI_THEME } from './tui/theme.js';
// Expose the mounted @inkjs/ui primitives through the product facade so
// integrations can inspect the actual runtime contract, not source text.
export { ThemeProvider, Spinner } from '@inkjs/ui';
export { renderTui } from './tui/render.js';
export {
  defaultTuiState,
  JobosTui,
  startTui,
  TUI_DOMAIN_ACTIONS
} from './tui/runtime.js';
// Pure derivations shared with the shell and later feature slices.
export {
  SETUP_STEP_LABELS,
  SLASH_CATALOG,
  RESUME_SOURCE_CHOICES,
  JOB_SOURCE_CHOICES,
  fitLabel,
  newRows,
  jobRows,
  railRows,
  actionChip,
  stageLabel,
  selectedJob,
  selectedRow,
  effectiveOverlay,
  isComposerActive,
  statusLine
} from './tui/model.js';
