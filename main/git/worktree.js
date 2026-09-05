import { createHash } from 'node:crypto';
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

/** Exported so the self-check can assert the argv without spawning Git. */
export function buildStatusArgv() {
  return ['status', '--porcelain=v2', '--branch', '-z'];
}

/**
 * `:(literal)` keeps a path with glob characters from being read as a pathspec
 * pattern, and the leading `--` keeps a path that looks like a flag from being
 * read as one.
 */
export function buildDiffArgv({ path, staged = false }) {
  validatePath(path);
  return ['diff', ...DIFF_ARGS, ...(staged ? ['--cached'] : []), '--', `:(literal)${path}`];
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
export async function loadWorktree({ cwd, log }) {
  const result = await runGit({ argv: buildStatusArgv(), cwd, log, operation: 'Read working tree' });
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
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, path: string, staged?: boolean }} options
 * @returns {Promise<import('./diff-parser.js').FilePatch & { digest: string }>}
 */
export async function loadWorktreeDiff({ cwd, log, path, staged = false }) {
  const argv = buildDiffArgv({ path, staged });
  const result = await runGit({ argv, cwd, log, operation: staged ? 'Read staged diff' : 'Read working tree diff' });
  if (result.code !== 0) throw new Error('Git could not read this diff.');
  const digest = createHash('sha256').update(result.stdout, 'utf8').digest('hex');
  return { ...parseFilePatchV1(result.stdout), digest };
}
