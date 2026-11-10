import { validateOid, validateFile } from './commit.js';
import { validateRefName } from './refs-ops.js';
import { discardInverse } from './discard-plan.js';
import { ignoreInverse } from './ignore-plan.js';
import { moveBranchInverse } from './reflog-plan.js';
import { ui, uiN } from '../../renderer/src/i18n/i18n.js';

function branchName(value) {
  validateRefName(value);
  if (value.startsWith('-')) throw new TypeError('Invalid saved branch name');
  return value;
}
const checkout = state => state.branch ? ['checkout', branchName(state.branch), '--'] : ['checkout', '--detach', validateOid(state.head), '--'];
const reset = (mode, oid) => ['reset', mode, oid];

export function buildUndoPlan(entry, direction) {
  if (!['undo', 'redo'].includes(direction)) throw new TypeError('Invalid Undo direction');
  const { kind, before, after, args } = entry;
  for (const state of [before, after]) {
    if (state.head !== null) validateOid(state.head);
    if (state.branch !== null) branchName(state.branch);
    // Only a stash pop or apply keeps its paths: its Undo names them.
    if (state.paths !== undefined) {
      if (!Array.isArray(state.paths)) throw new TypeError('Invalid saved operation paths');
      state.paths.forEach(validateFile);
    }
  }
  if (kind === 'refs:create-branch') { branchName(args[0]); validateOid(args[1]); if (typeof args[2] !== 'boolean') throw new TypeError('Invalid saved branch action'); }
  if (kind === 'stash:push' && (typeof args[0] !== 'boolean' || typeof args[1] !== 'string' || args[1].includes('\0'))) throw new TypeError('Invalid saved stash action');
  if (['stash:pop', 'stash:apply'].includes(kind)) {
    validateOid(before.stashOid);
    if (!Array.isArray(after.paths)) throw new TypeError('Invalid saved stash action');
    if (typeof before.stashMessage !== 'string' || before.stashMessage.includes('\0') || (args[0] !== undefined && (!Number.isInteger(args[0]) || args[0] < 0))) throw new TypeError('Invalid saved stash action');
  }
  const undo = direction === 'undo';
  let commands; let destructive = false;
  if (kind === 'worktree:discard' || kind === 'worktree:restore-discard') {
    if (!args || typeof args !== 'object' || !Array.isArray(args.paths) || !Array.isArray(args.removed) || !args.paths.length) throw new TypeError('Invalid saved discard');
    validateOid(args.before); validateOid(args.after);
    args.paths.forEach(validateFile);
    const known = new Set(args.paths);
    if (args.removed.some(file => !known.has(file))) throw new TypeError('Invalid saved discard');
    // Both directions only rewrite the recorded paths, and the Undo chain has
    // already checked they are exactly as the discard left them (or as Undo
    // restored them), so nothing unrecorded can be lost.
    if (kind === 'worktree:restore-discard') {
      // Bringing a backup back is a discard run the other way: `before` is what
      // it put on disk, `after` what was there, `removed` the files it created.
      return { commands: discardInverse(args, undo ? 'redo' : 'undo'), destructive: false,
        explanation: undo ? ui`Puts the files back as they were before the backup was restored.` : ui`Restores the same backup again.` };
    }
    return { commands: discardInverse(args, direction), destructive: false,
      explanation: undo ? ui`Restores the discarded files from the backup 🌱 Twig recorded before discarding.`
        : ui`Discards the same changes again. The backup stays in Reflog, under Discarded changes.` };
  }
  if (kind === 'worktree:ignore') {
    if (!args || typeof args !== 'object' || typeof args.created !== 'boolean') throw new TypeError('Invalid saved .gitignore edit');
    validateOid(args.before); validateOid(args.after);
    // Only .gitignore is rewritten, and the chain has checked it is exactly as the edit left it.
    return { commands: ignoreInverse(args, direction), destructive: false,
      explanation: undo ? (args.created ? ui`Deletes the .gitignore the rule created.` : ui`Restores .gitignore as it was before the rule was added.`)
        : ui`Adds the rule to .gitignore again.` };
  }
  if (kind === 'reflog:move-branch') {
    if (!Array.isArray(args) || args.length !== 4) throw new TypeError('Invalid saved branch move');
    branchName(args[0]); validateOid(args[1]); validateOid(args[2]);
    // Each direction is guarded: update-ref swaps only from the recorded tip,
    // and reset --keep refuses to overwrite uncommitted changes.
    return { commands: moveBranchInverse(args, direction), destructive: false,
      explanation: undo ? ui`Moves ${args[0]} back to ${args[1].slice(0, 7)}, where it was before.` : ui`Moves ${args[0]} to ${args[2].slice(0, 7)} again.` };
  }
  if (kind === 'refs:create-tag') {
    if (!Array.isArray(args) || args.length !== 2) throw new TypeError('Invalid saved tag');
    branchName(args[0]); validateOid(args[1]);
    // Both are compare-and-swap: Undo deletes the tag only while it still
    // points where it was made, Redo recreates it only if no such tag exists.
    const ref = `refs/tags/${args[0]}`;
    return { commands: [undo ? ['update-ref', '-d', ref, args[1]] : ['update-ref', ref, args[1], '0'.repeat(args[1].length)]], destructive: false,
      explanation: undo ? ui`Deletes the tag ${args[0]} that was just created.` : ui`Creates the tag ${args[0]} again.` };
  }
  if (kind === 'worktree:commit' || kind === 'ops:reword') {
    // A reword always has a commit under it; only a first commit undoes to nothing.
    commands = undo && !before.head ? [['update-ref', '-d', 'HEAD', after.head]]
      : [reset('--soft', undo ? before.head : after.head)];
  } else if (kind === 'ops:reset') {
    // A soft reset moved only the branch; a mixed one also set the index to
    // the target, which the chain records only when nothing was staged before
    // it — then the same mixed reset back restores the index exactly.
    if (!Array.isArray(args) || !['soft', 'mixed'].includes(args[0])) throw new TypeError('Invalid saved reset');
    commands = [reset(`--${args[0]}`, validateOid(undo ? before.head : after.head))];
  } else if (['ops:merge', 'ops:revert', 'ops:cherry-pick', 'ops:cherry-pick-many', 'ops:revert-many', 'patch:am'].includes(kind)) {
    destructive = true; commands = [reset('--hard', undo ? before.head : after.head)];
  } else if (kind === 'refs:checkout') commands = [checkout(undo ? before : after)];
  else if (kind === 'refs:create-branch') {
    commands = undo ? [...(args[2] ? [checkout(before)] : []), ['branch', '-d', '--', args[0]]]
      : [['branch', '--', args[0], args[1]], ...(args[2] ? [['checkout', args[0], '--']] : [])];
  } else if (kind === 'stash:push') {
    commands = undo ? [['stash', 'pop', '--index', 'stash@{0}']]
      : [['stash', 'push', ...(args[0] ? ['--include-untracked'] : []), ...(args[1] ? ['--message', args[1]] : [])]];
  } else if (kind === 'stash:pop' || kind === 'stash:apply') {
    destructive = undo;
    commands = undo ? [
      ['stash', 'push', '--include-untracked', '--message', '🌱 Twig undo stash', '--', ...after.paths.map(file => `:(literal)${file}`)],
      ['stash', 'drop', 'stash@{0}'],
      ...(kind === 'stash:pop' ? [['stash', 'store', '--message', before.stashMessage, before.stashOid]] : [])
    ] : [['stash', kind === 'stash:pop' ? 'pop' : 'apply', `stash@{${args[0] || 0}}`]];
  } else throw new Error(ui`This operation has no safe inverse.`);
  return { commands, destructive, explanation: destructive
    ? ui`This restores the recorded repository state. reset --hard replaces tracked files; stash drop removes only the temporary stash created by this inverse. Later changes must not be present.`
    : ui`Only the recorded application action will be reversed.` };
}

/** The actions Undo can reverse; every other action that changes the repository ends the chain. */
export const UNDOABLE_KINDS = Object.freeze(['worktree:discard', 'worktree:restore-discard', 'worktree:ignore', 'reflog:move-branch', 'refs:create-tag', 'worktree:commit', 'ops:reword', 'ops:reset', 'ops:merge',
  'ops:revert', 'ops:cherry-pick', 'ops:cherry-pick-many', 'ops:revert-many', 'patch:am', 'refs:checkout', 'refs:create-branch', 'stash:push', 'stash:pop', 'stash:apply']);

/** Actions that change only the index. An inverse that does not read the index survives them. */
export const INDEX_KINDS = Object.freeze(['worktree:stage', 'worktree:unstage', 'worktree:stage-all', 'worktree:unstage-all', 'worktree:apply', 'worktree:apply-untracked']);

const REFS_KINDS = ['worktree:commit', 'ops:reword', 'refs:checkout', 'refs:create-branch', 'refs:create-tag', 'reflog:move-branch'];
const FILE_KINDS = ['worktree:discard', 'worktree:restore-discard', 'worktree:ignore'];

/**
 * What an entry's inverse depends on, and so what must still hold before it
 * runs. `refs`: it only moves refs and HEAD, and Git refuses whatever would
 * overwrite a file (a soft reset, a checkout, a compare-and-swap on a ref).
 * `files`: it rewrites the paths it recorded and nothing else. `all`: it
 * replaces the working tree (reset --hard, a stash), so any later change counts.
 */
export function undoScope(kind) {
  return REFS_KINDS.includes(kind) ? 'refs' : FILE_KINDS.includes(kind) ? 'files' : 'all';
}

/** The paths a `files` entry rewrites. */
export function entryFiles({ kind, args }) {
  return kind === 'worktree:ignore' ? ['.gitignore'] : args.paths;
}

const short = oid => (oid ? oid.slice(0, 7) : '');
const place = state => state.branch || short(state.head);
const LABELS = {
  'worktree:commit': ({ after }) => [ui`Undo commit ${short(after.head)}`, ui`Redo commit ${short(after.head)}`],
  'ops:reword': ({ after }) => [ui`Undo the new message of ${short(after.head)}`, ui`Redo the new message of ${short(after.head)}`],
  'ops:reset': ({ before, after }) => [ui`Undo the reset: back to ${short(before.head)}`, ui`Redo the reset to ${short(after.head)}`],
  'ops:merge': () => [ui`Undo the merge`, ui`Redo the merge`],
  'ops:revert': () => [ui`Undo the revert`, ui`Redo the revert`],
  'ops:revert-many': () => [ui`Undo the revert`, ui`Redo the revert`],
  'ops:cherry-pick': () => [ui`Undo the cherry-pick`, ui`Redo the cherry-pick`],
  'ops:cherry-pick-many': () => [ui`Undo the cherry-pick`, ui`Redo the cherry-pick`],
  'patch:am': () => [ui`Undo the applied patches`, ui`Redo the applied patches`],
  'refs:checkout': ({ before, after }) => [ui`Undo the checkout: back to ${place(before)}`, ui`Redo the checkout of ${place(after)}`],
  'refs:create-branch': ({ args }) => [ui`Undo creating branch ${args[0]}`, ui`Redo creating branch ${args[0]}`],
  'refs:create-tag': ({ args }) => [ui`Undo creating tag ${args[0]}`, ui`Redo creating tag ${args[0]}`],
  'reflog:move-branch': ({ args }) => [ui`Undo moving ${args[0]}`, ui`Redo moving ${args[0]}`],
  'stash:push': () => [ui`Undo the stash`, ui`Redo the stash`],
  'stash:pop': () => [ui`Undo the stash pop`, ui`Redo the stash pop`],
  'stash:apply': () => [ui`Undo the stash apply`, ui`Redo the stash apply`],
  'worktree:ignore': () => [ui`Undo the .gitignore rule`, ui`Redo the .gitignore rule`],
  'worktree:discard': ({ args }) => [uiN(args.paths.length, 'Undo the discard of {n} file', 'Undo the discard of {n} files'),
    uiN(args.paths.length, 'Redo the discard of {n} file', 'Redo the discard of {n} files')],
  'worktree:restore-discard': ({ args }) => [uiN(args.paths.length, 'Undo restoring {n} file', 'Undo restoring {n} files'),
    uiN(args.paths.length, 'Redo restoring {n} file', 'Redo restoring {n} files')]
};

/** What the Undo or Redo button will do, as a whole phrase. */
export function undoLabel(entry, direction) {
  const words = LABELS[entry.kind]?.(entry) ?? [ui`Undo the last action`, ui`Redo the last action`];
  return words[direction === 'undo' ? 0 : 1];
}

const ENDS_CHAIN = {
  'ops:sequencer': ui`Continuing or aborting an operation ends the Undo chain.`,
  'refs:delete-branch': ui`Deleting a branch ends the Undo chain.`,
  'refs:rename-branch': ui`Renaming a branch ends the Undo chain.`,
  'refs:upstream': ui`Changing an upstream ends the Undo chain.`,
  'refs:delete-tag': ui`Deleting a tag ends the Undo chain.`,
  'bisect:run': ui`BugHunter moved HEAD, which ends the Undo chain.`,
  'sync:drop': ui`A drag and drop action ends the Undo chain.`
};

export function inverseReason(kind, before, after, args) {
  if (before.operation !== 'none' || after.operation !== 'none') return ui`An interrupted Git operation must be completed or aborted first.`;
  if (kind === 'sync:push-ref') return ui`A ref was published or deleted remotely. Undo cannot reverse publication.`;
  if (kind === 'sync:run') return args[0]?.startsWith('fetch') ? ui`Fetch brought new tags and ended the Undo chain.`
    : args[0]?.startsWith('pull') ? ui`Pull may have integrated commits. Use an explicit Git operation to reverse it.`
      : ui`Push may have published commits. Use an explicit Git operation to reverse it.`;
  if (kind === 'ops:rebase') return ui`Rebase rewrites history and ends the Undo chain.`;
  if (kind === 'ops:reset') {
    if (args[0] === 'hard') return ui`A hard reset replaced the files, which Undo cannot bring back. The commits it left are still in Reflog.`;
    if (!before.head || !after.head) return ui`There is no previous revision to restore.`;
    if (args[0] === 'mixed' && before.staged) return ui`This reset unstaged changes, which Undo cannot put back in the index. The commits are still in Reflog.`;
  }
  if (kind === 'submodules:update') return ui`Updating submodules moves their checkouts. Undo does not move them back.`;
  if (kind.startsWith('worktrees:')) return ui`Adding or removing a worktree ends the Undo chain.`;
  if (kind === 'patch:apply') return ui`A patch applied to the files ends the Undo chain. Its changes can be discarded like any other.`;
  if (['ops:merge', 'ops:revert', 'ops:cherry-pick', 'ops:cherry-pick-many', 'ops:revert-many', 'patch:am'].includes(kind) && (!before.clean || !after.clean)) return ui`This operation included working-tree changes; a hard reset would lose them.`;
  if (['stash:pop', 'stash:apply'].includes(kind) && (!before.clean || !after.paths.length)) return ui`Stash restoration cannot be separated safely from the existing working tree.`;
  if (kind === 'stash:pop' && args[0] > 0) return ui`Undo cannot safely restore the position of a popped stash below the top entry.`;
  if (kind === 'refs:checkout' && !before.head) return ui`Checkout from an unborn branch has no revision to restore.`;
  if (kind === 'refs:create-branch' && !before.head) return ui`There is no previous revision to restore.`;
  if (INDEX_KINDS.includes(kind)) return ui`Undo does not reverse staging. Unstage the file instead.`;
  if (kind.startsWith('conflict:')) return ui`Resolving a conflict ends the Undo chain.`;
  if (kind.startsWith('remotes:')) return ui`Changing a remote ends the Undo chain.`;
  if (kind.startsWith('maintenance:')) return ui`Maintenance changed the repository, which ends the Undo chain.`;
  if (!UNDOABLE_KINDS.includes(kind)) return ENDS_CHAIN[kind] ?? ui`This action ends the Undo chain.`;
  return null;
}
