/** Packing the Branch / tag column into lines.
 *
 * The column used to show two badges and a `+N` stub, which named a number
 * instead of the branches. Now every ref is shown: the badges wrap onto as
 * many lines as they need and the row grows to hold them. The wrapping is
 * computed here rather than left to `flex-wrap`, because a virtualized list
 * has to know a row's height before it renders the row.
 *
 * No imports: Vite and the Node check both load this file directly.
 */

/** Height of one wrapped line of badges, including the gap above it. */
export const REF_LINE_HEIGHT = 18;
/** Border + padding + icon + icon gap of a badge, around its text. */
export const BADGE_CHROME = 26;
/** Gap between two badges on the same line. */
export const BADGE_GAP = 4;
/** The HEAD tick and the mark bookmark sit before the first badge. */
export const HEAD_WIDTH = 20;
export const MARK_WIDTH = 18;

/** Width of one badge; `measure` returns the pixel width of the name. */
export function badgeWidth(name, measure) {
  return BADGE_CHROME + Math.ceil(measure(String(name ?? '')));
}

/** Greedy left-to-right packing. `widths` are badge widths in display order,
 * `lead` is what the HEAD tick and mark chip already take on the first line.
 * Returns lines of indices into `widths`; a badge wider than the whole column
 * gets a line of its own and is clipped there rather than pushed out of view. */
export function packRefLines(widths, available, lead = 0) {
  const room = Math.max(1, available);
  const lines = [];
  let line = [];
  let used = lead;
  for (let index = 0; index < widths.length; index += 1) {
    const width = widths[index];
    const need = line.length ? BADGE_GAP + width : width;
    if (line.length && used + need > room) {
      lines.push(line);
      line = [index];
      used = width;
    } else {
      line.push(index);
      used += need;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

/** Extra pixels this row needs beyond a plain one-line row. */
export function extraHeight(lineCount) {
  return Math.max(0, lineCount - 1) * REF_LINE_HEIGHT;
}
