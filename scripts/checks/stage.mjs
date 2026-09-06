import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadWorktree, loadWorktreeDiff } from '../../main/git/worktree.js';
import { applySelection, buildApplyArgv, buildIntentToAddArgv, buildStageArgv, buildStagePathsArgv, buildStageTrackedArgv, buildUnstageAllArgv, buildUnstageArgv, intentToAdd, stageAll, stageFile, unstageAll, unstageFile } from '../../main/git/stage.js';
import { buildSyncArgv, loadDivergence, runSync } from '../../main/git/sync.js';
import { createCommit, stashPop, stashPush, validateCommitMessage } from '../../main/git/commit-ops.js';
import { loadStashes as stashList } from '../../main/git/stash.js';

// Mutating operations are only meaningful against a real repository, so this
// check builds throwaway ones. Pull and push run against a local bare
// repository: real transport, no network.

// --- pure argv and validation, no Git ---

assert.deepEqual(buildStageArgv('src/a.js'), ['add', '--', ':(literal)src/a.js']);
assert.deepEqual(buildUnstageArgv('src/a.js'), ['restore', '--staged', '--', ':(literal)src/a.js']);
assert.deepEqual(buildUnstageArgv('src/a.js', true), ['rm', '--cached', '--force', '--', ':(literal)src/a.js']);
assert.deepEqual(buildIntentToAddArgv('new.txt'), ['add', '--intent-to-add', '--', ':(literal)new.txt']);
assert.deepEqual(buildStageTrackedArgv(), ['add', '--update']);
assert.deepEqual(buildStagePathsArgv(), ['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
assert.equal(buildStagePathsArgv().includes('--all'), false, 'the untracked section never sweeps in tracked changes');
assert.deepEqual(buildUnstageAllArgv(), ['reset']);
assert.equal(buildUnstageAllArgv().some(part => part.startsWith('--')), false, 'unstage all is a mixed reset, never --hard');
assert.deepEqual(buildApplyArgv(false), ['apply', '--cached', '--whitespace=nowarn', '-']);
assert.deepEqual(buildApplyArgv(true), ['apply', '--cached', '--whitespace=nowarn', '--reverse', '-']);
for (const bad of ['', '/abs/path', '../escape', 'a/../../b', 'nul\0byte', 42, null]) {
  assert.throws(() => buildStageArgv(bad), TypeError, `path ${String(bad)} must be rejected`);
}

assert.deepEqual(buildSyncArgv('pull'), ['pull', '--ff-only']);
assert.deepEqual(buildSyncArgv('push-force'), ['push', '--force-with-lease']);
assert.equal(buildSyncArgv('push-force').includes('--force'), false, 'plain --force is never offered');
assert.deepEqual(buildSyncArgv('push-upstream', 'feat/x'), ['push', '--set-upstream', 'origin', 'feat/x']);
assert.throws(() => buildSyncArgv('rm -rf'), TypeError);
for (const bad of ['', '--upstream', 'has space', 'tilde~1', 'star*', 'back\\slash', null]) {
  assert.throws(() => buildSyncArgv('push-upstream', bad), TypeError, `branch ${String(bad)} must be rejected`);
}

assert.equal(validateCommitMessage('').valid, false);
assert.equal(validateCommitMessage('   \n  ').valid, false);
assert.deepEqual(validateCommitMessage('feat: short subject').warnings, []);
assert.equal(validateCommitMessage(`feat: ${'x'.repeat(80)}`).warnings.length, 1);
assert.equal(validateCommitMessage('subject\nbody without blank line').warnings.length, 1);
assert.equal(validateCommitMessage('subject\n\nproper body').warnings.length, 0);

const root = await mkdtemp(path.join(tmpdir(), 'twig-stage-check-'));
const log = new CommandLog(root);

try {
  await log.load();
  const repo = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  await mkdir(repo, { recursive: true });
  const git = async (argv, cwd = repo, allowFailure = false) => {
    const result = await runGit({ argv, cwd, log, operation: 'check' });
    if (!allowFailure) assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result;
  };
  const indexContent = async file => (await git(['show', `:${file}`])).stdout;
  const staged = async () => (await loadWorktree({ cwd: repo, log })).staged.map(entry => entry.path);

  await git(['init', '--bare', '--initial-branch=main', bare], root);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', '']);

  // 1. Unborn branch: there is no HEAD, so unstaging must not use `restore`.
  {
    await writeFile(path.join(repo, 'first.txt'), 'hello\n', 'utf8');
    const before = await loadWorktree({ cwd: repo, log });
    assert.equal(before.branch.unborn, true, 'fixture should start on an unborn branch');
    assert.deepEqual(before.untracked.map(entry => entry.path), ['first.txt']);

    await stageFile({ cwd: repo, log, path: 'first.txt' });
    assert.deepEqual(await staged(), ['first.txt']);

    const restoreFails = await runGit({ argv: ['restore', '--staged', '--', ':(literal)first.txt'], cwd: repo, log, operation: 'check' });
    assert.notEqual(restoreFails.code, 0, 'restore --staged is expected to fail before the first commit');

    await unstageFile({ cwd: repo, log, path: 'first.txt', unborn: true });
    assert.deepEqual(await staged(), [], 'rm --cached unstages on an unborn branch');
  }

  // 2. Commit through stdin: a message with newlines and a leading dash survives.
  {
    await stageFile({ cwd: repo, log, path: 'first.txt' });
    const message = '-fix: message starting with a dash\n\nBody line with "quotes" and кириллица 🌱.';
    const warnings = await createCommit({ cwd: repo, log, message });
    assert.deepEqual(warnings, []);
    const stored = (await git(['log', '-1', '--format=%B'])).stdout;
    assert.equal(stored.trimEnd(), message, 'the message reached Git unchanged');
    await assert.rejects(() => createCommit({ cwd: repo, log, message: '  ' }), /A commit needs a message/);
  }

  // 3. Staging and unstaging a line selection end to end through git apply.
  {
    const base = Array.from({ length: 12 }, (_, i) => `row${String(i + 1).padStart(2, '0')}`);
    await writeFile(path.join(repo, 'grid.txt'), `${base.join('\n')}\n`, 'utf8');
    await stageFile({ cwd: repo, log, path: 'grid.txt' });
    await createCommit({ cwd: repo, log, message: 'add grid' });

    const changed = [...base];
    changed[1] = 'ROW02';
    changed[10] = 'ROW11';
    await writeFile(path.join(repo, 'grid.txt'), `${changed.join('\n')}\n`, 'utf8');

    const diff = await loadWorktreeDiff({ cwd: repo, log, path: 'grid.txt' });
    assert.equal(diff.hunks.length, 2);
    const applied = await applySelection({
      cwd: repo, log, path: 'grid.txt', hunks: diff.hunks, selection: [{ index: 0, lines: 'all' }]
    });
    assert.equal(applied, true);
    let content = (await indexContent('grid.txt')).split('\n');
    assert.equal(content.includes('ROW02'), true, 'the selected hunk was staged');
    assert.equal(content.includes('ROW11'), false, 'the other hunk was not');

    const cached = await loadWorktreeDiff({ cwd: repo, log, path: 'grid.txt', staged: true });
    const undone = await applySelection({
      cwd: repo, log, path: 'grid.txt', hunks: cached.hunks, reverse: true,
      selection: [{ index: 0, lines: 'all' }]
    });
    assert.equal(undone, true);
    content = (await indexContent('grid.txt')).split('\n');
    assert.equal(content.includes('ROW02'), false, 'reverse apply unstaged it again');

    assert.equal(await applySelection({ cwd: repo, log, path: 'grid.txt', hunks: diff.hunks, selection: [] }), false,
      'an empty selection runs no Git command');
  }

  // 4. An untracked file becomes stageable by hunk only after intent-to-add.
  {
    await writeFile(path.join(repo, 'fresh.txt'), 'alpha\nbeta\n', 'utf8');
    assert.deepEqual((await loadWorktreeDiff({ cwd: repo, log, path: 'fresh.txt' })).hunks, [],
      'an untracked file has no diff yet');
    await intentToAdd({ cwd: repo, log, path: 'fresh.txt' });
    const diff = await loadWorktreeDiff({ cwd: repo, log, path: 'fresh.txt' });
    assert.equal(diff.added, true);
    assert.equal(diff.hunks.length, 1, 'now it diffs as an addition');
    await applySelection({
      cwd: repo, log, path: 'fresh.txt', hunks: diff.hunks, added: true, mode: diff.mode,
      selection: [{ index: 0, lines: [0] }]
    });
    assert.equal(await indexContent('fresh.txt'), 'alpha\n', 'only the selected line was staged');
    await git(['reset', '-q']);
  }

  // 5. Stash round trip, including the untracked file.
  {
    const list = await stashList({ cwd: repo, log });
    assert.deepEqual(list, []);
    await stashPush({ cwd: repo, log, includeUntracked: true, message: 'twig fixture stash' });
    const after = await loadWorktree({ cwd: repo, log });
    assert.deepEqual([...after.staged, ...after.unstaged, ...after.untracked], [], 'stash cleaned the working tree');
    const stashes = await stashList({ cwd: repo, log });
    assert.equal(stashes.length, 1);
    assert.equal(stashes[0].ref, 'stash@{0}');
    assert.ok(stashes[0].subject.includes('twig fixture stash'));
    await stashPop({ cwd: repo, log });
    const restored = await loadWorktree({ cwd: repo, log });
    assert.equal(restored.unstaged.some(entry => entry.path === 'grid.txt'), true, 'pop brought the work back');
    assert.deepEqual(await stashList({ cwd: repo, log }), []);
    await git(['checkout', '--', '.']);
    await rm(path.join(repo, 'fresh.txt'), { force: true });
  }

  // 6. Push, divergence badges and pull against a local bare repository.
  {
    await git(['remote', 'add', 'origin', bare]);
    assert.deepEqual(await loadDivergence({ cwd: repo, log, branch: 'main' }), { ahead: 0, behind: 0, upstream: null });

    const pushed = await runSync({ cwd: repo, log, mode: 'push-upstream', branch: 'main' });
    assert.deepEqual(pushed, { ok: true, cancelled: false, message: null });
    assert.deepEqual(await loadDivergence({ cwd: repo, log, branch: 'main' }), { ahead: 0, behind: 0, upstream: 'origin/main' });

    // A second clone commits, so the first one falls behind after a fetch.
    const other = path.join(root, 'other');
    await git(['clone', bare, other], root);
    await git(['config', 'user.name', 'Other'], other);
    await git(['config', 'user.email', 'other@example.invalid'], other);
    await git(['config', 'commit.gpgsign', 'false'], other);
    await writeFile(path.join(other, 'remote-side.txt'), 'from the other clone\n', 'utf8');
    await git(['add', '--', ':(literal)remote-side.txt'], other);
    await git(['commit', '--message', 'remote side'], other);
    await git(['push'], other);

    assert.equal((await runSync({ cwd: repo, log, mode: 'fetch' })).ok, true);
    const behind = await loadDivergence({ cwd: repo, log, branch: 'main' });
    assert.deepEqual([behind.ahead, behind.behind], [0, 1], 'the badge sees one incoming commit');

    assert.equal((await runSync({ cwd: repo, log, mode: 'pull' })).ok, true);
    assert.deepEqual(await loadDivergence({ cwd: repo, log, branch: 'main' }), { ahead: 0, behind: 0, upstream: 'origin/main' });

    const cancelled = await runSync({ cwd: repo, log, mode: 'fetch', signal: AbortSignal.abort() });
    assert.equal(cancelled.cancelled, true, 'an already-aborted signal cancels the operation');
    assert.equal(cancelled.ok, false);
  }


  // 7. Bulk staging: a section, never a list of files sent by the renderer.
  {
    const bulk = path.join(root, 'bulk');
    await mkdir(bulk, { recursive: true });
    const bgit = (argv, allowFailure = false) => git(argv, bulk, allowFailure);
    await bgit(['init', '--initial-branch=main']);
    await bgit(['config', 'user.name', 'Twig Fixture']);
    await bgit(['config', 'user.email', 'fixture@example.invalid']);
    await bgit(['config', 'commit.gpgsign', 'false']);
    const tree = () => loadWorktree({ cwd: bulk, log });

    // Before the first commit `restore --staged` fails, so unstage all cannot use it.
    await writeFile(path.join(bulk, 'a.txt'), 'a\n', 'utf8');
    await stageFile({ cwd: bulk, log, path: 'a.txt' });
    assert.equal(await unstageAll({ cwd: bulk, log }), 1, 'unstage all works on an unborn branch');
    assert.deepEqual((await tree()).staged, []);

    await stageFile({ cwd: bulk, log, path: 'a.txt' });
    await writeFile(path.join(bulk, 'gone.txt'), 'gone\n', 'utf8');
    await stageFile({ cwd: bulk, log, path: 'gone.txt' });
    await createCommit({ cwd: bulk, log, message: 'base' });

    await writeFile(path.join(bulk, 'a.txt'), 'a changed\n', 'utf8');
    await rm(path.join(bulk, 'gone.txt'));
    await mkdir(path.join(bulk, 'new/deep'), { recursive: true });
    await writeFile(path.join(bulk, 'new/deep/n.txt'), 'n\n', 'utf8');
    await writeFile(path.join(bulk, 'star[1].txt'), 'literal name\n', 'utf8');

    assert.equal(await stageAll({ cwd: bulk, log, scope: 'tracked' }), 2, 'the modification and the deletion');
    let now = await tree();
    assert.deepEqual(now.staged.map(entry => entry.path).sort(), ['a.txt', 'gone.txt']);
    assert.deepEqual(now.untracked.map(entry => entry.path).sort(), ['new/', 'star[1].txt'], 'new files stayed untracked');

    assert.equal(await stageAll({ cwd: bulk, log, scope: 'untracked' }), 2);
    now = await tree();
    assert.deepEqual(now.staged.map(entry => entry.path).sort(), ['a.txt', 'gone.txt', 'new/deep/n.txt', 'star[1].txt'],
      'an untracked directory is staged recursively and a name with glob characters stays literal');
    assert.deepEqual(now.untracked, []);
    assert.equal(await stageAll({ cwd: bulk, log, scope: 'untracked' }), 0, 'an empty section runs no Git command');
    await assert.rejects(() => stageAll({ cwd: bulk, log, scope: 'everything' }), TypeError);

    assert.equal(await unstageAll({ cwd: bulk, log }), 4);
    now = await tree();
    assert.deepEqual(now.staged, []);
    assert.equal(now.unstaged.find(entry => entry.path === 'gone.txt').status, 'D', 'the deletion is back in the unstaged list');
    assert.equal(await readFile(path.join(bulk, 'a.txt'), 'utf8'), 'a changed\n', 'the working tree is untouched');
    assert.equal(existsSync(path.join(bulk, 'new/deep/n.txt')), true, 'unstaging never removes a new file');

    await bgit(['checkout', '--', '.']);
    await rm(path.join(bulk, 'new'), { recursive: true, force: true });
    await rm(path.join(bulk, 'star[1].txt'), { force: true });

    // A conflicted merge: `add` would mark the conflict resolved as it stands,
    // and `reset` would delete MERGE_HEAD and cancel the merge outright.
    await bgit(['checkout', '-b', 'side']);
    await writeFile(path.join(bulk, 'conflict.txt'), 'side\n', 'utf8');
    await stageFile({ cwd: bulk, log, path: 'conflict.txt' });
    await createCommit({ cwd: bulk, log, message: 'side' });
    await bgit(['checkout', 'main']);
    await writeFile(path.join(bulk, 'conflict.txt'), 'main\n', 'utf8');
    await stageFile({ cwd: bulk, log, path: 'conflict.txt' });
    await createCommit({ cwd: bulk, log, message: 'main' });
    assert.notEqual((await bgit(['merge', 'side'], true)).code, 0, 'the fixture merge must conflict');

    await assert.rejects(() => stageAll({ cwd: bulk, log, scope: 'tracked' }), /Resolve 1 conflicted file/);
    await assert.rejects(() => stageAll({ cwd: bulk, log, scope: 'untracked' }), /Resolve 1 conflicted file/);
    await assert.rejects(() => unstageAll({ cwd: bulk, log }), /Finish or abort the merge first/);

    // Resolving every conflict is still not enough: the merge itself is open.
    await writeFile(path.join(bulk, 'conflict.txt'), 'resolved\n', 'utf8');
    await stageFile({ cwd: bulk, log, path: 'conflict.txt' });
    await assert.rejects(() => unstageAll({ cwd: bulk, log }), /Finish or abort the merge first/);
    assert.equal(existsSync(path.join(bulk, '.git', 'MERGE_HEAD')), true, 'the refusal left the merge in place');
    await bgit(['merge', '--abort']);
  }

  console.log('stage: all checks passed against real repositories, including unborn branch, bulk staging, stash and a local remote');
} finally {
  await rm(root, { recursive: true, force: true });
}
