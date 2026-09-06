import { runGit } from './exec.js';
import { parseFileHistory, parseHistoryV1 } from './history-parser.js';
import { validateFile, validateOid } from './commit.js';

const FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b';
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const MAX_REBASE_ENTRIES = 1000;
const SEARCH_QUERY_MAX = 200;
const SEARCH_LIMIT = 200;
const SEARCH_HEX = /^[0-9a-f]{4,64}$/i;

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new TypeError(`limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
  }
}

function validateSkip(skip) {
  if (!Number.isInteger(skip) || skip < 0) throw new TypeError('skip must be a non-negative integer');
}

function validateQuery(query) {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (trimmed.length === 0 || trimmed.length > SEARCH_QUERY_MAX || trimmed.includes('\0')) {
    throw new TypeError(`query must be a non-empty string of at most ${SEARCH_QUERY_MAX} characters`);
  }
  return trimmed;
}

/**
 * Builds the argv for a page of `git log` output in this module's parser
 * format. Exported separately (beyond the `loadHistoryPage` in the M2-HISTORY
 * contract) so the self-check can assert on the exact argv without spawning
 * Git or touching `exec.js`.
 * @param {{ limit?: number, skip?: number }} options
 * @returns {string[]}
 */
export function buildHistoryArgv({ limit = 250, skip = 0 } = {}) {
  validateLimit(limit);
  validateSkip(skip);
  return ['log', '--all', '--topo-order', '-z', `--format=${FORMAT}`, `--max-count=${limit}`, `--skip=${skip}`];
}

/**
 * Loads one page of commit history, oldest paging boundary first: `nextSkip`
 * is `null` once a page comes back shorter than `limit`, meaning history is
 * exhausted. Refs are not read here; see `refs.js`.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, limit?: number, skip?: number }} options
 * @returns {Promise<{ commits: import('./history-parser.js').Commit[], nextSkip: number | null }>}
 */
export async function loadHistoryPage({ cwd, log, limit = 250, skip = 0 }) {
  const argv = buildHistoryArgv({ limit, skip });
  const result = await runGit({ argv, cwd, log, operation: 'Read commit history' });
  if (result.code !== 0) throw new Error('Git could not read commit history.');
  const commits = parseHistoryV1(result.stdout);
  return { commits, nextSkip: commits.length < limit ? null : skip + commits.length };
}

/**
 * Builds the argv for `git log --follow` on a single file, in this module's
 * parser format. `--follow` needs exactly one pathspec; it is passed as
 * `:(literal)` after `--` so a name that looks like a flag or a glob stays a
 * name. Exported separately so the self-check can assert on the exact argv
 * without spawning Git.
 * @param {string} file
 * @param {number} [limit]
 * @returns {string[]}
 */
export function buildFileHistoryArgv(file, limit = 250) {
  validateFile(file);
  validateLimit(limit);
  return ['log', '--follow', '--name-status', '--topo-order', '-z', `--format=${FORMAT}`, `--max-count=${limit}`, '--', `:(literal)${file}`];
}

/**
 * Every commit that touched one file, newest first, with renames followed.
 * Backs the "File history" item in the changed-files context menu. Refs are
 * not read here.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, file: string, limit?: number }} options
 * @returns {Promise<{ commits: import('./history-parser.js').Commit[] }>}
 */
export async function loadFileHistory({ cwd, log, file, limit = 250 }) {
  const argv = buildFileHistoryArgv(file, limit);
  const result = await runGit({ argv, cwd, log, operation: 'Read file history' });
  if (result.code !== 0) throw new Error('Git could not read the history for this file.');
  return { commits: parseFileHistory(result.stdout, file) };
}

/**
 * Builds the argv for a commit-message search across every ref. `--fixed-strings`
 * keeps the query literal (a user typing `(` is not writing a regex) and `-i`
 * makes it case-insensitive. `--grep` matches the subject and the body — the
 * same text the graph shows. Exported separately so the self-check can assert
 * the exact argv without spawning Git.
 * @param {string} query
 * @param {number} [limit]
 * @returns {string[]}
 */
export function buildSearchArgv(query, limit = SEARCH_LIMIT) {
  const trimmed = validateQuery(query);
  validateLimit(limit);
  return ['log', '--all', '--topo-order', '-z', '-i', '--fixed-strings', `--grep=${trimmed}`,
    `--format=${FORMAT}`, `--max-count=${limit}`];
}

/**
 * Commits whose message matches `query`, newest first, across all refs. A query
 * that is a hex string is also resolved as a commit id (or a prefix of one), so
 * searching by SHA finds the commit even when its message holds none of those
 * digits. Refs are not read here.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, query: string, limit?: number }} options
 * @returns {Promise<{ commits: import('./history-parser.js').Commit[], truncated: boolean }>}
 */
export async function searchHistory({ cwd, log, query, limit = SEARCH_LIMIT }) {
  const trimmed = validateQuery(query);
  const result = await runGit({ argv: buildSearchArgv(trimmed, limit), cwd, log, operation: 'Search commit history' });
  if (result.code !== 0) throw new Error('Git could not search commit history.');
  const commits = parseHistoryV1(result.stdout);
  const truncated = commits.length >= limit;
  if (SEARCH_HEX.test(trimmed) && !commits.some(commit => commit.oid.startsWith(trimmed.toLowerCase()))) {
    const resolved = await runGit({ argv: ['rev-parse', '--verify', '--quiet', `${trimmed}^{commit}`], cwd, log, operation: 'Resolve commit id' });
    const oid = resolved.stdout.trim();
    if (resolved.code === 0 && /^[0-9a-f]{40,64}$/i.test(oid) && !commits.some(commit => commit.oid === oid)) {
      const one = await runGit({ argv: ['log', '--no-walk', '-z', `--format=${FORMAT}`, oid], cwd, log, operation: 'Read commit history' });
      if (one.code === 0) commits.unshift(...parseHistoryV1(one.stdout));
    }
  }
  return { commits, truncated };
}

/**
 * The commits `git rebase --interactive <oid>` would put in its todo list:
 * everything reachable from HEAD but not from `<oid>`, oldest first, without
 * merges — which is what a rebase without `--rebase-merges` replays.
 *
 * There is no `--max-count` here on purpose: with `--reverse` Git applies the
 * limit before reversing, so a capped read would silently describe the wrong
 * end of the range. The count is checked afterwards instead.
 */
export function buildRebaseTodoArgv(oid) {
  return ['log', '--reverse', '--topo-order', '--no-merges', '-z', `--format=${FORMAT}`, `${validateOid(oid)}..HEAD`];
}

/** @param {{ cwd: string, log: import('../command-log.js').CommandLog, oid: string }} options */
export async function loadRebaseCandidates({ cwd, log, oid }) {
  const result = await runGit({ argv: buildRebaseTodoArgv(oid), cwd, log, operation: 'Read commits to rebase' });
  if (result.code !== 0) throw new Error('Git could not list the commits to rebase. This commit may not be behind the current branch.');
  const commits = parseHistoryV1(result.stdout);
  if (commits.length === 0) throw new Error('There is nothing between this commit and the current branch to rebase.');
  if (commits.length > MAX_REBASE_ENTRIES) throw new Error(`That is ${commits.length} commits. 🌱 Twig edits a rebase plan of at most ${MAX_REBASE_ENTRIES}.`);
  return commits;
}
