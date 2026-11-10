import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// What a failed Git command means, read from what real Git prints: a lock left
// in .git, nobody to commit as, a hook that said no, a signature that could not
// be made. And the two things main does about it: remove a stale lock (only a
// lock of this repository, only a plain file) and count the commits a detached
// HEAD would leave behind. No network: the SSH and HTTPS texts are Git's own
// words, fixed here; the network case is a real refused connection.

// Nothing of the person's own Git config may answer for "who are you".
const root = await mkdtemp(path.join(tmpdir(), 'twig-failure-check-'));
const globalConfig = path.join(root, 'gitconfig');
await writeFile(globalConfig, '');
process.env.GIT_CONFIG_GLOBAL = globalConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const name of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) delete process.env[name];

const { CommandLog } = await import('../../main/command-log.js');
const { runGit, gitRunningIn } = await import('../../main/git/exec.js');
const { createCommit } = await import('../../main/git/commit-ops.js');
const { stageFile } = await import('../../main/git/stage.js');
const { checkout } = await import('../../main/git/refs-ops.js');
const { runSync } = await import('../../main/git/sync.js');
const { DETAIL_MARK, carryDetail, countDetachedCommits, presentHooks, removeLock, withDetail } = await import('../../main/git/failure.js');
const gitFailure = await import('../../renderer/src/app/git-failure.js');
const { classifyFailure, lastLine, splitFailure, tailLines } = gitFailure;
const { failureNote, FAILURE_DIALOGS } = await import('../../renderer/src/app/failure-note.js');
const { failureText } = await import('../../renderer/src/i18n/i18n.js');

// --- the mark is one string in three places ---
assert.equal(gitFailure.DETAIL_MARK, DETAIL_MARK);
const i18nSource = await readFile(new URL('../../renderer/src/i18n/i18n.js', import.meta.url), 'utf8');
assert.ok(i18nSource.includes(JSON.stringify(DETAIL_MARK).slice(1, -1)), 'failureText cuts at the same mark');

// --- carrying a reason across IPC ---
const carried = carryDetail(Object.assign(new Error('Commit failed. See the command console.'), { detail: 'fatal: boom', hooks: ['pre-commit'] }));
assert.ok(carried.message.startsWith('Commit failed. See the command console.'));
// Electron prepends its own words to a rejected invoke.
const overIpc = new Error(`Error invoking remote method 'worktree:commit': Error: ${carried.message}`);
assert.equal(failureText(overIpc, 'x'), 'Commit failed. See the command console.', 'a window that does not read the reason shows the sentence as before');
assert.deepEqual(splitFailure(overIpc).reason, 'fatal: boom');
assert.deepEqual(splitFailure(overIpc).hooks, ['pre-commit']);
assert.equal(withDetail('plain'), 'plain', 'nothing to carry, nothing added');
const typeError = new TypeError('Invalid lock path');
assert.equal(carryDetail(typeError), typeError, 'a TypeError rejects the request as it is');
const bare = new Error('no detail');
assert.equal(carryDetail(bare), bare);
assert.equal(carryDetail(carried), carried, 'carried once');
assert.deepEqual(splitFailure({ ok: false, message: 'Merge did not finish.', reason: 'error: x', hooks: [] }), { message: 'Merge did not finish.', reason: 'error: x', hooks: [] });
assert.equal(splitFailure(`broken${DETAIL_MARK}{not json`).message, 'broken', 'a broken detail keeps the sentence');

// --- the line worth showing ---
assert.equal(lastLine('hint: a\nerror: first\nfatal: the reason\nhint: try again'), 'the reason');
assert.equal(lastLine('lint: 3 problems\n  src/a.js'), 'src/a.js');
assert.equal(lastLine(''), '');
assert.equal(tailLines('1\n2\n3\n4\n5\n6', 2), '5\n6');

// --- texts Git and SSH print that cannot be produced offline ---
const fixed = {
  'ssh-auth': 'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.',
  'host-key': 'Host key verification failed.\nfatal: Could not read from remote repository.',
  'https-auth': "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  network: "fatal: unable to access 'https://example.invalid/x.git/': Could not resolve host: example.invalid"
};
for (const [kind, text] of Object.entries(fixed)) assert.equal(classifyFailure(text).kind, kind, kind);
assert.equal(classifyFailure("remote: Invalid username or password.\nfatal: Authentication failed for 'https://github.com/a/b.git/'").kind, 'https-auth');
assert.equal(classifyFailure('').kind, 'none');
assert.equal(classifyFailure('fatal: something else').kind, 'other');
assert.equal(classifyFailure('fatal: something else', { hooks: ['pre-commit'] }).kind, 'hook', 'unexplained, with a hook present: the hook');

// --- words and ways out ---
for (const [kind, text] of Object.entries(fixed)) {
  const note = failureNote({ ok: false, message: 'Push failed. Show output in the console.', reason: text }, 'x', { repositoryId: 'r' });
  assert.equal(note.failed, true);
  assert.ok(note.text && note.text !== 'Push failed. Show output in the console.', `${kind} is put in words`);
  assert.ok(note.actions?.length === 1, `${kind} offers the dialog that fixes it`);
}
const plain = failureNote({ ok: false, message: 'Merge did not finish. Show output in the console.', reason: 'hint: x\nerror: Your local changes would be overwritten by merge' }, 'x');
assert.equal(plain.text, 'Merge did not finish. Show output in the console.');
assert.equal(plain.detail, 'Your local changes would be overwritten by merge', 'the rest: Git’s own last line under the sentence');
assert.equal(failureNote(new Error('Repository is unavailable'), 'x').text, 'Repository is unavailable', 'a failure without a reason is the sentence');
assert.equal(failureNote(null, 'Fallback.').text, 'Fallback.');
assert.equal(failureNote({ message: '', reason: 'fatal: x' }, 'Fallback.', { prefix: 'repo' }).text, 'repo: Fallback.');
assert.deepEqual(FAILURE_DIALOGS, ['Git profile', 'SSH', 'Remotes']);

const log = new CommandLog(path.join(root, 'journal'));
try {
  await log.load();
  const repo = path.join(root, 'work');
  await mkdir(repo);
  const git = async (argv, cwd = repo) => {
    const result = await runGit({ argv, cwd, log, operation: 'check' });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.useConfigOnly', 'true']);
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await git(['add', 'a.txt']);

  // Nobody to commit as: Git refuses, the note opens the Git profile.
  const anonymous = await createCommit({ cwd: repo, log, message: 'first' }).then(() => null, error => error);
  assert.ok(anonymous, 'a commit with no identity fails');
  const anonymousNote = failureNote(carryDetail(anonymous), 'x', { repositoryId: 'r' });
  assert.equal(classifyFailure(anonymous.detail).kind, 'identity', anonymous.detail);
  assert.equal(anonymousNote.actions[0].label, 'Open Git profile');
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await createCommit({ cwd: repo, log, message: 'first' });

  // A lock left behind: every staging action fails the same way until it goes.
  const gitDir = realpathSync(path.join(repo, '.git'));
  const lock = path.join(gitDir, 'index.lock');
  await writeFile(lock, '');
  await writeFile(path.join(repo, 'a.txt'), 'a\nb\n');
  const locked = await stageFile({ cwd: repo, log, path: 'a.txt' }).then(() => null, error => error);
  assert.ok(locked?.detail, 'stage carries what Git said');
  const lockCase = classifyFailure(locked.detail);
  assert.equal(lockCase.kind, 'lock', locked.detail);
  assert.equal(realpathSync(path.dirname(lockCase.lock)), gitDir, 'the lock path is the one Git named');
  const lockNote = failureNote(carryDetail(locked), 'x', { repositoryId: 'r' });
  assert.equal(lockNote.actions[0].label, 'Remove the lock…');
  assert.equal(failureNote(carryDetail(locked), 'x').actions.length, 0, 'no repository, no button');

  // Refusals: not a lock, not this repository, not a plain file, 🌱 Twig busy.
  for (const bad of ['relative/index.lock', path.join(gitDir, 'index'), 42, `${lock}\0`]) {
    await assert.rejects(removeLock({ cwd: repo, log, file: bad }), TypeError, String(bad));
  }
  const outside = path.join(root, 'outside.lock');
  await writeFile(outside, '');
  assert.equal((await removeLock({ cwd: repo, log, file: outside })).ok, false);
  assert.equal((await removeLock({ cwd: repo, log, file: path.join(gitDir, '..', '..', 'outside.lock') })).ok, false, 'no way out of .git with ..');
  assert.ok(existsSync(outside), 'a file outside the repository is never removed');
  await symlink(outside, path.join(gitDir, 'link.lock'));
  assert.equal((await removeLock({ cwd: repo, log, file: path.join(gitDir, 'link.lock') })).ok, false, 'a link is not removed');
  assert.ok(existsSync(outside));
  await mkdir(path.join(gitDir, 'folder.lock'));
  assert.equal((await removeLock({ cwd: repo, log, file: path.join(gitDir, 'folder.lock') })).ok, false, 'a folder is not removed');
  assert.equal((await removeLock({ cwd: repo, log, file: lock, busy: true })).ok, false, 'not while 🌱 Twig runs Git here');
  assert.ok(existsSync(lock));
  const removed = await removeLock({ cwd: repo, log, file: lockCase.lock });
  assert.deepEqual(removed, { ok: true, message: null });
  assert.equal(existsSync(lock), false);
  const entry = log.list().find(item => item.executable === '🌱 Twig' && item.argv[0] === 'remove');
  assert.ok(entry && entry.code === 0, 'the removal is in the journal');
  assert.equal((await removeLock({ cwd: repo, log, file: lock })).ok, true, 'a lock already gone is fine');
  await stageFile({ cwd: repo, log, path: 'a.txt' });

  // A lock in a linked worktree: its index lives in .git/worktrees/<name>, refs in the common dir.
  const linked = path.join(root, 'linked');
  await git(['worktree', 'add', '-b', 'side', linked]);
  const linkedGitDir = realpathSync(await git(['rev-parse', '--path-format=absolute', '--git-dir'], linked));
  const linkedLock = path.join(linkedGitDir, 'index.lock');
  await writeFile(linkedLock, '');
  assert.equal((await removeLock({ cwd: linked, log, file: linkedLock })).ok, true);
  const refLock = path.join(gitDir, 'refs', 'heads', 'side.lock');
  await writeFile(refLock, '');
  assert.equal((await removeLock({ cwd: linked, log, file: refLock })).ok, true, 'a ref lock in the common directory');
  await git(['worktree', 'remove', '--force', linked]);

  // A hook that says no: named, with what it printed.
  const hooks = path.join(gitDir, 'hooks');
  await mkdir(hooks, { recursive: true });
  await writeFile(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho "lint: 2 problems in a.txt" >&2\nexit 1\n');
  await chmod(path.join(hooks, 'pre-commit'), 0o755);
  const hooked = await createCommit({ cwd: repo, log, message: 'second' }).then(() => null, error => error);
  assert.deepEqual(hooked.hooks, ['pre-commit']);
  const hookNote = failureNote(carryDetail(hooked), 'x', { repositoryId: 'r' });
  assert.equal(hookNote.text, 'The pre-commit hook stopped it. What it printed:');
  assert.ok(hookNote.detail.includes('lint: 2 problems in a.txt'));
  // core.hooksPath is where Git looks then, and so does this.
  const elsewhere = path.join(root, 'hooks-elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'commit-msg'), '#!/bin/sh\nexit 1\n');
  await chmod(path.join(elsewhere, 'commit-msg'), 0o755);
  await git(['config', 'core.hooksPath', elsewhere]);
  assert.deepEqual(await presentHooks({ cwd: repo, log, names: ['pre-commit', 'commit-msg'] }), ['commit-msg']);
  await git(['config', '--unset', 'core.hooksPath']);
  await rm(path.join(hooks, 'pre-commit'));
  await writeFile(path.join(hooks, 'pre-commit.sample'), '#!/bin/sh\nexit 1\n');
  assert.deepEqual(await presentHooks({ cwd: repo, log, names: ['pre-commit'] }), [], 'samples do not count');

  // A signature that cannot be made.
  await git(['config', 'commit.gpgSign', 'true']);
  await git(['config', 'gpg.program', path.join(root, 'no-such-gpg')]);
  const unsigned = await createCommit({ cwd: repo, log, message: 'second' }).then(() => null, error => error);
  assert.equal(classifyFailure(unsigned.detail, { hooks: unsigned.hooks }).kind, 'signing', unsigned.detail);
  await git(['config', '--unset', 'commit.gpgSign']);
  await createCommit({ cwd: repo, log, message: 'second' });

  // A checkout Git refuses: the reason comes along with the sentence.
  await writeFile(path.join(repo, 'a.txt'), 'changed on main\n');
  await git(['commit', '-am', 'third']);
  await git(['switch', '-c', 'other', 'HEAD~1']);
  await writeFile(path.join(repo, 'a.txt'), 'local edit\n');
  const refused = await checkout({ cwd: repo, log, target: 'main' }).then(() => null, error => error);
  assert.ok(refused?.detail, 'checkout carries what Git said');
  const refusedNote = failureNote(carryDetail(refused), 'x');
  assert.match(refusedNote.detail, /overwritten by checkout/);
  await git(['checkout', '--', 'a.txt']);

  // The network, for real: nothing listens on port 1.
  await git(['remote', 'add', 'origin', 'ssh://git@127.0.0.1:1/nothing.git']);
  const unreachable = await runSync({ cwd: repo, log, mode: 'fetch' });
  assert.equal(unreachable.ok, false);
  assert.equal(classifyFailure(unreachable.reason, { hooks: unreachable.hooks }).kind, 'network', unreachable.reason);

  // Commits a detached HEAD would leave behind.
  await git(['switch', 'main']);
  assert.equal(await countDetachedCommits({ cwd: repo, log }), 0, 'on a branch: nothing to lose');
  await git(['checkout', '--detach']);
  assert.equal(await countDetachedCommits({ cwd: repo, log }), 0, 'detached at a branch tip: nothing to lose');
  await git(['commit', '--allow-empty', '-m', 'detached one']);
  await git(['commit', '--allow-empty', '-m', 'detached two']);
  assert.equal(await countDetachedCommits({ cwd: repo, log }), 2);
  await git(['update-ref', 'refs/twig/discard', 'HEAD']);
  assert.equal(await countDetachedCommits({ cwd: repo, log }), 2, '🌱 Twig’s own backups do not keep them');
  await git(['tag', 'keep', 'HEAD~1']);
  assert.equal(await countDetachedCommits({ cwd: repo, log }), 1, 'a tag keeps what it reaches');
  const probes = log.list().filter(item => item.operation === 'Read whether HEAD is detached');
  assert.ok(probes.length && probes.every(item => item.code === 0), 'the probe never reads as a failure in the journal');

  // 🌱 Twig knows when it is running Git in a folder.
  const pending = runGit({ argv: ['log', '--oneline'], cwd: repo, log, operation: 'check' });
  assert.equal(gitRunningIn(repo), true);
  assert.equal(gitRunningIn(root), true, 'a folder above counts');
  assert.equal(gitRunningIn(path.join(root, 'other')), false);
  await pending;
  assert.equal(gitRunningIn(repo), false);
} finally {
  await log.settled?.();
  await rm(root, { recursive: true, force: true });
}

console.log('git-failure: ok');
