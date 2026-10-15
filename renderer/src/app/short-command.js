/**
 * The console's "Short" view of a command: what a person would type, without
 * the plumbing 🌱 Twig adds to every git call so its output stays parseable.
 * Full shows the exact argv; Short is only a way of reading it, never what runs
 * or what is copied. No imports: Vite and the Node check both load it.
 */

export const COMMAND_VIEW_KEY = 'twig:console-commands';
export const PATH_VIEW_KEY = 'twig:console-path';

// Flags that only shape output for the parser or keep the user's config out of
// it. Dropping them does not change what the command does to the repository.
const PLUMBING = new Set([
  '--no-pager', '-z', '--no-color', '--color=never', '--no-ext-diff', '--no-textconv',
  '--no-show-signature', '--src-prefix=a/', '--dst-prefix=b/', '--progress',
]);
const LONG_FORMAT = /^(--format=|--pretty=(format|tformat):)/;
const FORMAT_LIMIT = 16;
const FULL_OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** argv after the executable → the short form, as an argv. */
export function shortArgv(argv) {
  if (!Array.isArray(argv)) return [];
  const out = [];
  let index = 0;
  // Global options before the subcommand: `-c key=value` pairs and --no-pager.
  while (index < argv.length) {
    if (argv[index] === '--no-pager') { index += 1; continue; }
    if (argv[index] === '-c' && index + 1 < argv.length) { index += 2; continue; }
    break;
  }
  for (; index < argv.length; index += 1) {
    const word = String(argv[index]);
    if (PLUMBING.has(word)) continue;
    // `--` only matters when what follows could be read as an option.
    if (word === '--') {
      const next = argv[index + 1];
      if (typeof next === 'string' && next.startsWith('-')) out.push(word);
      continue;
    }
    if (word.startsWith(':(literal)')) { out.push(word.slice(10)); continue; }
    // A full object id reads like git's own short form; the hover has it whole.
    if (FULL_OID.test(word)) { out.push(word.slice(0, 7)); continue; }
    if (LONG_FORMAT.test(word) && word.length > FORMAT_LIMIT) { out.push(`${word.slice(0, word.indexOf('=') + 1)}…`); continue; }
    out.push(word);
  }
  return out;
}

/** `git status` (short) or the exact `git --no-pager -c … status` (full), without a prompt. */
export function commandWords(entry, short) {
  const argv = Array.isArray(entry?.argv) ? entry.argv : [];
  const executable = entry?.executable || 'git';
  // Only git calls carry the plumbing; an automation's own command is shown as typed.
  const words = short && !entry?.executable ? shortArgv(argv) : argv;
  return `${executable} ${words.join(' ')}`;
}

/** `$ git status`: the form Copy entry and the hover use. */
export function commandLine(entry, short) { return `$ ${commandWords(entry, short)}`; }

export function readCommandView(storage) {
  try { return storage?.getItem(COMMAND_VIEW_KEY) === 'full' ? 'full' : 'short'; } catch { return 'short'; }
}

export function writeCommandView(storage, view) {
  try { storage?.setItem(COMMAND_VIEW_KEY, view === 'full' ? 'full' : 'short'); } catch { /* Session-local if storage is unavailable. */ }
}

/** Whether each line names the folder it ran in. Off by default: the hover and Copy entry still have it. */
export function readPathView(storage) {
  try { return storage?.getItem(PATH_VIEW_KEY) === 'show'; } catch { return false; }
}

export function writePathView(storage, show) {
  try { storage?.setItem(PATH_VIEW_KEY, show ? 'show' : 'hide'); } catch { /* Session-local if storage is unavailable. */ }
}
