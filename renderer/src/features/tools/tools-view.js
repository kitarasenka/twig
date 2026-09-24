/**
 * Words and shown commands for the Worktrees and Submodules screens. No
 * imports: Vite and the Node check both load it, and the check holds each
 * command against the argv main builds.
 */

const short = oid => (oid ? oid.slice(0, 7) : '');

/** The last part of a folder path, on any platform. */
export const folderLabel = folder => String(folder).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;

/** What a submodule's checkout is, in words. */
export function submoduleState(entry) {
  if (entry.state === 'uninitialized') return 'Not initialized: its files are not here yet.';
  if (entry.state === 'moved') return `Checked out at ${short(entry.head)}, not at the pinned ${short(entry.pinned)}.`;
  return `Checked out at the pinned commit ${short(entry.pinned)}.`;
}

/** The action a submodule row offers for its state, or null. */
export function submoduleAction(entry) {
  if (entry.state === 'uninitialized') return 'Initialize';
  if (entry.state === 'moved') return 'Check out pinned commit';
  return null;
}

export function submoduleUpdateCommand(paths = null) {
  return ['submodule', 'update', '--init', '--', ...(paths || [])];
}

export function submoduleConsequence(entries) {
  const moved = entries.filter(entry => entry.state === 'moved');
  const missing = entries.filter(entry => entry.state === 'uninitialized');
  const parts = [];
  if (missing.length) parts.push(`${missing.length === 1 ? `${missing[0].path} is` : `${missing.length} submodules are`} cloned from ${missing.length === 1 ? 'its' : 'their'} URL${missing.length === 1 ? '' : 's'}, which reaches the network`);
  if (moved.length) parts.push(`${moved.length === 1 ? `${moved[0].path} is` : `${moved.length} submodules are`} checked out at the pinned commit, detached; commits made there stay in ${moved.length === 1 ? 'its' : 'their'} reflog`);
  if (!parts.length) return 'Every submodule is already at its pinned commit; Git checks and changes nothing.';
  return `${parts.join('; ')}. Git refuses rather than overwrite uncommitted changes inside a submodule.`;
}

/** What a worktree row says about its checkout. */
export function worktreeLine(entry) {
  if (entry.bare) return 'Bare repository';
  if (entry.branch) return entry.branch;
  return `Detached at ${short(entry.head)}`;
}

export function worktreeBadges(entry) {
  return [entry.main && 'Main', entry.current && 'This tab', entry.locked && 'Locked', entry.prunable && 'Folder missing'].filter(Boolean);
}

/** Why a worktree cannot be removed from here, or undefined. */
export function worktreeRemoveReason(entry, busy = false) {
  if (busy) return 'Wait for the current action';
  if (entry.main) return 'The main worktree holds the repository itself';
  if (entry.current) return 'This is the worktree open in this tab';
  if (entry.locked) return `Locked: ${entry.locked}. Unlock it with git worktree unlock first`;
  if (entry.prunable) return 'Its folder is gone; Prune forgets it';
  return undefined;
}

export function worktreeAddCommand({ path, branch, create = false, startPoint = null }) {
  return create ? ['worktree', 'add', '-b', branch, '--', path, startPoint] : ['worktree', 'add', '--', path, branch];
}

export function worktreeRemoveCommand(path, force = false) {
  return ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path];
}

/** Local branches a new worktree can check out: not already checked out in any worktree. */
export function freeBranches(refs, worktrees) {
  const taken = new Set(worktrees.map(entry => entry.branch).filter(Boolean));
  return refs.filter(ref => ref.type === 'local' && !taken.has(ref.name)).map(ref => ref.name);
}
