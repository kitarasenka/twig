import { getWorkspaceContext } from './workspace.js';
import { listChanges } from './changes.js';
import { getCommit } from './show.js';
import { searchHistory } from './search.js';
import { getBlame } from './blame.js';
import { getUiContext } from './ui.js';
import { awaitCommit, newVersion, proposeCommit } from './commit.js';

/**
 * The implementations behind protocol.mjs's catalog, by tool name. A tool is
 * here only when it saves an agent something over running git itself — fewer
 * tokens, fewer calls — or gives it what git cannot (the person's selection,
 * their confirmation); a plain git command the agent can run is not wrapped. Each one is
 * `(ctx, args) => payload`; arguments arrive already checked against the
 * tool's schema with defaults filled in. All of them only read, except
 * propose_commit and new_version, which ask the person in 🌱 Twig's window
 * to commit (and tag).
 */
const IMPLEMENTATIONS = Object.freeze({
  get_workspace_context: getWorkspaceContext,
  list_changes: listChanges,
  get_commit: getCommit,
  search_history: searchHistory,
  get_blame: getBlame,
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
