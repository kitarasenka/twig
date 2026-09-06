import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadOperationState, resolveGitDir } from '../../main/git/operation-state.js';
import { cherryPick, merge, reset, revert, sequencer } from '../../main/git/history-ops.js';
import { checkout, createBranch, createTag } from '../../main/git/refs-ops.js';
import { clearPlan, planDirectory, startRebase } from '../../main/git/rebase.js';
import { loadRebaseCandidates } from '../../main/git/history.js';
import { buildUndoPlan, inverseReason } from '../../main/git/undo-plan.js';
import { loadConflict, saveResolution, takeSide } from '../../main/git/conflicts.js';
import { rewordHead } from '../../main/git/commit-ops.js';
import { buildRewordPlan } from '../../renderer/src/features/ops/reword-plan.js';
import { buildSquashPlan } from '../../renderer/src/features/ops/squash-plan.js';
import { parseConflictFile } from '../../renderer/src/features/conflicts/conflict-parser.js';

/**
 * Runs real Git, unlike the argv checks next to it. There is no other way to
 * prove any of this: that a conflict really stops the operation, that the
 * banner's state matches what Git wrote under `.git`, that the sequence editor
 * is actually consulted, and above all that an interactive rebase replays the
 * plan Twig supplied rather than Git's own default todo. An argv assertion
 * cannot tell a working rebase from one that silently picked everything.
 */

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-ops-'));
const cwd = path.join(root, 'repo');
const stateDir = path.join(root, 'state');
const log = new CommandLog(path.join(root, 'journal'));
await log.load();

const git = async (argv, at = cwd) => {
  const result = await runGit({ argv, cwd: at, log });
  assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`);
  return result.stdout.replace(/\n$/, '');
};
const write = (file, text) => writeFile(path.join(cwd, file), text, 'utf8');
const subjects = async (revision = 'HEAD') => (await git(['log', '--format=%s', revision])).split('\n').filter(Boolean);

try {
  await git(['init', '--initial-branch=main', cwd], root);
  for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);

  await write('f.txt', 'a\nb\nc\n');
  await git(['add', '--', ':(literal)f.txt']);
  await git(['commit', '--message', 'base']);
  const base = await git(['rev-parse', 'HEAD']);
  const gitDir = await resolveGitDir({ cwd, log });
  const options = { cwd, log, gitDir };

  // Nothing in progress at rest.
  assert.deepEqual(await loadOperationState(options),
    { kind: 'none', step: null, total: null, branch: null, conflicts: [], resolved: false });

  // --- branches and tags ---------------------------------------------------
  await createBranch({ ...options, name: 'side', startPoint: base });
  await createTag({ ...options, name: 'v0', oid: base, message: 'annotated from the check' });
  assert.equal(await git(['tag', '-l', '--format=%(contents:subject)', 'v0']), 'annotated from the check',
    'the tag message reached Git over stdin');
  assert.equal(await git(['cat-file', '-t', 'v0']), 'tag', 'a message makes it an annotated tag');

  await checkout({ ...options, target: 'side' });
  await write('f.txt', 'a\nSIDE\nc\n');
  await git(['commit', '--all', '--message', 'side edit']);
  await write('g.txt', 'side only\n');
  await git(['add', '--', ':(literal)g.txt']);
  await git(['commit', '--message', 'side second']);
  await checkout({ ...options, target: 'main' });
  await write('f.txt', 'a\nMAIN\nc\n');
  await git(['commit', '--all', '--message', 'main edit']);

  // --- a merge that conflicts ----------------------------------------------
  const merged = await merge({ ...options, revision: 'side' });
  assert.equal(merged.ok, false, 'a conflicting merge does not succeed');
  const conflicted = await loadOperationState(options);
  assert.equal(conflicted.kind, 'merge');
  assert.deepEqual(conflicted.conflicts, ['f.txt']);
  assert.equal(conflicted.resolved, false);

  // The editor sees all three sides and the markers Git left behind.
  const sides = await loadConflict({ ...options, path: 'f.txt' });
  assert.equal(sides.binary, false);
  assert.equal(sides.base, 'a\nb\nc\n');
  assert.equal(sides.ours, 'a\nMAIN\nc\n');
  assert.equal(sides.theirs, 'a\nSIDE\nc\n');
  const parsed = parseConflictFile(sides.merged);
  assert.equal(parsed.conflicts, 1);
  const [region] = parsed.regions.filter(item => item.kind === 'conflict');
  assert.deepEqual(region.ours, ['MAIN']);
  assert.deepEqual(region.theirs, ['SIDE']);

  // A stale fingerprint refuses the write rather than overwriting an edit
  // someone else made while the editor was open.
  await assert.rejects(saveResolution({ ...options, path: 'f.txt', content: 'x\n', mtimeMs: sides.mtimeMs - 1000, size: sides.size }),
    /changed on disk/);

  await saveResolution({ ...options, path: 'f.txt', content: 'a\nMAIN\nSIDE\nc\n', mtimeMs: sides.mtimeMs, size: sides.size });
  const ready = await loadOperationState(options);
  assert.equal(ready.kind, 'merge', 'the merge is still open until it is continued');
  assert.deepEqual(ready.conflicts, []);
  assert.equal(ready.resolved, true);

  const finished = await sequencer({ ...options, kind: 'merge', step: 'continue' });
  assert.equal(finished.ok, true, 'merge --continue must not hang on an editor');
  assert.equal((await loadOperationState(options)).kind, 'none');
  assert.equal((await git(['rev-list', '--parents', '-1', 'HEAD'])).split(' ').length, 3, 'a real merge commit');
  assert.equal(await readFile(path.join(cwd, 'f.txt'), 'utf8'), 'a\nMAIN\nSIDE\nc\n');

  // --- abort puts everything back ------------------------------------------
  await git(['checkout', 'side', '--']);
  await write('f.txt', 'a\nSIDE-AGAIN\nc\n');
  await git(['commit', '--all', '--message', 'side third']);
  await git(['checkout', 'main', '--']);
  const beforeAbort = await git(['rev-parse', 'HEAD']);
  assert.equal((await merge({ ...options, revision: 'side' })).ok, false);
  assert.equal((await loadOperationState(options)).kind, 'merge');
  assert.equal((await sequencer({ ...options, kind: 'merge', step: 'abort' })).ok, true);
  assert.equal((await loadOperationState(options)).kind, 'none');
  assert.equal(await git(['rev-parse', 'HEAD']), beforeAbort, 'abort leaves HEAD where it was');

  // --- taking one side whole ------------------------------------------------
  assert.equal((await merge({ ...options, revision: 'side' })).ok, false);
  await takeSide({ ...options, path: 'f.txt', side: 'theirs' });
  assert.deepEqual((await loadOperationState(options)).conflicts, []);
  assert.equal(await readFile(path.join(cwd, 'f.txt'), 'utf8'), 'a\nSIDE-AGAIN\nc\n');
  await sequencer({ ...options, kind: 'merge', step: 'abort' });

  // --- cherry-pick and revert ----------------------------------------------
  // A donor commit that main does not already contain: cherry-picking work
  // that is already merged is an empty pick, which is a different test.
  await git(['checkout', '-b', 'donor', beforeAbort, '--']);
  await write('pickme.txt', 'picked\n');
  await git(['add', '--', ':(literal)pickme.txt']);
  await git(['commit', '--message', 'add pickme']);
  const donor = await git(['rev-parse', 'HEAD']);

  await git(['checkout', '-b', 'picking', beforeAbort, '--']);
  assert.equal((await cherryPick({ ...options, oid: donor })).ok, true);
  assert.equal((await subjects())[0], 'add pickme');
  assert.equal(await readFile(path.join(cwd, 'pickme.txt'), 'utf8'), 'picked\n');

  const picked = await git(['rev-parse', 'HEAD']);
  assert.equal((await revert({ ...options, oid: picked })).ok, true, 'revert must not stop at an editor');
  assert.match((await subjects())[0], /^Revert "add pickme"$/);
  await assert.rejects(readFile(path.join(cwd, 'pickme.txt')), /ENOENT/, 'the revert really removed the file');

  // --- reset ----------------------------------------------------------------
  await write('scratch.txt', 'uncommitted\n');
  await git(['add', '--', ':(literal)scratch.txt']);
  assert.equal((await reset({ ...options, mode: 'hard', oid: beforeAbort })).ok, true);
  assert.equal(await git(['rev-parse', 'HEAD']), beforeAbort);
  await assert.rejects(readFile(path.join(cwd, 'scratch.txt')), /ENOENT/, '--hard destroys staged work, as the dialog warns');
  assert.equal(await git(['status', '--porcelain']), '', 'nothing is left over after --hard');

  // --- interactive rebase ---------------------------------------------------
  // Four commits whose order, count and messages all change, so a run that
  // ignored the plan could not accidentally produce the expected log.
  await git(['checkout', '-b', 'plan', beforeAbort, '--']);
  const made = [];
  for (const name of ['one', 'two', 'three', 'four']) {
    await write(`${name}.txt`, `${name}\n`);
    await git(['add', '--', `:(literal)${name}.txt`]);
    await git(['commit', '--message', `add ${name}`]);
    made.push(await git(['rev-parse', 'HEAD']));
  }
  const [one, two, three, four] = made;
  const plan = [
    { action: 'pick', oid: two },
    { action: 'reword', oid: one, message: 'add one, reworded' },
    { action: 'squash', oid: four },
    { action: 'drop', oid: three }
  ];
  const rebased = await startRebase({ ...options, stateDir, oid: beforeAbort, entries: plan });
  assert.equal(rebased.ok, true, 'the interactive rebase ran to the end without a terminal editor');
  assert.equal((await loadOperationState(options)).kind, 'none');
  assert.deepEqual(await subjects('HEAD~2..HEAD'), ['add one, reworded', 'add two'],
    'reordered, reworded, squashed and dropped exactly as planned');
  // g.txt predates the plan; three.txt is the dropped commit and must be
  // absent, while four.txt survives inside the squash.
  assert.deepEqual((await git(['ls-files'])).split('\n').sort(), ['f.txt', 'four.txt', 'g.txt', 'one.txt', 'two.txt'],
    'the dropped commit is gone and the squashed one is folded in');

  // The plan lives outside the repository and is cleared once it is over.
  assert.ok(!planDirectory(stateDir, cwd).startsWith(cwd));
  await clearPlan({ stateDir, cwd });

  // --- squashing a run of adjacent commits --------------------------------
  // Three commits in the middle of a branch fold into one; the commit after
  // them must survive untouched, and the run's own messages must all be gone
  // except the combined one the plan carries.
  await git(['checkout', '-b', 'squash-run', beforeAbort, '--']);
  const runOids = [];
  for (const name of ['s1', 's2', 's3', 'keep']) {
    await write(`${name}.txt`, `${name}\n`);
    await git(['add', '--', `:(literal)${name}.txt`]);
    await git(['commit', '--message', `add ${name}`]);
    runOids.push(await git(['rev-parse', 'HEAD']));
  }
  const [s1, s2, s3] = runOids;
  const squashRange = await loadRebaseCandidates({ cwd, log, oid: beforeAbort });
  assert.deepEqual(squashRange.map(entry => entry.subject), ['add s1', 'add s2', 'add s3', 'add keep']);
  const squashed = await startRebase({
    ...options, stateDir, oid: beforeAbort,
    entries: buildSquashPlan(squashRange, [s1, s2, s3], 'the three s commits, squashed')
  });
  assert.equal(squashed.ok, true, `the squash replay finished: ${squashed.message || ''}`);
  assert.equal((await loadOperationState(options)).kind, 'none');
  assert.deepEqual(await subjects(`${beforeAbort}..HEAD`), ['add keep', 'the three s commits, squashed'],
    'the run became one commit and the commit after it kept its own message');
  assert.deepEqual((await git(['show', '--stat', '--format=', 'HEAD~1'])).match(/s\d\.txt/g).sort(),
    ['s1.txt', 's2.txt', 's3.txt'], 'every change from the run is folded into the single commit');
  assert.equal(await readFile(path.join(cwd, 'keep.txt'), 'utf8'), 'keep\n');
  await clearPlan({ stateDir, cwd });

  // --- a rebase that conflicts, then continues ------------------------------
  await git(['checkout', '-b', 'topic', beforeAbort, '--']);
  await write('f.txt', 'a\nTOPIC\nc\n');
  await git(['commit', '--all', '--message', 'topic edit']);
  await git(['checkout', 'main', '--']);
  await write('f.txt', 'a\nTRUNK\nc\n');
  await git(['commit', '--all', '--message', 'trunk edit']);
  await git(['checkout', 'topic', '--']);

  const stopped = await startRebase({ ...options, stateDir, oid: await git(['rev-parse', 'main']), entries: null });
  assert.equal(stopped.ok, false);
  const during = await loadOperationState(options);
  assert.equal(during.kind, 'rebase');
  assert.equal(during.branch, 'topic', 'the banner names the branch being rebased, not the detached HEAD');
  assert.equal(during.step, 1);
  assert.equal(during.total, 1);
  assert.deepEqual(during.conflicts, ['f.txt']);

  const inRebase = await loadConflict({ ...options, path: 'f.txt' });
  await saveResolution({ ...options, path: 'f.txt', content: 'a\nTRUNK+TOPIC\nc\n', mtimeMs: inRebase.mtimeMs, size: inRebase.size });
  const continued = await sequencer({ ...options, kind: 'rebase', step: 'continue' });
  assert.equal(continued.ok, true, 'rebase --continue must not hang on an editor either');
  assert.equal((await loadOperationState(options)).kind, 'none');
  assert.deepEqual(await subjects('main..HEAD'), ['topic edit']);
  assert.equal(await readFile(path.join(cwd, 'f.txt'), 'utf8'), 'a\nTRUNK+TOPIC\nc\n');

  // --- binary files ----------------------------------------------------------
  await git(['checkout', 'main', '--']);
  await git(['checkout', '-b', 'bin-a', '--']);
  await writeFile(path.join(cwd, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
  await git(['add', '--', ':(literal)blob.bin']);
  await git(['commit', '--message', 'binary a']);
  await git(['checkout', 'main', '--']);
  await git(['checkout', '-b', 'bin-b', '--']);
  await writeFile(path.join(cwd, 'blob.bin'), Buffer.from([9, 9, 0, 9]));
  await git(['add', '--', ':(literal)blob.bin']);
  await git(['commit', '--message', 'binary b']);
  assert.equal((await merge({ ...options, revision: 'bin-a' })).ok, false);
  const binary = await loadConflict({ ...options, path: 'blob.bin' });
  assert.equal(binary.binary, true, 'a NUL byte means no line-by-line merge is offered');
  assert.equal(binary.merged, null);
  await takeSide({ ...options, path: 'blob.bin', side: 'theirs' });
  assert.deepEqual([...await readFile(path.join(cwd, 'blob.bin'))], [0, 1, 2, 0, 3]);
  await sequencer({ ...options, kind: 'merge', step: 'abort' });

  // --- rewording -------------------------------------------------------------
  // The tip, with something staged. This is the case an ordinary `--amend`
  // gets wrong: the staged file would be swallowed by the commit being
  // reworded, which is why the argv carries `--only`.
  await git(['checkout', 'main', '--']);
  await write('reword.txt', 'first\n');
  await git(['add', '--', ':(literal)reword.txt']);
  await git(['commit', '--message', 'typpo in the subject']);
  const beforeReword = await git(['rev-parse', 'HEAD']);
  const treeBefore = await git(['rev-parse', 'HEAD^{tree}']);
  await write('staged.txt', 'not part of that commit\n');
  await git(['add', '--', ':(literal)staged.txt']);

  const warnings = await rewordHead({ cwd, log, message: 'typo in the subject\n\nAnd a body.', expectedOid: beforeReword });
  assert.deepEqual(warnings, [], 'a short subject with a blank line after it warns about nothing');
  assert.equal(await git(['log', '-1', '--format=%s']), 'typo in the subject');
  assert.equal(await git(['log', '-1', '--format=%b']).then(body => body.trim()), 'And a body.');
  assert.equal(await git(['rev-parse', 'HEAD^{tree}']), treeBefore, 'the reworded commit keeps its own tree');
  assert.notEqual(await git(['rev-parse', 'HEAD']), beforeReword, 'rewriting a message mints a new object id');
  assert.deepEqual((await git(['diff', '--cached', '--name-only'])).split('\n').filter(Boolean), ['staged.txt'],
    'what was staged stays staged instead of being folded into the reworded commit');

  // The undo of a reword is the same soft reset a commit gets: HEAD goes back
  // to the commit that was rewritten, and the index is left alone.
  const afterReword = await git(['rev-parse', 'HEAD']);
  assert.deepEqual(buildUndoPlan({ kind: 'ops:reword', args: [], before: { head: beforeReword, branch: 'main', paths: [] }, after: { head: afterReword, branch: 'main', paths: [] } }, 'undo'),
    { commands: [['reset', '--soft', beforeReword]], destructive: false, explanation: 'Only the recorded application action will be reversed.' });
  assert.equal(inverseReason('ops:reword', { operation: 'none', clean: true }, { operation: 'none', clean: true }, []), null,
    'a reword does not end the Undo chain');

  // The oid the renderer was showing is checked against HEAD: a message
  // written for one commit must not land on another.
  await assert.rejects(() => rewordHead({ cwd, log, message: 'wrong target', expectedOid: beforeReword }), /moved since/);
  assert.equal(await git(['log', '-1', '--format=%s']), 'typo in the subject', 'the refused reword changed nothing');
  await assert.rejects(() => rewordHead({ cwd, log, message: '   ', expectedOid: afterReword }), /needs a message/);
  await git(['reset', '--', ':(literal)staged.txt']);

  // An older commit is reworded by replaying the range. Everything after it
  // must keep its content and its own message; only the target's changes.
  await write('later.txt', 'later\n');
  await git(['add', '--', ':(literal)later.txt']);
  await git(['commit', '--message', 'a later commit']);
  const older = await git(['rev-parse', 'HEAD~1']);
  const parent = await git(['rev-parse', 'HEAD~2']);
  const range = await loadRebaseCandidates({ cwd, log, oid: parent });
  assert.deepEqual(range.map(entry => entry.subject), ['typo in the subject', 'a later commit'],
    'the replayed range is oldest first, exactly as Git executes it');
  const replayed = await startRebase({ ...options, stateDir, oid: parent, entries: buildRewordPlan(range, older, 'reworded from inside the history') });
  assert.equal(replayed.ok, true, `the replay finished: ${replayed.message || ''}`);
  assert.deepEqual(await subjects(`${parent}..HEAD`), ['a later commit', 'reworded from inside the history'],
    'only the targeted message changed and the commit after it was replayed as it was');
  assert.equal(await git(['show', '--no-patch', '--format=%s', 'HEAD']), 'a later commit');
  assert.equal(await readFile(path.join(cwd, 'reword.txt'), 'utf8'), 'first\n', 'the replayed content is unchanged');
  assert.equal((await loadOperationState(options)).kind, 'none');
  await clearPlan({ stateDir, cwd });

  console.log('history-ops-live: all checks passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
