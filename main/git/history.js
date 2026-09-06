import { runGit } from './exec.js';
import { parseFileHistory, parseHistoryV1 } from './history-parser.js';
import { validateFile, validateOid } from './commit.js';

const FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b';
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;
const MAX_REBASE_ENTRIES = 1000;

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < MIN_LIMIT || limit > MAX_LIMIT) {
    throw new TypeError(`limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`);
  }
}

function validateSkip(skip) {
  if (!Number.isInteger(skip) || skip < 0) throw new TypeError('skip must be a non-negative integer');
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
