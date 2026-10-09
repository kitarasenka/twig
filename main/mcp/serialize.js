/** What one answer of search_history or get_blame carries before it says the rest did not fit. */
export const DIFF_BUDGET = 60_000;

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

/** Hashes as printed in text answers: unambiguous in practice, and every tool takes them back. */
export const shortHash = oid => oid.slice(0, 12);

/** `38e4efb73234 2026-10-06 Ada Lovelace: subject`, with `(merge of a, b)` on merges — one line of a search_history answer. */
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

// Characters a person never sees but a model reads: zero-width, bidi controls,
// Unicode tags (U+E0000…), line/paragraph separators. A file name built from
// them could carry text to the agent that 🌱 Twig's window does not show.
const INVISIBLE = /[\p{Cf}\p{Zl}\p{Zp}]/gu;
const escapeUnits = char => [...char].flatMap(c => {
  const units = [];
  for (let i = 0; i < c.length; i++) units.push(`\\u${c.charCodeAt(i).toString(16).padStart(4, '0')}`);
  return units;
}).join('');

/**
 * A path as one token: quoted like JSON only when it could be misread — control
 * or invisible characters, quotes, edge spaces, an arrow. Invisible characters
 * are written as `\uXXXX` escapes (JSON leaves them raw).
 */
export function quotePath(path) {
  if (!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}"\\]|^\s|\s$| -> /u.test(path)) return path;
  return JSON.stringify(path).replace(INVISIBLE, escapeUnits);
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

/**
 * The lines an answer starts with when the repository read was neither named
 * by the agent nor its own working directory's — the one open in 🌱 Twig —
 * so a wrong guess is visible, with a note saying why.
 */
export function repositoryPreamble(repo) {
  if (!repo.implicit) return '';
  return `repository: ${repo.path}\n${repo.note ? `note: ${repo.note}\n` : ''}`;
}
