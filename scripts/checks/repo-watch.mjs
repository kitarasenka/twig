import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveGitDir, isWatchedPath, createRepositoryWatcher } from '../../main/repo-watch.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// isWatchedPath: refs and markers count, lock files and unrelated churn do not.
for (const name of ['HEAD', 'packed-refs', 'ORIG_HEAD', 'refs/heads/main', 'logs/HEAD', 'rebase-merge/done']) {
  assert.equal(isWatchedPath(name), true, name);
}
// FETCH_HEAD is rewritten by every fetch, even one that brings nothing (the
// background fetch runs every few minutes); a fetch that does bring something
// moves refs/remotes, which is watched.
for (const name of ['index', 'index.lock', 'refs/heads/main.lock', 'config', 'objects/pack/pack-abc.pack', 'description', 'FETCH_HEAD']) {
  assert.equal(isWatchedPath(name), false, name);
}
assert.equal(isWatchedPath(null), true, 'a missing filename is treated as relevant');

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-watch-check-'));
try {
  // resolveGitDir: a real .git directory, a gitdir: pointer file, and neither.
  const repo = path.join(root, 'repo');
  const gitDir = path.join(repo, '.git');
  await mkdir(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(await resolveGitDir(repo), gitDir);

  const linked = path.join(root, 'linked');
  const realDir = path.join(root, 'worktrees', 'linked');
  await mkdir(realDir, { recursive: true });
  await mkdir(linked, { recursive: true });
  await writeFile(path.join(linked, '.git'), `gitdir: ${realDir}\n`);
  assert.equal(await resolveGitDir(linked), realDir);

  assert.equal(await resolveGitDir(path.join(root, 'nowhere')), null);

  // The watcher fires once per burst of relevant changes and addresses the event
  // to the repository it was told to watch.
  const events = [];
  const fakeWindow = { isDestroyed: () => false, webContents: { send: (channel, payload) => events.push({ channel, payload }) } };
  const watcher = createRepositoryWatcher(() => fakeWindow, 200);

  await watcher.watch(repo);
  assert.equal(watcher.watching, repo);
  await delay(50);

  // Several relevant writes inside one debounce window collapse to one event.
  await Promise.all([
    writeFile(path.join(gitDir, 'refs', 'heads', 'main'), 'a'.repeat(40) + '\n'),
    writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main\n'),
    writeFile(path.join(gitDir, 'ORIG_HEAD'), 'b'.repeat(40) + '\n')
  ]);
  await delay(500);
  assert.equal(events.length, 1, 'a burst of relevant writes is debounced to one event');
  assert.deepEqual(events[0], { channel: 'repo:external-change', payload: { cwd: repo } });

  // A lock file alone is ignored.
  events.length = 0;
  await writeFile(path.join(gitDir, 'index.lock'), '');
  await delay(400);
  assert.deepEqual(events, [], 'a .lock file does not wake the renderer');

  // Switching to null stops the watcher; the old directory no longer reports.
  await watcher.watch(null);
  assert.equal(watcher.watching, null);
  events.length = 0;
  await writeFile(path.join(gitDir, 'HEAD'), 'ref: refs/heads/other\n');
  await delay(400);
  assert.deepEqual(events, [], 'a stopped watcher is silent');

  watcher.stop();
  console.log('repo-watch check passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
