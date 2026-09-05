import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { loadWorktree, loadWorktreeDiff } from './git/worktree.js';
import { applySelection, intentToAdd, stageFile, unstageFile } from './git/stage.js';
import { createCommit, stashList, stashPop, stashPush } from './git/commit-ops.js';
import { loadDivergence, runSync } from './git/sync.js';

/**
 * Working-tree and synchronisation channels.
 *
 * The renderer never sends patch content: for a line selection it sends the
 * digest of the diff it was looking at plus indices, and main re-reads the
 * diff itself. So the index can only ever receive content Git itself just
 * produced, and a selection made against a stale diff is refused instead of
 * silently staging the wrong lines.
 */
export function registerWorktreeIpc(getWindow, entryUrl, { repositories, journal }) {
  const running = new Map();

  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new Error('Invalid working tree request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new Error('Repository is unavailable');
      return read({ cwd: repo.path, log: journal }, ...args.slice(1));
    });
  }

  const asPath = value => {
    if (typeof value !== 'string' || value.length === 0 || value.length > 32768) throw new Error('Invalid file path');
    return value;
  };

  handler('worktree:read', 1, options => loadWorktree(options));
  handler('worktree:diff', 3, (options, path, staged) => {
    if (typeof staged !== 'boolean') throw new Error('Invalid diff request');
    return loadWorktreeDiff({ ...options, path: asPath(path), staged });
  });
  handler('worktree:stage', 2, (options, path) => stageFile({ ...options, path: asPath(path) }).then(() => true));
  handler('worktree:unstage', 3, (options, path, unborn) => {
    if (typeof unborn !== 'boolean') throw new Error('Invalid unstage request');
    return unstageFile({ ...options, path: asPath(path), unborn }).then(() => true);
  });
  handler('worktree:track', 2, (options, path) => intentToAdd({ ...options, path: asPath(path) }).then(() => true));

  handler('worktree:apply', 5, async (options, path, staged, digest, selection) => {
    if (typeof staged !== 'boolean' || typeof digest !== 'string' || !Array.isArray(selection)) throw new Error('Invalid apply request');
    const file = asPath(path);
    const current = await loadWorktreeDiff({ ...options, path: file, staged });
    if (current.digest !== digest) throw new Error('This file changed since the diff was read. Refresh and select again.');
    return applySelection({
      ...options, path: file, hunks: current.hunks, selection, reverse: staged,
      added: current.added, deleted: current.deleted, mode: current.mode
    });
  });

  handler('worktree:commit', 3, (options, message, amend) => {
    if (typeof message !== 'string' || message.length > 1_000_000 || typeof amend !== 'boolean') throw new Error('Invalid commit request');
    return createCommit({ ...options, message, amend });
  });

  handler('stash:push', 3, (options, includeUntracked, message) => {
    if (typeof includeUntracked !== 'boolean' || typeof message !== 'string' || message.length > 4096) throw new Error('Invalid stash request');
    return stashPush({ ...options, includeUntracked, message }).then(() => true);
  });
  handler('stash:pop', 1, options => stashPop(options).then(() => true));
  handler('stash:list', 1, options => stashList(options));

  handler('sync:divergence', 2, (options, branch) => {
    if (branch !== null && typeof branch !== 'string') throw new Error('Invalid divergence request');
    return loadDivergence({ ...options, branch });
  });

  handler('sync:run', 3, async (options, mode, branch) => {
    if (typeof mode !== 'string' || (branch !== null && typeof branch !== 'string')) throw new Error('Invalid sync request');
    const key = options.cwd;
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    try {
      return await runSync({ ...options, mode, branch, signal: controller.signal });
    } finally {
      if (running.get(key) === controller) running.delete(key);
    }
  });

  handler('sync:cancel', 1, options => {
    running.get(options.cwd)?.abort();
    return true;
  });
}
