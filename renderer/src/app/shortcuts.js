/**
 * Keyboard shortcuts: every rebindable action, the key that triggers it, and
 * the person's changes, kept in localStorage. Handlers ask `matchesShortcut`
 * at the moment of the key press, so a change in Settings applies at once
 * without re-rendering anything. No imports: Vite and the Node check load it.
 *
 * A combo is a string like `Mod+Shift+Z`. `Mod` is Cmd on macOS and Ctrl
 * elsewhere, so one stored value means the same key on every platform. Keys
 * come from the physical key (`event.code`) where there is one: Alt+D on a Mac
 * types "∂", and Cmd+J on a Russian layout reports "о".
 */

export const SHORTCUTS_KEY = 'twig:shortcuts';

// `global` actions fire anywhere in the window, so they need a modifier (or a
// function key): a bare letter would be taken from the person typing in a field.
export const SHORTCUTS = [
  { id: 'console', group: 'Window', label: 'Show or hide the console', default: 'Mod+J', global: true },
  { id: 'settings', group: 'Window', label: 'Open Settings', default: 'Mod+,', global: true },
  { id: 'newTab', group: 'Window', label: 'New repository tab', default: 'Mod+T', global: true },
  { id: 'closeTab', group: 'Window', label: 'Close the tab', default: 'Mod+W', global: true },
  { id: 'search', group: 'Window', label: 'Search branches and commits', default: 'Mod+F', global: true },
  { id: 'undo', group: 'Actions', label: 'Undo the last action', default: 'Mod+Z', global: true },
  { id: 'redo', group: 'Actions', label: 'Redo', default: 'Mod+Shift+Z', global: true },
  { id: 'menu', group: 'Lists', label: 'Open the menu of the focused row', default: 'Shift+F10' },
  { id: 'rename', group: 'Lists', label: 'Rename the focused branch', default: 'F2' },
  { id: 'moveUp', group: 'Lists', label: 'Move a rebase step or automation action up', default: 'Alt+ArrowUp' },
  { id: 'moveDown', group: 'Lists', label: 'Move a rebase step or automation action down', default: 'Alt+ArrowDown' },
  { id: 'pickUp', group: 'Drag and drop', label: 'Pick up the focused branch or commit', default: 'Alt+D' },
  { id: 'drop', group: 'Drag and drop', label: 'Drop on the focused branch or commit', default: 'Alt+Enter' },
  { id: 'blameBefore', group: 'Blame', label: 'Blame the version before the selected line’s change', default: '[' },
];

const BY_ID = new Map(SHORTCUTS.map(item => [item.id, item]));
const MODIFIERS = ['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'];
const CODE_KEYS = {
  Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: '\'', BracketLeft: '[',
  BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space',
};
// Keys that move through lists and fields; alone or with Shift they stay theirs.
const NAVIGATION = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown',
  'Enter', 'Space', 'Backspace', 'Delete']);
// Copy, paste, select all, and what the system menu already answers to.
const RESERVED = new Map([
  ['Mod+C', 'copies'], ['Mod+V', 'pastes'], ['Mod+X', 'cuts'], ['Mod+A', 'selects all'], ['Mod+Q', 'quits 🌱 Twig'],
  ['Mod+H', 'hides the window'], ['Mod+M', 'minimises the window'], ['Mod+R', 'reloads the window'],
  ['Mod+0', 'resets the zoom'], ['Mod+=', 'zooms in'], ['Mod+Shift+=', 'zooms in'], ['Mod+-', 'zooms out'],
]);

export function isMac() { return /Mac/.test(globalThis.navigator?.platform || ''); }

function keyName(event) {
  const code = typeof event.code === 'string' ? event.code : '';
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (CODE_KEYS[code]) return CODE_KEYS[code];
  const key = event.key;
  if (typeof key !== 'string' || !key || key === 'Unidentified' || key === 'Dead') return null;
  if (key === ' ') return 'Space';
  if (key === '+') return 'Plus';
  return key.length === 1 ? key.toUpperCase() : key;
}

/** The combo a key press makes, or null for a lone modifier. */
export function comboFromEvent(event, mac = isMac()) {
  if (!event || ['Meta', 'Control', 'Alt', 'Shift', 'OS', 'AltGraph', 'CapsLock'].includes(event.key)) return null;
  const key = keyName(event);
  if (!key) return null;
  const parts = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (mac && event.ctrlKey) parts.push('Ctrl');
  if (!mac && event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return [...parts, key].join('+');
}

function parse(combo) {
  if (typeof combo !== 'string' || !combo) return null;
  const parts = combo.split('+');
  const last = parts.pop();
  const key = last?.length === 1 ? last.toUpperCase() : last;
  if (!key || MODIFIERS.includes(key) || parts.some(part => !MODIFIERS.includes(part))) return null;
  if (new Set(parts).size !== parts.length) return null;
  return { modifiers: parts, key };
}

/** Modifiers in the one order comboFromEvent writes them. */
export function normalizeCombo(combo) {
  const parsed = parse(combo);
  if (!parsed) return null;
  return [...MODIFIERS.filter(name => parsed.modifiers.includes(name)), parsed.key].join('+');
}

const ARROWS = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
/** `Mod+Shift+Z` → `Cmd+Shift+Z` on macOS, `Ctrl+Shift+Z` elsewhere. */
export function formatCombo(combo, mac = isMac()) {
  const parsed = parse(combo);
  if (!parsed) return '';
  const names = { Mod: mac ? 'Cmd' : 'Ctrl', Ctrl: 'Ctrl', Meta: 'Win', Alt: mac ? 'Option' : 'Alt', Shift: 'Shift' };
  return [...parsed.modifiers.map(name => names[name]), ARROWS[parsed.key] || parsed.key].join('+');
}

let overrides = null;
const listeners = new Set();

function readStored(storage) {
  let raw = null;
  try { raw = JSON.parse(storage?.getItem(SHORTCUTS_KEY) || 'null'); } catch { raw = null; }
  const result = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  for (const [id, combo] of Object.entries(raw)) {
    const normal = BY_ID.has(id) ? normalizeCombo(combo) : null;
    if (normal && normal !== BY_ID.get(id).default) result[id] = normal;
  }
  return result;
}

/** Reads the stored changes; the window does it on first use, a check passes its own storage. */
export function loadShortcuts(storage = globalThis.localStorage) {
  overrides = readStored(storage);
  // A change that lands on a key some other action also has (an edited file,
  // a newer default) is dropped: defaults never clash, so this always settles.
  for (let clashed = true; clashed;) {
    clashed = false;
    const count = new Map();
    for (const item of SHORTCUTS) { const combo = overrides[item.id] || item.default; count.set(combo, (count.get(combo) || 0) + 1); }
    for (const id of Object.keys(overrides)) if (count.get(overrides[id]) > 1) { delete overrides[id]; clashed = true; }
  }
  return bindings();
}

function ensure() { if (!overrides) loadShortcuts(); }

export function shortcut(id) {
  ensure();
  return overrides[id] || BY_ID.get(id)?.default || null;
}

export function bindings() {
  ensure();
  return Object.fromEntries(SHORTCUTS.map(item => [item.id, shortcut(item.id)]));
}

export function matchesShortcut(event, id, mac = isMac()) {
  const combo = shortcut(id);
  return Boolean(combo) && comboFromEvent(event, mac) === combo;
}

/** The menu key always opens a menu; the rebindable combo is the other way in. */
export function isMenuKey(event, mac = isMac()) {
  return event?.key === 'ContextMenu' || matchesShortcut(event, 'menu', mac);
}

/** Why `combo` cannot be used for `id`, or null. A clash names the other action. */
export function shortcutProblem(id, combo, mac = isMac()) {
  const item = BY_ID.get(id);
  const parsed = parse(combo);
  if (!item || !parsed) return { reason: 'Press a key, with or without modifiers.' };
  const normal = normalizeCombo(combo);
  const plain = parsed.modifiers.every(name => name === 'Shift');
  if (parsed.key === 'Escape') return { reason: 'Esc closes dialogs and menus and cancels a drag.' };
  if (parsed.key === 'Tab') return { reason: 'Tab moves between controls.' };
  if (plain && NAVIGATION.has(parsed.key)) return { reason: `${formatCombo(normal, mac)} moves through lists and text.` };
  if (item.global && plain && !/^F([1-9]|1[0-9]|2[0-4])$/.test(parsed.key)) {
    return { reason: `Add ${mac ? 'Cmd, Ctrl or Option' : 'Ctrl or Alt'}: on its own this key would type into text fields.` };
  }
  if (RESERVED.has(normal)) return { reason: `${formatCombo(normal, mac)} already ${RESERVED.get(normal)}.` };
  const other = SHORTCUTS.find(entry => entry.id !== id && shortcut(entry.id) === normal);
  if (other) return { reason: `${formatCombo(normal, mac)} is already “${other.label}”.`, conflict: other.id };
  return null;
}

function save(storage) {
  try { storage?.setItem(SHORTCUTS_KEY, JSON.stringify(overrides)); } catch { /* Session-local if storage is unavailable. */ }
  const snapshot = bindings();
  for (const listener of listeners) listener(snapshot);
}

/** Binds `combo` to `id`; refuses with the reason shortcutProblem gives. */
export function setShortcut(id, combo, storage = globalThis.localStorage, mac = isMac()) {
  ensure();
  const problem = shortcutProblem(id, combo, mac);
  if (problem) return { ok: false, ...problem };
  const normal = normalizeCombo(combo);
  if (normal === BY_ID.get(id).default) delete overrides[id]; else overrides[id] = normal;
  save(storage);
  return { ok: true };
}

/** Back to the default; refused when another action has taken that key since. */
export function resetShortcut(id, storage = globalThis.localStorage, mac = isMac()) {
  const item = BY_ID.get(id);
  if (!item) return { ok: false, reason: 'Unknown shortcut.' };
  return setShortcut(id, item.default, storage, mac);
}

export function resetAllShortcuts(storage = globalThis.localStorage) {
  overrides = {};
  save(storage);
  return bindings();
}

export function subscribeShortcuts(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
