// The whole-file view of a diff: the file as it was before the change or as it
// is after it, with the lines the change touches highlighted. What the two
// versions are called, which lines to light and where "next change" goes are
// decided here, as data, from the patch the diff already holds — the view
// reads the two texts and nothing else.
// Imports only its pure neighbours: Vite and the Node check both load it.
import { formatSize } from './lfs-pointer.js';

/** The largest version the view reads; main enforces the same number (MAX_TEXT_BYTES). */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

const short = oid => String(oid || '').slice(0, 8);

/**
 * The lines of a file as an editor numbers them: a trailing newline ends the
 * last line rather than starting an empty one, and a CRLF line ending is not
 * part of the line.
 * @param {string} text
 * @returns {string[]}
 */
export function fileLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * The line numbers a patch changes on one side of it: lines it adds on the
 * 'new' side, lines it removes on the 'old' one. A rewritten line is both.
 * @param {import('./intraline.js').PatchRow[]} rows from `annotatePatch`
 * @param {'old' | 'new'} side
 * @returns {Set<number>}
 */
export function changedLines(rows, side) {
  const cls = side === 'new' ? 'diff-added' : 'diff-deleted';
  const changed = new Set();
  for (const row of rows) {
    const line = side === 'new' ? row.newLine : row.oldLine;
    if (row.cls === cls && line) changed.add(line);
  }
  return changed;
}

/** The first line of each run of changed lines, in file order: where the change arrows stop. */
export function changeStarts(changed) {
  return [...changed].sort((a, b) => a - b).filter(line => !changed.has(line - 1));
}

/**
 * The change to go to from `line`, the line at the view's reading position:
 * the next one below it or the previous one above, wrapping at either end.
 * @returns {number | null}
 */
export function stepChange(starts, line, direction) {
  if (!starts.length) return null;
  if (direction > 0) return starts.find(start => start > line) ?? starts[0];
  return starts.findLast(start => start < line) ?? starts[starts.length - 1];
}

/**
 * What the two versions of a source are called, and the words on the switch
 * between them. `toggle` is null where Git has only one version: an untracked
 * file is only on disk.
 * @returns {{ toggle: string | null, after: string, before: string | null }}
 */
export function versionLabels(source) {
  switch (source?.kind) {
    case 'commit': return source.base
      ? { toggle: 'With the compared changes', after: `at ${short(source.oid)}`, before: `at ${short(source.base)}` }
      : { toggle: 'With this commit’s changes', after: `at ${short(source.oid)}`, before: `before ${short(source.oid)}` };
    case 'stash': return { toggle: 'With the stashed changes', after: 'in the stash', before: 'before the stash' };
    case 'staged': return { toggle: 'With staged changes', after: 'in the index', before: 'at HEAD' };
    case 'unstaged': return { toggle: 'With unstaged changes', after: 'on disk', before: 'in the index' };
    default: return { toggle: null, after: 'on disk', before: null };
  }
}

/**
 * Why one version cannot be shown, in words, or null when it can. A missing
 * version is an answer about the change — the commit added or deleted the
 * file — not an error.
 */
export function versionProblem(side, { source, withChanges }) {
  if (!side || side.state === 'ok') return null;
  if (side.state === 'binary') return 'This version is a binary file: there is no text to show.';
  if (side.state === 'large') return `This version is ${formatSize(side.size)}, too large to show here: 🌱 Twig shows files up to ${formatSize(MAX_FILE_BYTES)}.`;
  if (side.state === 'other') return side.reason || 'Git holds something other than a file here.';
  const kind = source?.kind;
  if (withChanges) {
    if (kind === 'commit') return source.base ? `The file does not exist at ${short(source.oid)}.` : 'This commit deletes the file.';
    if (kind === 'stash') return 'The stash deletes the file.';
    if (kind === 'staged') return 'The file is staged for deletion.';
    return 'The file is not on disk.';
  }
  if (kind === 'commit') return source.base ? `The file did not exist at ${short(source.base)}.` : 'The file did not exist before this commit.';
  if (kind === 'stash') return 'The file did not exist before the stash.';
  if (kind === 'staged') return 'HEAD has no version of this file: it is new.';
  if (kind === 'unstaged') return 'The index has no version of this file.';
  return 'Git has no earlier version of an untracked file.';
}

/**
 * The words beside the change arrows. Highlighted lines are what the change
 * adds or rewrites on the version after it, what it removes or rewrites on the
 * version before; a change that only adds has nothing to light before it.
 */
export function changeSummary({ starts, withChanges, patched }) {
  if (!patched) return 'Unchanged here';
  if (!starts.length) return withChanges ? 'Only removes lines' : 'Only adds lines';
  return `${starts.length} change${starts.length === 1 ? '' : 's'}`;
}
