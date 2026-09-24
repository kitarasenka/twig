import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { addWorktree, buildWorktreeAddArgv, buildWorktreeRemoveArgv, findWorktree, folderName, loadWorktrees, parseWorktreeList, pruneWorktrees, removeWorktree, suggestWorktreePath } from '../../main/git/worktrees.js';
import { inverseReason } from '../../main/git/undo-plan.js';
import { UndoService } from '../../main/undo.js';
import { folderLabel, freeBranches, worktreeAddCommand, worktreeBadges, worktreeLine, worktreeRemoveCommand, worktreeRemoveReason } from '../../renderer/src/features/tools/tools-view.js';
import { buildRefMenu } from '../../renderer/src/features/refs/ref-menu.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

const A = 'a'.repeat(40);

// --- parsing and words --------------------------------------------------------------------------
const listed = parseWorktreeList(`worktree /r/app\0HEAD ${A}\0branch refs/heads/main\0\0worktree /r/app-hot fix\0HEAD ${A}\0detached\0locked moving disks\0\0worktree /r/gone\0HEAD ${A}\0branch refs/heads/old\0prunable gitdir file points to non-existent location\0\0`);
assert.deepEqual(listed.map(entry => [entry.path, entry.branch, entry.detached, entry.main, entry.locked, Boolean(entry.prunable)]), [
  ['/r/app', 'main', false, true, null, false], ['/r/app-hot fix', null, true, false, 'moving disks', false], ['/r/gone', 'old', false, false, null, true]]);
assert.throws(() => parseWorktreeList('HEAD abc\0\0'), /Invalid worktree list/);
assert.equal(folderName('feature/login fix'), 'feature-login-fix');
assert.equal(folderName('..'), 'worktree');
assert.equal(folderLabel('/r/app-hot fix/'), 'app-hot fix');
assert.equal(folderLabel('C:\\work\\app'), 'app');
assert.equal(worktreeLine(listed[1]), `Detached at ${A.slice(0, 7)}`);
assert.deepEqual(worktreeBadges({ ...listed[0], current: true }), ['Main', 'This tab']);
assert.match(worktreeRemoveReason(listed[0]), /main worktree/);
assert.match(worktreeRemoveReason(listed[1]), /Locked: moving disks/);
assert.match(worktreeRemoveReason(listed[2]), /Prune/);
assert.equal(worktreeRemoveReason({ ...listed[2], prunable: null }), undefined);
for (const request of [{ path: '/r/x', branch: 'hot' }, { path: '/r/x y', branch: 'new/b', create: true, startPoint: A }]) {
  assert.deepEqual(worktreeAddCommand(request), buildWorktreeAddArgv(request), 'the dialog shows what main runs');
}
assert.deepEqual(worktreeRemoveCommand('/r/x', true), buildWorktreeRemoveArgv('/r/x', true));
assert.throws(() => buildWorktreeAddArgv({ path: 'relative', branch: 'x' }), TypeError);
assert.throws(() => buildWorktreeAddArgv({ path: '/r/x', branch: '--force' }), TypeError);
assert.throws(() => buildWorktreeAddArgv({ path: '/r/x', branch: 'x', create: true, startPoint: 'HEAD' }), TypeError, 'a new branch starts at an object id');
assert.deepEqual(freeBranches([{ type: 'local', name: 'main' }, { type: 'local', name: 'side' }, { type: 'remote', name: 'origin/x' }], [{ branch: 'main' }]), ['side']);
assert.equal(isUserCommand('Read worktrees'), false);
assert.equal(isUserCommand('Add worktree for hot'), true);
assert.match(inverseReason('worktrees:add', { operation: 'none' }, { operation: 'none' }, []), /worktree ends the Undo chain/);
{
  const handlers = new Proxy({}, { get: () => () => {} });
  const menu = buildRefMenu({ ref: { type: 'local', name: 'side', fullName: 'refs/heads/side', target: A }, head: { branch: 'main', oid: A }, handlers });
  assert.ok(menu.find(item => item.key === 'worktree' && !item.reason), 'a branch offers Open in a new worktree');
  const current = buildRefMenu({ ref: { type: 'local', name: 'main', fullName: 'refs/heads/main', target: A }, head: { branch: 'main', oid: A }, handlers });
  assert.match(current.find(item => item.key === 'worktree').reason, /Already checked out here/);
}

// --- real Git -------------------------------------------------------------------------------------
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-worktrees-')));
try {
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const cwd = path.join(root, 'app');
  const git = async (argv, at = cwd) => { const result = await runGit({ cwd: at, log, argv }); assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
  for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'app.txt'), 'one\n'); await git(['add', '.']); await git(['commit', '-m', 'one']);
  await git(['branch', 'side']);
  const head = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'draft.txt'), 'work in progress\n');

  // Where a new worktree goes: next to the main one, numbered while taken.
  assert.equal(await suggestWorktreePath({ main: cwd, branch: 'hot/fix' }), `${cwd}-hot-fix`);
  await mkdir(`${cwd}-hot-fix`);
  assert.equal(await suggestWorktreePath({ main: cwd, branch: 'hot/fix' }), `${cwd}-hot-fix-2`);
  assert.equal(await suggestWorktreePath({ main: cwd, branch: 'x', parent: path.join(root, 'elsewhere') }), path.join(root, 'elsewhere', 'x'));

  // An existing branch, and a new one at HEAD.
  const sideFolder = `${cwd}-side`;
  assert.deepEqual(await addWorktree({ cwd, log, path: sideFolder, branch: 'side' }), { ok: true, message: null, path: sideFolder });
  assert.equal(await git(['branch', '--show-current'], sideFolder), 'side');
  assert.equal(await readFile(path.join(cwd, 'draft.txt'), 'utf8'), 'work in progress\n', 'the work in progress here is untouched: nothing was stashed');
  const hotFolder = path.join(root, 'hot fix');
  assert.equal((await addWorktree({ cwd, log, path: hotFolder, branch: 'hotfix/login', create: true, startPoint: head })).ok, true);
  assert.equal(await git(['rev-parse', 'hotfix/login']), head);
  const refused = await addWorktree({ cwd, log, path: path.join(root, 'twice'), branch: 'side' });
  assert.equal(refused.ok, false); assert.match(refused.message, /Git refused: .*side/, 'a branch checked out elsewhere is refused with Git’s reason');
  await assert.rejects(addWorktree({ cwd, log, path: `${cwd}-hot-fix`, branch: 'x', create: true, startPoint: head }), /already exists/);

  let worktrees = await loadWorktrees({ cwd, log });
  assert.deepEqual(worktrees.map(entry => [entry.path, entry.branch, entry.main, entry.current]), [[cwd, 'main', true, true], [sideFolder, 'side', false, false], [hotFolder, 'hotfix/login', false, false]]);
  assert.equal((await loadWorktrees({ cwd: sideFolder, log })).find(entry => entry.current).path, sideFolder, 'read from another worktree, that one is current');
  await assert.rejects(findWorktree({ cwd, log, path: path.join(root, 'not-a-worktree') }), TypeError, 'only worktrees Git lists can be opened or removed');

  // Removing: the main one and this tab's are refused; a dirty one needs --force.
  await assert.rejects(removeWorktree({ cwd: sideFolder, log, path: cwd }), /main worktree/);
  await assert.rejects(removeWorktree({ cwd, log, path: cwd }), /main worktree/);
  await assert.rejects(removeWorktree({ cwd: sideFolder, log, path: sideFolder }), /open in this tab/);
  await writeFile(path.join(sideFolder, 'unsaved.txt'), 'x\n');
  const dirty = await removeWorktree({ cwd, log, path: sideFolder });
  assert.equal(dirty.ok, false); assert.equal(dirty.dirty, true);
  assert.ok(await stat(sideFolder), 'refused: the folder is still there');
  assert.equal((await removeWorktree({ cwd, log, path: sideFolder, force: true })).ok, true);
  await assert.rejects(stat(sideFolder), /ENOENT/);
  assert.equal(await git(['rev-parse', 'side']), head, 'the branch and its commits stay');

  // A folder deleted behind Git's back is prunable, and prune forgets it.
  await rm(hotFolder, { recursive: true, force: true });
  worktrees = await loadWorktrees({ cwd, log });
  assert.ok(worktrees.find(entry => entry.path === hotFolder).prunable);
  assert.deepEqual(await pruneWorktrees({ cwd, log }), { ok: true, message: null });
  assert.equal((await loadWorktrees({ cwd, log })).length, 1);

  // Through the Undo service, adding a worktree is recorded as ending the chain honestly.
  const undo = new UndoService({ directory: path.join(root, 'undo'), log }); await undo.load();
  await undo.perform(cwd, 'worktrees:add', [], () => addWorktree({ cwd, log, path: path.join(root, 'third'), branch: 'third', create: true, startPoint: head }));
  const state = await undo.inspect(cwd);
  assert.equal(state.undo, false); assert.match(state.undoReason, /worktree ends the Undo chain/);
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Worktree checks passed: list parsing, words and shown commands, folder suggestion, add for an existing and a new branch without touching the work here, refusals, remove with and without --force, prune, Undo reason.');
