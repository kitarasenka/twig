import assert from 'node:assert/strict';
import { parseFilePatchV1, DiffParseError } from '../../main/git/diff-parser.js';
import { buildDiffArgv, buildStatusArgv } from '../../main/git/worktree.js';

// Every fixture below is shaped exactly like real `git diff` output captured
// from git 2.54.0, including the tab that terminates a path containing spaces
// and the position of the no-newline marker.

// Empty diff: the file matches the other side.
assert.deepEqual(parseFilePatchV1(''), { binary: false, added: false, deleted: false, mode: null, hunks: [] });

// Ordinary modification with two changed lines and a missing final newline.
{
  const patch = [
    'diff --git a/a.txt b/a.txt',
    'index b2f931a..e5f063c 100644',
    '--- a/a.txt',
    '+++ b/a.txt',
    '@@ -1,5 +1,5 @@',
    ' one',
    '-two',
    '+TWO',
    ' three',
    ' four',
    '-five',
    '+FIVE-no-newline',
    '\\ No newline at end of file',
    ''
  ].join('\n');
  const result = parseFilePatchV1(patch);
  assert.equal(result.binary, false);
  assert.equal(result.added, false);
  assert.equal(result.deleted, false);
  assert.equal(result.hunks.length, 1);
  const [hunk] = result.hunks;
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [1, 5, 1, 5]);
  assert.deepEqual(hunk.lines.map(line => line.kind), ['context', 'delete', 'add', 'context', 'context', 'delete', 'add']);
  assert.deepEqual(hunk.lines.map(line => line.text), ['one', 'two', 'TWO', 'three', 'four', 'five', 'FIVE-no-newline']);
  assert.equal(hunk.lines.at(-1).noNewline, true);
  assert.equal(hunk.lines.filter(line => line.noNewline).length, 1);
}

// Omitted counts: `@@ -1 +1 @@` means one line on each side.
{
  const patch = 'diff --git a/tiny.txt b/tiny.txt\n--- a/tiny.txt\n+++ b/tiny.txt\n@@ -1 +1 @@\n-x\n+y\n';
  const [hunk] = parseFilePatchV1(patch).hunks;
  assert.deepEqual([hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines], [1, 1, 1, 1]);
}

// Added file: /dev/null on the old side, `new file mode` carries the mode.
{
  const patch = [
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    'index 0000000..d5f7fc3',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+added',
    ''
  ].join('\n');
  const result = parseFilePatchV1(patch);
  assert.equal(result.added, true);
  assert.equal(result.deleted, false);
  assert.equal(result.mode, '100644');
  assert.deepEqual(result.hunks[0].lines.map(line => line.kind), ['add']);
}

// Deleted file, and the tab that terminates a path containing a space.
{
  const patch = [
    'diff --git a/sp ace.txt b/sp ace.txt',
    'deleted file mode 100644',
    'index 2fa992c..0000000',
    '--- a/sp ace.txt\t',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-keep',
    ''
  ].join('\n');
  const result = parseFilePatchV1(patch);
  assert.equal(result.deleted, true);
  assert.equal(result.mode, '100644');
  assert.deepEqual([result.hunks[0].oldStart, result.hunks[0].newStart, result.hunks[0].newLines], [1, 0, 0]);
}

// Binary file: marker, no hunks.
{
  const patch = 'diff --git a/b.bin b/b.bin\nindex b1feab4..d125a61 100644\nBinary files a/b.bin and b/b.bin differ\n';
  const result = parseFilePatchV1(patch);
  assert.equal(result.binary, true);
  assert.deepEqual(result.hunks, []);
}

// Several hunks, a function heading after @@, an empty context line written
// by Git as a bare empty line, CRLF content and Unicode.
{
  const patch = [
    'diff --git a/multi.txt b/multi.txt',
    '--- a/multi.txt',
    '+++ b/multi.txt',
    '@@ -1,3 +1,3 @@ function twig()',
    ' первая',
    '-вторая\r',
    '+вторая 🌱\r',
    '',
    '@@ -10,2 +10,3 @@',
    ' tail',
    '+добавили',
    ' end',
    ''
  ].join('\n');
  const result = parseFilePatchV1(patch);
  assert.equal(result.hunks.length, 2);
  assert.equal(result.hunks[0].heading, 'function twig()');
  assert.equal(result.hunks[0].lines[2].text, 'вторая 🌱\r');
  assert.deepEqual(result.hunks[0].lines.at(-1), { kind: 'context', text: '', noNewline: false });
  assert.equal(result.hunks[1].heading, '');
  assert.deepEqual(result.hunks[1].lines.map(line => line.kind), ['context', 'add', 'context']);
}

// --- error handling ---

const assertRejects = (input, description) => {
  assert.throws(() => parseFilePatchV1(input), DiffParseError, description);
};

assertRejects(42, 'non-string input');
assertRejects('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,5 +1,5 @@\n one\n', 'hunk shorter than its header claims');
assertRejects('diff --git a/x b/x\n@@ -1 +1 @@\n-x\n+y\n@@ -1 +1 @@\n?bogus\n', 'unknown line prefix inside a hunk');
assertRejects('diff --git a/x b/x\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/y b/y\n@@ -1 +1 @@\n-a\n+b\n', 'more than one file in the patch');
assertRejects('diff --git a/x b/x\n@@ -1 +1 @@\n\\ No newline at end of file\n', 'no-newline marker without a preceding line');
assertRejects('diff --git a/b.bin b/b.bin\nBinary files a/b.bin and b/b.bin differ\n@@ -1 +1 @@\n-x\n+y\n', 'binary patch carrying hunks');

// Error messages must never leak file contents.
{
  const secret = 'AWS_SECRET_ACCESS_KEY=abc123';
  try {
    parseFilePatchV1(`diff --git a/env b/env\n@@ -1,9 +1,9 @@\n+${secret}\n`);
    assert.fail('expected parseFilePatchV1 to throw');
  } catch (error) {
    assert.ok(error instanceof DiffParseError);
    assert.equal(error.message.includes(secret), false);
    assert.equal(error.message.includes('abc123'), false);
  }
}

// --- argv builders: no Git spawned ---

assert.deepEqual(buildStatusArgv(), ['status', '--porcelain=v2', '--branch', '-z']);
assert.deepEqual(buildDiffArgv({ path: 'src/a.js' }),
  ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--', ':(literal)src/a.js']);
assert.deepEqual(buildDiffArgv({ path: 'src/a.js', staged: true }),
  ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--cached', '--', ':(literal)src/a.js']);
// A path that looks like a flag or carries glob characters stays a path.
assert.deepEqual(buildDiffArgv({ path: '--upload-pack=evil' }).at(-1), ':(literal)--upload-pack=evil');
assert.deepEqual(buildDiffArgv({ path: 'weird[*].txt' }).at(-1), ':(literal)weird[*].txt');
for (const path of ['', '/etc/passwd', '../escape', 'a/../../b', 'nul\0byte', 42, null]) {
  assert.throws(() => buildDiffArgv({ path }), TypeError, `path ${String(path)} must be rejected`);
}

console.log('diff-parser: all checks passed');
