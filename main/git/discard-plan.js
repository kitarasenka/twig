/**
 * The exact Git command each kind of discard runs, as argv. One module for
 * both sides: main executes these, and the renderer shows them verbatim in the
 * §6.5 confirmation, so the dialog can never describe a different command
 * from the one that runs. No imports — Vite and Node both load this file, as
 * they do `drop-plan.js`.
 *
 * Kinds:
 * - `file`       one tracked file's unstaged changes → back to the index version
 * - `untracked`  one untracked file, or folder when the path ends in `/`
 * - `tracked`    every unstaged change (the paths go over stdin)
 * - `untracked-all` every untracked path in the section
 * - `lines`      the selected lines of one file's unstaged diff, reverse-applied
 */

export const DISCARD_REF = 'refs/twig/discard';

const literal = path => `:(literal)${path}`;

export function validDiscardPath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 32768 && !path.includes('\0') && !path.includes('\n')
    && !path.startsWith('/') && !path.split('/').some(part => part === '..');
}

function check(path) {
  if (!validDiscardPath(path)) throw new TypeError('Invalid file path');
  return path;
}

/**
 * @param {'file' | 'untracked' | 'tracked' | 'untracked-all' | 'lines'} kind
 * @param {string[]} [paths] the one path for `file`/`untracked`, the section's paths for `untracked-all`
 * @returns {string[]} argv after `git`
 */
export function discardCommand(kind, paths = []) {
  if (kind === 'file') return ['restore', '--worktree', '--', literal(check(paths[0]))];
  if (kind === 'untracked') {
    const path = check(paths[0]);
    return ['clean', '-f', ...(path.endsWith('/') ? ['-d'] : []), '--', literal(path)];
  }
  if (kind === 'tracked') return ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'];
  if (kind === 'untracked-all') {
    if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('Nothing to delete');
    return ['clean', '-f', '-d', '--', ...paths.map(path => literal(check(path)))];
  }
  if (kind === 'lines') return ['apply', '--reverse', '--whitespace=nowarn', '-'];
  throw new TypeError('Unknown discard');
}

/**
 * Undo and Redo of a discard, from what the discard recorded: `before` and
 * `after` are commits under DISCARD_REF holding the affected files as they
 * were on either side. Undo restores every path from `before` — in Git's
 * default no-overlay mode a tracked path missing there is removed again.
 * Redo restores the tracked paths from `after` and deletes again the
 * untracked ones, which `after` cannot hold.
 * @returns {{ argv: string[], stdin?: string }[]}
 */
export function discardInverse({ before, after, paths, removed }, direction) {
  const list = items => `${items.map(literal).join('\0')}\0`;
  const restore = (source, items) => ({
    argv: ['restore', `--source=${source}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], stdin: list(items)
  });
  if (direction === 'undo') return [restore(before, paths)];
  const removedSet = new Set(removed);
  const kept = paths.filter(path => !removedSet.has(path));
  const commands = kept.length ? [restore(after, kept)] : [];
  for (let at = 0; at < removed.length; at += 200) {
    commands.push({ argv: ['clean', '-f', '-d', '--', ...removed.slice(at, at + 200).map(literal)] });
  }
  return commands;
}
