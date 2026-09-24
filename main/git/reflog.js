import { runGit } from './exec.js';
import { validateOid } from './commit.js';
import { validateRefName } from './refs-ops.js';
import { REFLOG_PAGE, moveBranchCommand, reflogRef, splitReflogSubject } from './reflog-plan.js';

/**
 * The reflog: every place HEAD and each branch pointed to, newest first. It is
 * how work lost to a reset, a rebase, an amend or a deleted branch comes back —
 * including mistakes made outside 🌱 Twig or after the Undo chain ended.
 *
 * Read with `git log --walk-reflogs` in a fixed NUL format, never by parsing
 * `git reflog`'s human output or the files under `.git/logs` (a reftable
 * repository has none). `--date=unix` turns the selector into `ref@{<time>}`,
 * which is where the time of the *move* (not of the commit) comes from; the
 * `@{n}` index is the entry's position.
 */

const FIELDS = ['oid', 'parents', 'selector', 'reflogSubject', 'mover', 'subject', 'author', 'committedAt'];
const FORMAT = '%H%x00%P%x00%gd%x00%gs%x00%gn%x00%s%x00%an%x00%ct';

/**
 * @param {{ branch?: ?string, skip?: number, limit?: number }} options
 * @returns {string[]}
 */
export function buildReflogArgv({ branch = null, skip = 0, limit = REFLOG_PAGE } = {}) {
  if (branch !== null) validateRefName(branch);
  if (!Number.isSafeInteger(skip) || skip < 0) throw new TypeError('Invalid reflog offset');
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid reflog page size');
  // One extra entry says whether another page exists.
  return ['log', '--walk-reflogs', '--no-show-signature', '--date=unix', '-z', `--format=${FORMAT}`,
    `--max-count=${limit + 1}`, `--skip=${skip}`, reflogRef(branch), '--'];
}

/**
 * @param {string} output `git log --walk-reflogs -z` in FORMAT
 * @param {number} skip index of the first entry
 * @param {string} name `HEAD` or the branch name, for the `name@{n}` label
 */
export function parseReflog(output, skip = 0, name = 'HEAD') {
  if (!output) return [];
  const tokens = output.split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  if (tokens.length % FIELDS.length) throw new Error('Invalid reflog output');
  const entries = [];
  for (let at = 0; at < tokens.length; at += FIELDS.length) {
    const record = Object.fromEntries(FIELDS.map((field, offset) => [field, tokens[at + offset]]));
    validateOid(record.oid);
    const time = /@\{(\d+)\}$/.exec(record.selector);
    const index = skip + entries.length;
    entries.push({
      index, selector: `${name}@{${index}}`, oid: record.oid,
      parents: record.parents ? record.parents.split(' ') : [],
      movedAt: time ? Number(time[1]) : null,
      ...splitReflogSubject(record.reflogSubject), reflogSubject: record.reflogSubject,
      mover: record.mover, subject: record.subject, author: record.author,
      committedAt: /^\d+$/.test(record.committedAt) ? Number(record.committedAt) : null
    });
  }
  return entries;
}

/**
 * Which of these commits no branch, tag, remote-tracking branch or HEAD
 * reaches any more — the ones that would be gone for good once the reflog
 * expires. One `rev-list` for the whole page: the ids go in on stdin.
 * @returns {Promise<Set<string>>}
 */
export async function findLost({ cwd, log, oids }) {
  const unique = [...new Set(oids)];
  if (!unique.length) return new Set();
  const result = await runGit({ cwd, log, argv: ['rev-list', '--ignore-missing', '--stdin', '--not', '--branches', '--tags', '--remotes', 'HEAD'],
    stdin: `${unique.join('\n')}\n`, operation: 'Read which reflog commits are on no branch' });
  if (result.code !== 0) throw new Error('Git could not tell which commits are on no branch.');
  const unreachable = new Set(result.stdout.split('\n').filter(Boolean));
  return new Set(unique.filter(oid => unreachable.has(oid)));
}

/**
 * One page of one reflog, each entry marked `lost` when nothing but the
 * reflog keeps its commit alive.
 * @param {{ cwd: string, log: object, branch?: ?string, skip?: number, limit?: number }} options
 */
export async function loadReflog({ cwd, log, branch = null, skip = 0, limit = REFLOG_PAGE }) {
  const argv = buildReflogArgv({ branch, skip, limit });
  const result = await runGit({ cwd, log, argv, operation: `Read the reflog of ${branch ?? 'HEAD'}` });
  if (result.code !== 0) throw new Error(`Git could not read the reflog of ${branch ?? 'HEAD'}.`);
  const all = parseReflog(result.stdout, skip, branch ?? 'HEAD');
  const entries = all.slice(0, limit);
  const lost = await findLost({ cwd, log, oids: entries.map(entry => entry.oid) });
  return { branch, entries: entries.map(entry => ({ ...entry, lost: lost.has(entry.oid) })), nextSkip: all.length > limit ? skip + limit : null };
}

async function read(cwd, log, argv, operation) {
  return runGit({ cwd, log, argv, operation });
}

/**
 * "Move this branch back here." The screen sends where it saw the branch
 * (`expected`); a branch that has moved since is refused, not overwritten.
 * @param {{ cwd: string, log: object, branch: string, oid: string, expected: string }} options
 * @returns {Promise<{ ok: true, message: null, undo: [string, string, string, boolean] }>}
 */
export async function moveBranch({ cwd, log, branch, oid, expected }) {
  validateRefName(branch); validateOid(oid); validateOid(expected);
  moveBranchCommand({ branch, oid, expected, current: false }); // refuses a name like `--force` before any Git runs
  if (oid === expected) throw new Error(`${branch} already points at ${oid.slice(0, 7)}.`);
  const tip = await read(cwd, log, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], 'Background: read branch before moving it');
  if (tip.code !== 0) throw new Error(`There is no branch ${branch} any more. Create a branch from the commit instead.`);
  if (tip.stdout.trim() !== expected) throw new Error(`${branch} moved since the reflog was read. Refresh and choose again.`);
  const target = await read(cwd, log, ['cat-file', '-e', `${oid}^{commit}`], 'Background: check the reflog commit still exists');
  if (target.code !== 0) throw new Error(`Commit ${oid.slice(0, 7)} is no longer in this repository.`);
  const head = await read(cwd, log, ['symbolic-ref', '--quiet', 'HEAD'], 'Background: read the checked-out branch');
  const current = head.code === 0 && head.stdout.trim() === `refs/heads/${branch}`;
  const argv = moveBranchCommand({ branch, oid, expected, current });
  const result = await runGit({ cwd, log, argv, operation: `Move ${branch} to ${oid.slice(0, 7)} from the reflog` });
  if (result.code !== 0) {
    throw new Error(current
      ? `Git refused to move ${branch}: uncommitted changes touch files that differ at ${oid.slice(0, 7)}. Commit or stash them first.`
      : `Git refused to move ${branch}. See the command console.`);
  }
  return { ok: true, message: null, undo: [branch, expected, oid, current] };
}
