import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import nodePath from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';
import { parseFilePatchV1 } from './diff-parser.js';

/**
 * @typedef {Object} FileChange
 * @property {string} path
 * @property {?string} originalPath rename source, else null
 * @property {string} status single-letter index or worktree status, '?' when untracked
 * @property {boolean} submodule
 */

// `--no-renames` keeps every path's diff self-contained: a detected rename
// would describe two different paths in one patch, while the patch builder
// writes a header from the single path it was given. Renames still reach the
// UI through parseStatusV2, which reports originalPath.
const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

function validatePath(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 32768
    || file.includes('\0') || file.startsWith('/') || file.split('/').some(part => part === '..')) {
    throw new TypeError('Invalid file path');
  }
  return file;
}

/**
 * Exported so the self-check can assert the argv without spawning Git.
 * `allUntracked` lists every file inside a new folder instead of the folder
 * itself (`dir/`), for readers that diff files one by one.
 */
export function buildStatusArgv({ allUntracked = false } = {}) {
  return ['status', '--porcelain=v2', '--branch', '-z', ...(allUntracked ? ['--untracked-files=all'] : [])];
}

function contextArgs(context) {
  if (context === null || context === undefined) return [];
  if (!Number.isInteger(context) || context < 0 || context > 100) throw new TypeError('Invalid context line count');
  return [`--unified=${context}`];
}

/**
 * `:(literal)` keeps a path with glob characters from being read as a pathspec
 * pattern, and the leading `--` keeps a path that looks like a flag from being
 * read as one. `context` is Git's own default (3) unless a reader asks for
 * another number; line staging always reads with the default.
 */
export function buildDiffArgv({ path, staged = false, context = null }) {
  validatePath(path);
  return ['diff', ...DIFF_ARGS, ...contextArgs(context), ...(staged ? ['--cached'] : []), '--', `:(literal)${path}`];
}

/**
 * An untracked file as the patch that would add it. `--no-index` compares two
 * paths on disk without touching the index, and Git treats the literal
 * `/dev/null` as "no file" on every platform, so this is a read, not the
 * `git add -N` the staging screen would need.
 */
export function buildUntrackedDiffArgv({ path, context = null }) {
  validatePath(path);
  return ['diff', '--no-index', ...DIFF_ARGS, ...contextArgs(context), '--', '/dev/null', path];
}

function changeFrom(entry, status) {
  return {
    path: entry.path,
    originalPath: entry.originalPath,
    status,
    submodule: entry.submodule !== null
  };
}

/**
 * Splits the working tree into what is staged, what is not, and what is
 * untracked. An entry with both an index and a worktree change appears in
 * both lists, which is exactly how Git models it and how the staging screen
 * has to show it.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog }} options
 * @returns {Promise<{ staged: FileChange[], unstaged: FileChange[], untracked: FileChange[], branch: object }>}
 */
export async function loadWorktree({ cwd, log, env = null, allUntracked = false }) {
  const result = await runGit({ argv: buildStatusArgv({ allUntracked }), cwd, log, env, operation: 'Read working tree' });
  if (result.code !== 0) throw new Error('Git could not read the working tree.');
  const status = parseStatusV2(result.stdout);

  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const entry of status.entries) {
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'untracked') { untracked.push(changeFrom(entry, '?')); continue; }
    if (entry.kind === 'unmerged') { unstaged.push(changeFrom(entry, 'U')); continue; }
    if (entry.indexStatus !== '.') staged.push(changeFrom(entry, entry.indexStatus));
    if (entry.worktreeStatus !== '.') unstaged.push(changeFrom(entry, entry.worktreeStatus));
  }
  return { staged, unstaged, untracked, branch: status.branch };
}

/**
 * Reads one file's patch. Untracked files have no diff until they are tracked
 * (`git add -N`), which is a mutation and therefore not done here.
 *
 * `digest` fingerprints the exact diff text this result was parsed from. A
 * line selection is only meaningful against the diff it was made on, so the
 * caller echoes the digest back when applying and the apply is refused if the
 * file changed in between. It also means the renderer never has to send patch
 * content back to main: it sends indices, and main re-reads the content.
 * `context` and `env` are for readers other than the staging screen: another
 * number of context lines, and `GIT_OPTIONAL_LOCKS=0` so a background read does
 * not rewrite the index's stat cache.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, path: string, staged?: boolean,
 *   context?: ?number, env?: ?Record<string, string> }} options
 * @returns {Promise<import('./diff-parser.js').FilePatch & { digest: string }>}
 */
export async function loadWorktreeDiff({ cwd, log, path, staged = false, context = null, env = null }) {
  const argv = buildDiffArgv({ path, staged, context });
  const result = await runGit({ argv, cwd, log, env, operation: staged ? 'Read staged diff' : 'Read working tree diff' });
  if (result.code !== 0) throw new Error('Git could not read this diff.');
  const digest = createHash('sha256').update(result.stdout, 'utf8').digest('hex');
  // `text` is the same patch the hunks were parsed from, carried along for the
  // read-only view in the uncommitted details panel, which renders a patch the
  // way the commit panel does. Line staging still works off `hunks`; nothing is
  // read back from `text`, and no second `git diff` runs to produce it.
  return { ...parseFilePatchV1(result.stdout), digest, text: result.stdout };
}

/** Past this an untracked file is described, not diffed: Git would read it all into one patch. */
export const UNTRACKED_DIFF_LIMIT = 1024 * 1024;

/**
 * Reads an untracked file as an added-file patch, for readers that want to see
 * new work before it is staged. The caller decides the path is untracked (from
 * a fresh status); a folder Git collapsed to `dir/`, or a file past
 * `UNTRACKED_DIFF_LIMIT`, comes back described instead of read.
 * `cwd` must be the repository root, which is how every caller holds it.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, path: string, context?: ?number }} options
 * @returns {Promise<(import('./diff-parser.js').FilePatch & { text: string }) | { directory: true } | { tooLarge: true, size: number }>}
 */
export async function loadUntrackedDiff({ cwd, log, path, context = null }) {
  validatePath(path);
  if (path.endsWith('/')) return { directory: true };
  const info = await lstat(nodePath.join(cwd, path));
  if (info.isDirectory()) return { directory: true };
  if (info.size > UNTRACKED_DIFF_LIMIT) return { tooLarge: true, size: info.size };
  const result = await runGit({ argv: buildUntrackedDiffArgv({ path, context }), cwd, log, operation: 'Read untracked file as a diff' });
  // `--no-index` answers 1 when the two sides differ, which they always do here.
  if (result.code !== 0 && result.code !== 1) throw new Error('Git could not read this file.');
  return { ...parseFilePatchV1(result.stdout), text: result.stdout };
}
