/**
 * How diffs are shown: line by line or word by word, with or without syntax
 * colours. Remembered like the theme (`localStorage`, try/catch around every
 * access), and announced with one window event so every diff on screen — the
 * commit panel, stashes, blame, staging — switches together.
 *
 * No imports: the Node self-check loads this with a fake storage.
 */
export const DIFF_PREFS_EVENT = 'twig:diff-prefs';
const MODE_KEY = 'twig:diff-mode';
const SYNTAX_KEY = 'twig:syntax';

/** @returns {{ mode: 'lines' | 'words', syntax: boolean }} */
export function readDiffPrefs(storage) {
  let mode = 'lines';
  let syntax = true;
  try { if (storage?.getItem(MODE_KEY) === 'words') mode = 'words'; } catch { /* storage unavailable */ }
  try { if (storage?.getItem(SYNTAX_KEY) === 'off') syntax = false; } catch { /* storage unavailable */ }
  return { mode, syntax };
}

/** Saves what changed; a storage that refuses keeps the choice for this session only. */
export function writeDiffPrefs(storage, next) {
  try {
    if (next.mode !== undefined) storage?.setItem(MODE_KEY, next.mode === 'words' ? 'words' : 'lines');
    if (next.syntax !== undefined) storage?.setItem(SYNTAX_KEY, next.syntax ? 'on' : 'off');
  } catch { /* private mode */ }
}
