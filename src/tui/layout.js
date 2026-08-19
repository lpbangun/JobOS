/** Shared terminal geometry for rendering and SGR mouse hit-testing. */

export const DEFAULT_VIEWPORT = Object.freeze({ width: 140, height: 42 });
export const MODAL_WIDTH = 52;
export const MODAL_PADDING_X = 2;

const BODY_TOP = 2;
const BODY_CHROME_ROWS = 3;
const NETWORK_MODAL_HEIGHT = 9;
const TRACKER_MODAL_HEIGHT = 35;

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
