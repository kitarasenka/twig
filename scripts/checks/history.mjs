import assert from 'node:assert/strict';
import { parseFileHistory, parseHistoryV1, HistoryParseError } from '../../main/git/history-parser.js';
import { buildFileHistoryArgv, buildHistoryArgv, buildSearchArgv } from '../../main/git/history.js';

const SHA1_A = '82df62445b05a04be53291bb36b5db80e46dad77';
const SHA1_B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const SHA1_C = '9d8a538c2683a0ed898778e9c139f019b57471e2';
const SHA256_A = 'a1b2c3'.repeat(10) + 'a1b2';
const SHA256_B = 'd4e5f6'.repeat(10) + 'd4e5';

// This module's own format: `-z` NUL-terminates each record instead of the
// default trailing newline, and the format string itself has 7 `%x00`
// separators for 8 fields — so a record is 8 NUL-delimited tokens with no
// extra separator glued between consecutive commits. Verified against real
// `git log -z --format=...` output on this checkout (git 2.54.0).
const record = (oid, parents, name, email, authorDate, committerDate, subject, body) =>
  [oid, parents, name, email, authorDate, committerDate, subject, body].join('\0') + '\0';

// Empty output: no commits reachable (e.g. --skip beyond history length).
assert.deepEqual(parseHistoryV1(''), []);

// Single ordinary commit.
{
  const input = record(SHA1_A, SHA1_B, 'ktarasenko', 'k@example.com',
    '2026-09-05T12:31:23+04:00', '2026-09-05T12:35:00+04:00', 'fix(bat_bus): keep route', 'Технически:\n- details');
  const [commit] = parseHistoryV1(input);
  assert.deepEqual(commit, {
    oid: SHA1_A,
    parents: [SHA1_B],
    author: { name: 'ktarasenko', email: 'k@example.com', date: '2026-09-05T12:31:23+04:00' },
    committedAt: '2026-09-05T12:35:00+04:00',
    subject: 'fix(bat_bus): keep route',
    body: 'Технически:\n- details'
  });
}

// Root commit: %P is empty, and so may %b be.
{
  const input = record(SHA1_A, '', 'kitarasenka', 'k@example.com',
    '2026-02-21T12:02:47+04:00', '2026-02-21T12:02:47+04:00', 'Initial commit', '');
  const [commit] = parseHistoryV1(input);
  assert.deepEqual(commit.parents, []);
  assert.equal(commit.body, '');
}

// Merge commit: %P is space-separated, all parents validated as hex ids.
{
  const input = record(SHA1_A, `${SHA1_B} ${SHA1_C}`, 'ktarasenko', 'k@example.com',
    '2026-08-07T12:41:09+04:00', '2026-08-07T12:41:09+04:00', 'Merge branch', '');
  const [commit] = parseHistoryV1(input);
  assert.deepEqual(commit.parents, [SHA1_B, SHA1_C]);
}

// SHA-256 repository object ids, including as a parent.
{
  const input = record(SHA256_A, SHA256_B, 'ktarasenko', 'k@example.com',
    '2026-09-05T12:31:23Z', '2026-09-05T12:31:23Z', 'sha256 repo', '');
  const [commit] = parseHistoryV1(input);
  assert.equal(commit.oid, SHA256_A);
  assert.deepEqual(commit.parents, [SHA256_B]);
}

// Multiple commits concatenated with no separator of their own between them.
{
  const input = record(SHA1_A, '', 'a', 'a@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'first', '')
    + record(SHA1_B, SHA1_A, 'b', 'b@example.com', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z', 'second', '');
  const commits = parseHistoryV1(input);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].oid, SHA1_A);
  assert.equal(commits[1].oid, SHA1_B);
  assert.deepEqual(commits[1].parents, [SHA1_A]);
}

// Subject/body must survive byte-for-byte: multiline, tabs, unicode, emoji,
// and text that looks like a hash or a NUL-free header, never re-interpreted.
{
  const body = 'Технически:\n- версия: 0.1.0 → 0.1.1\tсо табом\n82df62445b05a04be53291bb36b5db80e46dad77 not-a-real-field\n🌱 done';
  const input = record(SHA1_A, '', 'ktarasenko', 'k@example.com', '2026-09-05T00:00:00Z', '2026-09-05T00:00:00Z',
    'feat: 🌱 Twig — тема с кириллицей и emoji', body);
  const [commit] = parseHistoryV1(input);
  assert.equal(commit.subject, 'feat: 🌱 Twig — тема с кириллицей и emoji');
  assert.equal(commit.body, body);
}

// Empty subject is preserved as-is (Git allows committing with an empty
// message via -m "" plus --allow-empty-message).
{
  const input = record(SHA1_A, '', 'a', 'a@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '', '');
  const [commit] = parseHistoryV1(input);
  assert.equal(commit.subject, '');
}

// --- error handling ---

const assertRejects = (input, description) => {
  assert.throws(() => parseHistoryV1(input), HistoryParseError, description);
};

assertRejects(42, 'non-string input');
assertRejects(record(SHA1_A, '', 'a', 'a@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'subject', 'body').slice(0, -1),
  'missing trailing NUL (truncated stream)');
assertRejects(`${SHA1_A}\0${SHA1_B}\0only-five-fields\0x\0y\0`, 'wrong field count, not a multiple of 8');
assertRejects(record('not-a-hex-oid', '', 'a', 'a@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 's', ''),
  'invalid commit oid');
assertRejects(record(SHA1_A, 'not-a-hex-parent', 'a', 'a@example.com', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 's', ''),
  'invalid parent oid');
assertRejects(record(SHA1_A, '', 'a', 'a@example.com', 'not-a-date', '2026-01-01T00:00:00Z', 's', ''),
  'invalid author date');
assertRejects(record(SHA1_A, '', 'a', 'a@example.com', '2026-01-01T00:00:00Z', 'not-a-date', 's', ''),
  'invalid committer date');

// Error messages must never leak the offending commit data.
{
  const secretSubject = 'fix: rotate leaked-token-abc123';
  try {
    parseHistoryV1(record('bad-oid-with-secret-nearby', '', 'a', 'a@example.com',
      '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', secretSubject, ''));
    assert.fail('expected parseHistoryV1 to throw');
  } catch (error) {
    assert.ok(error instanceof HistoryParseError);
    assert.equal(error.message.includes(secretSubject), false);
    assert.equal(error.message.includes('bad-oid-with-secret-nearby'), false);
  }
}

// --- buildHistoryArgv: pure argv builder, no Git spawned ---

assert.deepEqual(buildHistoryArgv(), ['log', '--exclude=refs/stash', '--exclude=refs/twig/*', '--all', '--topo-order', '-z',
  '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', '--max-count=250', '--skip=0']);
assert.deepEqual(buildHistoryArgv({ limit: 50, skip: 100 }), ['log', '--exclude=refs/stash', '--exclude=refs/twig/*', '--all', '--topo-order', '-z',
  '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', '--max-count=50', '--skip=100']);

for (const limit of [0, -1, 501, 1.5, '250', NaN, Infinity]) {
  assert.throws(() => buildHistoryArgv({ limit }), TypeError, `limit ${limit} must be rejected`);
}
for (const skip of [-1, 1.5, '0', NaN]) {
  assert.throws(() => buildHistoryArgv({ skip }), TypeError, `skip ${skip} must be rejected`);
}
assert.deepEqual(buildHistoryArgv({ limit: 1, skip: 0 }).includes('--max-count=1'), true);
assert.deepEqual(buildHistoryArgv({ limit: 500, skip: 0 }).includes('--max-count=500'), true);

// --- buildFileHistoryArgv: `git log --follow` on one file, no Git spawned ---

assert.deepEqual(buildFileHistoryArgv('src/app.js'), ['log', '--follow', '--name-status', '--topo-order', '-z',
  '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', '--max-count=250', '--', ':(literal)src/app.js']);
assert.deepEqual(buildFileHistoryArgv('a b/c.txt', 10), ['log', '--follow', '--name-status', '--topo-order', '-z',
  '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', '--max-count=10', '--', ':(literal)a b/c.txt']);
// The path is the last argv token and sits after `--`, so a flag-like name stays a name.
assert.equal(buildFileHistoryArgv('--force').at(-1), ':(literal)--force');
for (const file of ['', 42, '/etc/passwd', '../escape', 'a/../b', 'has\0nul']) {
  assert.throws(() => buildFileHistoryArgv(file), TypeError, `file ${file} must be rejected`);
}
for (const limit of [0, -1, 501, 1.5, '250', NaN, Infinity]) {
  assert.throws(() => buildFileHistoryArgv('src/app.js', limit), TypeError, `limit ${limit} must be rejected`);
}

// --- buildSearchArgv: literal, case-insensitive `git log --grep` over all refs ---

assert.deepEqual(buildSearchArgv('fix login'), ['log', '--exclude=refs/stash', '--exclude=refs/twig/*', '--all', '--topo-order', '-z', '-i', '--fixed-strings',
  '--grep=fix login', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b', '--max-count=200']);
// The query is trimmed and stays one argv token after `--grep=`, so a regex- or
// flag-looking search string is matched literally, never interpreted.
assert.equal(buildSearchArgv('  --oops (a|b)  ').find(part => part.startsWith('--grep=')), '--grep=--oops (a|b)');
assert.deepEqual(buildSearchArgv('x', 500).includes('--max-count=500'), true);
for (const query of ['', '   ', 42, null, undefined, 'x'.repeat(201), 'has\0nul']) {
  assert.throws(() => buildSearchArgv(query), TypeError, `query ${query} must be rejected`);
}
for (const limit of [0, -1, 501, 1.5, '250', NaN]) {
  assert.throws(() => buildSearchArgv('x', limit), TypeError, `limit ${limit} must be rejected`);
}

const fileRecord = oid => record(oid, '', 'Fixture', 'f@example.invalid',
  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'File change', '');
const renamed = fileRecord(SHA1_A) + '\nR100\0old\n[1].txt\0new.txt\0'
  + fileRecord(SHA1_B) + '\nM\0old\n[1].txt\0';
assert.deepEqual(parseFileHistory(renamed, 'new.txt').map(commit => commit.path), ['new.txt', 'old\n[1].txt']);
assert.deepEqual(parseFileHistory('', 'new.txt'), []);
assert.equal(parseFileHistory(fileRecord(SHA1_A) + '\nD\0new.txt\0', 'new.txt')[0].path, 'new.txt');
for (const raw of [renamed.slice(0, -1), fileRecord(SHA1_A) + '\nR100\0old.txt\0', fileRecord(SHA1_A) + '\nBAD\0new.txt\0']) {
  assert.throws(() => parseFileHistory(raw, 'new.txt'), HistoryParseError);
}

console.log('history: all checks passed');
