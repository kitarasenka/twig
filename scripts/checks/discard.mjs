import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { buildUndoPlan } from '../../main/git/undo-plan.js';
import { buildHistoryArgv, buildSearchArgv } from '../../main/git/history.js';
import { loadWorktreeDiff } from '../../main/git/worktree.js';
import { DISCARD_REF, discardCommand, discardInverse } from '../../main/git/discard-plan.js';
import { discardAll, discardFile, discardSelection } from '../../main/git/discard.js';

// --- the commands the dialog shows are the ones that run -------------------------------
assert.deepEqual(discardCommand('file', ['src/a b.js']), ['restore', '--worktree', '--', ':(literal)src/a b.js']);
assert.deepEqual(discardCommand('untracked', ['notes.txt']), ['clean', '-f', '--', ':(literal)notes.txt']);
assert.deepEqual(discardCommand('untracked', ['build/']), ['clean', '-f', '-d', '--', ':(literal)build/'], 'a folder needs -d');
assert.deepEqual(discardCommand('tracked'), ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul']);
assert.deepEqual(discardCommand('untracked-all', ['a', 'b/']), ['clean', '-f', '-d', '--', ':(literal)a', ':(literal)b/']);
assert.deepEqual(discardCommand('lines'), ['apply', '--reverse', '--whitespace=nowarn', '-']);
for (const bad of ['../x', '/etc/passwd', 'a\0b', 'a\nb', '', 42]) assert.throws(() => discardCommand('file', [bad]), TypeError, String(bad));
assert.throws(() => discardCommand('reset --hard'), TypeError);
{
  const inverse = { before: 'a'.repeat(40), after: 'b'.repeat(40), paths: ['x.txt', 'new.txt'], removed: ['new.txt'] };
  assert.deepEqual(discardInverse(inverse, 'undo'), [{ argv: ['restore', `--source=${'a'.repeat(40)}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
    stdin: ':(literal)x.txt\0:(literal)new.txt\0' }]);
  assert.deepEqual(discardInverse(inverse, 'redo'), [
    { argv: ['restore', `--source=${'b'.repeat(40)}`, '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], stdin: ':(literal)x.txt\0' },
    { argv: ['clean', '-f', '-d', '--', ':(literal)new.txt'] }]);
  const entry = (args) => ({ kind: 'worktree:discard', args, before: { head: null, branch: null, paths: [] }, after: { head: null, branch: null, paths: [] } });
  assert.equal(buildUndoPlan(entry(inverse), 'undo').destructive, false);
  for (const bad of [{ ...inverse, before: '--oops' }, { ...inverse, paths: ['../x'] }, { ...inverse, removed: ['other.txt'] }, { ...inverse, paths: [] }, null]) {
    assert.throws(() => buildUndoPlan(entry(bad), 'undo'), TypeError);
  }
}
// History never shows the backups.
assert.ok(buildHistoryArgv().indexOf('--exclude=refs/twig/*') < buildHistoryArgv().indexOf('--all'), 'the exclusion precedes --all, or Git ignores it');
assert.ok(buildSearchArgv('x').indexOf('--exclude=refs/twig/*') < buildSearchArgv('x').indexOf('--all'));

// --- on a real repository ------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-discard-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const undo = new UndoService({ directory: root, log }); await undo.load();
  const options = { cwd, log };
  const git = async (argv, stdin = null) => { const result = await runGit({ ...options, argv, stdin }); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  const read = file => readFile(path.join(cwd, file), 'utf8');
  const exists = file => lstat(path.join(cwd, file)).then(() => true, () => false);
  const write = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); };
  const status = async () => (await git(['status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean).sort();
  const run = action => undo.perform(cwd, 'worktree:discard', [], action);
  const move = direction => undo.move(cwd, direction, async () => true);

  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  await write('code.txt', `${lines.join('\n')}\n`);
  await write('gone.txt', 'will be deleted\n');
  await write('run.sh', '#!/bin/sh\necho hi\n'); await chmod(path.join(cwd, 'run.sh'), 0o755);
  await write('mixed.txt', 'one\ntwo\n');
  await git(['add', '.']); await git(['commit', '-m', 'Base']);
  const base = (await git(['rev-parse', 'HEAD'])).trim();

  // 1. One tracked file: only the unstaged part goes; what is staged stays.
  await write('mixed.txt', 'one STAGED\ntwo\n'); await git(['add', '--', 'mixed.txt']);
  await write('mixed.txt', 'one STAGED\ntwo UNSTAGED\n');
  const stagedBefore = await git(['diff', '--cached']);
  const one = await run(() => discardFile({ ...options, path: 'mixed.txt', section: 'unstaged' }));
  assert.equal(one.count, 1);
  assert.equal(await read('mixed.txt'), 'one STAGED\ntwo\n', 'the working tree returns to the index version');
  assert.equal(await git(['diff', '--cached']), stagedBefore, 'the staged part is untouched');
  assert.equal(await git(['show', `${one.backup}:mixed.txt`]), 'one STAGED\ntwo UNSTAGED\n', 'the discarded text is in the backup');
  assert.equal((await git(['rev-parse', DISCARD_REF])).trim(), one.undo.after, 'the hidden ref points at the latest record');
  assert.equal((await git(['rev-parse', `${one.undo.after}^`])).trim(), one.backup, 'backups chain, so older ones stay reachable');
  // The backups never reach the graph.
  const history = (await git(buildHistoryArgv({ limit: 50 }))).split('\0').filter(line => /^[0-9a-f]{40}$/.test(line));
  assert.ok(!history.includes(one.backup) && !history.includes(one.undo.after), 'history does not list backup commits');
  assert.equal((await git(['rev-parse', 'HEAD'])).trim(), base, 'HEAD did not move');
  await move('undo');
  assert.equal(await read('mixed.txt'), 'one STAGED\ntwo UNSTAGED\n', 'Undo brings the discarded change back');
  assert.equal(await git(['diff', '--cached']), stagedBefore);
  await move('redo');
  assert.equal(await read('mixed.txt'), 'one STAGED\ntwo\n', 'Redo discards it again');
  await move('undo');

  // 2. Untracked: a file and a folder are deleted; Undo restores both, still untracked.
  await write('notes.todo', 'my notes\n');
  await write('build/out/a.txt', 'a\n'); await write('build/b.txt', 'b\n');
  await run(() => discardFile({ ...options, path: 'notes.todo', section: 'untracked' }));
  assert.equal(await exists('notes.todo'), false);
  await move('undo');
  assert.equal(await read('notes.todo'), 'my notes\n');
  assert.ok((await status()).includes('?? notes.todo'), 'restored untracked, not staged');
  await run(() => discardFile({ ...options, path: 'build/', section: 'untracked' }));
  assert.equal(await exists('build/out/a.txt'), false);
  await move('undo');
  assert.equal(await read('build/out/a.txt'), 'a\n');
  assert.equal(await read('build/b.txt'), 'b\n');

  // 3. The whole Changes section: a modification, a deletion, an executable, a link.
  await write('code.txt', `${lines.map((line, i) => (i === 3 ? 'CHANGED' : line)).join('\n')}\n`);
  await rm(path.join(cwd, 'gone.txt'));
  await write('run.sh', '#!/bin/sh\necho changed\n');
  const before = await status();
  const all = await run(() => discardAll({ ...options, scope: 'tracked' }));
  assert.equal(all.count, 4, 'mixed.txt, code.txt, gone.txt and run.sh');
  assert.equal(await read('gone.txt'), 'will be deleted\n', 'a deleted file comes back');
  assert.equal(await read('code.txt'), `${lines.join('\n')}\n`);
  assert.deepEqual(await status(), ['M  mixed.txt', '?? build/b.txt', '?? build/out/a.txt', '?? notes.todo'].sort(), 'only the staged part and untracked files are left');
  await move('undo');
  assert.deepEqual(await status(), before, 'Undo restores every change, including the deletion');
  assert.equal(await exists('gone.txt'), false, 'the deleted file is deleted again — no-overlay restore');
  assert.equal((await lstat(path.join(cwd, 'run.sh'))).mode & 0o111, 0o111, 'the executable bit survives');
  assert.equal(await read('run.sh'), '#!/bin/sh\necho changed\n');

  // 4. The whole Untracked section.
  const untracked = await run(() => discardAll({ ...options, scope: 'untracked' }));
  assert.equal(untracked.count, 3);
  assert.deepEqual((await status()).filter(line => line.startsWith('??')), []);
  await move('undo');
  assert.equal((await status()).filter(line => line.startsWith('??')).length, 3);

  // 5. Selected lines: two separate edits, discard only the second.
  await git(['restore', '--worktree', '--', 'code.txt']);
  await write('code.txt', `${lines.map((line, i) => (i === 2 ? 'FIRST EDIT' : i === 25 ? 'SECOND EDIT' : line)).join('\n')}\n`);
  const diff = await loadWorktreeDiff({ ...options, path: 'code.txt' });
  assert.equal(diff.hunks.length, 2);
  const second = diff.hunks[1].lines.map((line, index) => (line.kind === 'context' ? -1 : index)).filter(index => index >= 0);
  const edited = await read('code.txt');
  await run(() => discardSelection({ ...options, path: 'code.txt', digest: diff.digest, selection: [{ index: 1, lines: second }] }));
  const kept = await read('code.txt');
  assert.ok(kept.includes('FIRST EDIT') && !kept.includes('SECOND EDIT') && kept.includes('line 26'), 'only the selected change was discarded');
  await move('undo');
  assert.equal(await read('code.txt'), edited, 'Undo restores the selected lines byte for byte');
  await assert.rejects(discardSelection({ ...options, path: 'code.txt', digest: 'stale', selection: [{ index: 0, lines: 'all' }] }), /changed since the diff was read/);
  const unchanged = await read('code.txt');
  assert.deepEqual(await discardSelection({ ...options, path: 'code.txt', digest: (await loadWorktreeDiff({ ...options, path: 'code.txt' })).digest, selection: [] }), { count: 0 });
  assert.equal(await read('code.txt'), unchanged, 'an empty selection discards nothing');

  // 6. Refusals: nothing is backed up or discarded.
  const ref = (await git(['rev-parse', DISCARD_REF])).trim();
  await assert.rejects(discardFile({ ...options, path: 'README-missing.md', section: 'unstaged' }), /nothing to discard/);
  await assert.rejects(discardFile({ ...options, path: 'code.txt', section: 'untracked' }), /nothing to discard/, 'a path must be in the section it is discarded from');
  await assert.rejects(discardFile({ ...options, path: '../outside', section: 'unstaged' }), TypeError);
  await assert.rejects(discardFile({ ...options, path: 'code.txt', section: 'staged' }), TypeError);
  await assert.rejects(discardAll({ ...options, scope: 'everything' }), TypeError);
  await write('intent.txt', 'new\n'); await git(['add', '-N', '--', 'intent.txt']);
  await assert.rejects(discardFile({ ...options, path: 'intent.txt', section: 'unstaged' }), /only marked for tracking/);
  await git(['rm', '--cached', '-q', '--', 'intent.txt']);
  if (process.platform !== 'win32') {
    await symlink('code.txt', path.join(cwd, 'link'));
    await run(() => discardFile({ ...options, path: 'link', section: 'untracked' }));
    assert.equal(await exists('link'), false);
    await move('undo');
    assert.equal((await lstat(path.join(cwd, 'link'))).isSymbolicLink(), true, 'a link is restored as a link');
  }
  assert.notEqual((await git(['rev-parse', DISCARD_REF])).trim(), ref, 'the link discard recorded its own backups');

  // A conflicted file refuses both the single and the section discard.
  await git(['add', '-A']); await git(['commit', '-m', 'Everything']);
  await git(['checkout', '-b', 'other']); await write('mixed.txt', 'other side\n'); await git(['commit', '-am', 'Other']);
  await git(['checkout', 'main']); await write('mixed.txt', 'main side\n'); await git(['commit', '-am', 'Main']);
  await runGit({ ...options, argv: ['merge', 'other'] });
  await assert.rejects(discardFile({ ...options, path: 'mixed.txt', section: 'unstaged' }), /conflict/);
  await assert.rejects(discardAll({ ...options, scope: 'tracked' }), /conflict/);
  assert.match(await read('mixed.txt'), /<<<<<<</, 'the conflict is untouched');
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Discard checks passed: dialog commands, file/section/lines/untracked/folder/link, staged part kept, hidden backups, Undo and Redo byte-exact, refusals.');
