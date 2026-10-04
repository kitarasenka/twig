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
 *   getActiveId: () => ?string, getUiContext: () => ?object }} options
 */
export function createToolContext({ repositories, journal, getActiveId, getUiContext }) {
  const log = agentLog(journal);
  const gitDirs = new Map();

  function repository(selector) {
    const list = repositories.snapshot().repositories;
    let repo;
    if (selector === undefined || selector === null) {
      const activeId = getActiveId();
      if (!activeId) throw new McpError('NO_REPOSITORY_OPEN', 'No repository is currently open in 🌱 Twig.',
        { hint: 'Open one in 🌱 Twig, or pass `repository` — list_repositories shows the connected ones.' });
      repo = list.find(item => item.id === activeId);
      if (!repo) throw new McpError('NO_REPOSITORY_OPEN', 'The repository open in 🌱 Twig is no longer connected.');
    } else {
      repo = list.find(item => item.name === selector);
      if (!repo && path.isAbsolute(selector)) {
        const target = path.resolve(selector);
        repo = list.filter(item => item.path && inside(item.path, target)).sort((a, b) => b.path.length - a.path.length)[0];
      }
      if (!repo) throw new McpError('REPOSITORY_NOT_FOUND', `No repository connected to 🌱 Twig matches ${JSON.stringify(selector)}.`,
        { hint: 'Pass a name or an absolute path from list_repositories, or connect the repository in 🌱 Twig first.' });
    }
    if (!repo.available) throw new McpError('REPOSITORY_NOT_FOUND', `${repo.name} is connected but unavailable — it may have moved or been removed.`);
    return { id: repo.id, name: repo.name, path: repo.path, active: repo.id === getActiveId() };
  }

  return {
    log,
    env: READ_ENV,
    /** How every tool reads the working tree: no index write-back, every untracked file by name. */
    worktree: cwd => ({ cwd, log, env: READ_ENV, allUntracked: true }),
    repository,
    repositories: () => repositories.snapshot().repositories,
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
