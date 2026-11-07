import { ui } from '../../renderer/src/i18n/i18n.js';
// Shared by the console input (renderer) and the `console:run-command` IPC
// handler, and exercised by scripts/checks/read-only-command.mjs. Imports only the
// import-free i18n module (its messages are marked for translation).
//
// The console lets a user type a git command, but only a read-only one. This is
// NOT a shell and NOT a universal exec: `tokenize` refuses shell operators and
// performs no expansion, and `checkReadOnly` accepts only an allowlist of
// subcommands that never touch refs, the index, the working tree or config.
// The renderer runs both for instant feedback; main runs them again and never
// trusts the renderer's verdict.

const FORBIDDEN = /[;&|<>$`\n\r]/;

/**
 * Split a command string into argv, honouring single/double quotes and a
 * backslash escape, with no shell behaviour of any kind. A leading `git` token
 * is dropped so both `git log` and `log` work. Throws on anything ambiguous.
 */
export function tokenize(input) {
  if (typeof input !== 'string') throw new TypeError('A command must be a string.');
  const text = input.trim();
  if (!text) throw new TypeError(ui`Type a git command.`);
  if (text.length > 4096) throw new TypeError(ui`This command is too long.`);
  if (FORBIDDEN.test(text)) {
    throw new TypeError(ui`A git command here cannot contain shell operators (& | ; < > $ \` or newlines).`);
  }

  const argv = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === quote) { quote = null; continue; }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; hasToken = true; continue; }
    if (char === '\\') {
      const next = text[i + 1];
      if (next === undefined) throw new TypeError(ui`A command cannot end with a lone backslash.`);
      current += next; i++; hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) { argv.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += char; hasToken = true;
  }
  if (quote) throw new TypeError(ui`This command has an unbalanced quote.`);
  if (hasToken) argv.push(current);
  if (argv.length > 0 && argv[0].toLowerCase() === 'git') argv.shift();
  if (argv.length === 0) throw new TypeError(ui`Type a git command.`);
  return argv;
}

// Subcommands that only read. Anything that writes refs, the index, the working
// tree, config, or spawns an external tool is absent by design.
export const READ_ONLY = new Set([
  'log', 'show', 'diff', 'status', 'blame', 'annotate', 'shortlog', 'reflog',
  'rev-parse', 'rev-list', 'merge-base', 'describe', 'name-rev', 'cat-file',
  'ls-files', 'ls-tree', 'ls-remote', 'for-each-ref', 'show-ref', 'show-branch',
  'cherry', 'diff-tree', 'diff-index', 'diff-files', 'whatchanged', 'grep',
  'range-diff', 'count-objects', 'var', 'branch', 'tag', 'remote', 'stash',
  'worktree', 'symbolic-ref'
]);

// Options that read or write an arbitrary file, or run an external program
// configured in the repo. Rejected in any position. The value lists the
// subcommands an option is refused in (`null` — all of them).
// A bare `-c` / `-C` before the subcommand is caught earlier as argv[0]; after
// a subcommand `-c` (combined diff) and `-C` (detect copies) are read-only.
//
// Git accepts any unambiguous prefix of a long option (`--upload-pa` is
// `--upload-pack`), so a long token is refused when it is a prefix of one of
// these too — unless it is itself a real option of its own (`--text`).
const FORBIDDEN_OPTIONS = new Map([
  ['--output', null], ['--output-directory', null], ['--ext-diff', null],
  ['--open-files-in-pager', null], ['--exec', null], ['--upload-pack', null],
  ['--receive-pack', null], ['--textconv', null],
  ['--filters', new Set(['cat-file'])],
  ['--contents', new Set(['blame', 'annotate'])],
  ['--no-index', new Set(['diff', 'grep'])]
]);
const EXACT_OPTIONS = new Set(['--text']);
// Short spellings of the same: `-o` was always refused, `grep -O<pager>` is
// `--open-files-in-pager`, and short options cluster (`-iO<pager>`).
const FORBIDDEN_SHORT = new Map([['o', null], ['O', new Set(['grep'])]]);

function forbiddenOption(sub, token) {
  const applies = scope => scope === null || scope.has(sub);
  if (token.startsWith('--')) {
    const name = bareName(token);
    if (name.length < 3 || EXACT_OPTIONS.has(name)) return null;
    for (const [option, scope] of FORBIDDEN_OPTIONS) {
      if (applies(scope) && option.startsWith(name)) return option;
    }
    return null;
  }
  if (token === '-o') return '-o';
  for (const [letter, scope] of FORBIDDEN_SHORT) {
    if (letter !== 'o' && applies(scope) && token.slice(1).includes(letter)) return `-${letter}`;
  }
  return null;
}

// Second words that turn a subcommand whose default form is harmless into a
// mutation or an external call: `git remote add …`.
const MUTATING_SUBVERBS = {
  remote: new Set(['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update'])
};
// `git reflog` is `reflog show`, and a word it does not know is a ref. Every
// other verb of it writes, and Git adds more over time, so none passes anywhere.
const REFLOG_WRITES = new Set(['expire', 'delete', 'drop', 'write']);

// Subcommands whose bare form already writes (`git stash` == `git stash push`,
// `git worktree` alone errors) — only the listed read verbs are allowed.
const LISTING_ONLY = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list'])
};

// These subcommands mix reading and writing in one verb, and Git takes prefixes
// (`--del`) and clusters (`-qD`) of each option, so here the list says what
// reads and anything else is refused. Long options are spelled in full.
const LIST_OPTIONS = ['--list', '--sort', '--format', '--color', '--no-color', '--column', '--no-column', '--ignore-case', '--omit-empty',
  '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
const READ_OPTIONS = {
  branch: { long: new Set([...LIST_OPTIONS, '--all', '--remotes', '--verbose', '--show-current', '--abbrev', '--no-abbrev']), short: 'arlvi' },
  tag: { long: new Set(LIST_OPTIONS), short: 'li' },
  'symbolic-ref': { long: new Set(['--quiet', '--short', '--no-recurse']), short: 'q' },
  'ls-remote': { long: new Set(['--heads', '--branches', '--tags', '--refs', '--quiet', '--exit-code', '--get-url', '--symref', '--sort']), short: 'htbq' }
};
// `-l` / `--list` and any filter option put branch/tag into listing mode, where
// a trailing argument is a name pattern; without one it means "create this ref".
const LIST_MODE = new Set(['--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at']);
// Options Git reads the next word for. `--color` and `--column` are not among
// them: their value only comes after `=`, and the next word stays a name.
const VALUE_OPTIONS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort']);

const isOption = token => token.startsWith('-') && token !== '-' && token !== '--';
const bareName = token => token.split('=', 1)[0];

const countLines = token => /^-n\d*$/.test(token);

/** Walks `tokens` as Git would: `{ refused }` for an option off the list, else whether it lists and how many words are left. */
function readListing(sub, tokens) {
  const { long, short } = READ_OPTIONS[sub];
  let list = false;
  let positionals = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') { positionals += tokens.length - i - 1; break; }
    if (!isOption(token)) { positionals++; continue; }
    const name = bareName(token);
    const known = token.startsWith('--') ? long.has(name) : (sub === 'tag' && countLines(token)) || [...token.slice(1)].every(letter => short.includes(letter));
    if (!known) return { refused: name };
    if (LIST_MODE.has(name) || (sub === 'tag' && countLines(token)) || (!token.startsWith('--') && token.includes('l'))) list = true;
    if (VALUE_OPTIONS.has(token)) i++;
  }
  return { list, positionals };
}

// `git diff` turns into `--no-index` by itself when a path is outside the
// repository, and then prints any file on the disk.
function leavesRepository(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-S' || token === '-G') { i++; continue; }
    if (token === '--' || isOption(token)) continue;
    if (/^[/~]|^[A-Za-z]:[\\/]/.test(token) || token.split(/[\\/]/).includes('..')) return true;
  }
  return false;
}

/**
 * @param {string[]} argv  output of {@link tokenize}
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkReadOnly(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: ui`Type a git command.` };
  const sub = argv[0];
  if (isOption(sub)) {
    return { ok: false, reason: ui`Global options (like -c or -C) are not allowed here — start with a git subcommand.` };
  }
  if (!READ_ONLY.has(sub)) {
    return { ok: false, reason: ui`"${sub}" is not an allowed read-only git command. Use the app for anything that changes the repository.` };
  }

  const rest = argv.slice(1);
  for (const token of rest) {
    if (token === '--') break;
    if (!isOption(token)) continue;
    const option = forbiddenOption(sub, token);
    if (option) {
      return { ok: false, reason: ui`${option} is not allowed here — it can read or write a file or run an external program.` };
    }
  }
  // `git var -l` prints the whole config, credentials in URLs and headers included.
  if (sub === 'var' && rest.some(token => token === '-l')) {
    return { ok: false, reason: ui`"git var -l" prints the whole configuration and is not allowed here.` };
  }

  if (sub === 'diff' && leavesRepository(rest)) return { ok: false, reason: ui`"git diff" reads only files inside the repository here.` };

  if (sub === 'reflog') {
    const verb = rest.find(token => REFLOG_WRITES.has(token));
    if (verb) return { ok: false, reason: ui`"git ${sub} ${verb}" changes the repository and is not allowed here.` };
  }

  const subverbs = MUTATING_SUBVERBS[sub];
  if (subverbs) {
    const first = rest.find(token => !isOption(token));
    if (first && subverbs.has(first)) {
      return { ok: false, reason: ui`"git ${sub} ${first}" changes the repository and is not allowed here.` };
    }
  }

  const listing = LISTING_ONLY[sub];
  // First word or nothing: `git stash -k list` is `stash push -k -- list`.
  if (listing) {
    if (!listing.has(rest[0])) {
      return { ok: false, reason: ui`"git ${sub}" only reads here as "${[...listing].map(verb => `${sub} ${verb}`).join('" or "')}".` };
    }
  }

  if (sub === 'branch') {
    const { refused, list, positionals } = readListing(sub, rest);
    if (refused) return { ok: false, reason: ui`"git branch ${refused}" creates, deletes or moves a branch and is not allowed here.` };
    if (positionals > 0 && !list) {
      return { ok: false, reason: ui`Give "git branch" a name only with -l to match it — a bare name would create a branch.` };
    }
  }

  if (sub === 'tag') {
    const { refused, list, positionals } = readListing(sub, rest);
    if (refused) return { ok: false, reason: ui`"git tag ${refused}" writes a tag and is not allowed here.` };
    if (positionals > 0 && !list) {
      return { ok: false, reason: ui`Give "git tag" a name only with -l to match it — a bare name would create a tag.` };
    }
  }

  if (sub === 'symbolic-ref') {
    const { refused, positionals } = readListing(sub, rest);
    if (refused) return { ok: false, reason: ui`"git symbolic-ref -d" deletes a ref and is not allowed here.` };
    if (positionals >= 2) return { ok: false, reason: ui`"git symbolic-ref <name> <ref>" writes a ref and is not allowed here.` };
  }

  if (sub === 'ls-remote') {
    const { refused } = readListing(sub, rest);
    if (refused) return { ok: false, reason: ui`${refused} is not allowed here — it can read or write a file or run an external program.` };
  }

  return { ok: true };
}
