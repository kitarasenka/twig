// What the renderer reports about its selection, for get_ui_context and the
// `selection` in get_workspace_context. It is held in main's memory only, is
// never written to disk, and is replaced whole on every report. No imports:
// the Node check loads it directly.

export const UI_VIEWS = Object.freeze([
  'history', 'changes', 'staging', 'compare', 'file-history', 'blame', 'conflict',
  'branches', 'stashes', 'reflog', 'worktrees', 'submodules', 'maintenance', 'automations'
]);
export const FILE_SIDES = Object.freeze(['staged', 'unstaged', 'untracked']);

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_SELECTED = 100;

const oidOrNull = value => (value === null || value === undefined ? null : OID.test(value) ? value : undefined);

function pathOrNull(value) {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0') ? value : undefined;
}

/**
 * Validates a report from the renderer. Anything that does not fit is refused
 * whole (null) rather than partly kept: a half-understood selection would be
 * worse for an agent than none.
 * @returns {?{ repositoryId: ?string, view: ?string, selectedCommit: ?string, selectedCommits: string[],
 *   compare: ?{ base: string, target: string }, selectedFile: ?{ path: string, commit: ?string, side: ?string } }}
 */
export function normalizeUiContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const repositoryId = raw.repositoryId === null ? null : pathOrNull(raw.repositoryId);
  if (repositoryId === undefined) return null;
  const view = raw.view === null || raw.view === undefined ? null : UI_VIEWS.includes(raw.view) ? raw.view : undefined;
  const selectedCommit = oidOrNull(raw.selectedCommit);
  if (view === undefined || selectedCommit === undefined) return null;

  const commits = raw.selectedCommits ?? [];
  if (!Array.isArray(commits) || commits.length > MAX_SELECTED || !commits.every(oid => OID.test(oid))) return null;

  let compare = null;
  if (raw.compare !== null && raw.compare !== undefined) {
    if (typeof raw.compare !== 'object' || !OID.test(raw.compare.base) || !OID.test(raw.compare.target)) return null;
    compare = { base: raw.compare.base, target: raw.compare.target };
  }

  let selectedFile = null;
  if (raw.selectedFile !== null && raw.selectedFile !== undefined) {
    const file = raw.selectedFile;
    if (typeof file !== 'object') return null;
    const path = pathOrNull(file.path);
    const commit = oidOrNull(file.commit);
    const side = file.side === null || file.side === undefined ? null : FILE_SIDES.includes(file.side) ? file.side : undefined;
    if (!path || commit === undefined || side === undefined) return null;
    selectedFile = { path, commit, side };
  }
  return { repositoryId, view: repositoryId ? view : null, selectedCommit, selectedCommits: [...commits], compare, selectedFile };
}

/** The UI context of one repository, or null when the last report was about another one (or none). */
export function uiContextFor(context, repositoryId) {
  return context && repositoryId && context.repositoryId === repositoryId ? context : null;
}
