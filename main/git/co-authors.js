import { runGit } from './exec.js';
import { validateCoAuthor } from './co-author-trailer.js';

/**
 * Who a commit can credit as co-author: the people who already authored
 * commits in this repository. Read from Git's own history on request — when
 * the co-author field is first used — never from a network service.
 *
 * `%aN`/`%aE` honour `.mailmap`, so one person with two spellings of their
 * name shows once. Only the newest SCAN_LIMIT commits are read: that keeps the
 * list current and the cost bounded on a very long history. The backups under
 * `refs/twig/*` and the stash are 🌱 Twig's and the user's own bookkeeping,
 * not authorship, and are left out.
 */

export const SCAN_LIMIT = 5000;
/** The identity 🌱 Twig writes its own backup commits under. */
const OWN_EMAIL = 'twig@localhost';

export function buildCoAuthorsArgv() {
  // `--exclude` only applies to the `--all` that follows it.
  return ['log', '--exclude=refs/twig/*', '--exclude=refs/stash', '--all', '-z', '--format=%aN%x00%aE', `--max-count=${SCAN_LIMIT}`];
}

/** `--default ''` makes an unset address an empty answer rather than exit code 1 in the console. */
export const buildOwnEmailArgv = () => ['config', '--default', '', '--get', 'user.email'];

/**
 * @param {string} output of `buildCoAuthorsArgv`: name NUL email NUL, per commit
 * @param {?string} self the configured user.email, left out of the list
 * @returns {{ name: string, email: string, commits: number }[]} most commits first
 */
export function parseCoAuthors(output, self = null) {
  const tokens = String(output).split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const people = new Map();
  const skip = new Set([OWN_EMAIL, (self || '').trim().toLowerCase()].filter(Boolean));
  for (let at = 0; at + 1 < tokens.length; at += 2) {
    let person;
    try { person = validateCoAuthor({ name: tokens[at], email: tokens[at + 1] }); } catch { continue; }
    const key = person.email.toLowerCase();
    if (skip.has(key)) continue;
    const known = people.get(key);
    // History comes newest first, so the first spelling seen is the current one.
    if (known) known.commits += 1;
    else people.set(key, { ...person, commits: 1 });
  }
  return [...people.values()].sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name, 'en'));
}

/**
 * @param {{ cwd: string, log: object }} options
 * @returns {Promise<{ people: { name: string, email: string, commits: number }[], scanned: number }>}
 */
export async function loadCoAuthors({ cwd, log }) {
  const [history, own] = await Promise.all([
    runGit({ argv: buildCoAuthorsArgv(), cwd, log, operation: 'Read commit authors for co-authors' }),
    runGit({ argv: buildOwnEmailArgv(), cwd, log, operation: 'Read your commit e-mail' })
  ]);
  // A repository with no commits yet has nobody to credit — not an error.
  if (history.code !== 0) return { people: [], scanned: 0 };
  const scanned = history.stdout.split('\0').length >> 1;
  return { people: parseCoAuthors(history.stdout, own.code === 0 ? own.stdout.trim() : null), scanned };
}
