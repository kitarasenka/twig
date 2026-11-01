import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * Branch, tag and checkout operations — the non-history-rewriting half of the
 * commit context menu. Every name goes through `validateRefName`, and every
 * argv ends with `--` so a revision is never re-read as a path and a name is
 * never re-read as an option.
 */

// git-check-ref-format(1), restricted to the rules that apply to a single
// refname component and expressed without running Git, so the UI can reject a
// bad name before it costs a process.
const FORBIDDEN = /[\0-\x20\x7f~^:?*[\\]/;

export function validateRefName(name) {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) throw new TypeError('Invalid ref name');
  if (FORBIDDEN.test(name) || name.includes('..') || name.includes('@{') || name === '@'
    || name.startsWith('/') || name.endsWith('/') || name.includes('//')
    || name.endsWith('.') || name.endsWith('.lock')) throw new TypeError('Invalid ref name');
  for (const part of name.split('/')) {
    if (part.length === 0 || part.startsWith('.') || part.endsWith('.lock')) throw new TypeError('Invalid ref name');
  }
  return name;
}

export function buildCreateBranchArgv(name, startPoint) {
  return ['branch', '--', validateRefName(name), validateOid(startPoint)];
}

export function buildCheckoutBranchArgv(name) {
  return ['checkout', validateRefName(name), '--'];
}

export function buildCheckoutNewBranchArgv(name, startPoint) {
  return ['checkout', '-b', validateRefName(name), validateOid(startPoint), '--'];
}

/**
 * Checking out a commit that is not a branch tip leaves a detached HEAD.
 * `--detach` says so explicitly instead of relying on Git inferring it, so the
 * command in the console reads the way the confirmation dialog described it.
 */
export function buildCheckoutCommitArgv(oid) {
  return ['checkout', '--detach', validateOid(oid), '--'];
}

/** An annotated tag's message arrives on stdin (`-F -`), never in argv. */
export function buildCreateTagArgv(name, oid, annotated) {
  return ['tag', ...(annotated ? ['--annotate', '--file=-'] : []), '--', validateRefName(name), validateOid(oid)];
}

/** `-D` deletes an unmerged branch and is destructive: §6.5 requires a dialog first. */
export function buildDeleteBranchArgv(name, force) {
  return ['branch', force ? '-D' : '-d', '--', validateRefName(name)];
}

export function buildRenameBranchArgv(from, to) {
  return ['branch', '-m', '--', validateRefName(from), validateRefName(to)];
}

/**
 * `--set-upstream-to` carries its value inside the same argv word, which is
 * what makes it safe here: an upstream that begins with a dash cannot be read
 * as another option, and the branch itself still sits behind `--`.
 */
export function buildUpstreamArgv(branch, upstream) {
  return ['branch', upstream === null ? '--unset-upstream' : `--set-upstream-to=${validateRefName(upstream)}`,
    '--', validateRefName(branch)];
}

export function buildDeleteTagArgv(name) {
  return ['tag', '-d', '--', validateRefName(name)];
}

async function mutate({ cwd, log, argv, operation, failed, stdin = null }) {
  const result = await runGit({ argv, cwd, log, operation, stdin });
  if (result.code !== 0) throw new Error(failed);
  return result;
}

/** @param {{ cwd: string, log: object, name: string, startPoint: string, checkout?: boolean }} options */
export function createBranch({ cwd, log, name, startPoint, checkout = false }) {
  return mutate({
    cwd, log, operation: checkout ? 'Create and check out branch' : 'Create branch',
    failed: checkout ? ui`Create and check out branch failed. See the command console.` : ui`Create branch failed. See the command console.`,
    argv: checkout ? buildCheckoutNewBranchArgv(name, startPoint) : buildCreateBranchArgv(name, startPoint)
  }).then(() => true);
}

/** @param {{ cwd: string, log: object, name: string }} options */
export function deleteBranch({ cwd, log, name, force = false }) {
  return mutate({ cwd, log, argv: buildDeleteBranchArgv(name, force), operation: 'Delete branch', failed: ui`Delete branch failed. See the command console.` }).then(() => true);
}

/** @param {{ cwd: string, log: object, name: string, oid: string, message?: string }} options */
export function createTag({ cwd, log, name, oid, message = '' }) {
  const annotated = message.trim().length > 0;
  return mutate({
    cwd, log, argv: buildCreateTagArgv(name, oid, annotated),
    stdin: annotated ? message : null, operation: annotated ? 'Create annotated tag' : 'Create tag',
    failed: annotated ? ui`Create annotated tag failed. See the command console.` : ui`Create tag failed. See the command console.`
  }).then(() => true);
}

/**
 * What `refs/tags/<name>` holds — the tag object of an annotated tag, the
 * commit of a lightweight one — or null when there is no such tag. Undo keeps
 * this so it deletes (and Redo recreates) exactly that tag.
 * @param {{ cwd: string, log: object, name: string }} options
 */
export async function readTagRef({ cwd, log, name }) {
  const result = await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', `refs/tags/${validateRefName(name)}`], operation: `Read tag ${name}` });
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * @param {{ cwd: string, log: object, target: string, detach?: boolean }} options
 * @returns {Promise<true>} `target` is a branch name unless `detach` is set, in which case it is an object id
 */
export function checkout({ cwd, log, target, detach = false }) {
  return mutate({
    cwd, log, operation: detach ? 'Check out commit' : 'Check out branch',
    failed: detach ? ui`Check out commit failed. See the command console.` : ui`Check out branch failed. See the command console.`,
    argv: detach ? buildCheckoutCommitArgv(target) : buildCheckoutBranchArgv(target)
  }).then(() => true);
}

/** @param {{ cwd: string, log: object, from: string, to: string }} options */
export function renameBranch({ cwd, log, from, to }) {
  return mutate({ cwd, log, argv: buildRenameBranchArgv(from, to), operation: `Rename branch ${from} to ${to}`,
    failed: ui`Rename branch ${from} to ${to} failed. See the command console.` }).then(() => true);
}

/** @param {{ cwd: string, log: object, branch: string, upstream: ?string }} options */
export function setUpstream({ cwd, log, branch, upstream }) {
  return mutate({
    cwd, log, argv: buildUpstreamArgv(branch, upstream),
    operation: upstream === null ? `Unset upstream of ${branch}` : `Track ${upstream} from ${branch}`,
    failed: upstream === null ? ui`Unset upstream of ${branch} failed. See the command console.` : ui`Track ${upstream} from ${branch} failed. See the command console.`
  }).then(() => true);
}

/** @param {{ cwd: string, log: object, name: string }} options */
export function deleteTag({ cwd, log, name }) {
  return mutate({ cwd, log, argv: buildDeleteTagArgv(name), operation: `Delete tag ${name}`, failed: ui`Delete tag ${name} failed. See the command console.` }).then(() => true);
}
