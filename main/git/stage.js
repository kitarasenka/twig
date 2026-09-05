import { runGit } from './exec.js';
import { buildPatch } from './patch-builder.js';

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
