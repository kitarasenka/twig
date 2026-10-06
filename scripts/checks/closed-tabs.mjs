import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { CLOSED_TABS_KEY, readClosedTabs, startRepositoryId, writeClosedTabs } from '../../renderer/src/app/closed-tabs.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: key => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value); } };
}

// Round trip, sorted and stable.
const storage = memory();
writeClosedTabs(storage, new Set(['/b', '/a']));
assert.equal(storage.data[CLOSED_TABS_KEY], '["/a","/b"]');
assert.deepEqual([...readClosedTabs(storage)], ['/a', '/b']);
writeClosedTabs(storage, ['/c']);
assert.deepEqual([...readClosedTabs(storage)], ['/c']);

// Nothing stored, junk, wrong shapes, throwing storage — an empty set, never a throw.
assert.equal(readClosedTabs(memory()).size, 0);
assert.equal(readClosedTabs(null).size, 0);
assert.equal(readClosedTabs(memory({ [CLOSED_TABS_KEY]: '{not json' })).size, 0);
assert.equal(readClosedTabs(memory({ [CLOSED_TABS_KEY]: '{"a":1}' })).size, 0);
assert.deepEqual([...readClosedTabs(memory({ [CLOSED_TABS_KEY]: '["/a", 3, "", null]' }))], ['/a']);
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
assert.equal(readClosedTabs(broken).size, 0);
assert.doesNotThrow(() => writeClosedTabs(broken, new Set(['/a'])));

// Start tab: the remembered one while open, else the first open, else none.
const repos = [{ id: '/demo', sandbox: true }, { id: '/a' }, { id: '/b' }];
assert.equal(startRepositoryId(repos, '/b', new Set()), '/b');
assert.equal(startRepositoryId(repos, '/b', new Set(['/b'])), '/demo');
assert.equal(startRepositoryId(repos.slice(1), '/b', new Set(['/b'])), '/a');
assert.equal(startRepositoryId(repos.slice(1), '/a', new Set(['/a', '/b'])), null);
assert.equal(startRepositoryId(repos, null, new Set()), '/demo');
assert.equal(startRepositoryId([], '/a', new Set()), null);
assert.equal(startRepositoryId(null, '/a', new Set()), null);

// Wiring: App reads the set at startup, writes it back, and the tab strip hides its scrollbar.
const app = await read('renderer/src/app/App.jsx');
assert.match(app, /useState\(\(\) => \{ try \{ return readClosedTabs\(localStorage\)/);
assert.match(app, /startRepositoryId\(initialWorkspace\.repositories, initialWorkspace\.activeId, closed\)/);
assert.match(app, /writeClosedTabs\(localStorage,/);
const layout = await read('renderer/src/ui/layout.css');
assert.match(layout, /\.tabs \{[^}]*scrollbar-width: none/);
assert.match(layout, /\.tabs::-webkit-scrollbar \{ display: none; \}/);

console.log('closed-tabs: ok');
