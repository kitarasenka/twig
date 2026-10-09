// Shared by the console input (renderer) and the `console:run-command` IPC
// handler, and exercised by scripts/checks/read-only-command.mjs. No imports.
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
  if (!text) throw new TypeError('Type a git command.');
  if (text.length > 4096) throw new TypeError('This command is too long.');
  if (FORBIDDEN.test(text)) {
    throw new TypeError('A git command here cannot contain shell operators (& | ; < > $ ` or newlines).');
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
      if (next === undefined) throw new TypeError('A command cannot end with a lone backslash.');
      current += next; i++; hasToken = true;
      continue;
    }
    if (char === ' ' || char === '\t') {
      if (hasToken) { argv.push(current); current = ''; hasToken = false; }
      continue;
    }
    current += char; hasToken = true;
  }
  if (quote) throw new TypeError('This command has an unbalanced quote.');
  if (hasToken) argv.push(current);
  if (argv.length > 0 && argv[0].toLowerCase() === 'git') argv.shift();
  if (argv.length === 0) throw new TypeError('Type a git command.');
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
  ['--no-index', new Set(['diff'])]
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
// mutation or an external call. `git remote add …`, `git reflog delete`, …
const MUTATING_SUBVERBS = {
  remote: new Set(['add', 'remove', 'rm', 'rename', 'set-url', 'set-head', 'set-branches', 'prune', 'update']),
  reflog: new Set(['expire', 'delete'])
};

// Subcommands whose bare form already writes (`git stash` == `git stash push`,
// `git worktree` alone errors) — only the listed read verbs are allowed.
const LISTING_ONLY = {
  stash: new Set(['list', 'show']),
  worktree: new Set(['list'])
};

// Options that make branch/tag create, delete, move, or re-point something.
const BRANCH_WRITE = new Set([
  '-d', '-D', '--delete', '-m', '-M', '--move', '-c', '-C', '--copy',
  '-f', '--force', '--set-upstream-to', '-u', '--unset-upstream',
  '--edit-description', '--create-reflog'
]);
const TAG_WRITE = new Set(['-a', '--annotate', '-s', '--sign', '-m', '--message', '-F', '--file', '-d', '--delete', '-f', '--force', '-e', '--edit', '-u', '--local-user']);

const isOption = token => token.startsWith('-') && token !== '-' && token !== '--';
const bareName = token => token.split('=', 1)[0];

/**
 * @param {string[]} argv  output of {@link tokenize}
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkReadOnly(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: 'Type a git command.' };
  const sub = argv[0];
  if (isOption(sub)) {
    return { ok: false, reason: 'Global options (like -c or -C) are not allowed here — start with a git subcommand.' };
  }
  if (!READ_ONLY.has(sub)) {
    return { ok: false, reason: `"${sub}" is not an allowed read-only git command. Use the app for anything that changes the repository.` };
  }

  const rest = argv.slice(1);
  for (const token of rest) {
    if (token === '--') break;
    if (!isOption(token)) continue;
    const option = forbiddenOption(sub, token);
    if (option) {
      return { ok: false, reason: `${option} is not allowed here — it can read or write a file or run an external program.` };
    }
  }
  // `git var -l` prints the whole config, credentials in URLs and headers included.
  if (sub === 'var' && rest.some(token => token === '-l')) {
    return { ok: false, reason: '"git var -l" prints the whole configuration and is not allowed here.' };
  }

  const subverbs = MUTATING_SUBVERBS[sub];
  if (subverbs) {
    const first = rest.find(token => !isOption(token));
    if (first && subverbs.has(first)) {
      return { ok: false, reason: `"git ${sub} ${first}" changes the repository and is not allowed here.` };
    }
  }

  const listing = LISTING_ONLY[sub];
  if (listing) {
    const first = rest.find(token => !isOption(token));
    if (!first || !listing.has(first)) {
      return { ok: false, reason: `"git ${sub}" only reads here as "${[...listing].map(verb => `${sub} ${verb}`).join('" or "')}".` };
    }
  }

  // `-l` / `--list` and any filter option put branch/tag into listing mode,
  // where a trailing argument is a name pattern; without one, a trailing
  // argument means "create this ref".
  const FILTERS = ['-l', '--list', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at'];
  const VALUE_OPTS = new Set(['--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--sort', '--color', '--column', '-n']);

  if (sub === 'branch') {
    for (const token of rest) if (BRANCH_WRITE.has(bareName(token))) {
      return { ok: false, reason: `"git branch ${bareName(token)}" creates, deletes or moves a branch and is not allowed here.` };
    }
    const inListMode = rest.some(token => FILTERS.includes(bareName(token)));
    if (countPositionals(rest, VALUE_OPTS) > 0 && !inListMode) {
      return { ok: false, reason: 'Give "git branch" a name only with -l to match it — a bare name would create a branch.' };
    }
  }

  if (sub === 'tag') {
    for (const token of rest) if (TAG_WRITE.has(bareName(token))) {
      return { ok: false, reason: `"git tag ${bareName(token)}" writes a tag and is not allowed here.` };
    }
    const inListMode = rest.some(token => FILTERS.includes(bareName(token)) || /^-n\d*$/.test(token));
    if (countPositionals(rest, VALUE_OPTS) > 0 && !inListMode) {
      return { ok: false, reason: 'Give "git tag" a name only with -l to match it — a bare name would create a tag.' };
    }
  }

  if (sub === 'symbolic-ref') {
    if (rest.some(token => ['-d', '--delete'].includes(token))) return { ok: false, reason: '"git symbolic-ref -d" deletes a ref and is not allowed here.' };
    if (countPositionals(rest, new Set()) >= 2) return { ok: false, reason: '"git symbolic-ref <name> <ref>" writes a ref and is not allowed here.' };
  }

  return { ok: true };
}

// Count positional (non-option) tokens, skipping the value that follows an
// option which takes one (`--points-at HEAD`). Options using `=` carry their
// own value and never consume the next token.
function countPositionals(tokens, optionsWithValue) {
  let count = 0;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '--') { count += tokens.length - i - 1; break; }
    if (isOption(token)) {
      if (!token.includes('=') && optionsWithValue.has(token)) i++;
      continue;
    }
    count++;
  }
  return count;
}
