import { runGit } from './exec.js';
import { validateOid } from './commit.js';

/**
 * @typedef {Object} LineCount
 * @property {string} path the path on the new side
 * @property {?string} originalPath the old path when Git paired a rename, else null
 * @property {?number} insertions null for a binary file
 * @property {?number} deletions null for a binary file
 * @property {boolean} binary
 */

const COUNT = /^(?:\d+|-)$/;

/**
 * Parses `--numstat -z`. A plain record is `ins\tdel\tpath\0`; a rename or
 * copy Git paired is `ins\tdel\t\0old\0new\0` — the path field is empty and
 * the two names follow as their own NUL-terminated tokens. Binary files count
 * as `-\t-`. Nothing is unquoted: `-z` output is raw bytes.
 * @param {string} output
 * @returns {Map<string, LineCount>} keyed by the new-side path
 */
export function parseNumstat(output) {
  if (typeof output !== 'string') throw new TypeError('numstat output must be a string');
  const counts = new Map();
  if (!output) return counts;
  const tokens = output.split('\0');
  if (tokens.pop() !== '') throw new Error('Invalid numstat output');
  for (let i = 0; i < tokens.length; i++) {
    const fields = tokens[i].split('\t');
    if (fields.length < 3 || !COUNT.test(fields[0]) || !COUNT.test(fields[1])) throw new Error('Invalid numstat record');
    const binary = fields[0] === '-';
    let path = fields.slice(2).join('\t');
    let originalPath = null;
    if (path === '') {
      originalPath = tokens[++i];
      path = tokens[++i];
      if (!originalPath || !path) throw new Error('Invalid numstat rename record');
    }
    counts.set(path, {
      path, originalPath, binary,
      insertions: binary ? null : Number(fields[0]),
      deletions: binary ? null : Number(fields[1])
    });
  }
  return counts;
}

const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--numstat', '-z', '--find-renames'];

/** Exported so the self-check can assert the argv without spawning Git. */
export function buildWorktreeNumstatArgv({ staged = false } = {}) {
  return ['diff', ...DIFF_ARGS, ...(staged ? ['--cached'] : []), '--'];
}

/**
 * Same pair of trees `loadCommit` lists files for — the first parent, or the
 * empty tree for a root commit — and the same `--no-renames`, so every path in
 * its file list has exactly one count here.
 */
export function buildCommitNumstatArgv(oid, parent = null) {
  validateOid(oid);
  if (parent !== null) validateOid(parent);
  return ['diff-tree', '--root', '-r', '--no-commit-id', '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv',
    ...(parent ? [parent] : []), oid, '--'];
}

/**
 * Lines added and removed per path, on both sides of the index: what is
 * staged (index against HEAD) and what is not (working tree against the
 * index). Untracked files have no counts — Git has nothing to compare them
 * with until they are added.
 * `env` lets a background reader pass `GIT_OPTIONAL_LOCKS=0`, so the index's
 * stat cache is not rewritten under a command the person is running.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, env?: ?Record<string, string> }} options
 * @returns {Promise<{ staged: Map<string, LineCount>, unstaged: Map<string, LineCount> }>}
 */
export async function loadWorktreeNumstat({ cwd, log, env = null }) {
  const [staged, unstaged] = await Promise.all([true, false].map(async cached => {
    const result = await runGit({ argv: buildWorktreeNumstatArgv({ staged: cached }), cwd, log, env,
      operation: cached ? 'Read staged change sizes' : 'Read working tree change sizes' });
    if (result.code !== 0) throw new Error('Git could not count the changed lines.');
    return parseNumstat(result.stdout);
  }));
  return { staged, unstaged };
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, oid: string, parent?: ?string }} options
 * @returns {Promise<Map<string, LineCount>>}
 */
export async function loadCommitNumstat({ cwd, log, oid, parent = null }) {
  const result = await runGit({ argv: buildCommitNumstatArgv(oid, parent), cwd, log, operation: 'Read commit change sizes' });
  if (result.code !== 0) throw new Error('Git could not count the lines this commit changed.');
  return parseNumstat(result.stdout);
}
