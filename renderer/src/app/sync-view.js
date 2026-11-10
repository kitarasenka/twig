// What the window says after a pull or a push that did not go through, and the
// way out it offers. Git's own wording stays in the console: `refusal.kind`,
// read in main, picks the sentence here. Only the translator and the failure
// words are imported, so Vite and the Node check both load this module.

import { t, tr } from '../i18n/i18n.js';
import { syncFinished } from './sync-words.js';
import { failureNote } from './failure-note.js';

/** Shown in the Pull dialog; the check holds them against `buildSyncArgv`. */
export const PULL_COMMANDS = { 'pull-merge': ['pull', '--no-rebase'], 'pull-rebase': ['pull', '--rebase'] };

const PULL_ACTIONS = ['pull-rebase', 'pull-merge'];

function refusalWords(refusal, { branch, upstream }) {
  switch (refusal.kind) {
    case 'behind':
      return { text: upstream ? t`${upstream} has commits you do not have yet. Bring them in, then push again.`
        : t('The remote has commits you do not have yet. Bring them in, then push again.'), actions: PULL_ACTIONS };
    case 'rewritten':
      return { text: upstream ? t`${branch} was rewritten (amend, rebase or reset), so it no longer continues ${upstream}. Push with lease replaces what is there.`
        : t`${branch} was rewritten (amend, rebase or reset), so it no longer continues the remote branch. Push with lease replaces what is there.`,
      actions: ['push-force', ...PULL_ACTIONS] };
    case 'stale':
      return { text: t('The remote moved since the last fetch, so the lease refused the push and nothing was replaced. Bring in what changed first.'), actions: PULL_ACTIONS };
    case 'diverged':
      return { text: upstream ? t`${branch} and ${upstream} have both moved. Choose how to bring them together.`
        : t`${branch} and its upstream have both moved. Choose how to bring them together.`, actions: PULL_ACTIONS };
    case 'remote':
      return { text: t('The remote refused this push: a hook or a branch rule said no. Its reason is below.'), actions: [] };
    default:
      return null;
  }
}

/**
 * The note for a finished `runSync`. `actions` are the modes to offer, in order:
 * `push-force` only when this branch rewrote what the remote holds.
 * @param {{ ok: boolean, cancelled: boolean, message: ?string, reason?: string, refusal?: ?object }} result
 * @param {{ mode: string, branch: ?string, upstream: ?string, repositoryId?: ?string }} context
 * @returns {{ text: string, failed: boolean, detail?: string, actions?: (string|{ label: string, run: () => void })[] } | string}
 */
export function syncOutcome(result, { mode, branch, upstream, repositoryId = null }) {
  if (result.ok) return syncFinished(mode);
  if (result.cancelled) return { text: tr(result.message), failed: false };
  // The banner above the history carries it from here: this is a conflict, not a failure.
  if (result.refusal?.kind === 'stopped') return { text: t('The pull stopped on a conflict. The banner above the history shows what to resolve.'), failed: false };
  const words = result.refusal ? refusalWords(result.refusal, { branch, upstream }) : null;
  if (words) return { ...words, failed: true, detail: result.refusal.kind === 'remote' ? result.reason : undefined };
  // Anything else: what Git said, in words where the case is known (a key, a password, a lock, the network).
  return failureNote(result, tr(result.message), { repositoryId });
}

/** Pull only fast-forwards, so a branch that moved on both sides is asked about first. */
export const needsPullChoice = divergence => divergence.ahead > 0 && divergence.behind > 0;
