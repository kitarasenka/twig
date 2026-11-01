/**
 * Words and shown commands for the Worktrees and Submodules screens. Only the
 * translator is imported (it has no imports of its own): Vite and the Node
 * check both load it, and the check holds each command against the argv main
 * builds. Badges stay English (`mark`) because the screen compares them; it
 * translates them where it shows them.
 */

import { mark, t, tn } from '../../i18n/i18n.js';

const short = oid => (oid ? oid.slice(0, 7) : '');

/** The last part of a folder path, on any platform. */
export const folderLabel = folder => String(folder).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || folder;

/** What a submodule's checkout is, in words. */
export function submoduleState(entry) {
  if (entry.state === 'uninitialized') return t('Not initialized: its files are not here yet.');
  if (entry.state === 'moved') return t`Checked out at ${short(entry.head)}, not at the pinned ${short(entry.pinned)}.`;
  return t`Checked out at the pinned commit ${short(entry.pinned)}.`;
}

/** The action a submodule row offers for its state, or null. */
export function submoduleAction(entry) {
  if (entry.state === 'uninitialized') return t('Initialize');
  if (entry.state === 'moved') return t('Check out pinned commit');
  return null;
}

export function submoduleUpdateCommand(paths = null) {
  return ['submodule', 'update', '--init', '--', ...(paths || [])];
}

export function submoduleConsequence(entries) {
  const moved = entries.filter(entry => entry.state === 'moved');
  const missing = entries.filter(entry => entry.state === 'uninitialized');
  const parts = [];
  if (missing.length) {
    parts.push(missing.length === 1 ? t`${missing[0].path} is cloned from its URL, which reaches the network`
      : tn(missing.length, '{n} submodule is cloned from its URL, which reaches the network', '{n} submodules are cloned from their URLs, which reaches the network'));
  }
  if (moved.length) {
    parts.push(moved.length === 1 ? t`${moved[0].path} is checked out at the pinned commit, detached; commits made there stay in its reflog`
      : tn(moved.length, '{n} submodule is checked out at the pinned commit, detached; commits made there stay in its reflog',
        '{n} submodules are checked out at the pinned commit, detached; commits made there stay in their reflog'));
  }
  if (!parts.length) return t('Every submodule is already at its pinned commit; Git checks and changes nothing.');
  return `${parts.join('; ')}. ${t('Git refuses rather than overwrite uncommitted changes inside a submodule.')}`;
}

/** What a worktree row says about its checkout. */
export function worktreeLine(entry) {
  if (entry.bare) return t('Bare repository');
  if (entry.branch) return entry.branch;
  return t`Detached at ${short(entry.head)}`;
}

export function worktreeBadges(entry) {
  return [entry.main && mark('Main'), entry.current && mark('This tab'), entry.locked && mark('Locked'), entry.prunable && mark('Folder missing')].filter(Boolean);
}

/** Why a worktree cannot be removed from here, or undefined. */
export function worktreeRemoveReason(entry, busy = false) {
  if (busy) return t('Wait for the current action');
  if (entry.main) return t('The main worktree holds the repository itself');
  if (entry.current) return t('This is the worktree open in this tab');
  if (entry.locked) return t`Locked: ${entry.locked}. Unlock it with git worktree unlock first`;
  if (entry.prunable) return t('Its folder is gone; Prune forgets it');
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

/** What is not committed in a worktree, in one line. */
export function changesLine(changes) {
  if (!changes) return '';
  if (!changes.files) return t('Nothing uncommitted');
  const lines = changes.insertions || changes.deletions ? ` · +${changes.insertions} −${changes.deletions}` : '';
  const extra = [changes.untracked && tn(changes.untracked, '{n} new', '{n} new'),
    changes.conflicts && tn(changes.conflicts, '{n} in conflict', '{n} in conflict')].filter(Boolean).join(', ');
  return `${tn(changes.files, '{n} file not committed', '{n} files not committed')}${lines}${extra ? ` (${extra})` : ''}`;
}

/** Where a worktree's branch stands against the base, in one line, or ''. */
export function progressLine(card, base) {
  if (!base || card.main || card.ahead === null || card.ahead === undefined) return '';
  if (card.integrated === 'merged') return t`Merged into ${base}`;
  if (card.integrated === 'squashed') return t`Squashed into ${base}`;
  if (card.behind) {
    return tn(card.ahead, '{n} commit ahead of {base} · {behind} behind', '{n} commits ahead of {base} · {behind} behind', { base, behind: card.behind });
  }
  return tn(card.ahead, '{n} commit ahead of {base}', '{n} commits ahead of {base}', { base });
}

/** Labels on a board card, words first: colour is never the only sign. */
export function boardBadges(card) {
  return [card.main && mark('Main'), card.current && mark('This tab'), card.agent && mark('Agent'), card.connected && mark('Agent connected'),
    card.proposal && mark('Commit proposed'), card.integrated && mark('Done'), card.locked && mark('Locked'), card.prunable && mark('Folder missing')].filter(Boolean);
}

/** Why the worktree cannot be squashed into the base from its card, or undefined. */
export function squashReason(card, base, busy = false) {
  if (busy) return t('Wait for the current action');
  if (card.main) return t('This is the base');
  if (!base) return t('The main worktree is not on a branch');
  if (!card.branch) return t('This worktree is not on a branch');
  if (card.integrated) return t`Its work is already in ${base}`;
  if (!card.ahead) return t`No commits ahead of ${base} yet. Commit in the worktree first`;
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
  const many = connected.count > 1;
  const last = Date.parse(connected.lastCallAt ?? '');
  if (!Number.isFinite(last)) {
    return many ? tn(connected.count, '{n} agent connected · has not asked anything yet', '{n} agents connected · has not asked anything yet')
      : t('Agent connected · has not asked anything yet');
  }
  const when = ago(last / 1000);
  return many ? tn(connected.count, '{n} agent connected · last asked {when}', '{n} agents connected · last asked {when}', { when })
    : t`Agent connected · last asked ${when}`;
}

/** One side's change to a file in a comparison: what it did, or that it left the file alone. */
export function compareCell(side) {
  if (!side) return t('unchanged');
  if (side.untracked) return t('new, not committed');
  if (side.binary) return t('binary');
  if (side.status === 'D') return t('deleted');
  return `+${side.insertions ?? 0} −${side.deletions ?? 0}`;
}

/** Other worktrees a card can be compared with: not the base, not itself, with files. */
export function compareChoices(worktrees, path) {
  return worktrees.filter(entry => !entry.main && !entry.bare && !entry.prunable && entry.path !== path);
}
