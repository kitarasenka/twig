// What the history workspace tells main about its selection, for an AI agent
// that asks 🌱 Twig through the MCP server (get_ui_context). Only what the
// workspace really holds: there is no branch selection (a branch click selects
// its commit) and no hunk selection, so neither is reported.
// No imports: Vite and the Node check both load this module directly.

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const isOid = value => typeof value === 'string' && OID.test(value);
const SIDES = ['staged', 'unstaged', 'untracked'];

/**
 * @param {{ repositoryId: string, selected: ?string, selection: string[], range: ?{ base: string, oid: string },
 *   diff: ?{ file: string, oid?: string, section?: string }, fileHistory: ?{ path: string }, blame: ?{ path: string, oid: string },
 *   conflict: ?string, screen: ?string, uncommitted: boolean }} state
 */
export function buildUiContext({ repositoryId, selected, selection, range, diff, fileHistory, blame, conflict, screen, uncommitted }) {
  const view = conflict ? 'conflict'
    : screen ? (screen === 'worktree' ? 'staging' : screen)
      : blame ? 'blame'
        : fileHistory ? 'file-history'
          : uncommitted ? 'changes'
            : range ? 'compare' : 'history';
  const selectedCommit = isOid(selected) ? selected : null;
  let selectedFile = null;
  if (conflict) selectedFile = { path: conflict, commit: null, side: null };
  else if (screen) selectedFile = null;
  else if (blame) selectedFile = { path: blame.path, commit: isOid(blame.oid) ? blame.oid : null, side: null };
  else if (diff?.file) {
    selectedFile = {
      path: diff.file,
      commit: isOid(diff.oid) ? diff.oid : uncommitted ? null : selectedCommit,
      side: SIDES.includes(diff.section) ? diff.section : null
    };
  } else if (fileHistory?.path) selectedFile = { path: fileHistory.path, commit: null, side: null };
  return {
    repositoryId,
    view,
    selectedCommit: screen || uncommitted ? null : selectedCommit,
    selectedCommits: !screen && Array.isArray(selection) ? selection.filter(isOid).slice(0, 100) : [],
    compare: !screen && range && isOid(range.base) && isOid(range.oid) ? { base: range.base, target: range.oid } : null,
    selectedFile
  };
}
