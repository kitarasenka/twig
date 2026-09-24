import { moveBranchCommand } from '../../../../main/git/reflog-plan.js';

export { relativeTime } from '../../ui/relative-time.js';

/**
 * Words for the reflog screen: what each move was, when, what a recovered
 * branch could be called and what "move the branch here" will run. Pure data;
 * Vite and the Node check both load it.
 */

const ACTIONS = [
  [/^commit \(initial\)/, 'First commit'], [/^commit \(amend\)/, 'Amend'], [/^commit \(merge\)/, 'Merge commit'],
  [/^commit/, 'Commit'], [/^checkout/, 'Checkout'], [/^switch/, 'Checkout'], [/^reset/, 'Reset'],
  [/^rebase/, 'Rebase'], [/^pull/, 'Pull'], [/^merge/, 'Merge'], [/^cherry-pick/, 'Cherry-pick'],
  [/^revert/, 'Revert'], [/^branch/, 'Branch created'], [/^clone/, 'Clone'], [/^fetch/, 'Fetch'],
  [/^push|^update by push/, 'Push'], [/^🌱 Twig/, '🌱 Twig']
];

/** "commit (amend)" → "Amend"; an action Git added later keeps its own words. */
export function actionLabel(action) {
  const text = typeof action === 'string' ? action.trim() : '';
  for (const [pattern, label] of ACTIONS) if (pattern.test(text)) return label;
  return text || 'Move';
}

/** "moving to 420ea50bb14ff5e4…" → "moving to 420ea50": full ids are for Git, not for reading. */
export function shortenIds(text) {
  return typeof text === 'string' ? text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}(?:[0-9a-f]{24})?\b/gi, '$1') : '';
}

const HEX = /^[0-9a-f]{7,64}$/i;
const MOVE = /^moving from (\S+) to (\S+)$/;

/**
 * The branch HEAD was on when this entry was written, read from the nearest
 * checkout around it: a newer "moving from X to …" says it was on X, an older
 * "moving from … to Y" says it arrived on Y. A detached HEAD names no branch.
 * @param {{ action: string, detail: string }[]} entries newest first
 */
export function branchAt(entries, position) {
  for (let at = position - 1; at >= 0; at--) {
    const move = /^checkout|^switch/.test(entries[at].action) && MOVE.exec(entries[at].detail);
    if (move) return HEX.test(move[1]) ? null : move[1];
  }
  for (let at = position; at < entries.length; at++) {
    const move = /^checkout|^switch/.test(entries[at].action) && MOVE.exec(entries[at].detail);
    if (move) return HEX.test(move[2]) ? null : move[2];
  }
  return null;
}

/**
 * A name for a branch made from a reflog entry: the branch the commit was
 * made on when that name is free again (the usual story of a deleted
 * branch), otherwise `recovered-<sha>`.
 * @param {string[]} taken local branch names
 */
export function suggestBranchName(entries, position, taken) {
  const names = new Set(taken);
  const was = branchAt(entries, position);
  if (was && !names.has(was)) return was;
  const base = `${was ? `${was}-` : ''}recovered-${entries[position].oid.slice(0, 7)}`;
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base}-${n}`;
  return name;
}

/**
 * The §6.5 confirmation for moving a branch to a reflog entry.
 * @param {{ branch: string, oid: string, expected: string, current: boolean }} move
 */
export function moveBranchDialog({ branch, oid, expected, current }) {
  const short = oid.slice(0, 7);
  const where = `${branch} moves to ${short}; it points at ${expected.slice(0, 7)} now.`;
  const files = current
    ? ' It is checked out, so your files follow it. Uncommitted changes stay; if one is in a file that differs there, Git refuses and nothing moves.'
    : ' It is not checked out, so your files are not touched.';
  const strand = ` Commits only ${branch} holds now stay in its reflog, on this screen.`;
  return {
    title: `Move ${branch} to ${short}`, command: moveBranchCommand({ branch, oid, expected, current }),
    consequence: `${where}${files}${strand} Undo in the toolbar moves it back.`,
    confirmLabel: `Move ${branch}`
  };
}

/**
 * Why "Move <branch> here" cannot run for this entry, or undefined.
 * @param {{ branch: ?string, tip: ?string, oid: string, operation: string, busy: boolean }} state
 */
export function moveReason({ branch, tip, oid, operation, busy }) {
  if (busy) return 'Git is working';
  if (!branch) return 'HEAD is detached: there is no branch to move. Create a branch here instead.';
  if (!tip) return `${branch} does not exist any more. Create a branch here instead.`;
  if (operation !== 'none') return `Finish or abort the ${operation} first`;
  if (tip === oid) return `${branch} already points here`;
  return undefined;
}
