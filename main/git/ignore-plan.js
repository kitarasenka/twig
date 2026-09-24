/**
 * "Ignore this file / every *.ext file / this folder" for an untracked path:
 * which line goes into the repository's root `.gitignore`, and how Undo takes
 * it back out. One module for both sides — the menu shows the exact pattern
 * main will write, and main computes it again from the path and the kind
 * rather than accepting a pattern from the renderer. No imports: Vite and Node
 * both load this file, as they do `discard-plan.js`.
 *
 * Patterns are anchored with a leading `/` where they name one path, so
 * ignoring `build/out.log` does not also ignore `docs/build/out.log`. Every
 * character gitignore treats as special is escaped with a backslash, so a file
 * called `[draft] #1.txt` is ignored as exactly that name.
 */

export const IGNORE_FILE = '.gitignore';
export const IGNORE_KINDS = ['file', 'extension', 'folder'];

export function validIgnorePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !/[\0\n\r]/.test(path)
    && !path.startsWith('/') && !path.split('/').slice(0, path.endsWith('/') ? -1 : undefined).some(part => part === '' || part === '.' || part === '..');
}

/**
 * One path component as a literal gitignore pattern. `\`, `*`, `?` and `[` are
 * wildcards; a leading `#` makes a comment and a leading `!` a negation;
 * trailing spaces are dropped unless escaped.
 */
export function escapeIgnoreSegment(segment) {
  let escaped = segment.replace(/[\\*?[]/g, character => `\\${character}`);
  if (/^[#!]/.test(escaped)) escaped = `\\${escaped}`;
  return escaped.replace(/ +$/, spaces => spaces.replace(/ /g, '\\ '));
}

const escapePath = path => path.split('/').map(escapeIgnoreSegment).join('/');

/**
 * The choices a menu offers for one untracked path, most specific first.
 * A folder entry (`dir/`, which is how Git lists an untracked folder) offers
 * only itself; a file offers itself, its extension if it has one, and the
 * folder it lives in unless that is the repository root.
 * @returns {{ kind: string, pattern: string, text: string }[]}
 */
export function ignoreChoices(path) {
  if (!validIgnorePath(path)) throw new TypeError('Invalid file path');
  if (path.endsWith('/')) {
    const folder = path.slice(0, -1);
    return [{ kind: 'folder', pattern: `/${escapePath(folder)}/`, text: 'Ignore this folder' }];
  }
  const choices = [{ kind: 'file', pattern: `/${escapePath(path)}`, text: 'Ignore this file' }];
  const slash = path.lastIndexOf('/');
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // `.env` is a name, not an extension; `archive.` has none either.
  if (dot > 0 && dot < name.length - 1) {
    const extension = name.slice(dot + 1);
    choices.push({ kind: 'extension', pattern: `*.${escapeIgnoreSegment(extension)}`, text: `Ignore all .${extension} files` });
  }
  if (slash > 0) {
    const folder = path.slice(0, slash);
    choices.push({ kind: 'folder', pattern: `/${escapePath(folder)}/`, text: `Ignore folder ${folder}/` });
  }
  return choices;
}

export function ignoreChoice(path, kind) {
  const choice = ignoreChoices(path).find(item => item.kind === kind);
  if (!choice) throw new TypeError('This path cannot be ignored that way');
  return choice;
}

/**
 * `content` with `pattern` as a new last line. The file's own line ending is
 * kept, and a missing final newline is added first so the rule starts on a
 * line of its own. A rule already present verbatim is not added twice.
 * @returns {{ content: string, added: boolean }}
 */
export function appendIgnoreRule(content, pattern) {
  const lines = content.split(/\r?\n/);
  if (lines.some(line => line === pattern)) return { content, added: false };
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const separator = content.length && !content.endsWith('\n') ? eol : '';
  return { content: `${content}${separator}${pattern}${eol}`, added: true };
}

/**
 * Undo and Redo of an added rule, from the two backups taken around the
 * write (commits under `refs/twig/discard`, like a discard's). Undo puts the
 * old `.gitignore` back — or deletes the one this action created — and Redo
 * restores the version with the rule.
 * @param {{ before: string, after: string, created: boolean }} saved
 * @returns {{ argv: string[] }[]}
 */
export function ignoreInverse({ before, after, created }, direction) {
  const target = `:(literal)${IGNORE_FILE}`;
  if (direction === 'undo') {
    // `-x`: the new file is removed even if a rule in it happens to match itself.
    return created ? [{ argv: ['clean', '-f', '-x', '--', target] }]
      : [{ argv: ['restore', `--source=${before}`, '--worktree', '--', target] }];
  }
  return [{ argv: ['restore', `--source=${after}`, '--worktree', '--', target] }];
}
