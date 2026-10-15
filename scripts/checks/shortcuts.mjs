import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SHORTCUTS, SHORTCUTS_KEY, bindings, comboFromEvent, formatCombo, isMenuKey, loadShortcuts, matchesShortcut, normalizeCombo,
  resetAllShortcuts, resetShortcut, setShortcut, shortcut, shortcutProblem, subscribeShortcuts,
} from '../../renderer/src/app/shortcuts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const memory = (initial = {}) => { const map = new Map(Object.entries(initial)); return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };
const key = (code, keyValue, mods = {}) => ({ code, key: keyValue, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

// Every action is unique, has a valid default, and the defaults do not clash.
assert.equal(new Set(SHORTCUTS.map(item => item.id)).size, SHORTCUTS.length);
assert.equal(new Set(SHORTCUTS.map(item => item.default)).size, SHORTCUTS.length, 'no two defaults share a key');
for (const item of SHORTCUTS) assert.equal(normalizeCombo(item.default), item.default, `${item.id} default is normalized`);

// Events → combos: Mod is Cmd on macOS, Ctrl elsewhere; the physical key wins over the typed character.
assert.equal(comboFromEvent(key('KeyJ', 'j', { metaKey: true }), true), 'Mod+J');
assert.equal(comboFromEvent(key('KeyJ', 'о', { metaKey: true }), true), 'Mod+J', 'a Russian layout still presses J');
assert.equal(comboFromEvent(key('KeyJ', 'j', { ctrlKey: true }), false), 'Mod+J');
assert.equal(comboFromEvent(key('KeyJ', 'j', { ctrlKey: true }), true), 'Ctrl+J', 'Ctrl is its own key on a Mac');
assert.equal(comboFromEvent(key('KeyD', '∂', { altKey: true }), true), 'Alt+D', 'Option+D types ∂ and is still Alt+D');
assert.equal(comboFromEvent(key('KeyZ', 'Z', { metaKey: true, shiftKey: true }), true), 'Mod+Shift+Z');
assert.equal(comboFromEvent(key('Comma', ',', { metaKey: true }), true), 'Mod+,');
assert.equal(comboFromEvent(key('BracketLeft', '{', { shiftKey: true }), true), 'Shift+[');
assert.equal(comboFromEvent(key('F10', 'F10', { shiftKey: true }), true), 'Shift+F10');
assert.equal(comboFromEvent(key('ArrowUp', 'ArrowUp', { altKey: true }), true), 'Alt+ArrowUp');
assert.equal(comboFromEvent(key('Enter', 'Enter', { altKey: true }), true), 'Alt+Enter');
assert.equal(comboFromEvent(key('MetaLeft', 'Meta', { metaKey: true }), true), null, 'a lone modifier is not a combo');
assert.equal(comboFromEvent(key('', 'Dead'), true), null);
assert.equal(normalizeCombo('Shift+Mod+z'), 'Mod+Shift+Z', 'a letter is stored upper case');
assert.equal(normalizeCombo('Shift+Mod+Z'), 'Mod+Shift+Z');
assert.equal(normalizeCombo('Mod+Mod+Z'), null);
assert.equal(normalizeCombo('Hyper+Z'), null);
assert.equal(formatCombo('Mod+Shift+Z', true), 'Cmd+Shift+Z');
assert.equal(formatCombo('Mod+Shift+Z', false), 'Ctrl+Shift+Z');
assert.equal(formatCombo('Alt+ArrowUp', true), 'Option+↑');
assert.equal(formatCombo('Alt+ArrowUp', false), 'Alt+↑');

// Defaults answer as before.
loadShortcuts(memory());
assert.ok(matchesShortcut(key('KeyJ', 'j', { metaKey: true }), 'console', true));
assert.ok(!matchesShortcut(key('KeyJ', 'j', { metaKey: true, shiftKey: true }), 'console', true));
assert.ok(matchesShortcut(key('KeyZ', 'z', { ctrlKey: true }), 'undo', false));
assert.ok(matchesShortcut(key('KeyZ', 'Z', { ctrlKey: true, shiftKey: true }), 'redo', false));
assert.ok(!matchesShortcut(key('KeyZ', 'Z', { ctrlKey: true, shiftKey: true }), 'undo', false), 'redo is not also undo');
assert.ok(isMenuKey(key('F10', 'F10', { shiftKey: true }), true));
assert.ok(isMenuKey(key('ContextMenu', 'ContextMenu'), true), 'the menu key always works');
assert.ok(!isMenuKey(key('F10', 'F10'), true));
assert.ok(matchesShortcut(key('F2', 'F2'), 'rename', true));
assert.ok(!matchesShortcut(key('F2', 'F2', { altKey: true }), 'rename', true));
assert.ok(matchesShortcut(key('BracketLeft', '['), 'blameBefore', true));

// Rebinding: stored as a change only, applied at once, heard by Settings.
const storage = memory();
loadShortcuts(storage);
let heard = null;
const stop = subscribeShortcuts(next => { heard = next; });
assert.deepEqual(setShortcut('console', 'Mod+Shift+K', storage, true), { ok: true });
assert.equal(heard.console, 'Mod+Shift+K');
assert.deepEqual(JSON.parse(storage.getItem(SHORTCUTS_KEY)), { console: 'Mod+Shift+K' });
assert.ok(matchesShortcut(key('KeyK', 'K', { metaKey: true, shiftKey: true }), 'console', true));
assert.ok(!matchesShortcut(key('KeyJ', 'j', { metaKey: true }), 'console', true), 'the old key is free');
// Survives a restart.
loadShortcuts(storage);
assert.equal(shortcut('console'), 'Mod+Shift+K');

// Refusals, each with its reason; nothing changes.
const refuse = (id, combo, pattern) => {
  const before = bindings();
  const result = setShortcut(id, combo, storage, true);
  assert.equal(result.ok, false, `${combo} for ${id} is refused`);
  assert.match(result.reason, pattern);
  assert.deepEqual(bindings(), before);
  return result;
};
assert.equal(refuse('console', 'Mod+Z', /already “Undo the last action”/).conflict, 'undo');
refuse('console', 'K', /type into text fields/);
refuse('console', 'Shift+K', /type into text fields/);
refuse('menu', 'ArrowDown', /moves through lists/);
refuse('menu', 'Shift+ArrowDown', /moves through lists/);
refuse('menu', 'Escape', /Esc/);
refuse('menu', 'Alt+Tab', /Tab/);
refuse('search', 'Mod+C', /copies/);
refuse('search', 'Mod+R', /reloads/);
refuse('search', 'nonsense+', /Press a key/);
assert.ok(shortcutProblem('nope', 'Mod+K').reason);
// A function key is fine for a global action; a bare letter is fine where the list has focus.
assert.deepEqual(setShortcut('search', 'F6', storage, true), { ok: true });
assert.deepEqual(setShortcut('blameBefore', 'B', storage, true), { ok: true });
assert.ok(matchesShortcut(key('KeyB', 'b'), 'blameBefore', true));
// Re-binding to the default stores nothing for it.
assert.deepEqual(setShortcut('search', 'Mod+F', storage, true), { ok: true });
assert.equal(JSON.parse(storage.getItem(SHORTCUTS_KEY)).search, undefined);

// Reset: refused while another action holds the default, then fine.
assert.deepEqual(setShortcut('settings', 'Mod+J', storage, true), { ok: true });
const blocked = resetShortcut('console', storage, true);
assert.equal(blocked.ok, false);
assert.equal(blocked.conflict, 'settings');
assert.deepEqual(resetShortcut('settings', storage, true), { ok: true });
assert.deepEqual(resetShortcut('console', storage, true), { ok: true });
resetAllShortcuts(storage);
assert.deepEqual(JSON.parse(storage.getItem(SHORTCUTS_KEY)), {});
assert.deepEqual(bindings(), Object.fromEntries(SHORTCUTS.map(item => [item.id, item.default])));
stop();

// A hand-edited or broken store cannot break the keys.
loadShortcuts(memory({ [SHORTCUTS_KEY]: '{not json' }));
assert.equal(shortcut('console'), 'Mod+J');
loadShortcuts(memory({ [SHORTCUTS_KEY]: JSON.stringify({ console: 'Mod+Z', unknown: 'Mod+K', search: 42, redo: 'Mod+K' }) }));
assert.equal(shortcut('console'), 'Mod+J', 'a change that took Undo’s key is dropped');
assert.equal(shortcut('undo'), 'Mod+Z');
const loaded = bindings();
assert.equal(new Set(Object.values(loaded)).size, SHORTCUTS.length, 'a clash in the file is undone at load');
assert.equal(loaded.search, 'Mod+F');
assert.equal(loaded.redo, 'Mod+K');
const throwing = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
loadShortcuts(throwing);
assert.equal(shortcut('console'), 'Mod+J');
assert.deepEqual(setShortcut('console', 'Mod+Shift+K', throwing, true), { ok: true }, 'works for the session without storage');
resetAllShortcuts(throwing);

// No key handler reads raw modifier checks any more, and no key is printed in the UI.
const files = ['renderer/src/app/App.jsx', 'renderer/src/app/Console.jsx', 'renderer/src/features/graph/HistoryWorkspace.jsx',
  'renderer/src/features/graph/CommitGraph.jsx', 'renderer/src/features/graph/useGitDrag.js', 'renderer/src/features/commit/CommitPanel.jsx',
  'renderer/src/features/worktree/WorktreeScreen.jsx', 'renderer/src/features/worktree/WorktreePanel.jsx',
  'renderer/src/features/automations/PipelineEditor.jsx', 'renderer/src/features/rebase/RebaseDialog.jsx',
  'renderer/src/features/conflicts/ConflictEditor.jsx', 'renderer/src/features/blame/BlameView.jsx', 'renderer/src/ui/Dialog.jsx',
  'renderer/src/features/refs/ref-menu.js'];
for (const file of files) {
  const source = await readFile(path.join(root, file), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/<kbd/.test(code), `${file} prints no key`);
  assert.ok(!/(Cmd|Ctrl|Alt|Shift)\+[A-Z0-9,[]|Shift\+F10|F2 to|· Esc/.test(code), `${file} names no key in its text`);
  assert.ok(!/event\.key === 'F2'|event\.key === 'F10'|(?<!!)\be\.altKey &&|(?<!!)event\.altKey &&|\(event\.metaKey \|\| event\.ctrlKey\)/.test(code), `${file} asks shortcuts.js which key it is`);
}

console.log('Keyboard shortcuts passed: combos from events, defaults, rebinding, refusals and clashes, reset, broken storage, no keys in the UI.');
