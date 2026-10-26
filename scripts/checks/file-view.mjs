import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { MAX_TEXT_BYTES, loadTextPair, looksBinary, textSide } from '../../main/git/file-text.js';
import { annotatePatch } from '../../renderer/src/features/diff/intraline.js';
import {
  MAX_FILE_BYTES, changeStarts, changeSummary, changedLines, fileLines, stepChange, versionLabels, versionProblem
} from '../../renderer/src/features/diff/file-view.js';

// The whole-file view: both versions of a file as text, and which of their
// lines a diff touches.

// --- lines as an editor numbers them ---

assert.deepEqual(fileLines(''), [], 'an empty file has no lines');
assert.deepEqual(fileLines('a\nb\n'), ['a', 'b'], 'a trailing newline ends the last line');
assert.deepEqual(fileLines('a\nb'), ['a', 'b'], 'no newline at the end');
assert.deepEqual(fileLines('\n'), [''], 'one empty line');
assert.deepEqual(fileLines('a\r\nb\r\n'), ['a', 'b'], 'CRLF is not part of a line');
assert.deepEqual(fileLines('a\n\n\tb\n'), ['a', '', '\tb']);
assert.deepEqual(fileLines(null), []);
assert.equal(MAX_FILE_BYTES, MAX_TEXT_BYTES, 'the view names the limit main enforces');

// --- the lines a patch touches, on each side ---

const patch = [
  'diff --git a/f b/f', 'index 1..2 100644', '--- a/f', '+++ b/f',
  '@@ -1,4 +1,5 @@', ' one', '-two', '+TWO', '+two and a half', ' three', ' four',
  '@@ -10,3 +11,2 @@', ' ten', '-eleven', ' twelve', ''
].join('\n');
const rows = annotatePatch(patch);
assert.deepEqual([...changedLines(rows, 'new')].sort((a, b) => a - b), [2, 3], 'added lines, numbered on the new side');
assert.deepEqual([...changedLines(rows, 'old')].sort((a, b) => a - b), [2, 11], 'removed lines, numbered on the old side');
assert.equal(changedLines(annotatePatch(''), 'new').size, 0, 'no patch, nothing lit');
assert.deepEqual(changeStarts(new Set([2, 3, 7, 9, 10])), [2, 7, 9], 'each run of changed lines starts once');
assert.deepEqual(changeStarts(new Set()), []);
assert.equal(stepChange([2, 7, 9], 1, 1), 2);
assert.equal(stepChange([2, 7, 9], 2, 1), 7, 'next goes past the change in view');
assert.equal(stepChange([2, 7, 9], 9, 1), 2, 'and wraps after the last');
assert.equal(stepChange([2, 7, 9], 7, -1), 2);
assert.equal(stepChange([2, 7, 9], 2, -1), 9, 'previous wraps before the first');
assert.equal(stepChange([], 5, 1), null);

// --- words ---

const OID = 'a1b2c3d4'.repeat(5);
const BASE = 'f9e8d7c6'.repeat(5);
assert.deepEqual(versionLabels({ kind: 'commit', oid: OID, base: null }), { toggle: 'With this commit’s changes', after: 'at a1b2c3d4', before: 'before a1b2c3d4' });
assert.deepEqual(versionLabels({ kind: 'commit', oid: OID, base: BASE }), { toggle: 'With the compared changes', after: 'at a1b2c3d4', before: 'at f9e8d7c6' });
assert.equal(versionLabels({ kind: 'staged' }).before, 'at HEAD');
assert.equal(versionLabels({ kind: 'unstaged' }).after, 'on disk');
assert.equal(versionLabels({ kind: 'untracked' }).toggle, null, 'an untracked file has one version and no switch');
const commit = { kind: 'commit', oid: OID, base: null };
assert.equal(versionProblem({ state: 'ok', text: '' }, { source: commit, withChanges: true }), null);
assert.equal(versionProblem({ state: 'missing' }, { source: commit, withChanges: true }), 'This commit deletes the file.');
assert.equal(versionProblem({ state: 'missing' }, { source: commit, withChanges: false }), 'The file did not exist before this commit.');
assert.equal(versionProblem({ state: 'missing' }, { source: { ...commit, base: BASE }, withChanges: false }), 'The file did not exist at f9e8d7c6.');
assert.equal(versionProblem({ state: 'missing' }, { source: { kind: 'staged' }, withChanges: false }), 'HEAD has no version of this file: it is new.');
assert.match(versionProblem({ state: 'large', size: 6 * 1024 * 1024 }, { source: commit, withChanges: true }), /6 MB, too large to show here: .* up to 5 MB/);
assert.match(versionProblem({ state: 'binary', size: 4 }, { source: commit, withChanges: true }), /binary/);
assert.equal(changeSummary({ starts: [2, 7], withChanges: true, patched: true }), '2 changes');
assert.equal(changeSummary({ starts: [2], withChanges: true, patched: true }), '1 change');
assert.equal(changeSummary({ starts: [], withChanges: true, patched: true }), 'Only removes lines');
assert.equal(changeSummary({ starts: [], withChanges: false, patched: true }), 'Only adds lines');
assert.equal(changeSummary({ starts: [], withChanges: true, patched: false }), 'Unchanged here');

// --- text or not ---

assert.equal(looksBinary(Buffer.from('plain text\n')), false);
assert.equal(looksBinary(Buffer.from([0x50, 0, 0x4e])), true, 'a NUL marks a binary file, as Git decides');
assert.equal(looksBinary(Buffer.concat([Buffer.alloc(8000, 0x61), Buffer.from([0])])), false, 'only the first 8000 bytes are looked at');
assert.deepEqual(textSide({ state: 'ok', size: 3, bytes: Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]) }), { state: 'ok', size: 3, text: 'hi' }, 'a UTF-8 BOM is not text');
assert.equal(textSide({ state: 'ok', size: 2, bytes: Buffer.from([0x68, 0xff]) }).text, 'h�', 'bytes that are not UTF-8 read as U+FFFD');
assert.deepEqual(textSide({ state: 'large', size: 9 }), { state: 'large', size: 9 });
assert.deepEqual(textSide(undefined), { state: 'missing' });

// --- both versions from real Git ---

const root = await mkdtemp(path.join(tmpdir(), 'twig-file-view-'));
const repo = path.join(root, 'repo');
const log = new CommandLog(root);
try {
  await log.load();
  await mkdir(path.join(repo, 'src'), { recursive: true });
  const git = async (argv) => {
    const result = await runGit({ argv, cwd: repo, log, operation: 'Check setup' });
    assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const file = 'src/app one.js';
  const v1 = 'const a = 1;\nconst b = 2;\n';
  const v2 = 'const a = 1;\nconst b = 3;\nconst c = 4;\n';
  const v3 = 'const a = 10;\r\nconst b = 3;\r\n';
  await git(['init', '-q', '-b', 'main', '.']);
  await git(['config', 'user.email', 'check@example.invalid']);
  await git(['config', 'user.name', 'Twig Check']);
  await git(['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, file), v1);
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'add app']);
  const first = (await git(['rev-parse', 'HEAD'])).trim();
  await writeFile(path.join(repo, file), v2);
  await git(['commit', '-q', '-am', 'change app']);
  const second = (await git(['rev-parse', 'HEAD'])).trim();

  const added = await loadTextPair({ cwd: repo, log, file, source: { kind: 'commit', oid: first, base: null } });
  assert.deepEqual(added.old, { state: 'missing' }, 'before a root commit there is nothing');
  assert.deepEqual(added.new, { state: 'ok', size: v1.length, text: v1 });
  const changed = await loadTextPair({ cwd: repo, log, file, source: { kind: 'commit', oid: second, base: null } });
  assert.equal(changed.old.text, v1, 'before the commit: its first parent');
  assert.equal(changed.new.text, v2, 'with its changes: the commit');

  // The lines lit on each version are the ones the diff of that commit names.
  const diff = await git(['show', '--format=', '--first-parent', '--no-color', second, '--', file]);
  const lit = annotatePatch(diff);
  assert.deepEqual([...changedLines(lit, 'new')].map(line => fileLines(changed.new.text)[line - 1]), ['const b = 3;', 'const c = 4;']);
  assert.deepEqual([...changedLines(lit, 'old')].map(line => fileLines(changed.old.text)[line - 1]), ['const b = 2;']);

  // A merge commit: before is its first parent, as in the diff.
  await git(['checkout', '-q', '-b', 'side', first]);
  await writeFile(path.join(repo, 'side.txt'), 'side\n');
  await git(['add', 'side.txt']);
  await git(['commit', '-q', '-m', 'side']);
  await git(['checkout', '-q', 'main']);
  await git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
  const merge = (await git(['rev-parse', 'HEAD'])).trim();
  const merged = await loadTextPair({ cwd: repo, log, file: 'side.txt', source: { kind: 'commit', oid: merge, base: null } });
  assert.deepEqual(merged.old, { state: 'missing' }, 'not on the first parent');
  assert.equal(merged.new.text, 'side\n');
  const range = await loadTextPair({ cwd: repo, log, file, source: { kind: 'commit', oid: second, base: first } });
  assert.equal(range.old.text, v1, 'a compared range: the base');

  // Uncommitted: the index against HEAD, the disk against the index.
  await writeFile(path.join(repo, file), v3);
  await git(['add', file]);
  const v4 = `${v3}// on disk only\r\n`;
  await writeFile(path.join(repo, file), v4);
  const staged = await loadTextPair({ cwd: repo, log, file, source: { kind: 'staged' } });
  assert.equal(staged.old.text, v2, 'staged: HEAD before');
  assert.equal(staged.new.text, v3, 'staged: the index after, CRLF kept as stored');
  const unstaged = await loadTextPair({ cwd: repo, log, file, source: { kind: 'unstaged' } });
  assert.equal(unstaged.old.text, v3, 'unstaged: the index before');
  assert.equal(unstaged.new.text, v4, 'unstaged: the disk after');
  assert.deepEqual(fileLines(unstaged.new.text), ['const a = 10;', 'const b = 3;', '// on disk only']);

  await writeFile(path.join(repo, 'notes.md'), '# Notes\n');
  const untracked = await loadTextPair({ cwd: repo, log, file: 'notes.md', source: { kind: 'untracked' } });
  assert.deepEqual(untracked.old, { state: 'missing' });
  assert.equal(untracked.new.text, '# Notes\n');

  // Deleted by a commit: no "after", the "before" is still there to read.
  await git(['commit', '-q', '-am', 'crlf']);
  await git(['rm', '-q', '--', file]);
  await git(['commit', '-q', '-m', 'remove app']);
  const removed = await loadTextPair({ cwd: repo, log, file, source: { kind: 'commit', oid: (await git(['rev-parse', 'HEAD'])).trim(), base: null } });
  assert.deepEqual(removed.new, { state: 'missing' });
  assert.equal(removed.old.text, v4);

  // Binary, too large, a link on disk and a path out of the tree.
  await writeFile(path.join(repo, 'blob.bin'), Buffer.from([1, 0, 2, 0]));
  await git(['add', 'blob.bin']);
  assert.deepEqual((await loadTextPair({ cwd: repo, log, file: 'blob.bin', source: { kind: 'staged' } })).new, { state: 'binary', size: 4 });
  const huge = Buffer.alloc(MAX_TEXT_BYTES + 1, 0x61);
  await writeFile(path.join(repo, 'huge.txt'), huge);
  assert.deepEqual((await loadTextPair({ cwd: repo, log, file: 'huge.txt', source: { kind: 'untracked' } })).new, { state: 'large', size: huge.length });
  await git(['add', 'huge.txt']);
  assert.deepEqual((await loadTextPair({ cwd: repo, log, file: 'huge.txt', source: { kind: 'staged' } })).new, { state: 'large', size: huge.length });
  await symlink(path.join(repo, 'notes.md'), path.join(repo, 'link.md'));
  assert.equal((await loadTextPair({ cwd: repo, log, file: 'link.md', source: { kind: 'untracked' } })).new.state, 'other', 'a link on disk is not followed');
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'secret.txt'), 'secret\n');
  await symlink(elsewhere, path.join(repo, 'escape'));
  await assert.rejects(loadTextPair({ cwd: repo, log, file: 'escape/secret.txt', source: { kind: 'untracked' } }), TypeError);
  for (const bad of ['../x.txt', '/abs.txt', 'a\nb.txt', '']) {
    await assert.rejects(loadTextPair({ cwd: repo, log, file: bad, source: { kind: 'staged' } }), TypeError, `${JSON.stringify(bad)} is refused`);
  }
  for (const bad of [null, { kind: 'disk' }, { kind: 'commit', oid: 'HEAD', base: null }, { kind: 'commit', oid: OID, base: 'main' }]) {
    await assert.rejects(loadTextPair({ cwd: repo, log, file: 'notes.md', source: bad }), TypeError, `source ${JSON.stringify(bad)} is refused`);
  }

  // Every read exited 0, is the app's own (Full History), and the journal
  // holds byte counts, never the file.
  const reads = log.list().filter(entry => entry.operation.startsWith('Read file'));
  assert.ok(reads.length >= 10);
  assert.ok(reads.every(entry => entry.code === 0), 'a missing version is an answer, not a failed command');
  const { isUserCommand } = await import('../../main/command-source.js');
  assert.ok(reads.every(entry => !isUserCommand(entry.operation)));
  assert.ok(reads.filter(entry => entry.operation === 'Read file bytes').every(entry => /^\d+ bytes of binary output, not shown\.\n$/.test(log.outputOf(entry.id).stdout)));
  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.equal(journal.includes('on disk only'), false, 'no file text in the journal');
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('file view: lines, changed lines, words and both versions from real Git checked');
