import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, utimes, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { captureState } from '../../main/git/undo-snapshot.js';
import { INDEX_KINDS, UNDOABLE_KINDS, buildUndoPlan, inverseReason, undoLabel } from '../../main/git/undo-plan.js';
import { discardFile, loadDiscards, restoreDiscard } from '../../main/git/discard.js';
import { finishFirst, stepNote } from '../../main/git/operation-words.js';
import { syncFinished, syncRunning, syncWait } from '../../renderer/src/app/sync-words.js';
import { createCommit, rewordHead, stashPop, stashPush } from '../../main/git/commit-ops.js';
import { createBranch, checkout } from '../../main/git/refs-ops.js';
import { merge, revert } from '../../main/git/history-ops.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-undo-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  let undo = new UndoService({ directory: root, log }); await undo.load();
  const options = { cwd, log };
  const git = async argv => { const result = await runGit({ ...options, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  await git(['init', '--initial-branch=main']);
  options.gitDir = await git(['rev-parse', '--absolute-git-dir']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const state = () => captureState(options);
  const run = (kind, args, action) => undo.perform(cwd, kind, args, action);
  const move = direction => undo.move(cwd, direction, async () => true);
  await writeFile(path.join(cwd, 'one.txt'), 'one\n'); await git(['add', '--', 'one.txt']);
  const unborn = await state();
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'Root' }));
  const first = await state(); await move('undo'); assert.equal((await state()).shape, unborn.shape);
  assert.throws(() => buildUndoPlan({ kind: 'worktree:commit', before: { ...unborn, head: '--bad' }, after: first, args: [] }, 'undo'));
  await move('redo'); assert.equal((await state()).shape, first.shape);
  await writeFile(path.join(cwd, 'one.txt'), 'two\n'); await git(['add', '--', 'one.txt']);
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'Second' }));
  const second = await state();
  await move('undo'); assert.equal(await git(['rev-parse', 'HEAD']), first.head);
  undo = new UndoService({ directory: root, log }); await undo.load();
  assert.equal((await undo.inspect(cwd)).redo, true); await move('redo'); assert.equal((await state()).shape, second.shape);
  // A reword is undone like a commit — a soft reset back to the commit that
  // was rewritten — and the message itself is never written to the journal.
  await run('ops:reword', [second.head, 'Second, reworded'], () => rewordHead({ ...options, message: 'Second, reworded', expectedOid: second.head }));
  const reworded = await state(); assert.equal(await git(['log', '-1', '--format=%s']), 'Second, reworded');
  assert.ok(!(await readFile(path.join(root, 'operations.json'), 'utf8')).includes('Second, reworded'), 'the Undo journal stores no commit messages');
  await move('undo'); assert.equal((await state()).shape, second.shape); assert.equal(await git(['log', '-1', '--format=%s']), 'Second');
  await move('redo'); assert.equal((await state()).shape, reworded.shape);
  await move('undo'); assert.equal((await state()).shape, second.shape);
  await run('refs:create-branch', ['feature', second.head, true], () => createBranch({ ...options, name: 'feature', startPoint: second.head, checkout: true }));
  const branch = await state(); await move('undo'); assert.equal((await state()).shape, second.shape);
  await move('redo'); assert.equal((await state()).shape, branch.shape);
  await run('refs:checkout', [], () => checkout({ ...options, target: 'main', detach: false }));
  const checked = await state(); await move('undo'); assert.equal((await state()).shape, branch.shape); await move('redo'); assert.equal((await state()).shape, checked.shape);
  await writeFile(path.join(cwd, 'one.txt'), 'staged\n'); await git(['add', '--', 'one.txt']);
  await writeFile(path.join(cwd, 'one.txt'), 'unstaged\n'); await writeFile(path.join(cwd, 'new.txt'), 'untracked\n');
  const dirty = await state();
  await run('stash:push', [true, 'Saved changes'], () => stashPush({ ...options, includeUntracked: true, message: 'Saved changes' }));
  await move('undo'); assert.equal((await state()).shape, dirty.shape);
  await move('redo'); const shelved = await state();
  await run('stash:pop', [], () => stashPop(options)); const popped = await state();
  await move('undo'); assert.equal((await state()).shape, shelved.shape);
  await move('redo'); assert.equal((await state()).shape, popped.shape);
  await move('undo'); await move('undo'); assert.equal((await state()).shape, dirty.shape, 'Undo chain must work across restored stash identity');
  assert.equal(await readFile(path.join(cwd, 'one.txt'), 'utf8'), 'unstaged\n', 'the file is back with its content');
  assert.equal(await readFile(path.join(cwd, 'new.txt'), 'utf8'), 'untracked\n');
  await run('stash:push', [true, 'Apply fixture'], () => stashPush({ ...options, includeUntracked: true, message: 'Apply fixture' }));
  const beforeApply = await state();
  await run('stash:apply', [], () => git(['stash', 'apply'])); const applied = await state();
  await move('undo'); assert.equal((await state()).shape, beforeApply.shape);
  await move('redo'); assert.equal((await state()).shape, applied.shape);
  await git(['reset', '--hard', second.head]); await rm(path.join(cwd, 'new.txt'), { force: true });
  await git(['checkout', 'feature', '--']);
  await writeFile(path.join(cwd, 'feature.txt'), 'feature\n'); await git(['add', '--', 'feature.txt']); await git(['commit', '-m', 'Feature']);
  await git(['checkout', 'main', '--']);
  const beforeMerge = await state();
  await run('ops:merge', [], () => merge({ ...options, revision: 'feature', noFf: true })); const merged = await state();
  let asked = false;
  await undo.move(cwd, 'undo', async plan => { asked = true; assert.equal(plan.destructive, true); return false; });
  assert.ok(asked); assert.equal((await state()).shape, merged.shape);
  await move('undo'); assert.equal((await state()).shape, beforeMerge.shape); await move('redo'); assert.equal((await state()).shape, merged.shape);
  const target = await git(['rev-parse', 'feature']);
  await run('ops:revert', [], () => revert({ ...options, oid: target, mainline: null })); const reverted = await state();
  await move('undo'); assert.equal((await state()).shape, merged.shape); await move('redo'); assert.equal((await state()).shape, reverted.shape);
  await writeFile(path.join(cwd, 'external.txt'), 'external edit\n');
  assert.equal((await undo.inspect(cwd)).undo, false);
  await assert.rejects(move('undo'), /changed outside/);
  assert.equal(await readFile(path.join(cwd, 'external.txt'), 'utf8'), 'external edit\n');
  await run('sync:run', ['push'], async () => ({ ok: true }));
  assert.match((await undo.inspect(cwd)).undoReason, /published/);
  await assert.rejects(undo.move(cwd, 'bad', async () => true), TypeError);
  assert.ok(log.list().some(entry => entry.operation.startsWith('Undo')));

  // An action Undo cannot reverse, with no chain to end, takes no snapshot:
  // each one reads every changed file and the whole index. With a chain, it does.
  const checks = () => log.list().filter(entry => entry.operation === 'Background: Undo safety check').length;
  const quiet = checks();
  await writeFile(path.join(cwd, 'staged.txt'), 'staged\n');
  await run('worktree:stage', ['staged.txt'], () => git(['add', '--', 'staged.txt']));
  assert.equal(checks(), quiet, 'no snapshot around staging when there is nothing to undo');
  assert.match((await undo.inspect(cwd)).undoReason, /Undo does not reverse staging/, 'the Undo button still says why');
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'Staged file' }));
  const chained = checks();
  await writeFile(path.join(cwd, 'staged.txt'), 'staged again\n');
  await run('worktree:stage', ['staged.txt'], () => git(['add', '--', 'staged.txt']));
  assert.ok(checks() > chained, 'with a chain, staging is checked against it');
  assert.equal((await undo.inspect(cwd)).undo, true, 'and a commit does not depend on the index');
  await git(['commit', '-m', 'Staged file again']);

  // A large file is fingerprinted by its metadata instead of read: an edit is
  // still seen, even one that keeps the size and puts the mtime back.
  const large = path.join(cwd, 'dataset.bin');
  await writeFile(large, Buffer.alloc(2 * 1024 * 1024, 1));
  const largeBefore = await state();
  const { atime, mtime } = await stat(large);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(large, Buffer.alloc(2 * 1024 * 1024, 2));
  await utimes(large, atime, mtime);
  assert.notEqual((await state()).digest, largeBefore.digest, 'a same-size rewrite with the old mtime still changes the digest');
  const largeAfter = await state();
  assert.equal((await state()).digest, largeAfter.digest, 'and an untouched large file keeps it');

  // A small file is no longer read either: any write moves its change time,
  // even one that keeps the size and puts the modification time back.
  const small = path.join(cwd, 'small.txt');
  await writeFile(small, 'aaaa\n');
  const smallBefore = await state();
  const times = await stat(small);
  await new Promise(resolve => setTimeout(resolve, 20));
  await writeFile(small, 'bbbb\n');
  await utimes(small, times.atime, times.mtime);
  assert.notEqual((await state()).digest, smallBefore.digest, 'a same-size rewrite of a small file changes the digest');
  assert.equal((await state()).shape, smallBefore.shape, 'while Git itself sees no difference');
  await writeFile(small, 'cccc\n');
  assert.notEqual((await state()).digest, smallBefore.digest, 'a plain edit changes it too');
  await rm(small); await rm(large);

  // Each entry checks only what its inverse depends on (undoScope).
  const fresh = async () => {
    undo = new UndoService({ directory: await mkdtemp(path.join(root, 'state-')), log }); await undo.load();
    await git(['add', '--all']); await git(['commit', '-m', 'Clean slate', '--allow-empty']);
  };
  const tip = () => git(['rev-parse', 'HEAD']);
  const reason = async () => (await undo.inspect(cwd)).undoReason;

  // A commit survives staging, an unrelated edit and an unrelated new file.
  await fresh();
  await writeFile(path.join(cwd, 'c.txt'), 'c\n'); await git(['add', '--', 'c.txt']);
  const parent = await tip();
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'Commit to undo' }));
  const committed = await tip();
  assert.equal(await reason(), `Undo commit ${committed.slice(0, 7)}`, 'the tooltip is a phrase, not a channel name');
  await writeFile(path.join(cwd, 'other.txt'), 'other\n');
  await run('worktree:stage', ['other.txt'], () => git(['add', '--', 'other.txt']));
  await writeFile(path.join(cwd, 'saved-elsewhere.txt'), 'x\n');
  assert.equal((await undo.inspect(cwd)).undo, true, 'staging and unrelated files leave a commit undoable');
  await move('undo');
  assert.equal(await tip(), parent); assert.match(await git(['status', '--porcelain', '--', 'other.txt']), /^A/, 'what was staged stays staged');
  assert.equal((await undo.inspect(cwd)).redoReason, `Redo commit ${committed.slice(0, 7)}`);
  await move('redo'); assert.equal(await tip(), committed);
  // A ref moved from outside still ends it.
  await git(['commit', '-m', 'From a terminal']);
  assert.equal((await undo.inspect(cwd)).undo, false);
  assert.match(await reason(), /changed outside/);

  // A discard survives the same, and comes back byte for byte.
  await fresh();
  await writeFile(path.join(cwd, 'd.txt'), 'kept\n'); await writeFile(path.join(cwd, 'e.txt'), 'kept\n'); await git(['add', '--all']); await git(['commit', '-m', 'Two files']);
  await writeFile(path.join(cwd, 'd.txt'), 'two hundred lines of work\n');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'd.txt', section: 'unstaged' }));
  assert.equal(await reason(), 'Undo the discard of 1 file');
  await writeFile(path.join(cwd, 'e.txt'), 'next file\n');
  await run('worktree:stage', ['e.txt'], () => git(['add', '--', 'e.txt']));
  await writeFile(path.join(cwd, 'saved-in-editor.txt'), 'x\n');
  assert.equal((await undo.inspect(cwd)).undo, true, 'staging another file and saving another file leave Undo on');
  await move('undo');
  assert.equal(await readFile(path.join(cwd, 'd.txt'), 'utf8'), 'two hundred lines of work\n');
  await move('redo'); assert.equal(await readFile(path.join(cwd, 'd.txt'), 'utf8'), 'kept\n');
  await move('undo');

  // Two discards of one file: the second's Undo rewrites the file, with new
  // times and the content the first one left, and the first still undoes.
  await fresh();
  await writeFile(path.join(cwd, 'g.txt'), 'one\ntwo\n'); await git(['add', '--all']); await git(['commit', '-m', 'g']);
  await writeFile(path.join(cwd, 'g.txt'), 'first edit\ntwo\n');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'g.txt', section: 'unstaged' }));
  await writeFile(path.join(cwd, 'g.txt'), 'one\nsecond edit\n');
  assert.equal((await undo.inspect(cwd)).undo, false, 'an edit of a discarded path is not overwritten');
  assert.match(await reason(), /cannot put it back safely.*Discarded changes/, 'and the reason says where the backup is');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'g.txt', section: 'unstaged' }));
  await writeFile(path.join(cwd, 'g.txt'), 'third edit\ntwo\n');
  await new Promise(resolve => setTimeout(resolve, 5));
  await writeFile(path.join(cwd, 'g.txt'), 'one\ntwo\n');
  assert.equal((await undo.inspect(cwd)).undo, true, 'a file saved back to what the discard left is still what it left');

  await fresh();
  await writeFile(path.join(cwd, 'h.txt'), 'base\n'); await git(['add', '--all']); await git(['commit', '-m', 'h']);
  await writeFile(path.join(cwd, 'h.txt'), 'edit A\n');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'h.txt', section: 'unstaged' }));
  await writeFile(path.join(cwd, 'h.txt'), 'base\n');
  await run('worktree:stage', ['h.txt'], () => git(['add', '--', 'h.txt']));
  await writeFile(path.join(cwd, 'i.txt'), 'i\n'); await git(['add', '--', 'i.txt']);
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'On top of a discard' }));
  await move('undo'); await move('undo');
  assert.equal(await readFile(path.join(cwd, 'h.txt'), 'utf8'), 'edit A\n', 'a discard under a commit undoes after it: refs/twig/discard does not count');
  await git(['reset', '--hard']); await rm(path.join(cwd, 'i.txt'), { force: true });

  // A stale Redo goes alone: the commit under it can still be undone.
  await fresh();
  await writeFile(path.join(cwd, 'j.txt'), 'j\n'); await git(['add', '--all']);
  await run('worktree:commit', [], () => createCommit({ ...options, message: 'Under a discard' }));
  await writeFile(path.join(cwd, 'j.txt'), 'j edit\n');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'j.txt', section: 'unstaged' }));
  await move('undo');
  await writeFile(path.join(cwd, 'j.txt'), 'j edit, continued\n');
  const after = await undo.inspect(cwd);
  assert.equal(after.undo, true); assert.equal(after.redo, false, 'the edit makes the Redo unsafe, and only that');
  await move('undo');
  await git(['reset', '--hard']); await git(['clean', '-fd']);

  // A discard Undo no longer reaches is listed, and restored by its id alone.
  await fresh();
  await writeFile(path.join(cwd, 'k.txt'), 'k\n'); await git(['add', '--all']); await git(['commit', '-m', 'k']);
  await writeFile(path.join(cwd, 'k.txt'), 'lost work\n'); await writeFile(path.join(cwd, 'l.txt'), 'lost new file\n');
  await run('worktree:discard', ['unstaged'], () => discardFile({ ...options, path: 'k.txt', section: 'unstaged' }));
  await run('worktree:discard', ['untracked'], () => discardFile({ ...options, path: 'l.txt', section: 'untracked' }));
  await run('sync:run', ['push'], async () => ({ ok: true }));
  assert.equal((await undo.inspect(cwd)).undo, false);
  await writeFile(path.join(cwd, 'k.txt'), 'newer work\n');
  const discards = await loadDiscards(options);
  assert.deepEqual(discards.slice(0, 2).map(item => item.files), [['l.txt'], ['k.txt']], 'newest first, one entry per discard');
  assert.ok(discards.every(item => item.count === item.files.length && /^[0-9a-f]{40}$/.test(item.id) && item.at > 0));
  await run('worktree:restore-discard', [], () => restoreDiscard({ ...options, id: discards[1].id }));
  assert.equal(await readFile(path.join(cwd, 'k.txt'), 'utf8'), 'lost work\n');
  assert.equal(await reason(), 'Undo restoring 1 file');
  await move('undo'); assert.equal(await readFile(path.join(cwd, 'k.txt'), 'utf8'), 'newer work\n', 'Undo puts back what Restore replaced');
  await move('redo'); assert.equal(await readFile(path.join(cwd, 'k.txt'), 'utf8'), 'lost work\n');
  await move('undo');
  await run('worktree:restore-discard', [], () => restoreDiscard({ ...options, id: discards[0].id }));
  assert.equal(await readFile(path.join(cwd, 'l.txt'), 'utf8'), 'lost new file\n', 'a deleted untracked file comes back');
  await move('undo');
  await assert.rejects(stat(path.join(cwd, 'l.txt')), /ENOENT/, 'and Undo takes a file Restore created away again');
  await assert.rejects(restoreDiscard({ ...options, id: second.head }), /no longer kept/, 'a commit that is not a backup is refused');
  assert.ok(!(await loadDiscards(options)).some(item => item.files.length === 0), 'the records of a Restore are not listed as discards');

  // Checks asked for at once run once.
  await fresh();
  await writeFile(path.join(cwd, 'm.txt'), 'm\n'); await git(['add', '--all']);
  await run('stash:push', [true, 'Whole scope'], () => stashPush({ ...options, includeUntracked: true, message: 'Whole scope' }));
  const counted = checks();
  const answers = await Promise.all(Array.from({ length: 5 }, () => undo.inspect(cwd)));
  assert.equal(new Set(answers).size, 1, 'five callers, one answer');
  assert.equal(checks() - counted, 4, 'one snapshot, not five');
  await move('undo'); await git(['reset', '--hard']); await rm(path.join(cwd, 'm.txt'), { force: true });

  // The journal keeps no path lists; a pop keeps the ones its Undo names.
  await fresh();
  await Promise.all(Array.from({ length: 50 }, (_, index) => writeFile(path.join(cwd, `bulk-${index}.txt`), 'x\n')));
  await run('refs:create-tag', ['many-files', await tip()], async () => { await git(['tag', 'many-files']); return { ok: true, undo: ['many-files', await tip()] }; });
  const journal = await readFile(undo.file, 'utf8');
  assert.ok(!journal.includes('bulk-1.txt'), 'operations.json does not list changed files');
  assert.match(journal, /"count":50/);
  await move('undo');
  await Promise.all(Array.from({ length: 50 }, (_, index) => rm(path.join(cwd, `bulk-${index}.txt`))));

  // A journal from before this format ends its chain in words, and an empty
  // state keeps nothing of the old wording.
  const old = await mkdtemp(path.join(root, 'old-'));
  await writeFile(path.join(old, 'operations.json'), JSON.stringify([
    [cwd, { undo: [{ kind: 'worktree:commit', args: [], before: { paths: [] }, after: { digest: 'x', paths: ['a'] } }], redo: [], reason: '' }],
    ['/elsewhere', { undo: [], redo: [], reason: 'worktree stage ends the Undo chain.' }]]));
  const upgraded = new UndoService({ directory: old, log }); await upgraded.load();
  const last = await upgraded.inspect(cwd);
  assert.equal(last.undo, false); assert.match(last.undoReason, /was updated/);
  assert.match((await upgraded.inspect('/elsewhere')).undoReason, /No application actions to undo/);

  // Words on the two buttons, and no channel name in any of them.
  const empty = new UndoService({ directory: await mkdtemp(path.join(root, 'empty-')), log }); await empty.load();
  const idle = await empty.inspect(cwd);
  assert.match(idle.undoReason, /to undo/); assert.match(idle.redoReason, /to redo/, 'Redo says redo');
  const none = { operation: 'none', clean: true, paths: [], head: null, branch: null };
  for (const kind of [...INDEX_KINDS, 'ops:reset', 'ops:sequencer', 'refs:delete-branch', 'refs:rename-branch', 'refs:upstream', 'refs:delete-tag', 'bisect:run', 'conflict:save',
    'conflict:take', 'conflict:resolve', 'sync:drop', 'remotes:add', 'maintenance:gc', 'something:new']) {
    const text = inverseReason(kind, none, none, []);
    assert.ok(text && !text.includes(kind) && !text.includes(kind.replace(':', ' ')), `${kind}: ${text}`);
  }
  // A mode or an operation's state file is not a word in a sentence.
  for (const kind of ['merge', 'cherry-pick', 'revert', 'rebase', 'am']) {
    assert.match(finishFirst(kind), /^Finish or abort /);
    for (const step of ['continue', 'abort']) assert.ok(stepNote(kind, step) && !/\bam\b/.test(stepNote(kind, step)), `${kind} ${step}`);
  }
  assert.equal(finishFirst('am'), 'Finish or abort applying the patches first.');
  assert.equal(syncFinished('push-upstream'), 'Push finished.');
  assert.equal(syncRunning('pop'), 'Stash pop is running');
  assert.equal(syncWait('push-upstream'), 'Wait for the push to finish');
  for (const file of ['app/App.jsx', 'features/graph/HistoryWorkspace.jsx', 'features/ops/commit-menu.js', 'features/refs/ref-menu.js', 'features/worktree/WorktreeScreen.jsx']) {
    const source = await readFile(new URL(`../../renderer/src/${file}`, import.meta.url), 'utf8');
    assert.ok(!/t`\$\{(?:mode|syncing|operation\.kind|busyOp)\}|the \$\{(?:operation\.kind|busyOp)\}|Wait for \$\{/.test(source), `${file} puts an internal name in a sentence`);
  }
  const head = 'a'.repeat(40);
  const states = { before: { ...none, head }, after: { ...none, head, branch: 'main' } };
  const entry = kind => ({ kind, ...states, args: ['name', head, true] });
  for (const kind of UNDOABLE_KINDS) {
    const args = kind.includes('discard') ? { paths: ['a.txt'], removed: [], before: head, after: head } : entry(kind).args;
    for (const direction of ['undo', 'redo']) {
      const text = undoLabel({ ...entry(kind), args }, direction);
      assert.ok(!text.includes(kind) && !/worktree |ops |refs |patch |reflog /.test(text) && /^(Undo|Redo) /.test(text), `${kind}: ${text}`);
    }
  }
  console.log('Undo checks passed: root/normal commit, persistence, branch, checkout, staged/untracked stash chains, merge/revert confirmations, redo, external edits and irreversible barrier, no snapshots without a chain, files by metadata, each entry checked on what its inverse depends on, staging and unrelated files keep the chain, discards listed and restored, one check in flight, no path lists in the journal, old journals, words on the buttons.');
} finally { await rm(root, { recursive: true, force: true }); }
