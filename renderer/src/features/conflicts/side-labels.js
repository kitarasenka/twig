import { t } from '../../i18n/i18n.js';

const short = oid => (typeof oid === 'string' && oid ? oid.slice(0, 7) : null);

/**
 * Who "ours" and "theirs" are in the operation that stopped.
 *
 * Git's two words are positional, not personal: in a merge "ours" is the
 * branch you are on, but in a rebase it is the commit the branch is being
 * replayed onto, and "theirs" is your own commit. A person who reads "Take
 * all ours" as "keep mine" during a rebase throws their own change away, so
 * each side is named by what it is in this operation.
 *
 * `name` is short enough for a button (a branch, a short id); `role` is the
 * whole phrase for headings and dialogs. `refName(oid)` names a commit by a
 * ref that points at it, when there is one.
 *
 * @param {{ kind: string, branch?: ?string, onto?: ?string, incoming?: ?string, incomingName?: ?string }|null} operation
 * @param {{ headBranch?: ?string, refName?: (oid: string) => ?string }} [context]
 * @returns {{ ours: { name: string, role: string }, theirs: { name: string, role: string } }}
 */
export function conflictSides(operation, { headBranch = null, refName = () => null } = {}) {
  const kind = operation?.kind;
  const named = oid => (oid ? refName(oid) || short(oid) : null);
  const yours = headBranch || t('your branch');
  if (kind === 'rebase') {
    return {
      ours: { name: named(operation.onto) || t('the new base'), role: t('what your branch is being rebased onto') },
      theirs: { name: short(operation.incoming) || t('your commit'), role: t('your commit being replayed') }
    };
  }
  if (kind === 'merge') {
    return {
      ours: { name: yours, role: t('your branch, where the merge lands') },
      theirs: { name: operation.incomingName || named(operation.incoming) || t('the merged branch'), role: t('the branch being merged in') }
    };
  }
  if (kind === 'cherry-pick') {
    return {
      ours: { name: yours, role: t('your branch, where the commit lands') },
      theirs: { name: short(operation.incoming) || t('the picked commit'), role: t('the commit being cherry-picked') }
    };
  }
  if (kind === 'revert') {
    return {
      ours: { name: yours, role: t('your branch as it is now') },
      theirs: { name: short(operation.incoming) ? t`undo of ${short(operation.incoming)}` : t('the revert'), role: t('the change that undoes the reverted commit') }
    };
  }
  if (kind === 'am') {
    return { ours: { name: yours, role: t('your branch as it is now') }, theirs: { name: t('the patch'), role: t('the patch being applied') } };
  }
  if (kind === 'conflict') {
    return { ours: { name: yours, role: t('your branch as it is now') }, theirs: { name: t('the stash'), role: t('the stash being applied') } };
  }
  return { ours: { name: t('Ours'), role: t('the side Git calls ours') }, theirs: { name: t('Theirs'), role: t('the side Git calls theirs') } };
}

/** The ref a commit is known by, local branches first, for naming a side. */
export function refNamer(refs = []) {
  const byOid = new Map();
  for (const type of ['local', 'remote', 'tag']) {
    for (const ref of refs) if (ref.type === type && ref.target && !byOid.has(ref.target)) byOid.set(ref.target, ref.name);
  }
  return oid => byOid.get(oid) || null;
}
