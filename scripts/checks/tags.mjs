import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { RefsParseError, buildTagDetailsArgv, loadTagDetails, parseTagDetails } from '../../main/git/refs.js';
import { TAG_SORTS, compareVersions, readTagSort, sortTags, writeTagSort } from '../../renderer/src/features/refs/tag-sort.js';

// Tags on the "Branches and tags" screen: version order, and what each tag says.

// --- version order, no Git -------------------------------------------------------------------
const ascending = ['v0.9.0', 'v0.10.0-alpha', 'v0.10.0-beta.2', 'v0.10.0-beta.10', 'v0.10.0-rc1', 'v0.10.0', 'v0.10.0.1', 'v0.10.1', 'v1.0.0', 'v2.0.0', 'v10.0.0'];
for (let i = 0; i < ascending.length; i += 1) {
  for (let j = 0; j < ascending.length; j += 1) {
    const expected = Math.sign(i - j);
    assert.equal(Math.sign(compareVersions(ascending[i], ascending[j])), expected, `${ascending[i]} vs ${ascending[j]}`);
  }
}
assert.ok(compareVersions('1.10', '1.9') > 0, 'digit runs compare as numbers');
assert.ok(compareVersions('release-2', 'release-10') < 0);
assert.ok(compareVersions('v1.0.0-rc', 'v1.0.1') < 0, 'a pre-release is older than the next patch');
assert.ok(compareVersions('v1.0.0', 'v1.0.0-hotfix') < 0, 'a non-pre-release tail is newer');
assert.equal(compareVersions('v1.2.3', 'v1.2.3'), 0);
assert.ok(compareVersions('v99999999999999999999.0', 'v99999999999999999998.0') > 0, 'numbers beyond 2^53 still order');

const tags = [
  { name: 'v1.2.0', date: 3000 }, { name: 'latest', date: 9000 }, { name: 'v1.10.0', date: 1000 },
  { name: 'v1.10.0-rc1', date: 500 }, { name: 'stable', date: null }, { name: 'v0.9', date: 2000 }
];
assert.deepEqual(sortTags(tags, 'version').map(tag => tag.name), ['v1.10.0', 'v1.10.0-rc1', 'v1.2.0', 'v0.9', 'latest', 'stable'],
  'newest version first; tags without a number after every versioned one, by name');
assert.deepEqual(sortTags(tags, 'date').map(tag => tag.name), ['latest', 'v1.2.0', 'v0.9', 'v1.10.0', 'v1.10.0-rc1', 'stable'],
  'newest first; an unknown date goes last');
assert.deepEqual(sortTags(tags, 'name').map(tag => tag.name), ['latest', 'stable', 'v0.9', 'v1.10.0', 'v1.10.0-rc1', 'v1.2.0']);
assert.notEqual(sortTags(tags, 'name'), tags, 'sorting returns a new array');
assert.deepEqual(TAG_SORTS.map(sort => sort.id), ['version', 'date', 'name']);
{
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.equal(readTagSort(storage), 'version', 'version is the default');
  writeTagSort(storage, 'date'); assert.equal(readTagSort(storage), 'date');
  writeTagSort(storage, 'bogus'); assert.equal(readTagSort(storage), 'date', 'an unknown order is not saved');
  store.set('twig:tag-sort', 'bogus'); assert.equal(readTagSort(storage), 'version');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(readTagSort(broken), 'version'); writeTagSort(broken, 'name');
  assert.equal(readTagSort(null), 'version');
}

// --- parser, no Git --------------------------------------------------------------------------
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const record = fields => `${fields.join('\0')}\0`;
{
  const output = [
    record(['refs/tags/light', 'commit', A, '', '', '', '1700000000', 'Commit subject', 'Commit body\n', '']),
    record(['refs/tags/v1', 'tag', B, A, 'Tagger', '<tagger@example.invalid>', '1700000100', 'Release 1', 'Line one\n\nLine two\n', '-----BEGIN PGP SIGNATURE-----\n...\n'])
  ].join('\n') + '\n';
  assert.deepEqual(parseTagDetails(output), [
    { name: 'light', fullName: 'refs/tags/light', target: A, annotated: false, tagger: null, date: 1700000000000, subject: '', body: '', signed: false },
    { name: 'v1', fullName: 'refs/tags/v1', target: A, annotated: true, tagger: { name: 'Tagger', email: 'tagger@example.invalid' },
      date: 1700000100000, subject: 'Release 1', body: 'Line one\n\nLine two', signed: true }
  ], 'a lightweight tag does not borrow its commit message; an annotated one keeps its multi-line body');
  assert.deepEqual(parseTagDetails(''), []);
  for (const bad of [output.slice(0, -1), `${record(['refs/heads/main', 'commit', A, '', '', '', '1', '', '', ''])}\n`,
    `${record(['refs/tags/x', 'blob?', A, '', '', '', '1', '', '', ''])}\n`, `${record(['refs/tags/x', 'commit', 'nope', '', '', '', '1', '', '', ''])}\n`,
    `${record(['refs/tags/x', 'commit', A])}\n`, 42]) {
    assert.throws(() => parseTagDetails(bad), RefsParseError);
  }
}
assert.deepEqual(buildTagDetailsArgv().slice(-1), ['refs/tags'], 'only tags are read');

// --- a real repository -----------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-tags-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, stdin = null) => { const result = await runGit({ cwd, log, argv, stdin }); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'a.txt'), 'a\n');
  await git(['add', '.']); await git(['commit', '-m', 'First commit', '-m', 'Its body must not show on a lightweight tag']);
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['tag', 'v1.9.0']);
  await git(['tag', '--annotate', '--file=-', 'v1.10.0'], 'Release 1.10\n\nHighlights:\n- one\n- two\n');
  await git(['tag', '--annotate', '--file=-', 'v1.10.0-rc1'], 'Candidate\n');
  await git(['tag', '--annotate', '--file=-', 'nested/tag'], 'Nested\n');

  const details = await loadTagDetails({ cwd, log });
  const byName = Object.fromEntries(details.map(tag => [tag.name, tag]));
  assert.deepEqual(Object.keys(byName).sort(), ['nested/tag', 'v1.10.0', 'v1.10.0-rc1', 'v1.9.0']);
  assert.equal(byName['v1.9.0'].annotated, false);
  assert.equal(byName['v1.9.0'].subject, '', 'the commit subject is not shown as the tag message');
  assert.equal(byName['v1.10.0'].annotated, true);
  assert.equal(byName['v1.10.0'].subject, 'Release 1.10');
  assert.equal(byName['v1.10.0'].body, 'Highlights:\n- one\n- two');
  assert.deepEqual(byName['v1.10.0'].tagger, { name: 'Twig Test', email: 'test@example.invalid' });
  assert.equal(byName['v1.10.0'].target, head, 'an annotated tag points at its commit, not at the tag object');
  assert.ok(Number.isFinite(byName['v1.10.0'].date));
  assert.equal(byName['v1.10.0'].signed, false);
  assert.deepEqual(sortTags(details, 'version').map(tag => tag.name), ['v1.10.0', 'v1.10.0-rc1', 'v1.9.0', 'nested/tag'],
    'Git\'s own tags in version order; the tag without a number last');
  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.match(journal, /Read tag messages/, 'the read is journaled like every Git call');

  // The screen reads the messages through the new bridge method, sorts, and searches them too.
  const screen = await readFile(new URL('../../renderer/src/features/refs/RefsScreen.jsx', import.meta.url), 'utf8');
  assert.match(screen, /window\.twig\.getTagDetails\(repository\.id\)/);
  assert.match(screen, /sortTags\(/);
  assert.match(screen, /Lightweight tag/);
  const preload = await readFile(new URL('../../preload/index.js', import.meta.url), 'utf8');
  assert.match(preload, /getTagDetails: \(id\) => ipcRenderer\.invoke\('refs:tags', id\)/);
  console.log('tags check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
