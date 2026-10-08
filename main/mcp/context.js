import { realpathSync } from 'node:fs';
import path from 'node:path';
import { resolveGitDir } from '../git/operation-state.js';
import { McpError } from './errors.js';
import { uiContextFor } from './ui-context.js';

/**
 * Agent reads are 🌱 Twig reads too, so they go to the same journal — with the
 * operation prefixed `MCP:` so Full History says who asked. The "My" filter
 * keeps them out, like the app's own background reads.
 */
export function agentLog(journal) {
  return {
    start: entry => journal.start({ ...entry, operation: `MCP: ${entry.operation}` }),
    output: (...args) => journal.output(...args),
    finish: (...args) => journal.finish(...args)
  };
}

/**
 * `git status` and `git diff` refresh the index's stat cache and write it back
 * when they can take the lock. An agent's read must not race a commit the
 * person is making, so every reader that touches the working tree gets this.
 */
export const READ_ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0' });

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * What every tool gets: the repository it should read, resolved only against
 * the list the person connected in 🌱 Twig, the journal and the UI selection.
 * A path is matched without running Git; nested repositories resolve to the
 * deepest root that contains it.
 * @param {{ repositories: { snapshot: () => { repositories: object[] } }, journal: object,
 *   getActiveId: () => ?string, getUiContext: () => ?object, proposals?: ?object, waitMs?: ?number }} options
 */
export function createToolContext({ repositories, journal, getActiveId, getUiContext, proposals = null, waitMs = null }) {
  const log = agentLog(journal);
  const gitDirs = new Map();

  const connected = () => repositories.snapshot().repositories;
  // A process reports its working directory resolved (/private/var/… on
  // macOS) while a repository may be connected through a symlink (/var/…), so
  // paths are matched both as written and resolved. Roots are resolved once.
  const resolved = new Map();
  const real = file => { try { return realpathSync.native(file); } catch { return file; } };
  const realRoot = root => {
    if (!resolved.has(root)) resolved.set(root, real(root));
    return resolved.get(root);
  };
  /** The deepest connected repository that contains `target`, or undefined. */
  const containing = target => {
    const targets = [target, real(target)];
    return connected()
      .filter(item => item.path && targets.some(candidate => inside(item.path, candidate) || inside(realRoot(item.path), candidate)))
      .sort((a, b) => b.path.length - a.path.length)[0];
  };

  function usable(repo, extra = {}) {
    if (!repo.available) throw new McpError('REPOSITORY_NOT_FOUND', `${repo.name} is connected but unavailable — it may have moved or been removed.`);
    return { id: repo.id, name: repo.name, path: repo.path, active: repo.id === getActiveId(), implicit: false, ...extra };
  }

  /**
   * The repository a tool reads. Named by the agent — a name, a root or any
   * path inside it. Not named — the agent's own working directory when it is
   * inside a connected repository (the bridge reports it), else the one open
   * in 🌱 Twig — and that last guess is `implicit`: the answer then says which
   * repository it read, with a note when the agent's own folder is elsewhere.
   * @param {unknown} selector
   * @param {{ cwd?: ?string }} [client]
   */
  function repository(selector, client = {}) {
    if (selector !== undefined && selector !== null) {
      let repo = connected().find(item => item.name === selector);
      if (!repo && path.isAbsolute(selector)) repo = containing(path.resolve(selector));
      if (!repo) throw new McpError('REPOSITORY_NOT_FOUND', `No repository connected to 🌱 Twig matches ${JSON.stringify(selector)}.`,
        { hint: 'Pass a name or an absolute path get_workspace_context lists, or connect the repository in 🌱 Twig first.' });
      return usable(repo);
    }
    const own = client.cwd ? containing(client.cwd) : undefined;
    if (own) return usable(own);
    const activeId = getActiveId();
    const note = client.cwd ? `Your working directory ${client.cwd} is not a repository connected to 🌱 Twig; this is the one open in 🌱 Twig.` : null;
    if (!activeId) throw new McpError('NO_REPOSITORY_OPEN', 'No repository is currently open in 🌱 Twig.',
      { hint: client.cwd ? `Connect ${client.cwd} in 🌱 Twig, or pass \`repository\` — get_workspace_context lists the connected ones.`
        : 'Open one in 🌱 Twig, or pass `repository` — get_workspace_context lists the connected ones.' });
    const repo = connected().find(item => item.id === activeId);
    if (!repo) throw new McpError('NO_REPOSITORY_OPEN', 'The repository open in 🌱 Twig is no longer connected.');
    return usable(repo, { implicit: true, ...(note ? { note } : {}) });
  }

  return {
    log,
    env: READ_ENV,
    /** How every tool reads the working tree: no index write-back, every untracked file by name. */
    worktree: cwd => ({ cwd, log, env: READ_ENV, allUntracked: true }),
    repository,
    repositories: connected,
    /** Commit proposals (see commit-proposal.js), or null where none can be shown. */
    proposals,
    waitMs,
    /**
     * The same context for one client session: its working directory, as the
     * bridge reported it, becomes the repository tools read by default.
     * @param {{ cwd?: ?string }} client
     */
    forClient(client) {
      return client?.cwd ? { ...this, repository: selector => repository(selector, client) } : this;
    },
    activeId: getActiveId,
    ui: getUiContext,
    uiFor: id => uiContextFor(getUiContext(), id),
    /** The git directory never changes for a repository root, so it is asked for once. */
    async gitDir(cwd) {
      if (!gitDirs.has(cwd)) gitDirs.set(cwd, await resolveGitDir({ cwd, log }));
      return gitDirs.get(cwd);
    }
  };
}
