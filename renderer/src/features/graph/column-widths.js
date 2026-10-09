/**
 * Adjustable widths for the history table's columns. Each column carries a
 * resize handle on its right edge, so dragging a handle right always widens the
 * column it belongs to.
 *
 * The `graph` column is special: its default is `null`, meaning "size to the
 * lanes". A drag pins it to a fixed width; a double-click (or the keyboard
 * reset) drops back to `null` and the auto width returns. Every other column,
 * message included, is a plain fixed width — a trailing filler track soaks up
 * any slack, so dragging the divider on a column's right edge resizes it right
 * away, and the table scrolls horizontally only once the columns outgrow the pane.
 *
 * Every column's minimum is a tenth of its maximum (`MIN_SHARE`). A graph
 * narrower than its lanes clips them and scrolls sideways on its own, so its
 * floor is also never wider than the lanes need (`graphFloor`): narrowing a
 * small graph must not make it jump wider.
 *
 * No imports: Vite loads this for the graph and Node loads it in the
 * self-check, and both read the same file.
 */
export const MIN_SHARE = 0.1;
const column = (label, max, defaultWidth) => ({ label, min: Math.round(max * MIN_SHARE), max, defaultWidth });

export const HISTORY_COLUMNS = {
  branch: column('Branch / tag', 340, 140),
  graph: column('Graph', 640, null),
  message: column('Commit message', 1200, 300),
  author: column('Author', 320, 100),
  date: column('Date', 260, 104),
};

/** The automatic graph width never goes below this, however few lanes there are. */
export const GRAPH_AUTO_MIN = 72;

/** The narrowest the graph can be dragged: its minimum, unless the lanes need less. */
export function graphFloor(autoWidth) {
  return Math.min(HISTORY_COLUMNS.graph.min, Math.max(GRAPH_AUTO_MIN, autoWidth));
}

export const HISTORY_COLUMN_KEYS = Object.keys(HISTORY_COLUMNS);

/** Columns a right-click on the header can hide/show. Graph and Commit
 * message stay put: the graph is the point of the screen, and a message-less
 * row is just noise. */
export const TOGGLABLE_COLUMNS = ['branch', 'author', 'date'];

export const HISTORY_COLUMNS_KEY = 'twig:history-columns';
export const HISTORY_COLUMNS_VISIBLE_KEY = 'twig:history-columns-visible';

/** `floor` replaces the column's minimum: the graph passes `graphFloor(...)`. */
export function clampColumnWidth(key, width, floor = HISTORY_COLUMNS[key]?.min) {
  const size = HISTORY_COLUMNS[key];
  if (!size) return null;
  if (!Number.isFinite(width)) return size.defaultWidth;
  return Math.round(Math.min(size.max, Math.max(floor, width)));
}

export function defaultColumnWidths() {
  const widths = {};
  for (const key of HISTORY_COLUMN_KEYS) widths[key] = HISTORY_COLUMNS[key].defaultWidth;
  return widths;
}

/** Fill any missing or out-of-range value with the default, drop everything else. */
export function normalizeColumnWidths(raw) {
  const widths = defaultColumnWidths();
  if (raw && typeof raw === 'object') {
    for (const key of HISTORY_COLUMN_KEYS) {
      // Before the lanes are known the graph only gets the lowest floor it could
      // ever have; the graph clamps it again once it knows its lanes.
      if (Number.isFinite(raw[key])) widths[key] = clampColumnWidth(key, raw[key], key === 'graph' ? graphFloor(0) : undefined);
    }
  }
  return widths;
}

export function readColumnWidths(storage) {
  try {
    const stored = storage.getItem(HISTORY_COLUMNS_KEY);
    return normalizeColumnWidths(stored ? JSON.parse(stored) : null);
  } catch {
    return defaultColumnWidths();
  }
}

export function writeColumnWidths(storage, widths) {
  try {
    storage.setItem(HISTORY_COLUMNS_KEY, JSON.stringify(normalizeColumnWidths(widths)));
  } catch { /* Preference stays session-local when storage is unavailable. */ }
}

export function defaultColumnVisibility() {
  const visibility = {};
  for (const key of TOGGLABLE_COLUMNS) visibility[key] = true;
  return visibility;
}

/** Fill any missing or malformed entry with the default (visible), drop everything else. */
export function normalizeColumnVisibility(raw) {
  const visibility = defaultColumnVisibility();
  if (raw && typeof raw === 'object') {
    for (const key of TOGGLABLE_COLUMNS) {
      if (typeof raw[key] === 'boolean') visibility[key] = raw[key];
    }
  }
  return visibility;
}

export function readColumnVisibility(storage) {
  try {
    const stored = storage.getItem(HISTORY_COLUMNS_VISIBLE_KEY);
    return normalizeColumnVisibility(stored ? JSON.parse(stored) : null);
  } catch {
    return defaultColumnVisibility();
  }
}

export function writeColumnVisibility(storage, visibility) {
  try {
    storage.setItem(HISTORY_COLUMNS_VISIBLE_KEY, JSON.stringify(normalizeColumnVisibility(visibility)));
  } catch { /* Preference stays session-local when storage is unavailable. */ }
}

/** Pointer drag: `deltaX` is how far the handle moved from where it was grabbed. */
export function dragColumnWidth(key, startWidth, deltaX, floor) {
  return clampColumnWidth(key, startWidth + deltaX, floor);
}

/** Keyboard nudge: ArrowRight grows, ArrowLeft shrinks. */
export function nudgeColumnWidth(key, width, step, floor) {
  return clampColumnWidth(key, width + step, floor);
}

/** How far the graph scrolls sideways: `wanted`, kept inside what is hidden. */
export function clampGraphScroll(wanted, contentWidth, width) {
  const overflow = Math.max(0, contentWidth - width);
  if (!Number.isFinite(wanted)) return 0;
  return Math.round(Math.min(overflow, Math.max(0, wanted)));
}

/** The scroll that brings a commit's dot (at `x`, with `margin` around it) into view. */
export function revealGraphX(scroll, x, width, contentWidth, margin = 14) {
  let next = scroll;
  if (x - margin < next) next = x - margin;
  else if (x + margin > next + width) next = x + margin - width;
  return clampGraphScroll(next, contentWidth, width);
}
