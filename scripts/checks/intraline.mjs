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

// annotatePatch keeps the existing line classes and only pairs inside a hunk.
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
assert.equal(rows[2].cls, 'diff-deleted');
assert.equal(rows[2].segments, null, 'the --- header line is never paired');
assert.equal(rows[3].cls, 'diff-added');
assert.equal(rows[3].segments, null, 'the +++ header line is never paired');
assert.equal(rows[4].cls, 'diff-hunk');
assert.equal(rows[6].cls, 'diff-deleted');
assert.deepEqual(rows[6].segments, [{ type: 'same', text: 'сорок' }, { type: 'del', text: 'а' }]);
assert.deepEqual(rows[7].segments, [{ type: 'same', text: 'сорок' }]);
assert.equal(rows[5].segments, null);

// A patch with no hunk header pairs nothing.
for (const row of annotatePatch('-just\n+text')) assert.equal(row.segments, null);

// The renderer and this check agree on the segment class names.
const css = await read('renderer/src/ui/history.css');
assert.match(css, /\.diff-seg-add\b/);
assert.match(css, /\.diff-seg-del\b/);

console.log('intraline check passed: character diff, similarity and length guards, hunk pairing, patch annotation, CSS parity.');
