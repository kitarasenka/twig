import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { loadWorktree, loadWorktreeDiff } from './git/worktree.js';
import { applySelection, intentToAdd, stageAll, stageFile, unstageAll, unstageFile } from './git/stage.js';
import { createCommit, stashPop, stashPush } from './git/commit-ops.js';
import { loadStashDiff, loadStashes, loadStashFiles, runStashAction } from './git/stash.js';
import { loadDivergence, pushRef, runSync } from './git/sync.js';

/**
 * Working-tree and synchronisation channels.
 *
 * The renderer never sends patch content: for a line selection it sends the
 * digest of the diff it was looking at plus indices, and main re-reads the
 * diff itself. So the index can only ever receive content Git itself just
 * produced, and a selection made against a stale diff is refused instead of
 * silently staging the wrong lines.
 */
export function registerWorktreeIpc(getWindow, entryUrl, { repositories, journal, undo }) {
  const running = new Map();

  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new Error('Invalid working tree request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new Error('Repository is unavailable');
      const run = () => read({ cwd: repo.path, log: journal }, ...args.slice(1));
      const kind = channel === 'stash:action' && ['apply', 'pop'].includes(args[1]) ? `stash:${args[1]}` : channel;
      const parameters = kind !== channel ? [args[2]] : args.slice(1);
      return ['worktree:read', 'worktree:diff', 'stash:list', 'stash:files', 'stash:diff', 'sync:divergence', 'sync:cancel', 'sync:run', 'sync:push-ref'].includes(channel)
        ? run() : undo.perform(repo.path, kind, parameters, run);
    });
  }

  const asOid = value => {
    if (typeof value !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(value)) throw new Error('Invalid object id');
    return value;
  };

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

  /**
   * The bulk actions take a section, never a list of files: the paths are read
   * from a fresh `git status` inside main, so what gets staged is what the
   * section holds at the moment of the click.
   */
  handler('worktree:stage-all', 2, (options, scope) => {
    if (!['tracked', 'untracked'].includes(scope)) throw new Error('Invalid stage request');
    return stageAll({ ...options, scope });
  });
  handler('worktree:unstage-all', 1, options => unstageAll(options));

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
  handler('stash:list', 1, options => loadStashes(options));
  handler('stash:files', 2, (options, oid) => loadStashFiles({ ...options, oid: asOid(oid) }));
  handler('stash:diff', 4, (options, oid, path, untracked) => {
    if (typeof untracked !== 'boolean') throw new Error('Invalid stash diff request');
    return loadStashDiff({ ...options, oid: asOid(oid), file: asPath(path), untracked });
  });

  /**
   * One channel for apply, pop, drop and branch. The index names the stash and
   * the object id says which stash that index was showing: main re-reads the
   * list and refuses when the two no longer agree, because dropping any earlier
   * stash renumbers every later one.
   */
  handler('stash:action', 5, (options, action, index, expectedOid, name) => {
    if (typeof action !== 'string' || !Number.isInteger(index) || (name !== null && typeof name !== 'string')) {
      throw new Error('Invalid stash action request');
    }
    return runStashAction({ ...options, action, index, expectedOid: asOid(expectedOid), name });
  });

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
      return await undo.perform(options.cwd, 'sync:run', [mode, branch], () => controller.signal.aborted
        ? { ok: false, cancelled: true, notStarted: true, message: 'Cancelled before Git started.' }
        : runSync({ ...options, mode, branch, signal: controller.signal }));
    } finally {
      if (running.get(key) === controller) running.delete(key);
    }
  });

  /**
   * Publishing or deleting one ref on a remote. It shares the cancellation of
   * `sync:run` because it is the same kind of work: a network call the user
   * must be able to stop.
   */
  handler('sync:push-ref', 4, async (options, remote, ref, remove) => {
    if (typeof remote !== 'string' || typeof ref !== 'string' || typeof remove !== 'boolean'
      || remote.length > 255 || ref.length > 512) throw new Error('Invalid push request');
    const key = options.cwd;
    running.get(key)?.abort();
    const controller = new AbortController();
    running.set(key, controller);
    try {
      return await undo.perform(options.cwd, 'sync:push-ref', [], () => controller.signal.aborted
        ? { ok: false, cancelled: true, notStarted: true, message: 'Cancelled before Git started.' }
        : pushRef({ ...options, remote, ref, remove, signal: controller.signal }));
    } finally {
      if (running.get(key) === controller) running.delete(key);
    }
  });

  handler('sync:cancel', 1, options => {
    running.get(options.cwd)?.abort();
    return true;
  });
}
