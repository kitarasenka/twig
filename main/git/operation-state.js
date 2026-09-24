import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';

/**
 * What operation the repository is in the middle of, for the banner above the
 * history.
 *
 * Git has no porcelain for this. `git status` prints it only as prose in its
 * human-readable form, and `--porcelain=v2` leaves it out entirely, so the
 * state is read from the marker files Git itself writes under the git
 * directory. Those file names are part of Git's documented on-disk layout
 * (githooks/gitrepository-layout), which is why reading them is sound where
 * scraping the English output of `git status` would not be.
 *
 * @typedef {Object} OperationState
 * @property {'none'|'merge'|'cherry-pick'|'revert'|'rebase'|'am'} kind
 * @property {?number} step 1-based position in a rebase, else null
 * @property {?number} total number of rebase steps, else null
 * @property {?string} branch branch being rebased, from `head-name`
 * @property {string[]} conflicts paths Git reports as unmerged
 * @property {boolean} resolved true when the operation is stopped with nothing left conflicted
 */

const REBASE_DIRS = ['rebase-merge', 'rebase-apply'];

export async function readTrimmed(file) {
  try {
    return (await readFile(file, 'utf8')).trim();
  } catch {
    return null;
  }
}

export async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** @param {{ cwd: string, log: object }} options */
export async function resolveGitDir({ cwd, log }) {
  const result = await runGit({ argv: ['rev-parse', '--absolute-git-dir'], cwd, log, operation: 'Background: locate the git directory' });
  if (result.code !== 0) throw new Error('Git could not locate this repository.');
  return result.stdout.trimEnd();
}

/**
 * `rebase-apply` is shared: `git am` keeps its state there too, marked by an
 * `applying` file, and counts its steps in `next`/`last` rather than
 * `msgnum`/`end`. Telling them apart matters — `git rebase --continue` refuses
 * to continue an `am`, and the reverse.
 */
async function readRebase(gitDir) {
  for (const name of REBASE_DIRS) {
    const dir = path.join(gitDir, name);
    if (!await exists(dir)) continue;
    const am = name === 'rebase-apply' && await exists(path.join(dir, 'applying'));
    const [step, total, headName] = await Promise.all([
      readTrimmed(path.join(dir, am ? 'next' : 'msgnum')),
      readTrimmed(path.join(dir, am ? 'last' : 'end')),
      am ? null : readTrimmed(path.join(dir, 'head-name'))
    ]);
    return {
      kind: am ? 'am' : 'rebase',
      step: Number.isInteger(Number(step)) ? Number(step) : null,
      total: Number.isInteger(Number(total)) ? Number(total) : null,
      branch: headName ? headName.replace(/^refs\/heads\//, '') : null
    };
  }
  return null;
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, gitDir?: ?string }} options
 * @returns {Promise<OperationState>}
 */
export async function loadOperationState({ cwd, log, gitDir = null }) {
  const dir = gitDir || await resolveGitDir({ cwd, log });
  const rebase = await readRebase(dir);
  let head = rebase;
  if (!head) {
    // A revert and a cherry-pick share the sequencer, so the marker file is
    // the only thing that distinguishes them.
    for (const [file, kind] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']]) {
      if (await exists(path.join(dir, file))) { head = { kind, step: null, total: null, branch: null }; break; }
    }
  }
  if (!head) return { kind: 'none', step: null, total: null, branch: null, conflicts: [], resolved: false };

  const result = await runGit({ argv: ['status', '--porcelain=v2', '-z'], cwd, log, operation: 'Background: read conflicted files' });
  if (result.code !== 0) throw new Error('Git could not read the working tree.');
  const conflicts = parseStatusV2(result.stdout).entries.filter(entry => entry.kind === 'unmerged').map(entry => entry.path);
  return { ...head, conflicts, resolved: conflicts.length === 0 };
}
