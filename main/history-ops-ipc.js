import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { loadOperationState, resolveGitDir } from './git/operation-state.js';
import { cherryPick, merge, reset, revert, sequencer } from './git/history-ops.js';
import { checkout, createBranch, createTag, deleteBranch, deleteTag, renameBranch, setUpstream } from './git/refs-ops.js';
import { loadBisectState, runBisect } from './git/bisect.js';
import { clearPlan, planFiles, startRebase } from './git/rebase.js';
import { loadConflict, markResolved, saveResolution, takeSide } from './git/conflicts.js';

/**
 * History-mutating channels: the commit context menu, the interrupted-operation
 * banner and the conflict editor.
 *
 * Every mutation answers with the operation state read *after* it ran, because
 * a non-zero exit from a merge or a rebase is usually a conflict rather than a
 * failure, and only the state that follows tells the two apart. The renderer
 * therefore never has to guess what the repository is now in the middle of.
 */
export function registerHistoryOpsIpc(getWindow, entryUrl, { repositories, journal, stateDir, undo }) {
  const gitDirs = new Map();

  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new Error('Invalid operation request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new Error('Repository is unavailable');
      if (!gitDirs.has(repo.path)) gitDirs.set(repo.path, await resolveGitDir({ cwd: repo.path, log: journal }));
      const run = () => read({ cwd: repo.path, log: journal, gitDir: gitDirs.get(repo.path) }, ...args.slice(1));
      return ['ops:state', 'bisect:state', 'conflict:read'].includes(channel)
        ? run() : undo.perform(repo.path, channel, args.slice(1), run);
    });
  }

  /**
   * Runs one mutation and reports the state it left behind. A finished
   * operation drops its rebase plan, so a message prepared for one rebase can
   * never be applied to the next.
   *
   * A TypeError is never an outcome: the argv builders raise it for input that
   * is not valid Git at all — an unknown reset mode, a ref name with a space,
   * something that is not an object id — and such a call has to be refused at
   * the channel, not answered with a polite failure the renderer could ignore.
   * Everything else (a branch that exists, a conflict, a dirty tree) is a real
   * result and comes back as `ok: false` with the state that followed.
   */
  async function withState(options, run) {
    let outcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof TypeError) throw error;
      outcome = { ok: false, message: error.message };
    }
    const state = await loadOperationState(options);
    if (state.kind === 'none') await clearPlan({ stateDir, cwd: options.cwd });
    return { ...outcome, state };
  }

  /**
   * The bisect channels answer with the bisect state read after the command,
   * for the same reason the history ones answer with the operation state: what
   * Git did is visible only in the marks it left behind, never in the exit code
   * alone.
   */
  async function withBisect(options, run) {
    let outcome;
    try {
      outcome = await run();
    } catch (error) {
      if (error instanceof TypeError) throw error;
      outcome = { ok: false, message: error.message };
    }
    return { ...outcome, bisect: await loadBisectState(options) };
  }

  const asString = (value, limit = 4096) => {
    if (typeof value !== 'string' || value.length === 0 || value.length > limit) throw new Error('Invalid text argument');
    return value;
  };

  handler('ops:state', 1, options => loadOperationState(options));

  handler('ops:merge', 3, (options, revision, noFf) => {
    if (typeof noFf !== 'boolean') throw new Error('Invalid merge request');
    return withState(options, () => merge({ ...options, revision: asString(revision, 255), noFf }));
  });

  handler('ops:cherry-pick', 2, (options, oid) =>
    withState(options, () => cherryPick({ ...options, oid })));

  handler('ops:revert', 3, (options, oid, mainline) => {
    if (mainline !== null && !Number.isInteger(mainline)) throw new Error('Invalid revert request');
    return withState(options, () => revert({ ...options, oid, mainline }));
  });

  handler('ops:reset', 3, (options, mode, oid) =>
    withState(options, () => reset({ ...options, mode: asString(mode, 16), oid })));

  handler('ops:sequencer', 3, (options, kind, step) =>
    withState(options, () => sequencer({
      ...options, kind: asString(kind, 16), step: asString(step, 16),
      messagesFile: planFiles({ stateDir, cwd: options.cwd }).messagesFile
    })));

  handler('ops:rebase', 3, (options, oid, entries) => {
    if (entries !== null && !Array.isArray(entries)) throw new Error('Invalid rebase request');
    return withState(options, () => startRebase({ ...options, stateDir, oid, entries }));
  });

  handler('refs:create-branch', 4, (options, name, startPoint, checkoutNew) => {
    if (typeof checkoutNew !== 'boolean') throw new Error('Invalid branch request');
    return withState(options, () => createBranch({ ...options, name: asString(name, 255), startPoint, checkout: checkoutNew })
      .then(() => ({ ok: true, message: null })));
  });

  handler('refs:create-tag', 4, (options, name, oid, message) => {
    if (typeof message !== 'string' || message.length > 10000) throw new Error('Invalid tag request');
    return withState(options, () => createTag({ ...options, name: asString(name, 255), oid, message })
      .then(() => ({ ok: true, message: null })));
  });

  handler('refs:checkout', 3, (options, target, detach) => {
    if (typeof detach !== 'boolean') throw new Error('Invalid checkout request');
    return withState(options, () => checkout({ ...options, target: asString(target, 255), detach })
      .then(() => ({ ok: true, message: null })));
  });

  handler('refs:delete-branch', 3, (options, name, force) => {
    if (typeof force !== 'boolean') throw new Error('Invalid branch delete request');
    return withState(options, () => deleteBranch({ ...options, name: asString(name, 255), force })
      .then(() => ({ ok: true, message: null })));
  });

  handler('refs:rename-branch', 3, (options, from, to) =>
    withState(options, () => renameBranch({ ...options, from: asString(from, 255), to: asString(to, 255) })
      .then(() => ({ ok: true, message: null }))));

  handler('refs:upstream', 3, (options, branch, upstream) => {
    if (upstream !== null && typeof upstream !== 'string') throw new Error('Invalid upstream request');
    return withState(options, () => setUpstream({ ...options, branch: asString(branch, 255), upstream: upstream === null ? null : asString(upstream, 255) })
      .then(() => ({ ok: true, message: null })));
  });

  handler('refs:delete-tag', 2, (options, name) =>
    withState(options, () => deleteTag({ ...options, name: asString(name, 255) })
      .then(() => ({ ok: true, message: null }))));

  handler('bisect:state', 1, options => loadBisectState(options));

  /**
   * `start`, `bad`, `good`, `skip` and `reset`. The words `bad` and `good` are
   * not hard-coded into the command: a bisect started from the terminal may use
   * other terms, and Git then answers to those alone, so the terms are read
   * from the repository and spelled back to it.
   */
  handler('bisect:run', 3, async (options, step, oid) => {
    if (typeof step !== 'string' || step.length > 16 || (oid !== null && typeof oid !== 'string')) {
      throw new Error('Invalid bisect request');
    }
    const { terms } = await loadBisectState(options);
    return withBisect(options, () => runBisect({ ...options, step, oid, terms }));
  });

  handler('conflict:read', 2, (options, file) => loadConflict({ ...options, path: asString(file, 32768) }));

  handler('conflict:save', 5, (options, file, content, mtimeMs, size) => {
    if (typeof content !== 'string' || typeof mtimeMs !== 'number' || !Number.isInteger(size)) {
      throw new Error('Invalid conflict save request');
    }
    return withState(options, () => saveResolution({ ...options, path: asString(file, 32768), content, mtimeMs, size })
      .then(() => ({ ok: true, message: null })));
  });

  handler('conflict:take', 3, (options, file, side) =>
    withState(options, () => takeSide({ ...options, path: asString(file, 32768), side: asString(side, 16) })
      .then(() => ({ ok: true, message: null }))));

  handler('conflict:resolve', 2, (options, file) =>
    withState(options, () => markResolved({ ...options, path: asString(file, 32768) })
      .then(() => ({ ok: true, message: null }))));
}
