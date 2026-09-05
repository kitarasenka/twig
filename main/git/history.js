import { runGit } from './exec.js';
import { parseHistoryV1 } from './history-parser.js';

const FORMAT = '%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b';
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

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
