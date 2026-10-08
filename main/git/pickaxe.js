import { runGit } from './exec.js';
import { validateFile, validateRevision } from './commit.js';
import { chunkPath } from './worktree.js';
import { splitPatchFiles } from './diff-parser.js';
import { unquotePath } from './blame.js';

/**
 * What a search through history can look for, as an agent asks for it:
 * - `code` — `-S`: commits where the number of occurrences of the text
 *   changed, i.e. it was added or removed (moving a line does not count);
 * - `regex` — `-G`: commits with an added or removed line matching the
 *   pattern (POSIX extended regex, Git's own);
 * - `message` — the subject and body, literal and case-insensitive;
 * - `author` — the name or the email, literal and case-insensitive.
 * The first two read the patch too, so the caller can show where it matched.
 */
export const PICKAXE_MODES = Object.freeze(['code', 'regex', 'message', 'author']);
export const PATCH_MODES = Object.freeze(['code', 'regex']);

const QUERY_MAX = 200;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The most matches one search reads: its page and every page before it. */
export const LIMIT_MAX = 1000;
const CONTEXT_MAX = 20;

// A record starts with \0\x01 — neither ever appears in text Git prints for a
// text patch (a file holding NUL is binary and has no lines in the patch).
const RECORD = '\0\x01';
const FORMAT = '%x00%x01%H%x00%P%x00%an%x00%aI%x00%s';

export function validateSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.length > QUERY_MAX || query.includes('\0')) {
    throw new TypeError(`query must be non-empty text of at most ${QUERY_MAX} characters`);
  }
  return query;
}

const SELECT = {
  code: query => [`-S${query}`],
  regex: query => [`-G${query}`],
  message: query => ['-i', '--fixed-strings', `--grep=${query}`],
  author: query => ['-i', '--fixed-strings', `--author=${query}`]
};

/**
 * The argv that finds the first `limit` matching commits, as hashes only. A
 * search is two runs of Git: this one walks history, and buildPickaxeShowArgv
 * prints just one page — so a later page never makes Git print the patches
 * of every page before it. There is no `--skip`: with `-S`/`-G` Git skips
 * walked commits before the pickaxe filters them, while `--max-count` counts
 * matches, so pages are cut from this list instead (see searchCommits).
 * `revision` is a validated name after `--end-of-options`; `all` reads every
 * branch and tag the way the graph does (stash and 🌱 Twig's own refs left
 * out). A pathspec is `:(literal)` — a file, or a folder and everything under it.
 * @param {{ query: string, mode: string, revision?: ?string, all?: boolean, path?: ?string, limit: number }} options
 */
export function buildPickaxeArgv({ query, mode, revision = 'HEAD', all = false, path = null, limit }) {
  validateSearchQuery(query);
  if (!PICKAXE_MODES.includes(mode)) throw new TypeError('Unknown search mode');
  if (!Number.isInteger(limit) || limit < 1 || limit > LIMIT_MAX) throw new TypeError('Invalid limit');
  if (path !== null) validateFile(path);
  const where = all ? ['--exclude=refs/stash', '--exclude=refs/twig/*', '--all'] : ['--end-of-options', validateRevision(revision)];
  return ['log', '--topo-order', ...SELECT[mode](query), '--format=%H', `--max-count=${limit}`,
    ...where, '--', ...(path === null ? [] : [`:(literal)${path}`])];
}

/**
 * The argv that prints one page of matches: the commits, in the order given,
 * with the same pickaxe and pathspec, so only the files that matched come
 * back. Patches are plain: no external diff, no textconv, no rename pairing
 * (one `diff --git a/P b/P` per file, so the path can be read from the header).
 * @param {{ query: string, mode: string, oids: string[], path?: ?string, context?: number }} options
 */
export function buildPickaxeShowArgv({ query, mode, oids, path = null, context = 3 }) {
  validateSearchQuery(query);
  if (!PICKAXE_MODES.includes(mode)) throw new TypeError('Unknown search mode');
  if (!Array.isArray(oids) || !oids.length || oids.length > LIMIT_MAX || !oids.every(oid => OID.test(oid))) throw new TypeError('Invalid commits');
  if (!Number.isInteger(context) || context < 0 || context > CONTEXT_MAX) throw new TypeError('Invalid context');
  if (path !== null) validateFile(path);
  const patch = PATCH_MODES.includes(mode)
    ? [...SELECT[mode](query), '-p', '--no-ext-diff', '--no-textconv', '--no-renames', `-U${context}`]
    : ['--no-patch'];
  return ['show', ...patch, `--format=${FORMAT}`, '--end-of-options', ...oids, '--', ...(path === null ? [] : [`:(literal)${path}`])];
}

/** The path of one file chunk: from `diff --git` when unambiguous, else from its `+++`/`---` line. */
export function pickaxeChunkPath(chunk) {
  const fromHeader = chunkPath(chunk);
  if (fromHeader !== null) return fromHeader;
  const plus = /^\+\+\+ (?:b\/(.*)|("(?:[^"\\]|\\.)*"))$/m.exec(chunk);
  const minus = /^--- (?:a\/(.*)|("(?:[^"\\]|\\.)*"))$/m.exec(chunk);
  const pick = match => (match ? (match[1] !== undefined ? match[1].replace(/\t$/, '') : unquotePath(match[2]).replace(/^[ab]\//, '')) : null);
  return pick(plus) ?? pick(minus);
}

/**
 * Parses what buildPickaxeShowArgv prints: one record per commit, its header
 * fields, then (for code and regex) its patch split into files.
 * @returns {{ oid: string, parents: string[], author: { name: string, date: string }, subject: string, files: { path: ?string, patch: string }[] }[]}
 */
export function parsePickaxeLog(output) {
  if (typeof output !== 'string') throw new TypeError('output must be a string');
  return output.split(RECORD).slice(1).map(record => {
    const end = record.indexOf('\n');
    const head = end < 0 ? record : record.slice(0, end);
    const [oid, parents, name, date, subject = ''] = head.split('\0');
    if (!OID.test(oid)) throw new TypeError('malformed search record');
    const patch = end < 0 ? '' : record.slice(end + 1).replace(/^\n+/, '');
    const files = patch.trim() ? splitPatchFiles(patch).map(chunk => ({ path: pickaxeChunkPath(chunk), patch: chunk })) : [];
    return { oid, parents: parents ? parents.split(' ') : [], author: { name, date }, subject, files };
  });
}

export class SearchPatternError extends Error {}

function failure(result, mode) {
  const reason = result.stderr.split('\n').map(line => line.replace(/^(fatal|error):\s*/, '').trim()).find(Boolean) || 'Git could not search';
  if (mode === 'regex' && /regex|regular expression|brack|paren|repetition/i.test(reason)) return new SearchPatternError(reason);
  return new Error(`Git could not search history: ${reason}`);
}

/**
 * One page of a search. `nextSkip` is null on the last page. A regex Git
 * cannot compile is a SearchPatternError with Git's own reason.
 * @param {{ cwd: string, log: object, signal?: ?AbortSignal, skip?: number, limit: number, context?: number }
 *   & Parameters<typeof buildPickaxeArgv>[0]} options
 */
export async function searchCommits({ cwd, log, signal = null, skip = 0, limit, context = 3, ...options }) {
  if (!Number.isInteger(skip) || skip < 0 || skip + limit + 1 > LIMIT_MAX) throw new TypeError('Invalid skip');
  const found = await runGit({ argv: buildPickaxeArgv({ ...options, limit: skip + limit + 1 }), cwd, log, operation: 'Search history', signal });
  if (found.cancelled) return { cancelled: true, commits: [], nextSkip: null };
  if (found.code !== 0) throw failure(found, options.mode);
  const oids = found.stdout.split('\n').filter(Boolean).slice(skip);
  const more = oids.length > limit;
  const page = more ? oids.slice(0, limit) : oids;
  if (!page.length) return { cancelled: false, commits: [], nextSkip: null };
  const shown = await runGit({ argv: buildPickaxeShowArgv({ ...options, oids: page, context }), cwd, log, operation: 'Read search matches', signal });
  if (shown.cancelled) return { cancelled: true, commits: [], nextSkip: null };
  if (shown.code !== 0) throw failure(shown, options.mode);
  return { cancelled: false, commits: parsePickaxeLog(shown.stdout), nextSkip: more ? skip + limit : null };
}
