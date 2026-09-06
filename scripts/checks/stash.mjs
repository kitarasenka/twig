import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import {
  buildStashActionArgv, buildStashDiffArgv, buildStashListArgv, buildStashParentsArgv,
  buildStashTrackedArgv, buildStashUntrackedArgv, loadStashDiff, loadStashFiles, loadStashes,
  parseStashList, runStashAction
} from '../../main/git/stash.js';

// A stash is a commit with hidden parents and a reflog name that moves. None
// of that can be checked against a fixture, so this runs real Git.

// --- pure argv and parsing, no Git ---

assert.deepEqual(buildStashListArgv(), ['stash', 'list', '-z', '--format=%gd%x00%H%x00%P%x00%cI%x00%gs']);
const OID = 'a'.repeat(40);
assert.deepEqual(buildStashParentsArgv(OID), ['rev-list', '--parents', '-n', '1', OID, '--']);
assert.deepEqual(buildStashTrackedArgv(OID).slice(-3), [`${OID}^1`, OID, '--']);
assert.deepEqual(buildStashUntrackedArgv(OID).slice(-2), [`${OID}^3`, '--']);
assert.deepEqual(buildStashDiffArgv(OID, 'src/a.js').slice(-4), [`${OID}^1`, OID, '--', ':(literal)src/a.js']);
assert.equal(buildStashDiffArgv(OID, 'new.txt', true).includes(`${OID}^3`), true, 'an untracked file is read from the third parent');
for (const bad of ['', 'zz', 42, null, `${OID} --other`]) assert.throws(() => buildStashParentsArgv(bad), TypeError);
for (const bad of ['/abs', '../up', 'a\0b', '']) assert.throws(() => buildStashDiffArgv(OID, bad), TypeError);

assert.deepEqual(buildStashActionArgv('drop', 2), ['stash', 'drop', 'stash@{2}']);
assert.deepEqual(buildStashActionArgv('branch', 0, { name: 'fix/x' }), ['stash', 'branch', 'fix/x', 'stash@{0}']);
for (const bad of ['reset', 'clear', 'push', '', null]) assert.throws(() => buildStashActionArgv(bad, 0), TypeError);
for (const bad of [-1, 1.5, '0', null]) assert.throws(() => buildStashActionArgv('drop', bad), TypeError);
for (const bad of ['-D', '', 'has space', 'a..b', 'x@{1}', null]) {
  assert.throws(() => buildStashActionArgv('branch', 0, { name: bad }), TypeError, `branch name ${String(bad)} must be rejected`);
}

const listed = parseStashList([
  'stash@{0}', 'b'.repeat(40), `${'a'.repeat(40)} ${'d'.repeat(40)}`, '2026-09-05T23:44:33+04:00', 'On main: keep this',
  'stash@{1}', 'c'.repeat(40), 'e'.repeat(40), '2026-09-05T20:00:00+04:00', 'WIP on feat/x: 1234567 subject'
].join('\0') + '\0');
assert.equal(listed.length, 2);
assert.deepEqual(listed[0], { index: 0, ref: 'stash@{0}', oid: 'b'.repeat(40), base: 'a'.repeat(40), date: '2026-09-05T23:44:33+04:00',
  branch: 'main', message: 'keep this', subject: 'On main: keep this' });
assert.equal(listed[1].base, 'e'.repeat(40));
assert.equal(listed[1].branch, 'feat/x');
assert.equal(listed[1].message, '1234567 subject');
assert.deepEqual(parseStashList(''), []);
assert.throws(() => parseStashList('stash@{0}\0abc\0'), /Invalid stash list output/);
assert.throws(() => parseStashList(`stash@{1}\0${'b'.repeat(40)}\0\0d\0s\0`), /Unexpected stash order/);
assert.throws(() => parseStashList(`stash@{0}\0not-an-oid\0\0d\0s\0`), /Invalid stash identifier/);
assert.throws(() => parseStashList(`stash@{0}\0${'b'.repeat(40)}\0bad-parent\0d\0s\0`), /Invalid stash identifier/);

// --- real repository ---

const root = await mkdtemp(path.join(tmpdir(), 'twig-stash-check-'));
const log = new CommandLog(root);

try {
  await log.load();
  const repo = path.join(root, 'work');
  await mkdir(repo, { recursive: true });
  const git = async (argv, allowFailure = false) => {
    const result = await runGit({ argv, cwd: repo, log, operation: 'check' });
    if (!allowFailure) assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result;
  };
  const write = (file, body) => writeFile(path.join(repo, file), body);

  await git(['init', '-q', '-b', 'main', '.']);
  await git(['config', 'user.email', 'check@example.invalid']);
  await git(['config', 'user.name', 'Twig Check']);
  await write('a.txt', 'one\n');
  await write('b.txt', 'base\n');
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'base']);
  const baseSha = (await git(['rev-parse', 'HEAD'])).stdout.trim();

  // 1. Two stashes, one of them carrying an untracked file.
  await write('a.txt', 'one\ntwo\n');
  await write('c.txt', 'brand new\n');
  await git(['stash', 'push', '--include-untracked', '--message', 'first work']);
  await write('b.txt', 'base\nmore\n');
  await git(['stash', 'push', '--message', 'second work']);

  const stashes = await loadStashes({ cwd: repo, log });
  assert.equal(stashes.length, 2);
  assert.deepEqual(stashes.map(entry => entry.index), [0, 1]);
  assert.equal(stashes[0].message, 'second work');
  assert.equal(stashes[1].message, 'first work');
  assert.equal(stashes[0].branch, 'main');
  assert.equal(stashes[0].base, baseSha, 'a stash records the commit it was based on');
  assert.equal(stashes[1].base, baseSha);

  // 2. Both sides of a stash: the tracked diff and the untracked tree.
  const files = await loadStashFiles({ cwd: repo, log, oid: stashes[1].oid });
  assert.deepEqual(files, [
    { status: 'M', path: 'a.txt', untracked: false },
    { status: 'A', path: 'c.txt', untracked: true }
  ], 'an untracked file in a stash is listed and marked');
  assert.deepEqual(await loadStashFiles({ cwd: repo, log, oid: stashes[0].oid }),
    [{ status: 'M', path: 'b.txt', untracked: false }], 'a stash without ^3 lists only tracked changes');

  const tracked = await loadStashDiff({ cwd: repo, log, oid: stashes[1].oid, file: 'a.txt' });
  assert.match(tracked.patch, /^\+two$/m);
  assert.equal(tracked.binary, false);
  const untracked = await loadStashDiff({ cwd: repo, log, oid: stashes[1].oid, file: 'c.txt', untracked: true });
  assert.match(untracked.patch, /new file mode/);
  assert.match(untracked.patch, /^\+brand new$/m);

  // 3. The index guard: an object id that no longer sits at that index is refused.
  const stale = await runStashAction({ cwd: repo, log, action: 'drop', index: 0, expectedOid: stashes[1].oid });
  assert.deepEqual(stale, { ok: false, message: 'The stash list changed since it was read. Refresh and try again.' });
  assert.equal((await loadStashes({ cwd: repo, log })).length, 2, 'the refused action changed nothing');

  // 4. Apply keeps the stash, and the work comes back.
  const applied = await runStashAction({ cwd: repo, log, action: 'apply', index: 1, expectedOid: stashes[1].oid });
  assert.deepEqual(applied, { ok: true, message: null });
  assert.equal((await git(['show', ':a.txt'])).stdout.includes('two') || (await git(['diff', '--name-only'])).stdout.includes('a.txt'), true);
  assert.equal((await loadStashes({ cwd: repo, log })).length, 2, 'apply leaves the stash in the list');
  await git(['checkout', '--', '.']);
  await rm(path.join(repo, 'c.txt'), { force: true });

  // 5. Drop renumbers the rest, which is exactly why the guard exists.
  const dropped = await runStashAction({ cwd: repo, log, action: 'drop', index: 0, expectedOid: stashes[0].oid });
  assert.deepEqual(dropped, { ok: true, message: null });
  const afterDrop = await loadStashes({ cwd: repo, log });
  assert.equal(afterDrop.length, 1);
  assert.equal(afterDrop[0].oid, stashes[1].oid);
  assert.equal(afterDrop[0].index, 0, 'the surviving stash moved to index 0');

  // 6. `stash branch` restores the work on a new branch and consumes the stash.
  const branched = await runStashAction({ cwd: repo, log, action: 'branch', index: 0, expectedOid: afterDrop[0].oid, name: 'fix/from-stash' });
  assert.deepEqual(branched, { ok: true, message: null });
  assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'fix/from-stash');
  assert.deepEqual(await loadStashes({ cwd: repo, log }), [], 'the stash is consumed once it is restored');

  // 7. Pop on an empty list is a real failure, not a silent success.
  const empty = await runStashAction({ cwd: repo, log, action: 'pop', index: 0, expectedOid: afterDrop[0].oid });
  assert.equal(empty.ok, false);
  assert.match(empty.message, /changed since it was read/);

  console.log('stash check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
