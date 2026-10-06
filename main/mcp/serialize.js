import { createHash } from 'node:crypto';
import { McpError } from './errors.js';

/** Patch text one diff answer carries in total; past it, hunks come back as metadata. */
export const DIFF_BUDGET = 60_000;
/** Patch text of a single hunk asked for by id; past it, its lines are cut with a count of what was left out. */
export const HUNK_BUDGET = 80_000;

const MARKERS = { context: ' ', add: '+', delete: '-' };

/** `@@ -3,2 +3 @@ heading`, written the way Git writes it: a count of one is left out. */
export function hunkHeader(hunk) {
  const range = (start, count) => (count === 1 ? `${start}` : `${start},${count}`);
  return `@@ -${range(hunk.oldStart, hunk.oldLines)} +${range(hunk.newStart, hunk.newLines)} @@${hunk.heading ? ` ${hunk.heading}` : ''}`;
}

/** A hunk back to the text Git printed for it, `@@` header included. */
export function hunkPatch(hunk) {
  const lines = [hunkHeader(hunk)];
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
 * neighbouring hunk. Eight hex digits are plenty: an id is only ever compared
 * with the hunks of one file on one side.
 */
export function hunkId(side, context, path, patch) {
  const hash = createHash('sha256').update(`${path}\0${patch}`, 'utf8').digest('hex').slice(0, 8);
  return `${side}${context}-${hash}`;
}

const HUNK_ID = /^([wsuc])(\d{1,2})-([0-9a-f]{8})$/;

export function parseHunkId(id) {
  const match = HUNK_ID.exec(id);
  if (!match) throw new McpError('INVALID_HUNK', `${JSON.stringify(id)} is not a hunk id.`, { hint: 'Use an id exactly as get_diff or get_commit_diff printed it.' });
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

export const TRUNCATED_DIFF_HINT = 'Hunks marked "not shown" did not fit in one answer; get_diff_hunk reads one by its id.';

/** Hashes as printed in text answers: unambiguous in practice, and every tool takes them back. */
export const shortHash = oid => oid.slice(0, 12);

/** `38e4efb73234 2026-10-06 Ada Lovelace: subject`, with `(merge of a, b)` on merges — one get_history line. */
export function commitLine(commit) {
  const merge = commit.parents.length > 1 ? ` (merge of ${commit.parents.map(shortHash).join(', ')})` : '';
  return `${shortHash(commit.oid)} ${commit.author.date.slice(0, 10)} ${commit.author.name}: ${commit.subject}${merge}`;
}

// --- plain-text answers ---------------------------------------------------------------------
//
// Diffs go to an agent as the text Git itself would print, not as JSON: a
// patch inside a JSON string pays for every escaped newline and quote, and a
// model reads a unified diff natively. Each file gets one line in the shape of
// `git status --short` crossed with `--numstat`, then its hunks.

const LETTERS = Object.freeze({ untracked: '?' });

/** One status letter, as `git status --short` prints it. */
export const statusLetter = letter => (typeof letter === 'string' && /^[MADRCTUXB?]$/.test(letter) ? letter : LETTERS[letter] || 'M');

/** A path as one token: quoted like JSON only when it could be misread — control characters, quotes, edge spaces, an arrow. */
export function quotePath(path) {
  return /[\p{Cc}"\\]|^\s|\s$| -> /u.test(path) ? JSON.stringify(path) : path;
}

/**
 * `M +2 -1 src/app.js`, `R +0 -0 old.js -> new.js`, `M bin logo.png`, `? notes.txt`.
 * Counts are left out when unknown (an untracked file nobody read yet, a conflict).
 */
export function fileLine({ letter, path, originalPath = null, insertions = null, deletions = null, binary = false }) {
  const counts = binary ? 'bin' : insertions === null || insertions === undefined ? null : `+${insertions} -${deletions ?? 0}`;
  const name = originalPath ? `${quotePath(originalPath)} -> ${quotePath(path)}` : quotePath(path);
  return [statusLetter(letter), counts, name].filter(Boolean).join(' ');
}

/** Added and removed lines over a file's hunks. */
export function hunkTotals(hunks) {
  return hunks.reduce((sum, hunk) => ({ insertions: sum.insertions + hunk.added, deletions: sum.deletions + hunk.removed }), { insertions: 0, deletions: 0 });
}

/**
 * Hunks as text. A hunk that fits is its patch, header included and no id —
 * there is nothing more to ask for. One that did not fit is its header with
 * the id and size to ask for it by.
 */
export function renderHunks(hunks) {
  return hunks.map(hunk => {
    if (hunk.patch !== null) return hunk.patch;
    return `${hunkHeader(hunk)} [${hunk.id}: +${hunk.added} -${hunk.removed}, not shown]\n`;
  }).join('');
}

/**
 * The lines an answer starts with when the repository read was neither named
 * by the agent nor its own working directory's — the one open in 🌱 Twig —
 * so a wrong guess is visible, with a note saying why.
 */
export function repositoryPreamble(repo) {
  if (!repo.implicit) return '';
  return `repository: ${repo.path}\n${repo.note ? `note: ${repo.note}\n` : ''}`;
}
