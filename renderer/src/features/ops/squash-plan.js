/**
 * Squashing a run of adjacent commits into a single commit.
 *
 * Like rewording an older commit, this is an interactive rebase: Twig only
 * supplies the plan and lets Git replay it. The oldest commit of the run is
 * `reword`ed to the combined message the user approved, every newer commit of
 * the run is `fixup`ed into it (its own message dropped, because the one
 * message already covers them all), and everything after the run is `pick`ed
 * untouched. Routing the message through `reword` rather than `squash` means
 * the existing message map — which only carries `reword` text — delivers it
 * without a second editor prompt.
 *
 * `squashable` is the pure test the context menu asks before offering the
 * item: the selection has to be two or more commits that sit directly one
 * after another, none of them a merge. Whether they are on the current branch
 * is the caller's to check — that needs the branch, not just the commits.
 *
 * No imports on purpose: both Vite and the Node self-check load this file.
 *
 * @param {{ oid: string, parents: string[] }[]} selected newest-first, as the graph lists them
 */
export function squashable(selected) {
  if (!Array.isArray(selected) || selected.length < 2) {
    return { ok: false, reason: 'Select two or more commits to squash them.' };
  }
  for (const commit of selected) {
    if (!commit || !Array.isArray(commit.parents)) return { ok: false, reason: 'The selected commits could not be read. Refresh the history.' };
    if (commit.parents.length > 1) return { ok: false, reason: 'A merge commit cannot be squashed.' };
    if (commit.parents.length === 0) return { ok: false, reason: 'The very first commit of the history has nothing to squash into.' };
  }
  for (let i = 0; i < selected.length - 1; i++) {
    if (selected[i].parents[0] !== selected[i + 1].oid) {
      return { ok: false, reason: 'Only commits that sit directly one after another can be squashed.' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * @param {{ oid: string }[]} commits the range Git will replay, oldest first (base excluded)
 * @param {string[]} oids the commits the user selected
 * @param {string} message the combined message for the squashed commit
 */
export function buildSquashPlan(commits, oids, message) {
  if (!Array.isArray(commits) || commits.length === 0) throw new Error('There are no commits to replay.');
  if (typeof message !== 'string' || message.trim().length === 0) throw new Error('The squashed commit needs a message.');
  const chosen = new Set(oids);
  if (chosen.size < 2) throw new Error('Squashing needs at least two commits.');
  const positions = commits.map((commit, index) => (chosen.has(commit.oid) ? index : -1)).filter(index => index >= 0);
  if (positions.length !== chosen.size) {
    throw new Error('A selected commit is not among the ones being replayed. Refresh the history and try again.');
  }
  const first = positions[0];
  const last = positions[positions.length - 1];
  if (last - first + 1 !== positions.length) throw new Error('Only commits that sit directly one after another can be squashed.');
  return commits.map((commit, index) => {
    if (index === first) return { action: 'reword', oid: commit.oid, message };
    if (index > first && index <= last) return { action: 'fixup', oid: commit.oid };
    return { action: 'pick', oid: commit.oid };
  });
}
