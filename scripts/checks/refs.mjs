import assert from 'node:assert/strict';
import { parseRefsV1, RefsParseError, buildRefsArgv } from '../../main/git/refs.js';

const SHA1_A = '82df62445b05a04be53291bb36b5db80e46dad77';
const SHA1_B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const SHA1_C = '9d8a538c2683a0ed898778e9c139f019b57471e2';
const SHA256_A = 'a1b2c3'.repeat(10) + 'a1b2';

// `for-each-ref` has no NUL record separator: each line is `\n`-terminated by
// Git itself, and only the fields inside a line are NUL-delimited by this
// module's own format. Verified against real `git for-each-ref` output on
// this checkout (git 2.54.0): a record ends in `\0\n` only when the format
// string itself ends in `%00`, which this module's format does not do.
const line = (fullName, objectName, derefObjectName, objectType, upstreamFull, upstreamShort, upstreamTrack, symref) =>
  [fullName, objectName, derefObjectName, objectType, upstreamFull, upstreamShort, upstreamTrack, symref].join('\0') + '\n';

// Empty output: brand-new repository with no refs at all.
assert.deepEqual(parseRefsV1(''), []);

// Local branch with an in-sync upstream (empty %(upstream:track) means no divergence).
{
  const input = line('refs/heads/main', SHA1_A, '', 'commit', 'refs/remotes/origin/main', 'origin/main', '', '');
  const [ref] = parseRefsV1(input);
  assert.deepEqual(ref, { name: 'main', fullName: 'refs/heads/main', target: SHA1_A, type: 'local', upstream: 'origin/main', ahead: 0, behind: 0 });
}

// Local branch with no upstream configured at all.
{
  const input = line('refs/heads/scratch', SHA1_A, '', 'commit', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.upstream, null);
  assert.equal(ref.ahead, 0);
  assert.equal(ref.behind, 0);
}

// Diverged upstream: ahead only, behind only, and both.
for (const [track, expectAhead, expectBehind] of [['[ahead 3]', 3, 0], ['[behind 2]', 0, 2], ['[ahead 3, behind 2]', 3, 2]]) {
  const input = line('refs/heads/feature', SHA1_A, '', 'commit', 'refs/remotes/origin/feature', 'origin/feature', track, '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.ahead, expectAhead, track);
  assert.equal(ref.behind, expectBehind, track);
  assert.equal(ref.upstream, 'origin/feature', track);
}

// Configured upstream whose remote-tracking ref was pruned away: name is kept, divergence is not computable.
{
  const input = line('refs/heads/gone-branch', SHA1_A, '', 'commit', 'refs/remotes/origin/gone-branch', 'origin/gone-branch', '[gone]', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.upstream, 'origin/gone-branch');
  assert.equal(ref.ahead, 0);
  assert.equal(ref.behind, 0);
}

// Remote-tracking branch (its name keeps the remote prefix).
{
  const input = line('refs/remotes/origin/main', SHA1_A, '', 'commit', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.deepEqual(ref, { name: 'origin/main', fullName: 'refs/remotes/origin/main', target: SHA1_A, type: 'remote', upstream: null, ahead: 0, behind: 0 });
}

// Symbolic remote HEAD must be dropped entirely, not turned into a plain branch.
{
  const input = line('refs/remotes/origin/HEAD', SHA1_A, '', 'commit', '', '', '', 'refs/remotes/origin/main');
  assert.deepEqual(parseRefsV1(input), []);
}

// Lightweight tag: points straight at the commit, no dereferencing needed.
{
  const input = line('refs/tags/v1.0.0', SHA1_A, '', 'commit', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.type, 'tag');
  assert.equal(ref.target, SHA1_A);
}

// Annotated tag: %(objectname) is the tag object itself, %(*objectname) is the
// commit it points at — `target` must be the dereferenced commit, not the tag object.
{
  const tagObjectId = SHA1_C;
  const input = line('refs/tags/v2.0.0', tagObjectId, SHA1_B, 'tag', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.type, 'tag');
  assert.equal(ref.target, SHA1_B);
}

// SHA-256 repository object ids.
{
  const input = line('refs/heads/main', SHA256_A, '', 'commit', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.target, SHA256_A);
}

// Sorting: local, then remote, then tag; within a group, localeCompare('en').
{
  const input = line('refs/tags/v2.0.0', SHA1_A, '', 'commit', '', '', '', '')
    + line('refs/remotes/origin/main', SHA1_A, '', 'commit', '', '', '', '')
    + line('refs/heads/main', SHA1_A, '', 'commit', '', '', '', '')
    + line('refs/heads/álpha', SHA1_A, '', 'commit', '', '', '', '')
    + line('refs/tags/v1.0.0', SHA1_A, '', 'commit', '', '', '', '');
  const refs = parseRefsV1(input);
  assert.deepEqual(refs.map(ref => `${ref.type}:${ref.name}`), ['local:álpha', 'local:main', 'remote:origin/main', 'tag:v1.0.0', 'tag:v2.0.0']);
}

// Branch names that look like path hierarchies (grouped into folders by the sidebar) stay intact.
{
  const input = line('refs/heads/feat/git-desk', SHA1_A, '', 'commit', '', '', '', '');
  const [ref] = parseRefsV1(input);
  assert.equal(ref.name, 'feat/git-desk');
}

// --- error handling ---

const assertRejects = (input, description) => {
  assert.throws(() => parseRefsV1(input), RefsParseError, description);
};

assertRejects(42, 'non-string input');
assertRejects(line('refs/heads/main', SHA1_A, '', 'commit', '', '', '', '').slice(0, -1), 'missing trailing newline (truncated stream)');
assertRejects(`refs/heads/main\0${SHA1_A}\0only-four-fields\0x\n`, 'wrong field count');
assertRejects(line('refs/heads/main', 'not-a-hex-oid', '', 'commit', '', '', '', ''), 'invalid object id');
assertRejects(line('refs/heads/main', SHA1_A, '', 'bogus-type', '', '', '', ''), 'invalid object type');
assertRejects(line('refs/notes/commits', SHA1_A, '', 'commit', '', '', '', ''), 'unknown ref namespace');
assertRejects(line('refs/heads/main', SHA1_A, '', 'commit', 'refs/remotes/origin/main', 'origin/main', '[]', ''), 'malformed empty-bracket track');
assertRejects(line('refs/heads/main', SHA1_A, '', 'commit', 'refs/remotes/origin/main', 'origin/main', 'ahead 3', ''), 'track missing brackets');

// Error messages must never leak the offending ref data.
{
  const secretName = 'refs/heads/leaked-token-abc123';
  try {
    parseRefsV1(line(secretName, 'not-a-hex-oid', '', 'commit', '', '', '', ''));
    assert.fail('expected parseRefsV1 to throw');
  } catch (error) {
    assert.ok(error instanceof RefsParseError);
    assert.equal(error.message.includes(secretName), false);
  }
}

// --- buildRefsArgv: pure argv builder, no Git spawned ---

assert.deepEqual(buildRefsArgv(), ['for-each-ref',
  '--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(upstream)%00%(upstream:short)%00%(upstream:track)%00%(symref)',
  'refs/heads', 'refs/remotes', 'refs/tags']);

console.log('refs: all checks passed');
