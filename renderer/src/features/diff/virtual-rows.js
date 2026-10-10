// Windowing for long diffs. A lock file's diff is tens of thousands of rows;
// drawing all of them (56 000 rows, 360 000 DOM nodes for one package-lock.json)
// froze the window for two seconds and every scroll after. Rows of a diff are
// one line each, so a window of rows plus two spacers stands in for the rest.
// No imports: Vite and the Node check both load this module.

/** Diffs up to this many rows are drawn whole, so selecting and copying all of one keeps working. */
export const VIRTUAL_FROM = 1500;

/** Rows drawn beyond the visible ones on each side, so a fast scroll does not show gaps. */
export const OVERSCAN = 40;

/** The rows to draw for a scroll position: `[start, end)`. */
export function visibleRange({ count, rowHeight, scrollTop, viewHeight, overscan = OVERSCAN }) {
  if (!count || !(rowHeight > 0)) return { start: 0, end: Math.min(count, overscan * 2) };
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((Math.max(0, scrollTop) + Math.max(0, viewHeight)) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}

/**
 * The index of the row that needs the most width (a tab counted as a full tab
 * stop), drawn invisibly at zero height so the sideways scroll keeps its width
 * whichever rows are drawn.
 */
export function widestRow(rows) {
  let widest = -1;
  let most = -1;
  rows.forEach((row, index) => {
    let width = row.marker ? 1 : 0;
    for (const piece of row.pieces || []) for (const character of piece.text) width += character === '\t' ? 8 : 1;
    if (width > most) { most = width; widest = index; }
  });
  return widest;
}
