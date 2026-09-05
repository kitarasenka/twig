import assert from 'node:assert/strict';
import { ConflictParseError, hasConflictMarkers, parseConflictFile, resolveRegion }
  from '../../renderer/src/features/conflicts/conflict-parser.js';

// The exact shape git 2.54 writes for `merge.conflictStyle=merge`, captured
// from a real conflicted merge rather than reconstructed from memory.
const MERGE_STYLE = 'a\n<<<<<<< HEAD\nMAIN\n=======\nSIDE\n>>>>>>> side\nc\n';
// The diff3/zdiff3 form, which adds the base between `|||||||` and `=======`.
const DIFF3_STYLE = 'a\n<<<<<<< HEAD\nMAIN\n||||||| 5a6f0ab\nb\n=======\nSIDE\n>>>>>>> side\nc\n';

{
  const { regions, conflicts, trailingNewline } = parseConflictFile(MERGE_STYLE);
  assert.equal(conflicts, 1);
  assert.equal(trailingNewline, true);
  assert.deepEqual(regions.map(region => region.kind), ['common', 'conflict', 'common']);
  const [, conflict] = regions;
  assert.deepEqual(conflict.ours, ['MAIN']);
  assert.deepEqual(conflict.theirs, ['SIDE']);
  assert.equal(conflict.base, null, 'the default conflict style carries no base');
  assert.equal(conflict.oursLabel, 'HEAD');
  assert.equal(conflict.theirsLabel, 'side');
  assert.equal(conflict.start, 1);
  assert.equal(conflict.end, 5);
}

{
  const [, conflict] = parseConflictFile(DIFF3_STYLE).regions;
  assert.deepEqual(conflict.base, ['b'], 'diff3 keeps the merge base');
  assert.deepEqual(conflict.ours, ['MAIN']);
  assert.deepEqual(conflict.theirs, ['SIDE']);
}

// A file with no conflict at all is one common region, and no markers.
assert.deepEqual(parseConflictFile('one\ntwo\n').regions, [{ kind: 'common', lines: ['one', 'two'] }]);
assert.equal(hasConflictMarkers('one\ntwo\n'), false);
assert.equal(hasConflictMarkers(MERGE_STYLE), true);

// Two conflicts are numbered independently of the lines between them.
{
  const text = `<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> b\nmiddle\n<<<<<<< HEAD\n3\n=======\n4\n>>>>>>> b\n`;
  const { conflicts, regions } = parseConflictFile(text);
  assert.equal(conflicts, 2);
  assert.deepEqual(regions.filter(region => region.kind === 'conflict').map(region => region.index), [0, 1]);
}

// Empty sides happen constantly — add/delete conflicts produce them — and are
// not an error.
{
  const [conflict] = parseConflictFile('<<<<<<< HEAD\n=======\nnew\n>>>>>>> b\n').regions;
  assert.deepEqual(conflict.ours, []);
  assert.deepEqual(conflict.theirs, ['new']);
}

// A marker is exactly seven characters. Eight is ordinary content — a file of
// `========` rules must survive being opened.
{
  const text = 'before\n========\n<<<<<<<<\nafter\n';
  assert.equal(hasConflictMarkers(text), false);
  assert.deepEqual(parseConflictFile(text).conflicts, 0);
}

// Malformed input fails loudly instead of guessing.
assert.throws(() => parseConflictFile('<<<<<<< HEAD\nours\n'), ConflictParseError, 'unterminated');
assert.throws(() => parseConflictFile('<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c\n'), ConflictParseError, 'nested');
assert.throws(() => parseConflictFile(null), ConflictParseError);

// Resolving replaces exactly the marked span and nothing else, even when the
// same text appears elsewhere in the file.
{
  const text = 'MAIN\n<<<<<<< HEAD\nMAIN\n=======\nSIDE\n>>>>>>> side\nMAIN\n';
  assert.equal(resolveRegion(text, 0, ['MAIN']), 'MAIN\nMAIN\nMAIN\n');
  assert.equal(resolveRegion(text, 0, []), 'MAIN\nMAIN\n', 'taking neither side leaves the rest intact');
  assert.equal(resolveRegion(text, 0, ['MAIN', 'SIDE']), 'MAIN\nMAIN\nSIDE\nMAIN\n');
}
// A file with no trailing newline keeps not having one.
assert.equal(resolveRegion('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b', 0, ['x']), 'x');
assert.throws(() => resolveRegion(MERGE_STYLE, 3, ['x']), ConflictParseError, 'unknown region');
assert.throws(() => resolveRegion(MERGE_STYLE, 0, ['has\nnewline']), ConflictParseError);

// Resolving the second conflict renumbers nothing for the first.
{
  const text = '<<<<<<< HEAD\n1\n=======\n2\n>>>>>>> b\n<<<<<<< HEAD\n3\n=======\n4\n>>>>>>> b\n';
  const once = resolveRegion(text, 1, ['4']);
  assert.equal(parseConflictFile(once).conflicts, 1);
  assert.equal(resolveRegion(once, 0, ['1']), '1\n4\n');
}

console.log('conflict-parser: all checks passed');
