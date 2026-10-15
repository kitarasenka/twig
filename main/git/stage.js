import { runGit } from './exec.js';
import { buildPatch } from './patch-builder.js';
import { loadWorktree } from './worktree.js';
import { loadOperationState } from './operation-state.js';

/**
 * Index-writing operations. Every path reaches Git as `:(literal)<path>`
 * after a `--`, so a name that looks like a flag or carries glob characters
 * stays a plain path.
 */

function validatePath(file) {
  if (typeof file !== 'string' || file.length === 0 || file.length > 32768
    || file.includes('\0') || file.startsWith('/') || file.split('/').some(part => part === '..')) {
    throw new TypeError('Invalid file path');
  }
  return `:(literal)${file}`;
}

async function mutate({ cwd, log, argv, operation, stdin = null }) {
  const result = await runGit({ argv, cwd, log, operation, stdin });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result;
}

export function buildStageArgv(path) {
  return ['add', '--', validatePath(path)];
}

/**
 * On an unborn branch there is no HEAD to restore from, so `git restore
 * --staged` fails; `git rm --cached` is the equivalent that works before the
 * first commit. The caller passes `unborn` from parseStatusV2's branch info.
 */
export function buildUnstageArgv(path, unborn = false) {
  return unborn
    ? ['rm', '--cached', '--force', '--', validatePath(path)]
    : ['restore', '--staged', '--', validatePath(path)];
}

export function buildIntentToAddArgv(path) {
  return ['add', '--intent-to-add', '--', validatePath(path)];
}

/**
 * Everything at once — modified, deleted and new files of the whole working
 * tree, what `git add -A` does. Only an agent's commit proposal uses it, after
 * the person confirmed the file list it was shown.
 */
export function buildStageEverythingArgv() {
  return ['add', '--all'];
}

/** @param {{ cwd: string, log: object }} options */
export function stageEverything({ cwd, log }) {
  return mutate({ cwd, log, argv: buildStageEverythingArgv(), operation: 'Stage all changes' });
}

/** Everything Git already tracks: modifications and deletions, never a new file. */
export function buildStageTrackedArgv() {
  return ['add', '--update'];
}

/**
 * Git has no pathspec for "only what is untracked" — `--all` would sweep the
 * tracked changes in with them — so the new files are named one by one.
 * `--pathspec-from-file=-` (Git 2.25) keeps that list on stdin: a repository
 * with thousands of new files cannot overflow the command line, and a name
 * that looks like a flag never reaches argv at all.
 */
export function buildStagePathsArgv() {
  return ['add', '--pathspec-from-file=-', '--pathspec-file-nul'];
}

/**
 * `reset` rather than `restore --staged`, because it is the one form that also
 * works before the first commit, where there is no HEAD to restore from. It is
 * a mixed reset to HEAD: the index goes back, the working tree is untouched.
 */
export function buildUnstageAllArgv() {
  return ['reset'];
}

export function buildApplyArgv(reverse) {
  return ['apply', '--cached', '--whitespace=nowarn', ...(reverse ? ['--reverse'] : []), '-'];
}

/** @param {{ cwd: string, log: object, path: string }} options */
export function stageFile({ cwd, log, path }) {
  return mutate({ cwd, log, argv: buildStageArgv(path), operation: 'Stage file' });
}

/** @param {{ cwd: string, log: object, path: string, unborn?: boolean }} options */
export function unstageFile({ cwd, log, path, unborn = false }) {
  return mutate({ cwd, log, argv: buildUnstageArgv(path, unborn), operation: 'Unstage file' });
}

/**
 * An untracked file has no diff to select hunks from until Git tracks it.
 * `--intent-to-add` records the path without its content, after which it
 * appears in an ordinary diff as an addition.
 * @param {{ cwd: string, log: object, path: string }} options
 */
export function intentToAdd({ cwd, log, path }) {
  return mutate({ cwd, log, argv: buildIntentToAddArgv(path), operation: 'Track new file' });
}

/**
 * Stages or unstages a selection of hunks and lines by piping a rebuilt patch
 * into `git apply --cached`. The patch goes over stdin rather than a temp
 * file so the user's source never touches disk outside the repository.
 * @param {{ cwd: string, log: object, path: string, hunks: object[],
 *   selection: object[], reverse?: boolean, added?: boolean, deleted?: boolean, mode?: ?string }} options
 * @returns {Promise<boolean>} false when the selection was empty
 */
export async function applySelection({ cwd, log, path, hunks, selection, reverse = false, added = false, deleted = false, mode = null }) {
  const patch = buildPatch({ path, hunks, selection, reverse, added, deleted, mode });
  if (patch === null) return false;
  await mutate({
    cwd, log, argv: buildApplyArgv(reverse), stdin: patch,
    operation: reverse ? 'Unstage selection' : 'Stage selection'
  });
  return true;
}

/**
 * The paths of one section, read here rather than sent by the renderer: a bulk
 * action means "everything in this section now", not "everything I happened to
 * be looking at when I clicked".
 *
 * An unmerged path refuses the whole action. `git add` on a conflicted file
 * marks it resolved with whatever the file currently holds, so a bulk stage
 * would quietly resolve conflicts — markers and all — that the user never
 * opened, and a bulk unstage would drop the three index stages the conflict
 * editor needs.
 */
async function readBulkTarget({ cwd, log }) {
  const tree = await loadWorktree({ cwd, log });
  const conflicts = tree.unstaged.filter(entry => entry.status === 'U').length;
  if (conflicts) {
    throw new Error(`Resolve ${conflicts} conflicted file${conflicts === 1 ? '' : 's'} first: a bulk action would mark ${conflicts === 1 ? 'it' : 'them'} resolved as ${conflicts === 1 ? 'it is' : 'they are'}.`);
  }
  return tree;
}

/**
 * The part of a section the person is looking at: `only` is the list the
 * filtered view showed, kept to what the fresh status still has there, so a
 * path the renderer names but the section no longer holds is never touched.
 * `null` means the whole section.
 */
function narrow(entries, only) {
  const paths = entries.map(entry => entry.path);
  if (only === null) return paths;
  if (!Array.isArray(only)) throw new TypeError('Invalid path list');
  const wanted = new Set(only.map(path => { validatePath(path); return path; }));
  return paths.filter(path => wanted.has(path));
}

/** Named paths on stdin, each `:(literal)` so `a[1].ts` never matches `a1.ts`. */
const pathList = paths => `${paths.map(validatePath).join('\0')}\0`;

/** Unstaging named paths: `restore --staged`, or `rm --cached` before the first commit (see buildUnstageArgv). */
export function buildUnstagePathsArgv(unborn = false) {
  return unborn
    ? ['rm', '--cached', '--force', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul']
    : ['restore', '--staged', '--pathspec-from-file=-', '--pathspec-file-nul'];
}

/**
 * Stages a whole section of the working-tree screen, or with `only` just the
 * files of it a filter left on screen.
 * @param {{ cwd: string, log: object, scope: 'tracked'|'untracked', only?: string[]|null }} options
 * @returns {Promise<number>} how many entries were staged
 */
export async function stageAll({ cwd, log, scope, only = null }) {
  if (!['tracked', 'untracked'].includes(scope)) throw new TypeError('Invalid stage scope');
  const tree = await readBulkTarget({ cwd, log });
  const paths = narrow(scope === 'tracked' ? tree.unstaged : tree.untracked, only);
  if (paths.length === 0) return 0;
  if (scope === 'tracked' && only === null) {
    await mutate({ cwd, log, argv: buildStageTrackedArgv(), operation: 'Stage all tracked changes' });
  } else {
    const what = scope === 'tracked' ? 'changed file' : 'untracked path';
    await mutate({
      cwd, log, argv: buildStagePathsArgv(), operation: `Stage ${paths.length} ${what}${paths.length === 1 ? '' : 's'}`,
      stdin: pathList(paths)
    });
  }
  return paths.length;
}

/**
 * Empties the index back to HEAD, or with `only` unstages just those files.
 *
 * During a merge, cherry-pick, revert or rebase emptying the whole index would
 * also delete the marker file Git left behind and so silently cancel the
 * operation, which is not what "unstage" says. It is refused until that
 * operation is finished or aborted through its own banner. Named files go
 * through `restore --staged` like the per-file button, which leaves the
 * operation alone, so they are allowed.
 * @param {{ cwd: string, log: object, only?: string[]|null }} options
 * @returns {Promise<number>} how many entries were unstaged
 */
export async function unstageAll({ cwd, log, only = null }) {
  if (only === null) {
    const state = await loadOperationState({ cwd, log });
    if (state.kind !== 'none') throw new Error(`Finish or abort the ${state.kind} first: unstaging everything would cancel it.`);
  }
  const tree = await readBulkTarget({ cwd, log });
  const paths = narrow(tree.staged, only);
  if (paths.length === 0) return 0;
  if (only === null) await mutate({ cwd, log, argv: buildUnstageAllArgv(), operation: 'Unstage everything' });
  else {
    await mutate({
      cwd, log, argv: buildUnstagePathsArgv(Boolean(tree.branch?.unborn)),
      operation: `Unstage ${paths.length} file${paths.length === 1 ? '' : 's'}`, stdin: pathList(paths)
    });
  }
  return paths.length;
}
