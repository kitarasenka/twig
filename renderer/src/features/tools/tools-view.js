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

/**
 * The command that starts an agent in a worktree, for the person to paste in
 * a terminal: 🌱 Twig does not run agents itself. POSIX quoting everywhere
 * but Windows, where cmd.exe takes double quotes and `/d` to change drive.
 */
export function launchCommand(folder, platform = 'darwin') {
  if (platform === 'win32') return `cd /d "${folder}" && claude`;
  return `cd '${String(folder).replace(/'/g, "'\\''")}' && claude`;
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** What is not committed in a worktree, in one line. */
export function changesLine(changes) {
  if (!changes) return '';
  if (!changes.files) return 'Nothing uncommitted';
  const lines = changes.insertions || changes.deletions ? ` · +${changes.insertions} −${changes.deletions}` : '';
  const extra = [changes.untracked && `${changes.untracked} new`, changes.conflicts && `${changes.conflicts} in conflict`].filter(Boolean).join(', ');
  return `${plural(changes.files, 'file')} not committed${lines}${extra ? ` (${extra})` : ''}`;
}

/** Where a worktree's branch stands against the base, in one line, or ''. */
export function progressLine(card, base) {
  if (!base || card.main || card.ahead === null || card.ahead === undefined) return '';
  if (card.integrated === 'merged') return `Merged into ${base}`;
  if (card.integrated === 'squashed') return `Squashed into ${base}`;
  const parts = [`${plural(card.ahead, 'commit')} ahead of ${base}`];
  if (card.behind) parts.push(`${card.behind} behind`);
  return parts.join(' · ');
}

/** Labels on a board card, words first: colour is never the only sign. */
export function boardBadges(card) {
  return [card.main && 'Main', card.current && 'This tab', card.agent && 'Agent', card.connected && 'Agent connected', card.proposal && 'Commit proposed',
    card.integrated && 'Done', card.locked && 'Locked', card.prunable && 'Folder missing'].filter(Boolean);
}

/** Why the worktree cannot be squashed into the base from its card, or undefined. */
export function squashReason(card, base, busy = false) {
  if (busy) return 'Wait for the current action';
  if (card.main) return 'This is the base';
  if (!base) return 'The main worktree is not on a branch';
  if (!card.branch) return 'This worktree is not on a branch';
  if (card.integrated) return `Its work is already in ${base}`;
  if (!card.ahead) return `No commits ahead of ${base} yet. Commit in the worktree first`;
  return undefined;
}

/** The two commands "Remove worktree and branch" runs. */
export function finishCommands(path, branch) {
  return [worktreeRemoveCommand(path), ['branch', '-D', '--', branch]];
}

/**
 * An agent connected over MCP from this worktree, in words, or ''. `ago`
 * turns a time in seconds into "2 minutes ago" (the screen passes relativeTime).
 */
export function connectedLine(connected, ago) {
  if (!connected) return '';
  const who = connected.count > 1 ? `${connected.count} agents connected` : 'Agent connected';
  const last = Date.parse(connected.lastCallAt ?? '');
  return Number.isFinite(last) ? `${who} · last asked ${ago(last / 1000)}` : `${who} · has not asked anything yet`;
}

/** One side's change to a file in a comparison: what it did, or that it left the file alone. */
export function compareCell(side) {
  if (!side) return 'unchanged';
  if (side.untracked) return 'new, not committed';
  if (side.binary) return 'binary';
  if (side.status === 'D') return 'deleted';
  return `+${side.insertions ?? 0} −${side.deletions ?? 0}`;
}

/** Other worktrees a card can be compared with: not the base, not itself, with files. */
export function compareChoices(worktrees, path) {
  return worktrees.filter(entry => !entry.main && !entry.bare && !entry.prunable && entry.path !== path);
}
