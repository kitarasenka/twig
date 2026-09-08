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
 * No imports: Vite loads this for the graph and Node loads it in the
 * self-check, and both read the same file.
 */
export const HISTORY_COLUMNS = {
  branch: { label: 'Branch / tag', min: 90, max: 340, defaultWidth: 140 },
  graph: { label: 'Graph', min: 48, max: 640, defaultWidth: null },
  message: { label: 'Commit message', min: 160, max: 1200, defaultWidth: 300 },
  author: { label: 'Author', min: 72, max: 320, defaultWidth: 100 },
  date: { label: 'Date', min: 72, max: 260, defaultWidth: 104 },
};

export const HISTORY_COLUMN_KEYS = Object.keys(HISTORY_COLUMNS);

export const HISTORY_COLUMNS_KEY = 'twig:history-columns';

export function clampColumnWidth(key, width) {
  const size = HISTORY_COLUMNS[key];
  if (!size) return null;
  if (!Number.isFinite(width)) return size.defaultWidth;
  return Math.round(Math.min(size.max, Math.max(size.min, width)));
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
      if (Number.isFinite(raw[key])) widths[key] = clampColumnWidth(key, raw[key]);
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

/** Pointer drag: `deltaX` is how far the handle moved from where it was grabbed. */
export function dragColumnWidth(key, startWidth, deltaX) {
  return clampColumnWidth(key, startWidth + deltaX);
}

/** Keyboard nudge: ArrowRight grows, ArrowLeft shrinks. */
export function nudgeColumnWidth(key, width, step) {
  return clampColumnWidth(key, width + step);
}
