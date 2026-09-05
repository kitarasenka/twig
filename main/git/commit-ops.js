import { runGit } from './exec.js';

/** Commit creation and the stash, i.e. local writes that move HEAD or shelve work. */

const SUBJECT_LIMIT = 72;

/**
 * Checks a commit message without blocking on style. An empty message is a
 * hard error because Git would refuse it anyway; a long subject or a missing
 * blank line after it are warnings, because they are conventions and the user
 * is allowed to break them knowingly.
 * @param {string} message
 * @returns {{ valid: boolean, error: ?string, warnings: string[] }}
 */
export function validateCommitMessage(message) {
  if (typeof message !== 'string' || message.trim().length === 0) {
    return { valid: false, error: 'A commit needs a message.', warnings: [] };
  }
  const lines = message.split('\n');
  const warnings = [];
  if (lines[0].length > SUBJECT_LIMIT) warnings.push(`The subject is ${lines[0].length} characters; ${SUBJECT_LIMIT} keeps it readable in logs.`);
  if (lines.length > 1 && lines[1].trim().length > 0) warnings.push('Leave a blank line between the subject and the body.');
  return { valid: true, error: null, warnings };
}

export function buildCommitArgv({ amend = false } = {}) {
  return ['commit', '--file=-', '--cleanup=strip', ...(amend ? ['--amend'] : [])];
}

export function buildStashArgv({ includeUntracked = false, message = '' } = {}) {
  return ['stash', 'push', ...(includeUntracked ? ['--include-untracked'] : []),
    ...(message ? ['--message', message] : [])];
}

export const buildStashPopArgv = () => ['stash', 'pop'];

async function mutate({ cwd, log, argv, operation, stdin = null }) {
  const result = await runGit({ argv, cwd, log, operation, stdin });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result;
}

/**
 * Writes the commit message over stdin instead of `-m`, so a message with
 * newlines, quotes or a leading dash reaches Git unchanged.
 * @param {{ cwd: string, log: object, message: string, amend?: boolean }} options
 */
export async function createCommit({ cwd, log, message, amend = false }) {
  const check = validateCommitMessage(message);
  if (!check.valid) throw new Error(check.error);
  await mutate({ cwd, log, argv: buildCommitArgv({ amend }), stdin: message, operation: 'Commit' });
  return check.warnings;
}

/** @param {{ cwd: string, log: object, includeUntracked?: boolean, message?: string }} options */
export function stashPush({ cwd, log, includeUntracked = false, message = '' }) {
  return mutate({ cwd, log, argv: buildStashArgv({ includeUntracked, message }), operation: 'Stash changes' });
}

/** @param {{ cwd: string, log: object }} options */
export function stashPop({ cwd, log }) {
  return mutate({ cwd, log, argv: buildStashPopArgv(), operation: 'Pop stash' });
}
