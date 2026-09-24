/**
 * The reflog screen's commands, shared by main (which runs them) and the
 * renderer (whose §6.5 dialog prints them), so what the dialog shows is what
 * runs. No imports: Vite and the Node check load it too; main still validates
 * names and ids with the full rules before anything reaches Git.
 */

/** One page of the reflog. Reflogs keep 90 days of moves, so they are paged. */
export const REFLOG_PAGE = 200;

const OID = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[^\0-\x20\x7f~^:?*[\\]+$/;

function checkOid(value) {
  if (typeof value !== 'string' || !OID.test(value)) throw new TypeError('Invalid commit identifier');
  return value;
}
function checkBranch(value) {
  if (typeof value !== 'string' || !BRANCH.test(value) || value.endsWith('/') || value.endsWith('.lock')) throw new TypeError('Invalid branch name');
  return value;
}

/** The ref whose reflog is read: HEAD, or one local branch by name. */
export function reflogRef(branch) {
  return branch === null || branch === undefined ? 'HEAD' : `refs/heads/${checkBranch(branch)}`;
}

/**
 * Moving a branch back to where it once was.
 *
 * - The checked-out branch moves with `reset --keep`: HEAD, index and files
 *   follow it, and Git refuses outright when an uncommitted change sits in a
 *   file the move would rewrite — nothing uncommitted can be lost.
 * - Any other branch moves with `update-ref <new> <old>`: Git swaps the ref
 *   only while it still points where the screen saw it, so a branch that moved
 *   in the meantime is refused rather than overwritten.
 *
 * @param {{ branch: string, oid: string, expected: string, current: boolean }} move
 * @returns {string[]}
 */
export function moveBranchCommand({ branch, oid, expected, current }) {
  checkBranch(branch); checkOid(oid); checkOid(expected);
  if (typeof current !== 'boolean') throw new TypeError('Invalid branch move');
  if (current) return ['reset', '--keep', oid];
  return ['update-ref', '-m', `🌱 Twig: move ${branch} to ${oid.slice(0, 7)} from the reflog`, `refs/heads/${branch}`, oid, expected];
}

/**
 * Undo puts the branch back where the move found it; Redo moves it again.
 * Both are the same guarded command with the two ends swapped.
 * @param {[string, string, string, boolean]} args branch, where it was, where it went, checked out
 */
export function moveBranchInverse(args, direction) {
  if (!Array.isArray(args) || args.length !== 4) throw new TypeError('Invalid saved branch move');
  const [branch, from, to, current] = args;
  if (direction === 'undo') return [moveBranchCommand({ branch, oid: from, expected: to, current })];
  if (direction === 'redo') return [moveBranchCommand({ branch, oid: to, expected: from, current })];
  throw new TypeError('Invalid Undo direction');
}

/**
 * A reflog message is `<action>: <detail>` — "checkout: moving from a to b",
 * "commit (amend): Fix", "reset: moving to HEAD~1", "rebase (finish): …".
 * @returns {{ action: string, detail: string }}
 */
export function splitReflogSubject(subject) {
  const text = typeof subject === 'string' ? subject : '';
  const colon = text.indexOf(': ');
  return colon < 0 ? { action: text, detail: '' } : { action: text.slice(0, colon), detail: text.slice(colon + 2) };
}
