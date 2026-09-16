import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { segmentPair, segmentHunkLines, annotatePatch } from '../../renderer/src/features/diff/intraline.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');

// Reconstruct each side from its segments to prove nothing is dropped or added.
const rebuild = (segments, keep) => segments.filter(s => s.type === 'same' || s.type === keep).map(s => s.text).join('');

function check(oldText, newText) {
  const result = segmentPair(oldText, newText);
  if (result === null) return null;
  assert.equal(rebuild(result.old, 'del'), oldText, `old rebuild for ${oldText} → ${newText}`);
  assert.equal(rebuild(result.new, 'add'), newText, `new rebuild for ${oldText} → ${newText}`);
  for (const seg of [...result.old, ...result.new]) assert.ok(seg.text.length > 0, 'no empty segment');
  for (let i = 1; i < result.old.length; i++) assert.notEqual(result.old[i].type, result.old[i - 1].type, 'old segments are coalesced');
  for (let i = 1; i < result.new.length; i++) assert.notEqual(result.new[i].type, result.new[i - 1].type, 'new segments are coalesced');
  return result;
}

// Equal lines carry no highlight at all.
assert.equal(segmentPair('same text', 'same text'), null);

// A trailing letter vanished: the old line strikes just "а", the new line adds nothing.
const dropped = check('сорока', 'сорок');
assert.deepEqual(dropped.old, [{ type: 'same', text: 'сорок' }, { type: 'del', text: 'а' }]);
assert.deepEqual(dropped.new, [{ type: 'same', text: 'сорок' }]);

// A middle edit keeps both ends untouched.
const middle = check('const width = m + 1;', 'const width = n + 1;');
assert.deepEqual(middle.old, [{ type: 'same', text: 'const width = ' }, { type: 'del', text: 'm' }, { type: 'same', text: ' + 1;' }]);
assert.deepEqual(middle.new, [{ type: 'same', text: 'const width = ' }, { type: 'add', text: 'n' }, { type: 'same', text: ' + 1;' }]);

// A shared prefix with a rewritten tail is still worth showing.
const tail = check('Hello real history', 'Hello Twig');
assert.equal(tail.old[0].type, 'same');
assert.ok(tail.old[0].text.startsWith('Hello '));

// A parameter inserted mid-line marks exactly the inserted span — the diff works
// on tokens, so shared letters in "onConsole" are not scattered across the line.
const inserted = check('foo(onConsole, onBack) {', 'foo(runAutomation = null, onConsole, onBack) {');
assert.deepEqual(inserted.old, [{ type: 'same', text: 'foo(onConsole, onBack) {' }]);
assert.deepEqual(inserted.new, [
  { type: 'same', text: 'foo(' },
  { type: 'add', text: 'runAutomation = null, ' },
  { type: 'same', text: 'onConsole, onBack) {' }
]);

// A genuine rewrite falls back to whole-line colouring.
assert.equal(segmentPair('the quick brown fox', 'JUMPS OVER LAZY DOGS'), null);

// Absurdly long lines are shown whole rather than building a huge table.
assert.equal(segmentPair('x'.repeat(500), 'y'.repeat(500)), null);

// segmentHunkLines pairs the k-th removed line with the k-th added line in a run.
const lines = [
  { kind: 'context', text: 'unchanged' },
  { kind: 'delete', text: 'alpha one' },
  { kind: 'delete', text: 'beta two' },
  { kind: 'add', text: 'alpha ONE' },
  { kind: 'add', text: 'beta two extended' },
  { kind: 'add', text: 'gamma three' },
  { kind: 'context', text: 'tail' }
];
const hunkSegments = segmentHunkLines(lines);
assert.equal(hunkSegments[0], null);
assert.equal(hunkSegments[6], null);
assert.equal(hunkSegments[5], null, 'the unpaired extra addition stays whole');
assert.equal(rebuild(hunkSegments[1], 'del'), 'alpha one');
assert.equal(rebuild(hunkSegments[3], 'add'), 'alpha ONE');
assert.equal(rebuild(hunkSegments[4], 'add'), 'beta two extended');

// A pure addition block is never paired.
assert.deepEqual(segmentHunkLines([{ kind: 'add', text: 'a' }, { kind: 'add', text: 'b' }]), [null, null]);

// annotatePatch drops the per-file header and only pairs inside a hunk.
const patch = [
  'diff --git a/poem.txt b/poem.txt',
  'index 111..222 100644',
  '--- a/poem.txt',
  '+++ b/poem.txt',
  '@@ -1,2 +1,2 @@',
  ' first line',
  '-сорока',
  '+сорок',
  ' last line'
].join('\n');
const rows = annotatePatch(patch);
assert.deepEqual(rows.map(row => row.text), [
  '@@ -1,2 +1,2 @@', ' first line', '-сорока', '+сорок', ' last line'
], 'diff --git, index and ---/+++ are not changes to the file');
assert.equal(rows[0].cls, 'diff-hunk');
assert.equal(rows[2].cls, 'diff-deleted');
assert.deepEqual(rows[2].segments, [{ type: 'same', text: 'сорок' }, { type: 'del', text: 'а' }]);
assert.deepEqual(rows[3].segments, [{ type: 'same', text: 'сорок' }]);
assert.equal(rows[1].segments, null);

// Every file of a multi-file patch loses its header, hunks keep their order.
const multi = annotatePatch([
  'diff --git a/one.txt b/one.txt',
  'index 1..2 100644',
  '--- a/one.txt',
  '+++ b/one.txt',
  '@@ -1 +1 @@',
  '-one',
  '+ONE',
  'diff --git a/two.txt b/two.txt',
  'new file mode 100644',
  'index 0000000..3 100644',
  '--- /dev/null',
  '+++ b/two.txt',
  '@@ -0,0 +1 @@',
  '+two'
].join('\n')).map(row => row.text);
assert.deepEqual(multi, ['@@ -1 +1 @@', '-one', '+ONE', '@@ -0,0 +1 @@', '+two']);

// A removed line that looks like a header survives: it is inside a hunk.
assert.deepEqual(annotatePatch([
  'diff --git a/m.txt b/m.txt',
  '--- a/m.txt',
  '+++ b/m.txt',
  '@@ -1 +1 @@',
  '--- a/m.txt',
  '+++ b/m.txt'
].join('\n')).map(row => row.text), ['@@ -1 +1 @@', '--- a/m.txt', '+++ b/m.txt']);

// A header-only patch (a mode change) keeps its lines: an empty body says less.
assert.deepEqual(annotatePatch([
  'diff --git a/run.sh b/run.sh',
  'old mode 100644',
  'new mode 100755'
].join('\n')).map(row => row.text), ['diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755']);

// A patch with no hunk header pairs nothing.
for (const row of annotatePatch('-just\n+text')) assert.equal(row.segments, null);

// Line numbers: context advances both sides, a removal only the old side, an
// addition only the new one; the hunk header itself carries no number.
const numbered = annotatePatch([
  'diff --git a/poem.txt b/poem.txt',
  '--- a/poem.txt',
  '+++ b/poem.txt',
  '@@ -10,4 +20,5 @@ def build(x):',
  ' context',
  '-gone',
  '+kept',
  '+added',
  ' tail'
].join('\n')).map(row => [row.oldLine, row.newLine]);
assert.deepEqual(numbered, [[null, null], [10, 20], [11, null], [null, 21], [null, 22], [12, 23]]);

// A second hunk restarts the count from its own header, and `\ No newline at
// end of file` is not a line of either side.
const twoHunks = annotatePatch([
  '@@ -1 +1 @@',
  '-one',
  '+ONE',
  '\\ No newline at end of file',
  '@@ -40,2 +41,2 @@',
  ' forty',
  '+forty one'
].join('\n')).map(row => [row.oldLine, row.newLine]);
assert.deepEqual(twoHunks, [[null, null], [1, null], [null, 1], [null, null], [null, null], [40, 41], [null, 42]]);

// A new file (`-0,0`) numbers only the side that exists.
assert.deepEqual(annotatePatch('@@ -0,0 +1,2 @@\n+first\n+second').map(row => [row.oldLine, row.newLine]),
  [[null, null], [null, 1], [null, 2]]);

// The newline that ends a patch is not a line of the file.
assert.deepEqual(annotatePatch('@@ -1 +1 @@\n-one\n+ONE\n').map(row => row.text), ['@@ -1 +1 @@', '-one', '+ONE']);

// Lines outside any hunk (a header-only patch) are never numbered.
for (const row of annotatePatch('diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755')) {
  assert.equal(row.oldLine, null);
  assert.equal(row.newLine, null);
}

// The renderer and this check agree on the segment and gutter class names.
const css = await read('renderer/src/ui/history.css');
assert.match(css, /\.diff-seg-add\b/);
assert.match(css, /\.diff-seg-del\b/);
for (const name of ['diff-gutter', 'diff-line-old', 'diff-line-new']) assert.match(css, new RegExp(`\\.${name}\\b`), `${name} is styled`);
const jsx = await read('renderer/src/features/diff/DiffLines.jsx');
for (const name of ['diff-gutter', 'diff-line-old', 'diff-line-new']) assert.ok(jsx.includes(name), `${name} is rendered`);

console.log('intraline check passed: character diff, similarity and length guards, hunk pairing, patch annotation, line numbers, CSS parity.');
