// The console's copy of the journal, kept up to date from main's events.
//
// Every git process sends at least three events (start, its output, finish),
// and one refresh runs a few dozen processes. Applying each event on its own
// meant copying the whole entry list and re-rendering the window for every one
// of them; the app now collects the events that arrive together and applies
// them in one pass. No imports: Vite and the Node check both load this module.

/** As many entries as main keeps in its journal. */
export const CONSOLE_LIMIT = 2000;

/** How long events gather before they reach the screen; short enough to read as live. */
export const CONSOLE_FLUSH_MS = 40;

/**
 * Applies a batch of journal events in order: one copy of the list, one pass
 * over the events. Entries are replaced, never mutated, so a row that did not
 * change keeps its identity.
 * @param {object[]} entries
 * @param {{ type: 'start'|'output'|'finish', id?: string, entry?: object, stream?: string, chunk?: string, result?: object }[]} updates
 */
export function applyConsoleUpdates(entries, updates) {
  if (!updates.length) return entries;
  let next = entries.slice();
  let index = null;
  const position = id => {
    if (!index) { index = new Map(); next.forEach((entry, at) => index.set(entry.id, at)); }
    return index.get(id);
  };
  for (const update of updates) {
    if (update.type === 'start') {
      next.push({ ...update.entry, stdout: '', stderr: '', state: 'running', code: null, ms: null });
      index?.set(update.entry.id, next.length - 1);
      continue;
    }
    if (update.type !== 'output' && update.type !== 'finish') continue;
    const at = position(update.id);
    if (at === undefined) continue;
    const entry = next[at];
    next[at] = update.type === 'output'
      ? { ...entry, [update.stream]: entry[update.stream] + update.chunk }
      : { ...entry, ...update.result, state: 'finished' };
  }
  if (next.length > CONSOLE_LIMIT) next = next.slice(-CONSOLE_LIMIT);
  return next;
}

// Terminal escape sequences — colours (CSI) and titles or links (OSC) — as
// they reach the console from a person's `color.diff = always`, a typed
// `--color`, or a server's coloured `remote:` lines. Built from a char code so
// no control character sits in the source.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const TERMINAL_CODES = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}`, 'g');

/** Output as the console shows and copies it: the text, without the escape codes around it. */
export function plainText(text) {
  return typeof text === 'string' && text.includes(ESC) ? text.replace(TERMINAL_CODES, '') : text;
}
