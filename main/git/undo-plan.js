import { validateOid, validateFile } from './commit.js';
import { validateRefName } from './refs-ops.js';

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
    if (!Array.isArray(state.paths)) throw new TypeError('Invalid saved operation paths');
    state.paths.forEach(validateFile);
  }
  if (kind === 'refs:create-branch') { branchName(args[0]); validateOid(args[1]); if (typeof args[2] !== 'boolean') throw new TypeError('Invalid saved branch action'); }
  if (kind === 'stash:push' && (typeof args[0] !== 'boolean' || typeof args[1] !== 'string' || args[1].includes('\0'))) throw new TypeError('Invalid saved stash action');
  if (['stash:pop', 'stash:apply'].includes(kind)) {
    validateOid(before.stashOid);
    if (typeof before.stashMessage !== 'string' || before.stashMessage.includes('\0') || (args[0] !== undefined && (!Number.isInteger(args[0]) || args[0] < 0))) throw new TypeError('Invalid saved stash action');
  }
  const undo = direction === 'undo';
  let commands; let destructive = false;
  if (kind === 'worktree:commit') {
    commands = undo && !before.head ? [['update-ref', '-d', 'HEAD', after.head]]
      : [reset('--soft', undo ? before.head : after.head)];
  } else if (['ops:merge', 'ops:revert', 'ops:cherry-pick'].includes(kind)) {
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
      ['stash', 'push', '--include-untracked', '--message', 'Twig undo stash', '--', ...after.paths.map(file => `:(literal)${file}`)],
      ['stash', 'drop', 'stash@{0}'],
      ...(kind === 'stash:pop' ? [['stash', 'store', '--message', before.stashMessage, before.stashOid]] : [])
    ] : [['stash', kind === 'stash:pop' ? 'pop' : 'apply', `stash@{${args[0] || 0}}`]];
  } else throw new Error('This operation has no safe inverse.');
  return { commands, destructive, explanation: destructive
    ? 'This restores the recorded repository state. reset --hard replaces tracked files; stash drop removes only the temporary stash created by this inverse. Later changes must not be present.'
    : 'Only the recorded application action will be reversed.' };
}

export function inverseReason(kind, before, after, args) {
  if (before.operation !== 'none' || after.operation !== 'none') return 'An interrupted Git operation must be completed or aborted first.';
  if (kind === 'sync:push-ref') return 'A ref was published or deleted remotely. Undo cannot reverse publication.';
  if (kind === 'sync:run') return args[0]?.startsWith('fetch') ? 'Fetch refreshed remote references and ended the Undo chain.'
    : `${args[0]} may have published or integrated commits. Use an explicit Git operation to reverse it.`;
  if (kind === 'ops:rebase') return 'Rebase rewrites history and ends the Undo chain.';
  if (['ops:merge', 'ops:revert', 'ops:cherry-pick'].includes(kind) && (!before.clean || !after.clean)) return 'This operation included working-tree changes; a hard reset would lose them.';
  if (['stash:pop', 'stash:apply'].includes(kind) && (!before.clean || !after.paths.length)) return 'Stash restoration cannot be separated safely from the existing working tree.';
  if (kind === 'stash:pop' && args[0] > 0) return 'Undo cannot safely restore the position of a popped stash below the top entry.';
  if (kind === 'refs:checkout' && !before.head) return 'Checkout from an unborn branch has no revision to restore.';
  if (kind === 'refs:create-branch' && !before.head) return 'There is no previous revision to restore.';
  if (!['worktree:commit', 'ops:merge', 'ops:revert', 'ops:cherry-pick', 'refs:checkout', 'refs:create-branch', 'stash:push', 'stash:pop', 'stash:apply'].includes(kind)) return `${kind.replaceAll(':', ' ')} ends the Undo chain.`;
  return null;
}
