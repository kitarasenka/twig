/**
 * Intra-line diff: inside a line that a hunk both removes and adds back, mark
 * just the parts that actually differ instead of painting the whole line.
 *
 * The diff works on *tokens* — runs of word characters, runs of whitespace and
 * single punctuation marks — not raw characters, so inserting `runAutomation =
 * null, ` before `onConsole` marks exactly that span instead of scattering the
 * shared letters `o`, `n`, `s`… across the line. A replaced token that is only
 * lightly edited ("сорока" → "сорок") is then refined down to the character.
 *
 * No imports: this module is loaded by both Vite and the Node self-check.
 *
 * @typedef {{ type: 'same' | 'del' | 'add', text: string }} Segment
 * @typedef {{ type: 'equal' | 'delete' | 'insert', text: string }} Op
 */

// The token LCS table is O(n*m). Real lines sit far below this; a longer line is
// shown whole rather than building a large table.
const MAX_LINE = 400;

// Below this share of shared characters the two lines are a rewrite, not an
// edit, and a partial highlight would be confetti — show them whole instead.
const MIN_SIMILARITY = 0.2;

// A replaced token pair is only refined to the character when they still share
// this much; otherwise the whole old token is removed and the new one added.
const REFINE_SIMILARITY = 0.25;

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;

function tokenize(text) {
  return text.match(TOKEN) ?? [];
}

function pushSegment(segments, type, text) {
  const last = segments[segments.length - 1];
  if (last && last.type === type) last.text += text;
  else segments.push({ type, text });
}

/**
 * Myers-free LCS diff of two sequences into coalesced ops. `units` are compared
 * with `===`, so this serves both the token pass (strings) and the refine pass
 * (single characters).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Op[]}
 */
function diffSequences(a, b) {
  const n = a.length;
  const m = b.length;
  const width = m + 1;
  const lcs = new Uint32Array(width * (n + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j]
        ? lcs[(i + 1) * width + (j + 1)] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + (j + 1)]);
    }
  }
  const ops = [];
  const push = (type, piece) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += piece;
    else ops.push({ type, text: piece });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('equal', a[i]); i++; j++; }
    else if (lcs[(i + 1) * width + j] >= lcs[i * width + (j + 1)]) { push('delete', a[i]); i++; }
    else { push('insert', b[j]); j++; }
  }
  while (i < n) { push('delete', a[i]); i++; }
  while (j < m) { push('insert', b[j]); j++; }
  return ops;
}

const sharedLength = (ops) => ops.reduce((total, op) => op.type === 'equal' ? total + op.text.length : total, 0);

/** Replace each delete→insert pair (a token swap) with its character diff when
 *  the two still overlap enough for that to read as an edit rather than noise. */
function refine(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const next = ops[k + 1];
    if (op.type === 'delete' && next && next.type === 'insert') {
      const chars = diffSequences([...op.text], [...next.text]);
      if (sharedLength(chars) / Math.max(op.text.length, next.text.length) >= REFINE_SIMILARITY) {
        out.push(...chars);
        k++;
        continue;
      }
    }
    out.push(op);
  }
  return out;
}

/**
 * Token-level diff of two single lines (no leading +/- marker).
 * @param {string} oldText
 * @param {string} newText
 * @returns {{ old: Segment[], new: Segment[], merged: Segment[] } | null} null
 *   when the lines are equal, too long, or too dissimilar to highlight
 *   partially. `merged` is the one-line form word mode shows: shared text once,
 *   removed and added pieces in the order the edit reads — whole words, never
 *   refined to the character, because `250` → `500` inline must read as one
 *   word replaced, not as `2500` with single digits struck and underlined.
 */
export function segmentPair(oldText, newText) {
  if (oldText === newText) return null;
  if (oldText.length > MAX_LINE || newText.length > MAX_LINE) return null;

  const words = diffSequences(tokenize(oldText), tokenize(newText));
  const ops = refine(words);
  if (sharedLength(ops) / Math.max(oldText.length, newText.length) < MIN_SIMILARITY) return null;

  const oldSegs = [];
  const newSegs = [];
  for (const op of ops) {
    if (op.type === 'equal') { pushSegment(oldSegs, 'same', op.text); pushSegment(newSegs, 'same', op.text); }
    else if (op.type === 'delete') pushSegment(oldSegs, 'del', op.text);
    else pushSegment(newSegs, 'add', op.text);
  }
  const merged = [];
  for (const op of words) pushSegment(merged, op.type === 'equal' ? 'same' : op.type === 'delete' ? 'del' : 'add', op.text);
  return { old: oldSegs, new: newSegs, merged };
}

/**
 * Walk parsed hunk lines and pair each removed line with the added line that
 * replaces it (k-th removed ↔ k-th added within one contiguous run).
 * @param {{ kind: 'context' | 'add' | 'delete', text: string }[]} lines
 * @returns {(Segment[] | null)[]} one entry per input line, aligned by index.
 */
export function segmentHunkLines(lines) {
  const out = lines.map(() => null);
  let k = 0;
  while (k < lines.length) {
    if (lines[k].kind !== 'delete') { k++; continue; }
    let removedEnd = k;
    while (removedEnd < lines.length && lines[removedEnd].kind === 'delete') removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < lines.length && lines[addedEnd].kind === 'add') addedEnd++;
    const pairs = Math.min(removedEnd - k, addedEnd - removedEnd);
    for (let p = 0; p < pairs; p++) {
      const seg = segmentPair(lines[k + p].text, lines[removedEnd + p].text);
      if (seg) { out[k + p] = seg.old; out[removedEnd + p] = seg.new; }
    }
    k = addedEnd;
  }
  return out;
}

/**
 * @typedef {{ cls: '' | 'diff-added' | 'diff-deleted' | 'diff-hunk',
 *   text: string, segments: Segment[] | null, merged?: Segment[],
 *   oldLine: number | null, newLine: number | null }} PatchRow
 * `merged` sits on the removed line of a pair; word mode shows it in place of both.
 */

/** Git's per-file preamble: machine bookkeeping, not a change to the file. */
const HEADER = /^(diff --git |index |--- |\+\+\+ |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to )/;

/**
 * Drop the `diff --git` / `index` / `---` / `+++` preamble of every file in the
 * patch, keeping only hunks and their lines. Header lines are recognised only
 * outside a hunk, so a removed line that happens to read `--- a/x` survives.
 * A patch that is nothing but a header (a mode change) is returned untouched —
 * an empty body would say less than the header does.
 * @param {string[]} lines
 * @returns {string[]}
 */
function stripHeaders(lines) {
  let inHunk = false;
  const kept = lines.filter(line => {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    return inHunk || !HEADER.test(line);
  });
  return kept.length ? kept : lines;
}

/** Start line numbers of a hunk header: `@@ -12,7 +12,9 @@` → [12, 12]. Its
 *  counts are not read — the lines themselves say how far each side runs. */
const HUNK = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Split raw unified-diff text into rows for rendering, attaching intra-line
 * segments to paired -/+ lines. The per-file header is stripped: only hunks
 * and their lines are rendered.
 * @param {string} patch
 * @returns {PatchRow[]}
 */
export function annotatePatch(patch) {
  const raw = patch.split('\n');
  // A patch ends with a newline, so the split leaves one empty tail element.
  // It is not a line of the file and must not take a line number.
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
  const lines = stripHeaders(raw);
  let firstHunk = lines.findIndex(line => line.startsWith('@@'));
  if (firstHunk < 0) firstHunk = lines.length;

  // Line numbers are counted from the hunk header, the only place the patch
  // states them: a removed line advances the old side, an added one the new
  // side, context both. Everything else (the header itself, `\ No newline`,
  // a header-only patch) has no number on either side.
  let oldNext = 0;
  let newNext = 0;
  const rows = lines.map(text => {
    if (text.startsWith('@@')) {
      const hunk = HUNK.exec(text);
      oldNext = hunk ? Number(hunk[1]) : 0;
      newNext = hunk ? Number(hunk[2]) : 0;
      return { cls: 'diff-hunk', text, segments: null, oldLine: null, newLine: null };
    }
    const cls = text.startsWith('+') ? 'diff-added' : text.startsWith('-') ? 'diff-deleted' : '';
    const counts = oldNext > 0 || newNext > 0;
    const numbered = counts && (cls !== '' || text.startsWith(' ') || text === '');
    return {
      cls,
      text,
      segments: null,
      oldLine: numbered && cls !== 'diff-added' ? oldNext++ : null,
      newLine: numbered && cls !== 'diff-deleted' ? newNext++ : null
    };
  });

  let k = firstHunk + 1;
  while (k < rows.length) {
    if (rows[k].cls !== 'diff-deleted') { k++; continue; }
    let removedEnd = k;
    while (removedEnd < rows.length && rows[removedEnd].cls === 'diff-deleted') removedEnd++;
    let addedEnd = removedEnd;
    while (addedEnd < rows.length && rows[addedEnd].cls === 'diff-added') addedEnd++;
    const pairs = Math.min(removedEnd - k, addedEnd - removedEnd);
    for (let p = 0; p < pairs; p++) {
      const seg = segmentPair(rows[k + p].text.slice(1), rows[removedEnd + p].text.slice(1));
      if (seg) { rows[k + p].segments = seg.old; rows[k + p].merged = seg.merged; rows[removedEnd + p].segments = seg.new; }
    }
    k = addedEnd;
  }
  return rows;
}
