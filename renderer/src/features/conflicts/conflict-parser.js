/**
 * Splits a working-tree file that Git left conflicted into plain regions and
 * conflict regions. Runs no Git and touches no disk, so the self-check can
 * cover the shapes Git actually writes without building a repository for each.
 *
 * It lives with the editor rather than in `main/git/` because the editor
 * re-parses on every keystroke and a round trip through IPC for that would be
 * absurd; main only ever writes the finished bytes. Having no imports at all,
 * it is equally loadable by Vite and by plain Node in the self-check.
 *
 * @typedef {Object} CommonRegion
 * @property {'common'} kind
 * @property {string[]} lines
 *
 * @typedef {Object} ConflictRegion
 * @property {'conflict'} kind
 * @property {number} index 0-based position among the conflicts in this file
 * @property {string[]} ours
 * @property {?string[]} base only present when merge.conflictStyle is diff3 or zdiff3
 * @property {string[]} theirs
 * @property {string} oursLabel text after `<<<<<<< `, e.g. `HEAD`
 * @property {string} theirsLabel text after `>>>>>>> `
 * @property {number} start 0-based index of the `<<<<<<<` line in the file
 * @property {number} end 0-based index of the `>>>>>>>` line in the file
 */

export class ConflictParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConflictParseError';
  }
}

function fail(message) {
  throw new ConflictParseError(message);
}

const OURS = '<<<<<<<';
const BASE = '|||||||';
const SPLIT = '=======';
const THEIRS = '>>>>>>>';

// A marker is a run of exactly seven characters at the start of a line,
// followed by the end of the line or a single space and a label. A line of
// eight or more is ordinary content — Git writes seven.
function marker(line, token) {
  if (!line.startsWith(token)) return null;
  if (line.length === token.length) return '';
  if (line[token.length] !== ' ') return null;
  return line.slice(token.length + 1);
}

/**
 * @param {string} text raw file content
 * @returns {{ regions: (CommonRegion|ConflictRegion)[], conflicts: number, trailingNewline: boolean }}
 */
export function parseConflictFile(text) {
  if (typeof text !== 'string') fail('content must be a string');
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (trailingNewline) lines.pop();

  const regions = [];
  let common = [];
  let conflicts = 0;
  const flush = () => {
    if (common.length > 0) { regions.push({ kind: 'common', lines: common }); common = []; }
  };

  for (let i = 0; i < lines.length; i++) {
    const oursLabel = marker(lines[i], OURS);
    if (oursLabel === null) { common.push(lines[i]); continue; }

    const start = i;
    const ours = [];
    let base = null;
    let theirs = null;
    let theirsLabel = null;
    let side = 'ours';
    for (i++; i < lines.length; i++) {
      const line = lines[i];
      if (marker(line, OURS) !== null) fail('nested conflict marker');
      const baseLabel = side === 'ours' ? marker(line, BASE) : null;
      if (baseLabel !== null) { base = []; side = 'base'; continue; }
      if (side !== 'theirs' && marker(line, SPLIT) === '') { theirs = []; side = 'theirs'; continue; }
      const closing = side === 'theirs' ? marker(line, THEIRS) : null;
      if (closing !== null) { theirsLabel = closing; break; }
      (side === 'ours' ? ours : side === 'base' ? base : theirs).push(line);
    }
    if (theirsLabel === null) fail('unterminated conflict region');

    flush();
    regions.push({ kind: 'conflict', index: conflicts, ours, base, theirs, oursLabel, theirsLabel, start, end: i });
    conflicts++;
  }
  flush();
  return { regions, conflicts, trailingNewline };
}

/** True when any conflict marker is still present, for the warning before saving. */
export function hasConflictMarkers(text) {
  return text.split('\n').some(line =>
    marker(line, OURS) !== null || marker(line, SPLIT) === '' || marker(line, THEIRS) !== null);
}

/**
 * Replaces one conflict region with the given lines, leaving the rest of the
 * file byte-for-byte alone. Operating on the parsed line span rather than on a
 * search-and-replace means a file that legitimately contains the same text
 * elsewhere cannot be corrupted.
 * @param {string} text
 * @param {number} index conflict position, as reported by parseConflictFile
 * @param {string[]} lines replacement content
 * @returns {string}
 */
export function resolveRegion(text, index, lines) {
  const { regions, trailingNewline } = parseConflictFile(text);
  const region = regions.find(item => item.kind === 'conflict' && item.index === index);
  if (!region) fail('unknown conflict region');
  if (!Array.isArray(lines) || lines.some(line => typeof line !== 'string' || line.includes('\n'))) {
    fail('replacement must be lines');
  }
  const all = text.split('\n');
  if (trailingNewline) all.pop();
  all.splice(region.start, region.end - region.start + 1, ...lines);
  return all.join('\n') + (trailingNewline ? '\n' : '');
}
