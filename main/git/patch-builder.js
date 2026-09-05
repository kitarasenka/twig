/**
 * @typedef {{ index: number, lines: number[] | 'all' }} HunkSelection
 */

export class PatchBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchBuildError';
  }
}

function fail(message) {
  throw new PatchBuildError(message);
}

const MARKERS = { context: ' ', add: '+', delete: '-' };
const NO_NEWLINE = '\\ No newline at end of file';

/** Git omits the count when it is 1 and writes `start,0` for an empty side. */
const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);

/**
 * Decides what a single line becomes in the built patch.
 *
 * Staging (`reverse: false`) reads a worktree diff whose old side is the index:
 * an unselected addition must not reach the index, so it is dropped, while an
 * unselected deletion must stay in the index, so it becomes context.
 * Unstaging (`reverse: true`) reads `git diff --cached`, whose new side is the
 * index that `git apply --reverse` will be matched against: there an
 * unselected addition is already in the index and must survive, so it becomes
 * context, and an unselected deletion is absent from the index, so it is
 * dropped. The two cases are mirror images, not the same rule.
 * @returns {'keep'|'context'|'drop'}
 */
function classify(kind, selected, reverse) {
  if (kind === 'context') return 'context';
  if (selected) return 'keep';
  const demoted = reverse ? 'add' : 'delete';
  return kind === demoted ? 'context' : 'drop';
}

function selectedLines(hunk, selection) {
  if (selection.lines === 'all') return null;
  if (!Array.isArray(selection.lines)) fail('selection lines must be an array or "all"');
  const chosen = new Set();
  for (const index of selection.lines) {
    if (!Number.isInteger(index) || index < 0 || index >= hunk.lines.length) fail('selection refers to a line outside the hunk');
    chosen.add(index);
  }
  return chosen;
}

/**
 * Builds a patch for `git apply --cached [--reverse]` from a subset of a
 * parsed file patch.
 *
 * Line numbering mirrors with `reverse` just like line classification does:
 * the side `git apply` matches against the index keeps the parsed numbers,
 * and the side it writes drifts by the delta accumulated over the hunks
 * actually emitted (the arithmetic `git add -p` performs). Getting this wrong
 * usually still applies, because `git apply` searches around the stated line,
 * so it has to be asserted directly rather than trusted to fail loudly.
 * @param {{ path: string, hunks: import('./diff-parser.js').Hunk[],
 *   selection: HunkSelection[], reverse?: boolean, added?: boolean,
 *   deleted?: boolean, mode?: ?string }} options
 * @returns {?string} patch text, or null when nothing is selected
 */
export function buildPatch({ path, hunks, selection, reverse = false, added = false, deleted = false, mode = null }) {
  if (typeof path !== 'string' || path.length === 0) fail('path must be a non-empty string');
  if (!Array.isArray(hunks)) fail('hunks must be an array');
  if (!Array.isArray(selection)) fail('selection must be an array');

  const ordered = [...selection].sort((a, b) => a.index - b.index);
  const seen = new Set();
  const body = [];
  let delta = 0;
  let emittedNewLines = 0;
  let emittedHunks = 0;

  for (const entry of ordered) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= hunks.length) fail('selection refers to a hunk outside the patch');
    if (seen.has(entry.index)) fail('selection lists the same hunk twice');
    seen.add(entry.index);

    const hunk = hunks[entry.index];
    const chosen = selectedLines(hunk, entry);
    const lines = [];
    let oldCount = 0;
    let newCount = 0;
    let changed = false;

    hunk.lines.forEach((line, lineIndex) => {
      const action = classify(line.kind, chosen === null || chosen.has(lineIndex), reverse);
      if (action === 'drop') return;
      const kind = action === 'context' ? 'context' : line.kind;
      if (kind !== 'context') changed = true;
      if (kind !== 'add') oldCount++;
      if (kind !== 'delete') newCount++;
      lines.push(`${MARKERS[kind]}${line.text}`);
      if (line.noNewline) lines.push(NO_NEWLINE);
    });

    if (!changed) continue;

    // `git apply` matches one side of the patch against the index and writes
    // the other. Staging matches the old side (the parsed diff's old side is
    // the index); `--reverse` matches the new side instead. So the side whose
    // numbering must survive as parsed flips with `reverse`, and the synthetic
    // side is the one that drifts by the accumulated delta.
    const matchStart = reverse ? hunk.newStart : hunk.oldStart;
    const matchCount = reverse ? newCount : oldCount;
    const resultCount = reverse ? oldCount : newCount;
    const resultStart = resultCount === 0 ? matchStart + delta - 1 : matchStart + delta;
    const heading = hunk.heading ? ` ${hunk.heading}` : '';
    const oldSide = range(reverse ? resultStart : matchStart, oldCount);
    const newSide = range(reverse ? matchStart : resultStart, newCount);
    body.push(`@@ -${oldSide} +${newSide} @@${heading}`, ...lines);

    delta += resultCount - matchCount;
    emittedNewLines += newCount;
    emittedHunks++;
  }

  if (emittedHunks === 0) return null;

  // A partially staged deletion still leaves content behind, so it is no
  // longer a deletion; the same holds mirrored for an addition.
  const wholeFileGone = deleted && emittedHunks === hunks.length && emittedNewLines === 0;
  const head = [`diff --git a/${path} b/${path}`];
  if (added && mode) head.push(`new file mode ${mode}`);
  if (wholeFileGone && mode) head.push(`deleted file mode ${mode}`);
  // The trailing tab terminates the path: without it `--- a/sp ace.txt` is
  // ambiguous. Git accepts the tab for ordinary paths too.
  head.push(added ? '--- /dev/null' : `--- a/${path}\t`);
  head.push(wholeFileGone ? '+++ /dev/null' : `+++ b/${path}\t`);

  return `${[...head, ...body].join('\n')}\n`;
}
