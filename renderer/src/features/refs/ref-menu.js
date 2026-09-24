import { ClipboardCopy, Download, FolderGit2, GitBranch, GitCommitHorizontal, GitCompare, GitMerge, History, Redo2, Tag } from 'lucide-react';
import { refActionItems } from '../ops/commit-menu.js';

/**
 * The context menu of a branch or tag in the left sidebar, as data.
 *
 * It answers "what do I do with this ref?" — show it, check it out, merge or
 * rebase against it, compare it with HEAD, branch from it — and then offers the
 * very same management items the commit menu and the "Branches and tags"
 * screen offer (rename, upstream, publish, delete), through `refActionItems`.
 * Like the commit menu, an item that cannot run right now stays and says why.
 */
export function buildRefMenu({ ref, head = {}, remotes = [], operation = { kind: 'none' }, handlers }) {
  const busy = operation.kind !== 'none';
  const reason = busy ? `Finish or abort the ${operation.kind} first` : undefined;
  const target = head.branch || 'HEAD';
  const current = ref.type === 'local' && ref.name === head.branch;
  const same = Boolean(head.oid) && ref.target === head.oid;
  const noHead = !head.oid ? 'Nothing is checked out yet' : undefined;
  const items = [{ key: 'show', icon: History, text: 'Show in history', run: () => handlers.show(ref) }];
  // Rename is the one management item people reach for most, so on a local
  // branch it sits right under Check out (with its F2 shortcut) instead of
  // halfway down the list with the rest of `refActionItems`.
  const management = refActionItems({ ref, remotes, head, reason, handlers });
  const rename = management.find(item => item.key === `ref-rename-${ref.fullName}`);

  if (ref.type === 'local') {
    items.push({ key: 'checkout', icon: GitCommitHorizontal, text: `Check out ${ref.name}`,
      reason: reason || (current ? 'Already checked out' : undefined), run: () => handlers.checkoutBranch(ref.name) });
    if (rename) items.push({ ...rename, hint: 'F2' });
    // A second checkout in its own folder: work on this branch without
    // putting the current work away. Git itself refuses a branch another
    // worktree already has checked out, and says which.
    if (handlers.openWorktree) {
      items.push({ key: 'worktree', icon: FolderGit2, text: `Open ${ref.name} in a new worktree…`, hint: 'own folder, own tab',
        reason: current ? 'Already checked out here' : undefined, run: () => handlers.openWorktree(ref.name) });
    }
  } else if (ref.type === 'tag') {
    items.push({ key: 'checkout', icon: GitCommitHorizontal, text: `Check out ${ref.name} (detached)`,
      reason: reason || (head.detached && same ? 'Already checked out' : undefined), run: () => handlers.checkoutDetached(ref) });
  }

  if (ref.type !== 'tag') {
    const mergeReason = reason || (current ? 'This is the current branch' : noHead || (same ? `${target} already points here` : undefined));
    items.push(
      { key: 'merge', icon: GitMerge, text: `Merge ${ref.name} into ${target}`, reason: mergeReason, run: () => handlers.merge(ref.name, false) },
      { key: 'merge-noff', icon: GitMerge, text: `Merge ${ref.name} into ${target} without fast-forward`, reason: mergeReason, run: () => handlers.merge(ref.name, true) },
      { key: 'rebase', icon: Redo2, text: `Rebase ${target} onto ${ref.name}`,
        reason: reason || (current ? 'This is the current branch' : noHead || (same ? `${target} already points here` : undefined)),
        run: () => handlers.rebaseOnto(ref) }
    );
  }
  // Comparing reads two trees and changes nothing, so an open merge does not block it.
  items.push({ key: 'compare', icon: GitCompare, text: `Compare with ${target}`,
    reason: noHead || (same ? `${ref.name} and ${target} are the same commit` : undefined), run: () => handlers.compare(ref) });

  items.push({ separator: true });
  if (ref.type !== 'remote') {
    items.push({ key: 'branch-from', icon: GitBranch, text: `Create branch from ${ref.name}…`, reason, run: () => handlers.createBranchFrom(ref) });
  }
  if (ref.type === 'local') {
    items.push({ key: 'tag-at', icon: Tag, text: `Create tag at ${ref.name}…`, reason, run: () => handlers.createTagAt(ref) });
  }
  items.push(...management.filter(item => item !== rename));

  const what = ref.type === 'tag' ? 'tag' : 'branch';
  items.push(
    { separator: true },
    { key: 'copy-name', icon: ClipboardCopy, text: `Copy ${what} name`, run: () => handlers.copy(ref.name, `${what[0].toUpperCase()}${what.slice(1)} name`) },
    { key: 'copy-sha', icon: ClipboardCopy, text: 'Copy commit SHA', run: () => handlers.copy(ref.target, 'SHA') }
  );
  return items;
}

/**
 * The menu of a sidebar section header — LOCAL, REMOTE or TAGS: the actions
 * that make a new entry in that section, plus the screen that manages all of
 * them.
 */
export function buildSectionMenu({ type, head = {}, remotes = [], operation = { kind: 'none' }, handlers }) {
  const busy = operation.kind !== 'none';
  const reason = busy ? `Finish or abort the ${operation.kind} first` : undefined;
  const noHead = !head.oid ? 'Nothing is checked out yet' : undefined;
  const items = [];
  if (type === 'local') {
    items.push({ key: 'new-branch', icon: GitBranch, text: `Create branch at ${head.branch || 'HEAD'}…`, reason: reason || noHead, run: handlers.createBranchAtHead });
  } else if (type === 'remote') {
    items.push({ key: 'fetch', icon: Download, text: 'Fetch', hint: 'git fetch --prune',
      reason: reason || (remotes.length ? undefined : 'No remote is configured'), run: handlers.fetch });
  } else if (type === 'tag') {
    items.push({ key: 'new-tag', icon: Tag, text: `Create tag at ${head.branch || 'HEAD'}…`, reason: reason || noHead, run: handlers.createTagAtHead });
  }
  items.push({ separator: true }, { key: 'manage', icon: GitBranch, text: 'Open Branches and tags', run: handlers.manage });
  return items;
}
