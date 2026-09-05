import assert from 'node:assert/strict';
import { parseStatusV2, StatusParseError } from '../../main/git/status-parser.js';

const SHA1_A = '82df62445b05a04be53291bb36b5db80e46dad77';
const SHA1_B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const SHA256_A = 'a1b2c3'.repeat(10) + 'a1b2';
assert.equal(SHA256_A.length, 64, 'sanity check on the SHA-256 fixture length');

const record = (...fields) => fields.join('\0') + '\0';
const output = (...records) => records.join('');

// Empty output: clean worktree with no --branch, or nothing changed.
{
  const result = parseStatusV2('');
  assert.deepEqual(result, {
    branch: { oid: null, name: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 },
    entries: []
  });
}

// Full branch headers plus an ordinary modified entry.
{
  const input = output(
    record(`# branch.oid ${SHA1_A}`),
    record('# branch.head main'),
    record('# branch.upstream origin/main'),
    record('# branch.ab +2 -3'),
    record(`1 M. N... 100644 100644 100644 ${SHA1_A} ${SHA1_B} src/index.js`)
  );
  const result = parseStatusV2(input);
  assert.equal(result.branch.oid, SHA1_A);
  assert.equal(result.branch.name, 'main');
  assert.equal(result.branch.detached, false);
  assert.equal(result.branch.unborn, false);
  assert.equal(result.branch.upstream, 'origin/main');
  assert.equal(result.branch.ahead, 2);
  assert.equal(result.branch.behind, 3);
  assert.deepEqual(result.entries, [{
    kind: 'ordinary',
    path: 'src/index.js',
    originalPath: null,
    indexStatus: 'M',
    worktreeStatus: '.',
    submodule: null,
    score: null
  }]);
}

// Detached HEAD, no upstream.
{
  const input = output(record(`# branch.oid ${SHA1_A}`), record('# branch.head (detached)'));
  const result = parseStatusV2(input);
  assert.equal(result.branch.detached, true);
  assert.equal(result.branch.name, null);
  assert.equal(result.branch.upstream, null);
  assert.equal(result.branch.ahead, 0);
  assert.equal(result.branch.behind, 0);
}

// Unborn branch (fresh repo, no commits yet).
{
  const input = output(record('# branch.oid (initial)'), record('# branch.head main'));
  const result = parseStatusV2(input);
  assert.equal(result.branch.unborn, true);
  assert.equal(result.branch.oid, null);
  assert.equal(result.branch.name, 'main');
}

// SHA-256 repository object ids.
{
  const input = output(record(`# branch.oid ${SHA256_A}`), record('# branch.head main'));
  const result = parseStatusV2(input);
  assert.equal(result.branch.oid, SHA256_A);
}

// Unknown headers (future Git versions, `# stash N`) are ignored, not rejected.
{
  const input = output(
    record('# branch.oid (initial)'),
    record('# branch.mystery-field some value'),
    record('# stash 3')
  );
  const result = parseStatusV2(input);
  assert.equal(result.branch.unborn, true);
  assert.deepEqual(result.entries, []);
}

// Rename: target path comes before origPath after -z, per git-status(1).
{
  const input = record(
    `2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_B} R100 new name.txt`,
    'old name.txt'
  );
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries, [{
    kind: 'renamed',
    path: 'new name.txt',
    originalPath: 'old name.txt',
    indexStatus: 'R',
    worktreeStatus: '.',
    submodule: null,
    score: { kind: 'rename', value: 100 }
  }]);
}

// Copy score, partial similarity.
{
  const input = record(`2 C. N... 100644 100644 100644 ${SHA1_A} ${SHA1_B} C75 copy.txt`, 'source.txt');
  const result = parseStatusV2(input);
  assert.equal(result.entries[0].score.kind, 'copy');
  assert.equal(result.entries[0].score.value, 75);
}

// Paths with spaces, tabs, newlines, backslashes, cyrillic, emoji and a leading dash
// must survive byte-for-byte: no trim, no normalization, no whitespace splitting.
{
  const weirdPath = '-leading dash/two\tspaces\nnewline\\back\\slash кириллица 🌱.txt';
  const input = record(`1 .M N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} ${weirdPath}`);
  const result = parseStatusV2(input);
  assert.equal(result.entries[0].path, weirdPath);
}

{
  const weirdOrig = 'источник 📄.txt';
  const weirdPath = 'назначение → цель.txt';
  const input = record(`2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} R90 ${weirdPath}`, weirdOrig);
  const result = parseStatusV2(input);
  assert.equal(result.entries[0].path, weirdPath);
  assert.equal(result.entries[0].originalPath, weirdOrig);
}

// A filename that itself looks like a header or record line must stay opaque data,
// never be re-parsed as structure: dispatch happens on token position, not content.
{
  const trickyName = '# branch.oid deadbeef';
  const input = record(`? ${trickyName}`);
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries, [{
    kind: 'untracked', path: trickyName, originalPath: null, indexStatus: '.', worktreeStatus: '.', submodule: null, score: null
  }]);
}
{
  const trickyOrig = '2 R. N... 100644 100644 100644 deadbeef deadbeef R50 fake.txt';
  const input = record(`2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} R50 real.txt`, trickyOrig);
  const result = parseStatusV2(input);
  assert.equal(result.entries[0].originalPath, trickyOrig);
}

// Unmerged entries: every conflict XY combination from git-status(1) short format.
for (const xy of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
  const input = record(`u ${xy} N... 100644 100644 100644 100644 ${SHA1_A} ${SHA1_A} ${SHA1_A} conflict.txt`);
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries, [{
    kind: 'unmerged',
    path: 'conflict.txt',
    originalPath: null,
    indexStatus: xy[0],
    worktreeStatus: xy[1],
    submodule: null,
    score: null
  }]);
}

// Ignored entry.
{
  const input = record('! dist/bundle.js');
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries, [{
    kind: 'ignored', path: 'dist/bundle.js', originalPath: null, indexStatus: '.', worktreeStatus: '.', submodule: null, score: null
  }]);
}

// Dirty submodule: commit changed, tracked changes, untracked changes must not
// collapse into a plain modified-file entry.
{
  const input = record(`1 .M SCMU 160000 160000 160000 ${SHA1_A} ${SHA1_B} vendor/lib`);
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries[0].submodule, { commitChanged: true, trackedChanges: true, untrackedChanges: true });
}
{
  const input = record(`1 .M S..U 160000 160000 160000 ${SHA1_A} ${SHA1_B} vendor/lib`);
  const result = parseStatusV2(input);
  assert.deepEqual(result.entries[0].submodule, { commitChanged: false, trackedChanges: false, untrackedChanges: true });
}

// --- error handling ---

const assertRejects = (input, description) => {
  assert.throws(() => parseStatusV2(input), StatusParseError, description);
};

assertRejects(42, 'non-string input');
assertRejects('1 .M N... 100644 100644 100644 ' + SHA1_A + ' ' + SHA1_A + ' truncated.txt', 'missing trailing NUL');
assertRejects(record('3 bogus record type'), 'unknown record type');
assertRejects(record('# branch.ab not-a-count'), 'malformed branch.ab header');
assertRejects(record('# branch.oid not-hex'), 'malformed branch.oid header');
assertRejects(record('# branch.head'), 'branch.head with no value');
assertRejects('\0', 'empty record between NULs');
assertRejects(record(`2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} R100 orphaned-rename.txt`), 'type 2 record with no following origPath token');
assertRejects(record('1 .M N... 100644 100644 file.txt'), 'ordinary record with too few fields');
assertRejects(record(`1 .M N.X. 100644 100644 100644 ${SHA1_A} ${SHA1_A} file.txt`), 'invalid submodule field');
assertRejects(record(`2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} R101 over-100.txt`), 'rename score above 100');
assertRejects(record(`2 R. N... 100644 100644 100644 ${SHA1_A} ${SHA1_A} X50 bad-letter.txt`), 'rename score with invalid letter');
assertRejects(record(`u XY N... 100644 100644 100644 100644 ${SHA1_A} ${SHA1_A} ${SHA1_A} file.txt`), 'unmerged with invalid XY code');

// Error messages must never leak the offending input (paths, hashes, secrets).
{
  const secretPath = 'super-secret-token-abc123.env';
  const malformed = `1 .M N... 100644 100644 file.txt-${secretPath}`;
  try {
    parseStatusV2(record(malformed));
    assert.fail('expected parseStatusV2 to throw');
  } catch (error) {
    assert.ok(error instanceof StatusParseError);
    assert.equal(error.message.includes(secretPath), false);
    assert.equal(error.message.includes('file.txt'), false);
  }
}

console.log('status-parser: all checks passed');
