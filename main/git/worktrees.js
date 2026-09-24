import { stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { validateRefName } from './refs-ops.js';

/**
 * Worktrees: more than one checkout of the same repository, each in its own
 * folder on its own branch — fix a hotfix without stashing the work in
 * progress. Read with `git worktree list --porcelain -z`.
 */

/** `git worktree list --porcelain -z`: attributes NUL-terminated, records ended by an empty one. */
export function parseWorktreeList(output) {
  const worktrees = [];
  let current = null;
  for (const line of output.split('\0')) {
    if (line === '') { if (current) worktrees.push(current); current = null; continue; }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'worktree') { current = { path: value, head: null, branch: null, detached: false, bare: false, locked: null, prunable: null }; continue; }
    if (!current) throw new Error('Invalid worktree list');
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'detached') current.detached = true;
    else if (key === 'bare') current.bare = true;
    else if (key === 'locked') current.locked = value || 'locked';
    else if (key === 'prunable') current.prunable = value || 'its folder is gone';
  }
  if (current) worktrees.push(current);
  return worktrees.map((worktree, index) => ({ ...worktree, main: index === 0 }));
}

/**
 * @param {{ cwd: string, log: object }} options
 * @returns {Promise<Array<{ path: string, head: ?string, branch: ?string, detached: boolean, bare: boolean, locked: ?string, prunable: ?string, main: boolean, current: boolean }>>}
 */
export async function loadWorktrees({ cwd, log }) {
  const result = await runGit({ cwd, log, argv: ['worktree', 'list', '--porcelain', '-z'], operation: 'Read worktrees' });
  if (result.code !== 0) throw new Error('Git could not list the worktrees.');
  const here = path.resolve(cwd);
  return parseWorktreeList(result.stdout).map(worktree => ({ ...worktree, current: path.resolve(worktree.path) === here }));
}

/** `feature/login fix` → `feature-login-fix`, for a folder name. */
export function folderName(branch) {
  return String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80) || 'worktree';
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

/**
 * Where a new worktree for `branch` goes unless the person picks a folder:
 * next to the main one, as `<repository>-<branch>`, with a number added while
 * that name is taken — Git refuses a folder that already has files in it.
 */
export async function suggestWorktreePath({ main, branch, parent = null }) {
  const base = parent ? path.join(parent, folderName(branch)) : `${main}-${folderName(branch)}`;
  for (let attempt = 1; attempt < 100; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-${attempt}`;
    if (!await exists(candidate)) return candidate;
  }
  throw new Error('Choose a folder for the new worktree.');
}

/**
 * `git worktree add`: an existing branch that is not checked out anywhere
 * else, or a new branch started at `startPoint`.
 * @param {{ path: string, branch: string, create?: boolean, startPoint?: ?string }} options
 */
export function buildWorktreeAddArgv({ path: folder, branch, create = false, startPoint = null }) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new TypeError('Invalid worktree folder');
  validateRefName(branch);
  if (branch.startsWith('-')) throw new TypeError('Invalid branch name');
  if (!create) return ['worktree', 'add', '--', folder, branch];
  validateOid(startPoint);
  return ['worktree', 'add', '-b', branch, '--', folder, startPoint];
}

/** `git worktree remove`; `--force` also throws away its uncommitted changes, so it is asked for separately. */
export function buildWorktreeRemoveArgv(folder, force = false) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new TypeError('Invalid worktree folder');
  return ['worktree', 'remove', ...(force ? ['--force'] : []), '--', folder];
}

/** @param {{ cwd: string, log: object, path: string, branch: string, create?: boolean, startPoint?: ?string }} options */
export async function addWorktree({ cwd, log, ...request }) {
  const argv = buildWorktreeAddArgv(request);
  if (await exists(request.path)) throw new Error(`${request.path} already exists. Choose another folder.`);
  const result = await runGit({ cwd, log, argv, operation: `Add worktree for ${request.branch}` });
  if (result.code !== 0) {
    const reason = result.stderr.split('\n').find(line => line.startsWith('fatal: '))?.slice(7);
    return { ok: false, message: reason ? `Git refused: ${reason}` : 'git worktree add did not finish. Show output in the console.' };
  }
  return { ok: true, message: null, path: request.path };
}

/**
 * The worktree the screen named, checked against the list Git gives now.
 * Neither the main worktree nor the one this window is showing can be removed
 * from here.
 */
export async function findWorktree({ cwd, log, path: wanted }) {
  if (typeof wanted !== 'string' || !path.isAbsolute(wanted)) throw new TypeError('Invalid worktree folder');
  const found = (await loadWorktrees({ cwd, log })).find(entry => path.resolve(entry.path) === path.resolve(wanted));
  if (!found) throw new TypeError('There is no such worktree.');
  return found;
}

/** @param {{ cwd: string, log: object, path: string, force?: boolean }} options */
export async function removeWorktree({ cwd, log, path: folder, force = false }) {
  const found = await findWorktree({ cwd, log, path: folder });
  if (found.main) throw new Error('The main worktree cannot be removed; it holds the repository itself.');
  if (found.current) throw new Error('This worktree is the one open in this tab. Remove it from another worktree’s tab.');
  const result = await runGit({ cwd, log, argv: buildWorktreeRemoveArgv(found.path, force), operation: `Remove worktree ${path.basename(found.path)}` });
  if (result.code !== 0) {
    const dirty = /contains modified or untracked files|is dirty/.test(result.stderr);
    return { ok: false, dirty, message: dirty ? 'This worktree has uncommitted or untracked files. Removing it anyway throws them away.'
      : result.stderr.split('\n').find(line => line.startsWith('fatal: '))?.slice(7) || 'git worktree remove did not finish. Show output in the console.' };
  }
  return { ok: true, message: null, path: found.path };
}

/** `git worktree prune`: forgets worktrees whose folders are gone. Touches no files. */
export async function pruneWorktrees({ cwd, log }) {
  const result = await runGit({ cwd, log, argv: ['worktree', 'prune'], operation: 'Prune missing worktrees' });
  return result.code === 0 ? { ok: true, message: null } : { ok: false, message: 'git worktree prune did not finish. Show output in the console.' };
}
