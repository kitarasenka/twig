/**
 * What a diff row looks like on screen, as data: which syntax colours each
 * side of a hunk gets, how those colours merge with the intra-line change
 * segments, and how word mode folds a removed/added pair into one line.
 *
 * Highlighting itself is injected (`highlight(lines) → ranges per line`), so
 * this module stays free of imports: Vite and the Node self-check both load
 * it, and the check can drive it with a fake highlighter as well as Prism.
 *
 * @typedef {{ start: number, end: number, cls: string }} Range
 * @typedef {{ text: string, cls: string }} Piece
 * @typedef {{ kind: 'context' | 'add' | 'delete' | 'hunk' | 'meta', text: string }} SourceLine
 */

const SEGMENT_CLASS = { same: '', del: 'diff-seg-del', add: 'diff-seg-add' };

/**
 * Highlight each side of every hunk as one block — the old side is its
 * context and removed lines, the new side its context and added lines — so a
 * comment or string that spans lines is coloured correctly on both. A removed
 * line takes its colours from the old side; added and context lines from the
 * new one. `hunk` lines start a new block; `meta` lines (`\ No newline…`)
 * belong to neither side.
 * @param {SourceLine[]} lines text without the leading +/-/space marker
 * @param {(lines: string[]) => (Range[] | null)[]} highlight
 * @returns {(Range[] | null)[]} aligned with `lines`
 */
export function sideSyntax(lines, highlight) {
  const out = lines.map(() => null);
  let start = 0;
  const flush = end => {
    const oldIdx = [];
    const newIdx = [];
    for (let i = start; i < end; i++) {
      const { kind } = lines[i];
      if (kind === 'context' || kind === 'delete') oldIdx.push(i);
      if (kind === 'context' || kind === 'add') newIdx.push(i);
    }
    const oldRanges = oldIdx.length ? highlight(oldIdx.map(i => lines[i].text)) : [];
    const newRanges = newIdx.length ? highlight(newIdx.map(i => lines[i].text)) : [];
    oldIdx.forEach((index, n) => { if (lines[index].kind === 'delete') out[index] = oldRanges[n] ?? null; });
    newIdx.forEach((index, n) => { out[index] = newRanges[n] ?? null; });
  };
  lines.forEach((line, index) => {
    if (line.kind === 'hunk') { flush(index); start = index + 1; }
  });
  flush(lines.length);
  return out;
}

/** The patch rows `annotatePatch` produced, as source lines for `sideSyntax`. */
export function patchSourceLines(rows) {
  let inHunk = false;
  return rows.map(row => {
    if (row.cls === 'diff-hunk') { inHunk = true; return { kind: 'hunk', text: row.text }; }
    if (!inHunk) return { kind: 'hunk', text: row.text };
    if (row.text.startsWith('\\')) return { kind: 'meta', text: row.text };
    const kind = row.cls === 'diff-added' ? 'add' : row.cls === 'diff-deleted' ? 'delete' : 'context';
    return { kind, text: row.text.slice(1) };
  });
}

/**
 * Cut `text` — which starts at column `offset` of its line — at every syntax
 * range boundary, tagging each piece with the range's class and `extra`.
 * @param {string} text
 * @param {number} offset
 * @param {Range[] | null} ranges sorted, non-overlapping
 * @param {string} extra a class every piece carries (a change segment's)
 * @returns {Piece[]}
 */
export function splitByRanges(text, offset, ranges, extra = '') {
  const pieces = [];
  const push = (piece, cls) => {
    if (!piece) return;
    const joined = [cls, extra].filter(Boolean).join(' ');
    const last = pieces[pieces.length - 1];
    if (last && last.cls === joined) last.text += piece;
    else pieces.push({ text: piece, cls: joined });
  };
  const end = offset + text.length;
  let at = offset;
  for (const range of ranges || []) {
    if (range.end <= at) continue;
    if (range.start >= end) break;
    if (range.start > at) push(text.slice(at - offset, range.start - offset), '');
    const stop = Math.min(range.end, end);
    push(text.slice(Math.max(range.start, at) - offset, stop - offset), range.cls);
    at = stop;
  }
  if (at < end) push(text.slice(at - offset), '');
  return pieces;
}

/**
 * One line's pieces: its syntax colours, overlaid with the intra-line change
 * segments when the line has them. Segments cover the line in order.
 * @param {string} text the line without its marker
 * @param {Range[] | null} ranges
 * @param {{ type: 'same' | 'del' | 'add', text: string }[] | null} segments
 * @returns {Piece[]}
 */
export function lineSpans(text, ranges, segments) {
  if (!segments) return splitByRanges(text, 0, ranges);
  const pieces = [];
  let offset = 0;
  for (const segment of segments) {
    pieces.push(...splitByRanges(segment.text, offset, ranges, SEGMENT_CLASS[segment.type]));
    offset += segment.text.length;
  }
  return pieces;
}

/**
 * The rows DiffLines renders.
 *
 * In `lines` mode every patch row is one screen row. In `words` mode a removed
 * line and the added line that replaces it (a pair `annotatePatch` found
 * similar enough to segment) become one row, `diff-changed`, that reads like
 * `git diff --word-diff`: shared text once, removed pieces struck through,
 * added pieces underlined, each keeping the syntax colour of its own side.
 * Lines too different to pair stay as separate removed and added rows —
 * interleaving a rewrite word by word would be unreadable.
 *
 * @param {object[]} rows from `annotatePatch`
 * @param {{ syntax?: (Range[] | null)[] | null, words?: boolean }} options
 * @returns {{ cls: string, marker: string, pieces: Piece[], oldLine: ?number, newLine: ?number }[]}
 */
export function displayRows(rows, { syntax = null, words = false } = {}) {
  const at = index => syntax?.[index] ?? null;
  const plain = (row, index) => {
    if (row.cls === 'diff-hunk' || row.text.startsWith('\\') || !/^[ +-]/.test(row.text)) {
      return { cls: row.cls, marker: '', pieces: [{ text: row.text, cls: '' }], oldLine: row.oldLine, newLine: row.newLine };
    }
    return { cls: row.cls, marker: row.text[0], pieces: lineSpans(row.text.slice(1), at(index), row.segments), oldLine: row.oldLine, newLine: row.newLine };
  };
  if (!words) return rows.map(plain);

  const out = [];
  let k = 0;
  while (k < rows.length) {
    if (rows[k].cls !== 'diff-deleted') { out.push(plain(rows[k], k)); k++; continue; }
    let removedEnd = k;
    while (removedEnd < rows.length && rows[removedEnd].cls === 'diff-deleted') removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < rows.length && rows[addedEnd].cls === 'diff-added') addedEnd++;
    const pairs = Math.min(removedEnd - k, addedEnd - removedEnd);
    for (let p = 0; p < pairs; p++) {
      const oldIndex = k + p;
      const newIndex = removedEnd + p;
      const merged = rows[oldIndex].merged;
      if (!merged) { out.push(plain(rows[oldIndex], oldIndex), plain(rows[newIndex], newIndex)); continue; }
      const pieces = [];
      let oldAt = 0;
      let newAt = 0;
      for (const segment of merged) {
        if (segment.type === 'del') {
          pieces.push(...splitByRanges(segment.text, oldAt, at(oldIndex), SEGMENT_CLASS.del));
          oldAt += segment.text.length;
        } else {
          pieces.push(...splitByRanges(segment.text, newAt, at(newIndex), SEGMENT_CLASS[segment.type]));
          newAt += segment.text.length;
          if (segment.type === 'same') oldAt += segment.text.length;
        }
      }
      out.push({ cls: 'diff-changed', marker: '~', pieces, oldLine: rows[oldIndex].oldLine, newLine: rows[newIndex].newLine });
    }
    for (let i = k + pairs; i < removedEnd; i++) out.push(plain(rows[i], i));
    for (let i = removedEnd + pairs; i < addedEnd; i++) out.push(plain(rows[i], i));
    k = addedEnd;
  }
  return out;
}
