import { moveBranchCommand } from '../../../../main/git/reflog-plan.js';
import { mark, t } from '../../i18n/i18n.js';

export { relativeTime } from '../../ui/relative-time.js';

/**
 * Words for the reflog screen: what each move was, when, what a recovered
 * branch could be called and what "move the branch here" will run. Pure data;
 * Vite and the Node check both load it.
 */

// Display labels of Git's operations; the screen's language may keep the Git verbs.
const ACTIONS = [
  [/^commit \(initial\)/, mark('First commit')], [/^commit \(amend\)/, mark('Amend')], [/^commit \(merge\)/, mark('Merge commit')],
  [/^commit/, mark('Commit')], [/^checkout/, mark('Checkout')], [/^switch/, mark('Checkout')], [/^reset/, mark('Reset')],
  [/^rebase/, mark('Rebase')], [/^pull/, mark('Pull')], [/^merge/, mark('Merge')], [/^cherry-pick/, mark('Cherry-pick')],
  [/^revert/, mark('Revert')], [/^branch/, mark('Branch created')], [/^clone/, mark('Clone')], [/^fetch/, mark('Fetch')],
  [/^push|^update by push/, mark('Push')], [/^🌱 Twig/, '🌱 Twig']
];

/** "commit (amend)" → "Amend"; an action Git added later keeps its own words. */
export function actionLabel(action) {
  const text = typeof action === 'string' ? action.trim() : '';
  for (const [pattern, label] of ACTIONS) if (pattern.test(text)) return t(label);
  return text || t('Move');
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
  const now = expected.slice(0, 7);
  // Whole sentences: each language orders them its own way.
  const consequence = current
    ? t`${branch} moves to ${short}; it points at ${now} now. It is checked out, so your files follow it. Uncommitted changes stay; if one is in a file that differs there, Git refuses and nothing moves. Commits only ${branch} holds now stay in its reflog, on this screen. Undo in the toolbar moves it back.`
    : t`${branch} moves to ${short}; it points at ${now} now. It is not checked out, so your files are not touched. Commits only ${branch} holds now stay in its reflog, on this screen. Undo in the toolbar moves it back.`;
  return {
    title: t`Move ${branch} to ${short}`, command: moveBranchCommand({ branch, oid, expected, current }),
    consequence,
    confirmLabel: t`Move ${branch}`
  };
}

/**
 * Why "Move <branch> here" cannot run for this entry, or undefined.
 * @param {{ branch: ?string, tip: ?string, oid: string, operation: string, busy: boolean }} state
 */
export function moveReason({ branch, tip, oid, operation, busy }) {
  if (busy) return t('Git is working');
  if (!branch) return t('HEAD is detached: there is no branch to move. Create a branch here instead.');
  if (!tip) return t`${branch} does not exist any more. Create a branch here instead.`;
  if (operation !== 'none') return t`Finish or abort the ${operation} first`;
  if (tip === oid) return t`${branch} already points here`;
  return undefined;
}
