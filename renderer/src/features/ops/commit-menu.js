import { Bookmark, BookmarkX, ClipboardCopy, Combine, FileOutput, GitBranch, GitCommitHorizontal, GitMerge, Link2, ListOrdered, PenLine, Redo2, RotateCcw, Scissors, Tag, Target, Trash2, Undo2, Upload } from 'lucide-react';
import { squashable } from './squash-plan.js';

/**
 * What can be done to one ref itself — rename, upstream, publish, delete — the
 * same set the "Branches and tags" screen offers. Shared by the commit menu
 * (for the refs on that row) and the sidebar menu (for the ref under the
 * pointer), so the two can never drift apart. Deleting a ref has no inverse,
 * so each item that mutates goes through the §6.5 confirmation the handlers
 * open, not straight to the command.
 */
export function refActionItems({ ref, remotes = [], head = {}, reason, handlers }) {
  const remoteNames = (Array.isArray(remotes) ? remotes : []).filter(name => typeof name === 'string' && name);
  const perRemote = (make) => remoteNames.map(make);
  if (ref.type === 'local') {
    const current = ref.name === head.branch;
    return [
      { key: `ref-rename-${ref.fullName}`, icon: PenLine, text: `Rename ${ref.name}…`, reason, run: () => handlers.renameBranch(ref.name) },
      { key: `ref-upstream-${ref.fullName}`, icon: Link2, text: `Set upstream for ${ref.name}…`, reason, run: () => handlers.setUpstream(ref) },
      ...perRemote(name => ({
        key: `ref-publish-${ref.fullName}-${name}`, icon: Upload,
        text: remoteNames.length > 1 ? `Publish ${ref.name} to ${name}` : `Publish ${ref.name}`,
        reason, run: () => handlers.publishBranch(ref.name, name)
      })),
      { key: `ref-delete-${ref.fullName}`, icon: Trash2, danger: true, text: `Delete ${ref.name}`,
        reason: reason || (current ? 'A checked-out branch cannot be deleted' : undefined),
        run: () => handlers.deleteBranch(ref.name) }
    ];
  }
  if (ref.type === 'remote') {
    return [
      { key: `ref-checkout-remote-${ref.fullName}`, icon: GitCommitHorizontal, text: `Check out ${ref.name} as a new branch…`, reason, run: () => handlers.checkoutRemote(ref) },
      { key: `ref-delete-remote-${ref.fullName}`, icon: Trash2, danger: true, text: `Delete ${ref.name} on its remote`, reason, run: () => handlers.deleteRemoteBranch(ref) }
    ];
  }
  if (ref.type === 'tag') {
    return [
      ...perRemote(name => ({
        key: `ref-tag-publish-${ref.fullName}-${name}`, icon: Upload,
        text: remoteNames.length > 1 ? `Publish ${ref.name} to ${name}` : `Publish ${ref.name}`,
        reason, run: () => handlers.publishTag(ref, name)
      })),
      { key: `ref-tag-delete-${ref.fullName}`, icon: Trash2, danger: true, text: `Delete tag ${ref.name}`, reason, run: () => handlers.deleteTag(ref) },
      ...perRemote(name => ({
        key: `ref-tag-delete-remote-${ref.fullName}-${name}`, icon: Trash2, danger: true,
        text: remoteNames.length > 1 ? `Delete ${ref.name} on ${name}` : `Delete ${ref.name} on its remote`,
        reason, run: () => handlers.deleteTagOnRemote(ref, name)
      }))
    ];
  }
  return [];
}

/**
 * The items of the commit context menu (§8.2), as data.
 *
 * The brief asks for only what applies to be shown, so this is a pure function
 * of the commit, the refs pointing at it and what the repository is currently
 * in the middle of — which also makes "is `Merge` offered on a commit with no
 * branch?" a question the self-check can answer without a window.
 *
 * The one deliberate exception the brief allows is an item kept but disabled
 * when the reason is more useful than the absence: while a merge or rebase is
 * unfinished, Git refuses everything, and a menu that had quietly shrunk to
 * two items would leave the user guessing.
 */
export function buildCommitMenu({ commit, refs = [], remotes = [], head = {}, operation = { kind: 'none' },
  bisect = { active: false, done: false, terms: { bad: 'bad', good: 'good' } }, dirty = false, mark = null, handlers }) {
  const short = commit.oid.slice(0, 7);
  const busy = operation.kind !== 'none';
  const reason = busy ? `Finish or abort the ${operation.kind} first` : undefined;
  const branches = refs.filter(ref => ref.type === 'local' || ref.type === 'remote');
  const isHead = head.oid === commit.oid;
  const target = head.branch ? head.branch : 'HEAD';

  const items = [
    { key: 'branch', icon: GitBranch, text: 'Create branch here…', reason, run: handlers.createBranch },
    { key: 'tag', icon: Tag, text: 'Create tag here…', reason, run: handlers.createTag },
    ...branches
      .filter(ref => ref.type === 'local' && ref.name !== head.branch)
      .map(ref => ({ key: `checkout-${ref.fullName}`, icon: GitCommitHorizontal, text: `Check out ${ref.name}`, reason, run: () => handlers.checkoutBranch(ref.name) })),
    { key: 'detach', icon: GitCommitHorizontal, text: `Check out ${short} (detached)`, reason: reason || (isHead && head.detached ? 'Already checked out' : undefined), run: handlers.checkoutCommit },
    { separator: true }
  ];

  // Everything the "Branches and tags" screen does to a ref, offered on the
  // commit the ref sits on — but only for the refs that actually point here.
  const refItems = refs.flatMap(ref => refActionItems({ ref, remotes, head, reason, handlers }));
  if (refItems.length) items.push(...refItems, { separator: true });

  for (const ref of branches) {
    if (ref.type === 'local' && ref.name === head.branch) continue;
    items.push({
      key: `merge-${ref.fullName}`, icon: GitMerge, text: `Merge ${ref.name} into ${target}`,
      reason, run: () => handlers.merge(ref.name, false)
    });
    items.push({
      key: `merge-noff-${ref.fullName}`, icon: GitMerge, text: `Merge ${ref.name} into ${target} without fast-forward`,
      reason, run: () => handlers.merge(ref.name, true)
    });
  }
  if (branches.length === 0) {
    items.push({ key: 'merge-none', icon: GitMerge, text: `Merge into ${target}`, reason: 'No branch points at this commit', run: () => {} });
  }

  // Rewording the tip is `commit --amend`, which needs nothing but HEAD. An
  // older commit is rewritten by replaying the range, so it inherits every
  // condition a rebase has: a clean tree, a commit that has a parent to replay
  // from, and no merge, which a plain rebase does not replay at all.
  const rewordReason = reason || (isHead ? undefined
    : commit.parents.length === 0 ? 'Only the newest commit can be reworded here; this one starts the history'
      : commit.parents.length > 1 ? 'A merge commit cannot be replayed by rebase'
        : dirty ? 'Commit or stash your changes first' : undefined);
  items.push(
    { key: 'reword', icon: PenLine, text: `Reword ${short}…`,
      hint: isHead ? 'change the message only' : 'replays the commits after it', reason: rewordReason, run: handlers.reword },
    { key: 'rebase', icon: Redo2, text: `Rebase ${target} onto ${short}`, reason: reason || (isHead ? 'This is already where the branch is' : undefined), run: handlers.rebase },
    { key: 'rebase-i', icon: ListOrdered, text: `Rebase ${target} interactively from ${short}…`, reason: reason || (isHead ? 'There is nothing after this commit to replay' : undefined), run: handlers.interactiveRebase },
    { separator: true },
    { key: 'cherry-pick', icon: Scissors, text: `Cherry-pick ${short} onto ${target}`, reason: reason || (isHead ? 'This commit is already the tip' : undefined), run: handlers.cherryPick },
    { key: 'revert', icon: Undo2, text: `Revert ${short}`, reason, hint: commit.parents.length > 1 ? 'merge commit' : undefined, run: handlers.revert },
    { separator: true }
  );

  for (const [mode, note] of [['soft', 'keep the changes staged'], ['mixed', 'keep the changes, unstaged'], ['hard', 'throw the changes away']]) {
    items.push({
      key: `reset-${mode}`, icon: RotateCcw, text: `Reset ${target} to ${short} — ${mode}`, hint: note,
      danger: mode === 'hard', reason, run: () => handlers.reset(mode)
    });
  }

  // Bisect checks commits out one after another, so it needs the same clean
  // working tree a checkout does; saying so is more use than hiding the item.
  const bisectReason = reason || (dirty ? 'Commit or stash your changes first' : undefined);
  const terms = bisect.terms || { bad: 'bad', good: 'good' };
  items.push({ separator: true });
  if (!bisect.active) {
    items.push({
      key: 'bisect-start', icon: Target, text: `🌱 BugHunter (bisect) — start at ${short}`,
      hint: 'this commit has the bug; find where it started', reason: bisectReason, run: () => handlers.bisect('start')
    });
  } else {
    if (!bisect.done) {
      items.push(
        { key: 'bisect-bad', icon: Target, text: `Mark ${short} as ${terms.bad}`, reason: bisectReason, run: () => handlers.bisect('bad') },
        { key: 'bisect-good', icon: Target, text: `Mark ${short} as ${terms.good}`, reason: bisectReason, run: () => handlers.bisect('good') }
      );
    }
    items.push({ key: 'bisect-reset', icon: Target, text: 'Stop BugHunter and return', reason, run: () => handlers.bisect('reset') });
  }

  // Local marks are userData metadata, not a Git command, so nothing about an
  // unfinished operation blocks them: the item stays enabled mid-rebase.
  items.push(
    { separator: true },
    { key: 'mark', icon: Bookmark, text: mark ? 'Edit mark and note…' : 'Mark this commit…', run: handlers.mark }
  );
  if (mark) items.push({ key: 'unmark', icon: BookmarkX, text: 'Remove mark', run: handlers.removeMark });

  if (handlers.exportPatch) {
    items.push({ separator: true }, {
      key: 'export-patch', icon: FileOutput, text: `Export ${short} as a patch…`, hint: 'git format-patch',
      reason: commit.parents.length > 1 ? 'A merge commit has no single diff to export' : undefined, run: handlers.exportPatch
    });
  }
  items.push(
    { separator: true },
    { key: 'copy-sha', icon: ClipboardCopy, text: 'Copy full SHA', run: () => handlers.copy(commit.oid, 'SHA') },
    { key: 'copy-message', icon: ClipboardCopy, text: 'Copy message', run: () => handlers.copy([commit.subject, commit.body].filter(Boolean).join('\n\n'), 'Message') }
  );
  return items;
}

/**
 * The context menu shown when two or more commits are selected and the pointer
 * is on one of them. The brief's rule for the single-commit menu holds here
 * too: Squash is offered only when it can actually run — the selection is an
 * adjacent run of non-merge commits on the current branch — and when it cannot
 * because the tree is dirty or another operation is open, the item stays but
 * says why, since a menu that had quietly dropped it would read as a missing
 * feature. A selection that is out of order or off the branch simply has no
 * Squash item, exactly as asked.
 *
 * @param {{ oid: string, parents: string[] }[]} commits newest-first, as the graph lists them
 */
export function buildMultiCommitMenu({ commits, operation = { kind: 'none' }, dirty = false, onCurrentBranch = true,
  someOnCurrentBranch = onCurrentBranch, head = {}, handlers }) {
  const busy = operation.kind !== 'none';
  const busyReason = busy ? `Finish or abort the ${operation.kind} first` : undefined;
  const check = squashable(commits);
  const items = [];
  if (check.ok && onCurrentBranch) {
    items.push({
      key: 'squash', icon: Combine, text: `Squash ${commits.length} commits into one…`,
      hint: 'replays them as a single commit',
      reason: busyReason || (dirty ? 'Commit or stash your changes first' : undefined),
      run: handlers.squash
    });
    items.push({ separator: true });
  }
  // Cherry-pick and revert of a selection are kept even when they cannot run,
  // with the reason: which commits are on the branch is not visible at a glance.
  const target = head.branch || 'HEAD';
  const merge = commits.some(commit => commit.parents.length > 1)
    ? 'A merge commit is selected; cherry-pick or revert merge commits one at a time' : undefined;
  if (handlers.cherryPick) {
    items.push({
      key: 'cherry-pick-many', icon: Scissors, text: `Cherry-pick ${commits.length} commits onto ${target}…`,
      hint: 'oldest first', reason: busyReason || merge
        || (someOnCurrentBranch ? `${onCurrentBranch ? 'These commits are' : 'Some of these commits are'} already on ${target}` : undefined),
      run: handlers.cherryPick
    });
  }
  if (handlers.revert) {
    items.push({
      key: 'revert-many', icon: Undo2, text: `Revert ${commits.length} commits…`,
      hint: 'newest first, one revert commit each', reason: busyReason || merge
        || (!onCurrentBranch ? `Only commits on ${target} can be reverted here` : undefined),
      run: handlers.revert
    });
  }
  if (handlers.exportPatch) {
    items.push({
      key: 'export-patches', icon: FileOutput, text: `Export ${commits.length} commits as a patch…`, hint: 'one file, oldest first',
      reason: merge ? 'A merge commit is selected; it has no single diff to export' : undefined, run: handlers.exportPatch
    });
  }
  if (handlers.cherryPick || handlers.revert || handlers.exportPatch) items.push({ separator: true });
  items.push({ key: 'copy-shas', icon: ClipboardCopy, text: `Copy ${commits.length} SHAs`, run: handlers.copyShas });
  return items;
}
