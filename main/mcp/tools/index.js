import { getWorkspaceContext, listRepositories } from './workspace.js';
import { getDiff, getDiffHunk, listChanges } from './changes.js';
import { getCommit, getCommitDiff, getHistory } from './history.js';
import { getUiContext } from './ui.js';
import { awaitCommit, newVersion, proposeCommit } from './commit.js';

/**
 * The implementations behind protocol.mjs's catalog, by tool name. Each one is
 * `(ctx, args) => payload`; arguments arrive already checked against the
 * tool's schema with defaults filled in. All of them only read, except
 * propose_commit and new_version, which ask the person in 🌱 Twig's window
 * to commit (and tag).
 */
const IMPLEMENTATIONS = Object.freeze({
  get_workspace_context: getWorkspaceContext,
  list_repositories: listRepositories,
  list_changes: listChanges,
  get_diff: getDiff,
  get_diff_hunk: getDiffHunk,
  get_history: getHistory,
  get_commit: getCommit,
  get_commit_diff: getCommitDiff,
  get_ui_context: getUiContext,
  propose_commit: proposeCommit,
  new_version: newVersion,
  await_commit: awaitCommit
});

export const TOOL_NAMES = Object.freeze(Object.keys(IMPLEMENTATIONS));

/**
 * Binds every tool to one context, in the shape `createMcpSession` takes. The
 * session passes what it knows about its client (its working directory), so
 * one context serves every connection.
 */
export function bindTools(ctx) {
  return Object.fromEntries(Object.entries(IMPLEMENTATIONS).map(([name, run]) => [name, async (args, client = {}) => run(ctx.forClient(client), args)]));
}
