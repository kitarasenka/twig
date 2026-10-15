import assert from 'node:assert/strict';
import { ALL_TYPES, NO_EXTENSION, baseName, buildFileTree, extensionOf, extensionOptions, matchesFile, readFileView, writeFileView } from '../../renderer/src/features/diff/file-filter.js';

// Extensions: the last name only, lower-cased, a leading dot names the file.
assert.equal(extensionOf('src/App.JSX'), '.jsx');
assert.equal(extensionOf('a/b.test.ts'), '.ts');
assert.equal(extensionOf('Makefile'), NO_EXTENSION);
assert.equal(extensionOf('.gitignore'), NO_EXTENSION);
assert.equal(extensionOf('config/.env'), NO_EXTENSION);
assert.equal(extensionOf('v1.2/readme'), NO_EXTENSION, 'a dot in a folder is not the file type');
assert.equal(extensionOf('trailing.'), NO_EXTENSION);

// Choices: counted, most common first, no extension last, ties by name.
const paths = ['a.ts', 'b.ts', 'c.TS', 'd.md', 'e.css', 'Makefile', '.gitignore'];
assert.deepEqual(extensionOptions(paths).map(option => option.label), ['.ts (3)', '.css (1)', '.md (1)', 'No extension (2)']);
assert.deepEqual(extensionOptions(paths, '.py').find(option => option.value === '.py'), { value: '.py', count: 0, label: '.py (0)' },
  'a chosen type that left the lists stays listed');
assert.equal(extensionOptions(paths, ALL_TYPES).length, 4);
assert.deepEqual(extensionOptions([]), []);

// Matching: text anywhere in the path, any case, and the type.
assert.ok(matchesFile('src/App.jsx', '', ALL_TYPES));
assert.ok(matchesFile('src/App.jsx', ' app ', '.jsx'));
assert.ok(!matchesFile('src/App.jsx', '', '.js'), '.js is not .jsx');
assert.ok(!matchesFile('src/App.jsx', 'nope', ALL_TYPES));
assert.ok(matchesFile('Makefile', '', NO_EXTENSION));

// The tree: nested folders, files in their order, root files at the root.
const tree = buildFileTree([{ path: 'b/x.js' }, { path: 'top.md' }, { path: 'a/deep/y.js' }, { path: 'b/a.js' }]);
assert.deepEqual([...tree.folders.keys()], ['b', 'a'], 'folders in first-seen order');
assert.deepEqual(tree.files.map(file => file.path), ['top.md']);
assert.deepEqual(tree.folders.get('b').files.map(file => file.path), ['b/x.js', 'b/a.js']);
assert.equal(tree.folders.get('a').folders.get('deep').files[0].path, 'a/deep/y.js');
assert.equal(baseName('a/deep/y.js'), 'y.js');

// The view choice: remembered, and a failing storage falls back to the path list.
const store = new Map();
const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
assert.equal(readFileView(storage), 'path');
writeFileView('tree', storage);
assert.equal(readFileView(storage), 'tree');
writeFileView('bogus', storage);
assert.equal(readFileView(storage), 'path');
const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
assert.equal(readFileView(broken), 'path');
assert.doesNotThrow(() => writeFileView('tree', broken));

console.log('File filter checks passed: extensions, type choices, matching, tree, remembered view.');
