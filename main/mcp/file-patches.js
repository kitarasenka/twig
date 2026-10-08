import path from 'node:path';
import { fileLine, hunkPatch } from './serialize.js';

// What list_changes and get_commit share: which files are worth a patch, how
// the patches share one answer, and how a file left out is named so the agent
// reads it itself with git. A file is shown whole or not at all — there is no
// tool for "the rest of this file", the git command the note prints is it.

/** A file with more changed lines than this is listed, not inlined. */
export const FILE_LINE_LIMIT = 400;
/** Room kept per listed file for its counts and a "(why it is not shown)" line. */
const NOTE_RESERVE = 80;
/** The note of a file whose patch did not fit; the answer ends with one command that reads all of them. */
export const DID_NOT_FIT = 'did not fit in this answer';

/**
 * Files whose diff says nothing a reader wants: lock files and minified or
 * source-map output. Their line counts are still listed. A repository can
 * mark more with `-diff` in .gitattributes — Git then counts them as binary.
 */
const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'go.sum', 'flake.lock', 'Podfile.lock',
  'pubspec.lock', 'mix.lock', 'packages.lock.json', 'gradle.lockfile'
]);
const GENERATED = /\.min\.(?:js|mjs|css)$|\.(?:js|css)\.map$/;

export function isGeneratedPath(file) {
  return LOCK_FILES.has(path.posix.basename(file)) || GENERATED.test(file);
}

/** A path or argument as one POSIX shell word: bare when it is plainly safe, else single-quoted. */
export function shellWord(value) {
  return /^[\w./@%+=,:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

/** `-U1` when the answer was read with other than Git's default three lines of context. */
export const unifiedFlag = context => (context === undefined || context === null || context === 3 ? '' : ` -U${context}`);

/** Lines added and removed in a parsed patch. */
export function patchTotals(patch) {
  let insertions = 0;
  let deletions = 0;
  for (const hunk of patch.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') insertions++;
      else if (line.kind === 'delete') deletions++;
    }
  }
  return { insertions, deletions };
}

/** Why a file's patch is left out for its size or kind, or null. `read` is how to read it instead. */
export function sizeReason(entry, read) {
  if (isGeneratedPath(entry.path)) return `lock or generated file: ${read}`;
  if ((entry.insertions ?? 0) + (entry.deletions ?? 0) > FILE_LINE_LIMIT) return `over ${FILE_LINE_LIMIT} changed lines: ${read}`;
  return null;
}

/** What an answer has left for patches once its head and every file line, with room for a note, are counted. */
export function patchBudget(maxBytes, head, entries) {
  const overhead = Buffer.byteLength(head) + 32
    + entries.reduce((sum, entry) => sum + Buffer.byteLength(fileLine(entry)) + 4 + NOTE_RESERVE, 0);
  return Math.max(0, maxBytes - overhead);
}

/**
 * Sets `text` on every entry with a `patch` and fits them into `budget`:
 * smallest first, so the budget runs out on the big ones, and a file that
 * does not fit gets a note instead of a cut patch — with `read(entry)` when
 * it has to be read on its own, plain DID_NOT_FIT when `read` gives null and
 * the answer names one command for all of them (`leftOutLine`).
 */
export function fitPatches(entries, budget, read = () => null) {
  const sized = entries.filter(entry => entry.patch && !entry.binary && !entry.note).map(entry => {
    entry.text = entry.patch.hunks.map(hunkPatch).join('');
    entry.bytes = Buffer.byteLength(entry.text);
    return entry;
  });
  for (const entry of [...sized].sort((a, b) => a.bytes - b.bytes)) {
    if (entry.bytes <= budget) budget -= entry.bytes;
    else {
      const how = read(entry);
      entry.note = how ? `${DID_NOT_FIT}: ${how}` : DID_NOT_FIT;
      entry.text = null;
    }
  }
  for (const entry of entries) {
    if (entry.note || entry.text || entry.binary || !entry.patch) continue;
    entry.note = entry.originalPath ? 'renamed, content unchanged' : entry.patch.mode ? 'mode change only' : 'no text change';
  }
}

/** The last line of an answer whose `entries` did not all fit: one command that reads them, or null. */
export function leftOutLine(entries, command) {
  const paths = entries.filter(entry => entry.note === DID_NOT_FIT).map(entry => entry.path);
  return paths.length ? `Did not fit, all in one call: ${command(paths)}` : null;
}

/** `## M +2 -1 path`, then its patch or `(why not)`, for each entry. */
export function fileBlocks(entries) {
  return entries.flatMap(entry => [
    `## ${fileLine(entry)}`,
    ...(entry.text ? [entry.text.replace(/\n$/, '')] : entry.note ? [`(${entry.note})`] : [])
  ]);
}
