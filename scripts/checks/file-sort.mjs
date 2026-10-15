import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FILE_SORTS, compareFiles, fileExtension } from '../../renderer/src/features/commit/file-sort.js';

assert.equal(fileExtension('src/app.test.js'), 'js', 'the last dot counts');
assert.equal(fileExtension('README.MD'), 'md', 'case does not split a type');
assert.equal(fileExtension('Makefile'), '');
assert.equal(fileExtension('.gitignore'), '', 'a leading dot is part of the name');
assert.equal(fileExtension('.github/workflows/deploy.yml'), 'yml', 'a dotted folder is not the extension');
assert.equal(fileExtension('v1.2/notes'), '', 'a dot in a folder is not the extension');
assert.equal(fileExtension('trailing.'), '');

const files = ['src/b.ts', 'Makefile', 'docs/a.md', 'src/a.ts', '.gitignore', 'README.MD', 'z.js']
  .map((path, index) => ({ path, status: 'MAD'[index % 3] }));
const order = sort => files.slice().sort(compareFiles(sort)).map(file => file.path);

assert.deepEqual(order('extension'), ['z.js', 'docs/a.md', 'README.MD', 'src/a.ts', 'src/b.ts', '.gitignore', 'Makefile'],
  'types alphabetically, path inside a type, no extension last');
assert.deepEqual(order('path'), ['.gitignore', 'docs/a.md', 'Makefile', 'README.MD', 'src/a.ts', 'src/b.ts', 'z.js']);
assert.deepEqual(order('status'), ['.gitignore', 'Makefile', 'docs/a.md', 'README.MD', 'src/a.ts', 'src/b.ts', 'z.js'], 'status, then path');
assert.deepEqual(order('unknown'), order('path'), 'an unknown sort falls back to the path');

assert.deepEqual(FILE_SORTS.map(option => option.value), ['path', 'status', 'extension']);
const panel = await readFile(new URL('../../renderer/src/features/commit/CommitPanel.jsx', import.meta.url), 'utf8');
assert.match(panel, /FILE_SORTS\.map/, 'the select offers every sort');
assert.match(panel, /compareFiles\(sort\)/, 'the list uses the shared order');

console.log('file-sort: ok');
