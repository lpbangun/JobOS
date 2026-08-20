/** Shared terminal geometry for rendering and SGR mouse hit-testing. */

export const DEFAULT_VIEWPORT = Object.freeze({ width: 140, height: 42 });
export const MODAL_WIDTH = 52;
export const MODAL_PADDING_X = 2;

const BODY_TOP = 2;
const BODY_CHROME_ROWS = 3;
const NETWORK_MODAL_HEIGHT = 9;
const TRACKER_MODAL_HEIGHT = 35;

// Board geometry constants — integer cell allocation only.
export const BOARD_TAB_WIDTH = 10;
export const BOARD_TAB_COUNT = 3;
export const MIN_RAIL_WIDTH = 16;
export const MIN_PANE_WIDTH = 24;
export const HEADER_WORKSPACE_WIDTH = 12; // [W-19,W-8] inclusive
// Jobs header span is 8 cells [W-7,W]
export const RAIL_ROW_HEIGHT = 2;
export const RAIL_ROWS_TOP = 3;

function dimension(override, live, fallback) {
  const requested = Number(override);
  if (Number.isFinite(requested) && requested > 0) return Math.max(1, Math.floor(requested));
  const measured = Number(live);
  if (Number.isFinite(measured) && measured > 0) return Math.max(1, Math.floor(measured));
  return fallback;
}

/** CLI overrides win per axis, then the live output size, then fixed fallback. */
export function resolveViewport(options = {}, stdout = null) {
  return {
    width: dimension(options.width, stdout?.columns, DEFAULT_VIEWPORT.width),
    height: dimension(options.height, stdout?.rows, DEFAULT_VIEWPORT.height)
  };
}

/** First 1-based content column inside the centered Modal component. */
export function modalContentLeft(width) {
  const measured = Math.max(1, Math.floor(Number(width) || DEFAULT_VIEWPORT.width));
  const modalWidth = Math.min(MODAL_WIDTH, measured);
  const outerLeft = Math.floor((measured - modalWidth) / 2);
  return outerLeft + Math.min(MODAL_PADDING_X, Math.max(0, modalWidth - 1)) + 1;
}

function centeredModalTop(height, naturalHeight) {
  const measured = Math.max(1, Math.floor(Number(height) || DEFAULT_VIEWPORT.height));
  const bodyHeight = Math.max(0, measured - BODY_CHROME_ROWS);
  return BODY_TOP + Math.floor(Math.max(0, bodyHeight - naturalHeight) / 2);
}

/** Geometry of the Tracker direct-stage chip line rendered by TrackerOverlay. */
export function trackerStageGeometry(width, height) {
  const measuredHeight = Math.max(1, Math.floor(Number(height) || DEFAULT_VIEWPORT.height));
  const bodyHeight = Math.max(0, measuredHeight - BODY_CHROME_ROWS);
  // When the 35-row tracker is taller than a very short body, Yoga removes
  // vertical free space from the upper stack. This is the same compact-modal
  // contraction used by the rendered tree; the stage line remains visible.
  const compactShift = Math.min(2, Math.floor(Math.max(0, TRACKER_MODAL_HEIGHT - bodyHeight) / 7));
  const row = centeredModalTop(measuredHeight, TRACKER_MODAL_HEIGHT) + 6 - compactShift;
  return {
    contentLeft: modalContentLeft(width),
    row,
    rowEnd: row + 1 // chip marginBottom is part of the clickable chip region
  };
}

/** Geometry of NetworkOverlay's `i Edit intent` text control. */
export function networkIntentGeometry(width, height) {
  return {
    contentLeft: modalContentLeft(width),
    row: centeredModalTop(height, NETWORK_MODAL_HEIGHT) + 5,
    label: 'i Edit intent'
  };
}

/** Inclusive 1-based rectangle helper. */
export function contains(rect, col, row) {
  if (!rect) return false;
  return col >= rect.left && col <= rect.right && row >= rect.top && row <= rect.bottom;
}

function clipRect(rect, width, height) {
  if (!rect) return null;
  const left = Math.max(1, rect.left);
  const right = Math.min(width, rect.right);
  const top = Math.max(1, rect.top);
  const bottom = Math.min(height, rect.bottom);
  if (left > right || top > bottom) return null;
  return { left, right, top, bottom };
}

/**
 * Deterministic integer board geometry shared by rendering and hit-testing.
 * No percentages remain in consumers — widths are integer cells derived once
 * from the viewport and passed explicitly to Yoga and to hitTestGrid.
 */
export function boardGeometry(viewport) {
  const width = Math.max(1, Math.floor(Number(viewport?.width) || DEFAULT_VIEWPORT.width));
  const height = Math.max(1, Math.floor(Number(viewport?.height) || DEFAULT_VIEWPORT.height));
  const minSplitWidth = MIN_RAIL_WIDTH + BOARD_TAB_WIDTH * BOARD_TAB_COUNT; // 46
  const isSplit = width >= minSplitWidth && height >= 6;
  let railWidth;
  let paneWidth;
  let mode;
  if (isSplit) {
    const desired = Math.floor(width * 0.34);
    const maxRail = Math.max(MIN_RAIL_WIDTH, width - MIN_PANE_WIDTH);
    railWidth = Math.max(MIN_RAIL_WIDTH, Math.min(desired, maxRail));
    paneWidth = width - railWidth;
    // Ensure pane can contain the three tabs when split; if not, compact.
    if (paneWidth < BOARD_TAB_WIDTH * BOARD_TAB_COUNT) {
      mode = 'compact';
      railWidth = width;
      paneWidth = 0;
    } else {
      mode = 'split';
    }
  } else {
    mode = 'compact';
    railWidth = width;
    paneWidth = 0;
  }
  const headerWorkspace = { left: width - 19, right: width - 8, top: 1, bottom: 1 };
  const headerJobs = { left: width - 7, right: width, top: 1, bottom: 1 };
  const bodyTop = 2;
  const bodyBottom = Math.max(1, height - 2);
  const statusRow = height - 1;
  const footerRow = height;
  const composerRow = height - 2;
  // Rail rect covers the full left column area
  const railRect = { left: 1, right: railWidth, top: bodyTop, bottom: bodyBottom };
  const paneRect = mode === 'split'
    ? { left: railWidth + 1, right: width, top: bodyTop, bottom: bodyBottom }
    : { left: 1, right: 0, top: bodyTop, bottom: bodyBottom };
  // Rail mode tabs on row 2 inside rail
  const railHalf = Math.floor(railWidth / 2);
  const railNew = { left: 1, right: railHalf, top: 2, bottom: 2 };
  const railJobs = { left: railHalf + 1, right: railWidth, top: 2, bottom: 2 };
  // Pane tabs on row 2 inside pane — equal 10-cell, contiguous, content-hugging
  let paneJob = null;
  let panePeople = null;
  let paneChat = null;
  if (mode === 'split') {
    const tabStart = railWidth + 1;
    paneJob = { left: tabStart, right: tabStart + BOARD_TAB_WIDTH - 1, top: 2, bottom: 2 };
    panePeople = { left: tabStart + BOARD_TAB_WIDTH, right: tabStart + BOARD_TAB_WIDTH * 2 - 1, top: 2, bottom: 2 };
    paneChat = { left: tabStart + BOARD_TAB_WIDTH * 2, right: tabStart + BOARD_TAB_WIDTH * 3 - 1, top: 2, bottom: 2 };
  }
  // Clip all rects to viewport for hit-testing visibility contracts
  const clipped = {
    headerWorkspace: clipRect(headerWorkspace, width, height),
    headerJobs: clipRect(headerJobs, width, height),
    rail: clipRect(railRect, width, height),
    railNew: clipRect(railNew, width, height),
    railJobs: clipRect(railJobs, width, height),
    pane: paneWidth > 0 ? clipRect(paneRect, width, height) : null,
    paneJob: paneJob ? clipRect(paneJob, width, height) : null,
    panePeople: panePeople ? clipRect(panePeople, width, height) : null,
    paneChat: paneChat ? clipRect(paneChat, width, height) : null
  };
  return {
    viewport: { width, height },
    mode,
    railWidth,
    paneWidth,
    header: {
      workspace: headerWorkspace,
      jobs: headerJobs,
      workspaceClipped: clipped.headerWorkspace,
      jobsClipped: clipped.headerJobs
    },
    body: { top: bodyTop, bottom: bodyBottom },
    rail: {
      rect: railRect,
      rectClipped: clipped.rail,
      width: railWidth,
      tabs: { new: railNew, jobs: railJobs },
      tabsClipped: { new: clipped.railNew, jobs: clipped.railJobs },
      rowsTop: RAIL_ROWS_TOP,
      rowHeight: RAIL_ROW_HEIGHT
    },
    pane: {
      rect: paneRect,
      rectClipped: clipped.pane,
      width: paneWidth,
      tabs: { job: paneJob, people: panePeople, chat: paneChat },
      tabsClipped: { job: clipped.paneJob, people: clipped.panePeople, chat: clipped.paneChat },
      composerRow
    },
    statusRow,
    footerRow,
    composerRow,
    // expose clip helper result map for tests
    clipped
  };
}
