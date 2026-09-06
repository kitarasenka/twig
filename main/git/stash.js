import { runGit } from './exec.js';
import { parseChangedFiles, validateFile, validateOid } from './commit.js';

/**
 * The stash list and the contents of one stash.
 *
 * A stash is a commit with two or three parents: `^1` is the commit the work
 * was based on, `^2` is the index, and `^3` — only when the stash was made
 * with `--include-untracked` — is a tree of the untracked files. That is why
 * one stash needs two listings: the tracked side is a diff against `^1`, and
 * the untracked side is a tree that exists in no diff at all.
 *
 * Reads address a stash by its object id, which is stable. Mutations cannot:
 * `git stash drop <sha>` is refused with "is not a stash reference", so they
 * have to use `stash@{n}` — and an index moves as soon as any other stash is
 * dropped. Every mutation therefore re-reads the list and refuses unless the
 * id at that index is still the one the screen was showing.
 */

const DIFF_ARGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

export const STASH_ACTIONS = ['apply', 'pop', 'drop', 'branch'];

/**
 * `%gd` is the `stash@{n}` ref, `%H` the stash commit, `%P` its parent oids
 * (`^1` is the commit the work was based on), `%gs` the reflog subject.
 */
export function buildStashListArgv() {
  return ['stash', 'list', '-z', '--format=%gd%x00%H%x00%P%x00%cI%x00%gs'];
}

export function buildStashParentsArgv(oid) {
  return ['rev-list', '--parents', '-n', '1', validateOid(oid), '--'];
}

export function buildStashTrackedArgv(oid) {
  return ['diff', ...DIFF_ARGS, '--name-status', '-z', `${validateOid(oid)}^1`, oid, '--'];
}

export function buildStashUntrackedArgv(oid) {
  return ['show', '--format=', '--name-only', '-z', `${validateOid(oid)}^3`, '--'];
}

export function buildStashDiffArgv(oid, file, untracked = false) {
  validateOid(oid);
  return ['diff', ...DIFF_ARGS, `${oid}^1`, untracked ? `${oid}^3` : oid, '--', `:(literal)${validateFile(file)}`];
}

/**
 * `git stash branch <name> <stash>` takes the name before the stash and has no
 * `--` to hide it behind, so a name that starts with a dash would be read as an
 * option. Git refuses such a branch name anyway; refusing it here keeps the
 * argv honest instead of relying on that.
 */
export function buildStashActionArgv(action, index, { name = null } = {}) {
  if (!STASH_ACTIONS.includes(action)) throw new TypeError('Unknown stash action');
  if (!Number.isInteger(index) || index < 0 || index > 100000) throw new TypeError('Invalid stash index');
  const ref = `stash@{${index}}`;
  if (action !== 'branch') return ['stash', action, ref];
  if (typeof name !== 'string' || !name || name.length > 255 || name.startsWith('-')
    || /[\0-\x20\x7f~^:?*[\\]/.test(name) || name.includes('..') || name.includes('@{')) throw new TypeError('Invalid branch name');
  return ['stash', 'branch', name, ref];
}

/**
 * The reflog subject of a stash reads `WIP on <branch>: <sha> <subject>` or,
 * with an explicit message, `On <branch>: <message>`. Both forms are kept: the
 * split is for the UI, the raw subject stays as the thing Git actually stored.
 */
export function parseStashList(output) {
  if (!output) return [];
  const oidPattern = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;
  const tokens = output.split('\0');
  if (tokens.pop() !== '' || tokens.length % 5 !== 0) throw new Error('Invalid stash list output');
  const entries = [];
  for (let i = 0; i < tokens.length; i += 5) {
    const [ref, oid, parentList, date, subject] = tokens.slice(i, i + 5);
    const position = /^stash@\{(\d+)\}$/.exec(ref);
    if (!position || Number(position[1]) !== entries.length) throw new Error('Unexpected stash order');
    if (!oidPattern.test(oid)) throw new Error('Invalid stash identifier');
    const parents = parentList ? parentList.split(' ').filter(Boolean) : [];
    if (parents.some(parent => !oidPattern.test(parent))) throw new Error('Invalid stash identifier');
    const described = /^(?:WIP on|On) ([^:]*): ([\s\S]*)$/.exec(subject);
    entries.push({
      index: entries.length, ref, oid, base: parents[0] ?? null, date,
      branch: described ? described[1] : null,
      message: described ? described[2] : subject,
      subject
    });
  }
  return entries;
}

async function execute(cwd, log, argv, operation) {
  const result = await runGit({ cwd, log, argv, operation });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result.stdout;
}

/** @param {{ cwd: string, log: object }} options */
export async function loadStashes({ cwd, log }) {
  return parseStashList(await execute(cwd, log, buildStashListArgv(), 'Read stashes'));
}

/**
 * Both sides of one stash, merged into a single list. `untracked` says which
 * revision pair a file's diff has to be read from, because an untracked file
 * exists only in `^3` and is invisible to the diff the tracked side uses.
 * @param {{ cwd: string, log: object, oid: string }} options
 */
export async function loadStashFiles({ cwd, log, oid }) {
  const parents = (await execute(cwd, log, buildStashParentsArgv(oid), 'Read stash parents')).trim().split(/\s+/);
  const tracked = parseChangedFiles(await execute(cwd, log, buildStashTrackedArgv(oid), 'Read stash changes'));
  const untracked = parents.length >= 4
    ? (await execute(cwd, log, buildStashUntrackedArgv(oid), 'Read stashed untracked files')).split('\0').filter(Boolean)
    : [];
  return [
    ...tracked.map(file => ({ ...file, untracked: false })),
    ...untracked.map(path => ({ path, status: 'A', untracked: true }))
  ].sort((a, b) => a.path.localeCompare(b.path));
}

/** @param {{ cwd: string, log: object, oid: string, file: string, untracked?: boolean }} options */
export async function loadStashDiff({ cwd, log, oid, file, untracked = false }) {
  const patch = await execute(cwd, log, buildStashDiffArgv(oid, file, untracked), 'Read stash diff');
  return { patch, binary: /^(?:Binary files |GIT binary patch)/m.test(patch) };
}

/**
 * Applies, pops, drops or branches one stash. The index alone is not enough to
 * name a stash safely — dropping any earlier one renumbers the rest — so the
 * caller echoes back the object id it was showing and the action is refused
 * unless the list still agrees.
 * @param {{ cwd: string, log: object, action: string, index: number, expectedOid: string, name?: ?string }} options
 * @returns {Promise<{ ok: boolean, message: ?string }>}
 */
export async function runStashAction({ cwd, log, action, index, expectedOid, name = null }) {
  const argv = buildStashActionArgv(action, index, { name });
  validateOid(expectedOid);
  const entry = (await loadStashes({ cwd, log })).find(item => item.index === index);
  if (!entry || entry.oid !== expectedOid) {
    return { ok: false, message: 'The stash list changed since it was read. Refresh and try again.' };
  }
  const operation = `Stash ${action}: ${entry.ref}`;
  const result = await runGit({ cwd, log, argv, operation });
  if (result.code !== 0) return { ok: false, message: `${operation} did not finish. Show output in the console.` };
  return { ok: true, message: null };
}
