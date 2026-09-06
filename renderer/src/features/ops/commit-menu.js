import { ClipboardCopy, GitBranch, GitCommitHorizontal, GitMerge, ListOrdered, PenLine, Redo2, RotateCcw, Scissors, Tag, Target, Undo2 } from 'lucide-react';

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
export function buildCommitMenu({ commit, refs = [], head = {}, operation = { kind: 'none' },
  bisect = { active: false, done: false, terms: { bad: 'bad', good: 'good' } }, dirty = false, handlers }) {
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

  items.push(
    { separator: true },
    { key: 'copy-sha', icon: ClipboardCopy, text: 'Copy full SHA', run: () => handlers.copy(commit.oid, 'SHA') },
    { key: 'copy-message', icon: ClipboardCopy, text: 'Copy message', run: () => handlers.copy([commit.subject, commit.body].filter(Boolean).join('\n\n'), 'Message') }
  );
  return items;
}
