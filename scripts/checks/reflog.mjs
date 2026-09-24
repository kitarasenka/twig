import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { buildUndoPlan } from '../../main/git/undo-plan.js';
import { buildReflogArgv, loadReflog, moveBranch, parseReflog } from '../../main/git/reflog.js';
import { moveBranchCommand, moveBranchInverse, reflogRef, splitReflogSubject } from '../../main/git/reflog-plan.js';
import { actionLabel, branchAt, shortenIds, moveBranchDialog, moveReason, relativeTime, suggestBranchName } from '../../renderer/src/features/reflog/reflog-view.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// --- argv and pure helpers, without Git ---------------------------------------------------
assert.deepEqual(buildReflogArgv().slice(-2), ['HEAD', '--'], 'HEAD by default, then --');
assert.deepEqual(buildReflogArgv({ branch: 'feature/x', skip: 200, limit: 50 }).slice(-4), ['--max-count=51', '--skip=200', 'refs/heads/feature/x', '--'],
  'a branch is spelled in full; one extra entry tells whether there is another page');
for (const bad of ['--all', 'a b', '../x', 'x..y', '@', '']) assert.throws(() => buildReflogArgv({ branch: bad }), TypeError, bad);
assert.throws(() => buildReflogArgv({ skip: -1 }), TypeError);
assert.equal(reflogRef(null), 'HEAD');
assert.throws(() => reflogRef('-x'), TypeError);
assert.deepEqual(splitReflogSubject('checkout: moving from main to feat'), { action: 'checkout', detail: 'moving from main to feat' });
assert.deepEqual(splitReflogSubject('commit (amend): Fix: the thing'), { action: 'commit (amend)', detail: 'Fix: the thing' });
assert.deepEqual(splitReflogSubject('odd'), { action: 'odd', detail: '' });
assert.deepEqual(parseReflog([A, B, 'HEAD@{1790000000}', 'reset: moving to HEAD~1', 'Maya', 'Subject', 'Maya', '1790000000', ''].join('\0'), 4, 'HEAD'),
  [{ index: 4, selector: 'HEAD@{4}', oid: A, parents: [B], movedAt: 1790000000, action: 'reset', detail: 'moving to HEAD~1',
    reflogSubject: 'reset: moving to HEAD~1', mover: 'Maya', subject: 'Subject', author: 'Maya', committedAt: 1790000000 }]);
assert.throws(() => parseReflog('x\0y\0'), /Invalid reflog output/);

assert.deepEqual(moveBranchCommand({ branch: 'main', oid: A, expected: B, current: true }), ['reset', '--keep', A],
  'the checked-out branch moves with reset --keep, which refuses to overwrite uncommitted work');
const guarded = moveBranchCommand({ branch: 'side', oid: A, expected: B, current: false });
assert.deepEqual([guarded[0], ...guarded.slice(3)], ['update-ref', 'refs/heads/side', A, B], 'any other branch moves only from the tip the screen saw');
assert.throws(() => moveBranchCommand({ branch: '--force', oid: A, expected: B, current: false }), TypeError);
assert.throws(() => moveBranchCommand({ branch: 'main', oid: 'HEAD~1', expected: B, current: false }), TypeError);
assert.deepEqual(moveBranchInverse(['side', B, A, false], 'undo')[0].slice(-2), [B, A], 'Undo swaps the two ends');
assert.deepEqual(moveBranchInverse(['side', B, A, false], 'redo')[0].slice(-2), [A, B]);
assert.throws(() => buildUndoPlan({ kind: 'reflog:move-branch', args: ['side', B, 'nope', false], before: { head: null, branch: null, paths: [] }, after: { head: null, branch: null, paths: [] } }, 'undo'), TypeError);

assert.equal(shortenIds(`moving to ${A}`), 'moving to aaaaaaa');
assert.equal(shortenIds(`moving to ${'c'.repeat(64)} now`), 'moving to ccccccc now');
assert.equal(shortenIds('moving from main to feat'), 'moving from main to feat');
assert.equal(actionLabel('commit (amend)'), 'Amend');
assert.equal(actionLabel('commit (initial)'), 'First commit');
assert.equal(actionLabel('rebase (finish)'), 'Rebase');
assert.equal(actionLabel('something new'), 'something new');
assert.equal(relativeTime(1000, 1000 * 1000 + 10_000), 'just now');
assert.equal(relativeTime(0, 3 * 3600 * 1000), '3 hours ago');
assert.equal(relativeTime(0, 86400 * 1000), '1 day ago');
assert.equal(relativeTime(null), 'at an unknown time');
const story = [
  { action: 'reset', detail: 'moving to HEAD~1', oid: '1'.repeat(40) },
  { action: 'checkout', detail: 'moving from feat to main', oid: '2'.repeat(40) },
  { action: 'commit', detail: 'Feature work', oid: '3'.repeat(40) },
  { action: 'checkout', detail: 'moving from main to feat', oid: '4'.repeat(40) }
];
assert.equal(branchAt(story, 2), 'feat', 'a newer "moving from feat" says the commit was made on feat');
assert.equal(branchAt(story, 3), 'feat', 'otherwise an older "to feat" does');
assert.equal(suggestBranchName(story, 2, ['main']), 'feat', 'a deleted branch comes back under its own name');
assert.equal(suggestBranchName(story, 2, ['main', 'feat']), `feat-recovered-${'3'.repeat(7)}`);
assert.equal(suggestBranchName([{ action: 'commit', detail: 'x', oid: A }], 0, [`recovered-${A.slice(0, 7)}`]), `recovered-${A.slice(0, 7)}-2`);
assert.equal(branchAt([{ action: 'checkout', detail: `moving from ${A} to main` }, { action: 'commit', detail: 'x' }], 1), null, 'a detached HEAD names no branch');
const dialog = moveBranchDialog({ branch: 'main', oid: A, expected: B, current: true });
assert.deepEqual(dialog.command, ['reset', '--keep', A]);
assert.match(dialog.consequence, /files follow it/);
assert.match(dialog.consequence, /Undo/);
assert.match(moveBranchDialog({ branch: 'side', oid: A, expected: B, current: false }).consequence, /not touched/);
assert.match(moveReason({ branch: null, tip: null, oid: A, operation: 'none', busy: false }), /detached/);
assert.match(moveReason({ branch: 'main', tip: A, oid: A, operation: 'none', busy: false }), /already points here/);
assert.match(moveReason({ branch: 'main', tip: B, oid: A, operation: 'merge', busy: false }), /merge/);
assert.equal(moveReason({ branch: 'main', tip: B, oid: A, operation: 'none', busy: false }), undefined);

// --- on a real repository --------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-reflog-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const options = { cwd, log };
  const git = async argv => { const result = await runGit({ ...options, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const commit = async (file, text, message) => { await writeFile(path.join(cwd, file), text); await git(['add', '--', file]); await git(['commit', '-m', message]); return git(['rev-parse', 'HEAD']); };
  const c1 = await commit('app.txt', 'one\n', 'One');
  const c2 = await commit('app.txt', 'two\n', 'Two');
  const c3 = await commit('app.txt', 'three\n', 'Three');
  await git(['checkout', '-b', 'feat']);
  const f1 = await commit('feat.txt', 'feature\n', 'Feature work');
  await git(['checkout', 'main']);
  await git(['branch', '-D', 'feat']);              // the feature branch is gone…
  await git(['reset', '--hard', c2]);              // …and so is Three, from the terminal

  const head = await loadReflog({ ...options });
  assert.equal(head.entries[0].selector, 'HEAD@{0}');
  assert.equal(head.entries[0].action, 'reset');
  assert.equal(head.entries[0].oid, c2);
  assert.ok(head.entries[0].movedAt > 1_600_000_000, 'the time of the move comes with it');
  const byOid = oid => head.entries.find(entry => entry.oid === oid);
  assert.equal(byOid(f1).lost, true, 'the deleted branch’s commit is on no branch');
  assert.equal(byOid(c3).lost, true, 'the commit a hard reset dropped is on no branch');
  assert.equal(byOid(c2).lost, false);
  assert.equal(byOid(c1).lost, false);
  assert.equal(head.nextSkip, null);
  const position = head.entries.findIndex(entry => entry.oid === f1);
  assert.equal(suggestBranchName(head.entries, position, ['main']), 'feat', 'the screen offers the deleted branch’s own name');

  const first = await loadReflog({ ...options, limit: 2 });
  assert.equal(first.entries.length, 2); assert.equal(first.nextSkip, 2);
  const second = await loadReflog({ ...options, skip: 2, limit: 2 });
  assert.equal(second.entries[0].index, 2); assert.equal(second.entries[0].selector, 'HEAD@{2}');
  assert.equal(second.entries[0].oid, head.entries[2].oid, 'pages continue where the last one stopped');

  const main = await loadReflog({ ...options, branch: 'main' });
  assert.equal(main.entries[0].selector, 'main@{0}');
  assert.deepEqual(main.entries.map(entry => entry.oid), [c2, c3, c2, c1], 'the branch’s own moves, newest first');
  await git(['update-ref', 'refs/heads/bare', c1]);
  await rm(path.join(cwd, '.git', 'logs', 'refs', 'heads', 'bare'), { force: true });
  assert.deepEqual((await loadReflog({ ...options, branch: 'bare' })).entries, [], 'a branch without a reflog is empty, not an error');

  // Moving the checked-out branch back, through the real Undo service.
  const undo = new UndoService({ directory: root, log }); await undo.load();
  const perform = (args, action) => undo.perform(cwd, 'reflog:move-branch', args, action);
  await writeFile(path.join(cwd, 'notes.txt'), 'uncommitted\n');   // unrelated work in progress stays
  const moved = await perform(['main', c3, c2], () => moveBranch({ ...options, branch: 'main', oid: c3, expected: c2 }));
  assert.deepEqual(moved.undo, ['main', c2, c3, true]);
  assert.equal(await git(['rev-parse', 'HEAD']), c3);
  assert.equal(await readFile(path.join(cwd, 'app.txt'), 'utf8'), 'three\n', 'the files follow the checked-out branch');
  assert.equal(await readFile(path.join(cwd, 'notes.txt'), 'utf8'), 'uncommitted\n', 'uncommitted work survives reset --keep');
  await undo.move(cwd, 'undo', async () => true);
  assert.equal(await git(['rev-parse', 'main']), c2, 'Undo moves the branch back');
  await undo.move(cwd, 'redo', async () => true);
  assert.equal(await git(['rev-parse', 'main']), c3, 'Redo moves it again');

  // A conflicting uncommitted change is refused by Git and nothing moves.
  await writeFile(path.join(cwd, 'app.txt'), 'my edit\n');
  await assert.rejects(moveBranch({ ...options, branch: 'main', oid: c1, expected: c3 }), /uncommitted changes/);
  assert.equal(await git(['rev-parse', 'main']), c3);
  assert.equal(await readFile(path.join(cwd, 'app.txt'), 'utf8'), 'my edit\n');
  await git(['checkout', '--', 'app.txt']);

  // A branch that is not checked out moves by compare-and-swap; the files stay.
  await git(['branch', 'side', c1]);
  await assert.rejects(moveBranch({ ...options, branch: 'side', oid: c2, expected: c3 }), /moved since/, 'a stale tip is refused');
  const side = await perform(['side', c2, c1], () => moveBranch({ ...options, branch: 'side', oid: c2, expected: c1 }));
  assert.deepEqual(side.undo, ['side', c1, c2, false]);
  assert.equal(await git(['rev-parse', 'side']), c2);
  assert.equal(await git(['rev-parse', 'HEAD']), c3, 'HEAD did not move');
  assert.match(await git(['reflog', '-1', '--format=%gs', 'side']), /🌱 Twig: move side to/, 'the move is itself in the branch’s reflog');
  await undo.move(cwd, 'undo', async () => true);
  assert.equal(await git(['rev-parse', 'side']), c1);

  await assert.rejects(moveBranch({ ...options, branch: 'side', oid: c1, expected: c1 }), /already points/);
  await assert.rejects(moveBranch({ ...options, branch: 'gone', oid: c1, expected: c2 }), /no branch gone/);
  await assert.rejects(moveBranch({ ...options, branch: 'side', oid: 'f'.repeat(40), expected: c1 }), /no longer in this repository/);
  await assert.rejects(moveBranch({ ...options, branch: '--force', oid: c1, expected: c2 }), TypeError);

  // Recovering the deleted branch is an ordinary branch at the lost commit.
  await git(['branch', 'feat', f1]);
  const after = await loadReflog({ ...options });
  assert.equal(after.entries.find(entry => entry.oid === f1).lost, false, 'once a branch holds it, it is no longer lost');
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Reflog checks passed: argv and parsing, paging, branch reflogs, lost commits, suggested names, move with reset --keep and update-ref, Undo/Redo, refusals.');
