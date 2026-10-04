import { createHash } from 'node:crypto';
import { McpError } from './errors.js';

/** Patch text one diff answer carries in total; past it, hunks come back as metadata. */
export const DIFF_BUDGET = 60_000;
/** Patch text of a single hunk asked for by id; past it, its lines are cut with a count of what was left out. */
export const HUNK_BUDGET = 80_000;

const STATUS_WORDS = Object.freeze({
  M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed',
  U: 'conflicted', '?': 'untracked', X: 'unknown', B: 'broken'
});

export const statusWord = letter => STATUS_WORDS[letter] || 'changed';

const MARKERS = { context: ' ', add: '+', delete: '-' };

/** A hunk back to the text Git printed for it, `@@` header included. */
export function hunkPatch(hunk) {
  const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@${hunk.heading ? ` ${hunk.heading}` : ''}`;
  const lines = [header];
  for (const line of hunk.lines) {
    lines.push(MARKERS[line.kind] + line.text);
    if (line.noNewline) lines.push('\\ No newline at end of file');
  }
  return lines.join('\n') + '\n';
}

/**
 * Hunk ids say where a hunk was read from — `w` working tree, `s` staged, `u`
 * untracked, `c` a commit — and with how many context lines, then a hash of
 * the path and the hunk's own text. So an id is checked, not trusted: asking
 * for it again re-reads the diff the same way and finds the hunk only if it is
 * still exactly there. A file edited since gives INVALID_HUNK, never a
 * neighbouring hunk.
 */
export function hunkId(side, context, path, patch) {
  const hash = createHash('sha256').update(`${path}\0${patch}`, 'utf8').digest('hex').slice(0, 12);
  return `${side}${context}-${hash}`;
}

const HUNK_ID = /^([wsuc])(\d{1,2})-([0-9a-f]{12})$/;

export function parseHunkId(id) {
  const match = HUNK_ID.exec(id);
  if (!match) throw new McpError('INVALID_HUNK', `${JSON.stringify(id)} is not a hunk id.`, { hint: 'Use an id exactly as get_diff or get_commit_diff returned it.' });
  return { side: match[1], context: Number(match[2]) };
}

function hunkSummary(hunk, id) {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.kind === 'add') added++;
    else if (line.kind === 'delete') removed++;
  }
  return {
    id, oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines,
    ...(hunk.heading ? { heading: hunk.heading } : {}), added, removed
  };
}

/** Every hunk of a parsed file patch with its id and text, before any budget is applied. */
export function describeHunks(patch, side, context, path) {
  return patch.hunks.map(hunk => {
    const text = hunkPatch(hunk);
    return { ...hunkSummary(hunk, hunkId(side, context, path, text)), patch: text };
  });
}

/**
 * Keeps hunk text while it fits the budget and turns the rest into metadata
 * (`patch: null`). Hunks stay in order and every one keeps its id, so the
 * answer is whole JSON and the agent can ask for exactly the hunks it skipped.
 * @returns {{ hunks: object[], used: number, truncated: boolean }}
 */
export function fitHunks(hunks, budget) {
  let used = 0;
  let truncated = false;
  const fitted = hunks.map(hunk => {
    if (!truncated && used + hunk.patch.length <= budget) { used += hunk.patch.length; return hunk; }
    truncated = true;
    return { ...hunk, patch: null };
  });
  return { hunks: fitted, used, truncated };
}

/** One hunk, its lines cut at HUNK_BUDGET with the count of what was left out. */
export function capHunk(hunk) {
  if (hunk.patch.length <= HUNK_BUDGET) return { ...hunk, truncated: false };
  const lines = hunk.patch.split('\n');
  const kept = [];
  let size = 0;
  for (const line of lines) {
    if (size + line.length + 1 > HUNK_BUDGET) break;
    kept.push(line);
    size += line.length + 1;
  }
  return { ...hunk, patch: kept.join('\n') + '\n', truncated: true, omittedLines: lines.length - 1 - kept.length };
}

export const TRUNCATED_DIFF_HINT = 'This diff is larger than one answer. Hunks with patch: null were left out — request them one at a time by id.';

/** A commit as get_history lists it. */
export function compactCommit(commit) {
  return { hash: commit.oid, message: commit.subject, author: commit.author.name, date: commit.author.date, parents: commit.parents };
}
