import { mark, t, tn } from '../../i18n/i18n.js';

/**
 * The words and commands of the confirmations for actions that cannot be
 * undone, or only partly: Abort and Skip on the operation banner, a plain
 * rebase and a soft or mixed reset from a menu, putting a conflict back.
 * Each returns the props of a ConfirmDialog without its onConfirm. It is
 * loaded the first time one of them is asked for, not with the window.
 */

// What Abort throws away, per operation, as whole sentences.
const ABORT_WORDS = {
  merge: mark('The merge stops, and the branch and the files go back to how they were before it started.'),
  rebase: mark('The rebase stops, and the branch goes back to where it was before it started. The commits already replayed are left out.'),
  'cherry-pick': mark('The cherry-pick stops, and the branch goes back to where it was before it started.'),
  revert: mark('The revert stops, and the branch goes back to where it was before it started.'),
  am: mark('Applying the patches stops, and the branch goes back to where it was before it started.')
};
const ABORT_TITLES = { merge: mark('Abort the merge'), rebase: mark('Abort the rebase'), 'cherry-pick': mark('Abort the cherry-pick'),
  revert: mark('Abort the revert'), am: mark('Abort applying the patches') };

/**
 * Abort or Skip: the command, what is lost (the files already resolved, the
 * unsaved conflict drafts) and how far the operation got.
 * @param {{ kind: string, step: ?number, total: ?number, conflicts: string[], resolvedFiles?: string[] }} operation
 * @param {'abort'|'skip'} step
 * @param {Set<string>} unsaved files with a conflict-editor draft
 */
export function stepConfirm(operation, step, unsaved) {
  const { kind } = operation;
  const resolved = operation.resolvedFiles?.length || 0;
  const drafts = [...unsaved].filter(file => operation.conflicts.includes(file)).length;
  const skipLabel = kind === 'am' ? t('Skip this patch') : t('Skip this commit');
  const lost = [
    step === 'abort' ? t(ABORT_WORDS[kind] || ABORT_WORDS.merge)
      : kind === 'am' ? t('The patch being applied now is left out, together with what you resolved in it.')
        : t('The commit being applied now is left out, together with what you resolved in it.'),
    operation.step && operation.total ? t`It stopped at step ${operation.step} of ${operation.total}.` : null,
    resolved ? tn(resolved, 'You already resolved {n} file here, and that resolution is lost.', 'You already resolved {n} files here, and those resolutions are lost.') : null,
    drafts ? tn(drafts, '{n} file has unsaved edits in the conflict editor, and they are lost.', '{n} files have unsaved edits in the conflict editor, and they are lost.') : null,
    t('Undo cannot reverse this.')
  ];
  return {
    type: 'confirm', command: [kind, `--${step}`], consequence: lost.filter(Boolean).join(' '),
    title: step === 'abort' ? t(ABORT_TITLES[kind] || ABORT_TITLES.merge) : skipLabel,
    confirmLabel: step === 'abort' ? t('Abort') : skipLabel
  };
}

/** A plain rebase from a menu: every replayed commit is rewritten, and Undo cannot take it back. */
export function rebaseConfirm(target, onto, oid) {
  return {
    type: 'confirm', title: t`Rebase ${target} onto ${onto}`, command: ['rebase', oid], danger: false,
    consequence: t`The commits of ${target} that ${onto} does not have are replayed on top of it and get new object ids. Undo cannot reverse a rebase; the old commits stay in Reflog for a while. If any of them is already pushed, the remote will only accept them after a force push.`,
    confirmLabel: t('Rebase')
  };
}

/**
 * A soft or mixed reset keeps every file, and Undo moves the branch back —
 * except a mixed one over something staged, which Undo cannot re-stage.
 */
export function resetConfirm(target, short, mode, oid, staged) {
  return {
    type: 'confirm', title: t`Reset ${target} to ${short}`, command: ['reset', `--${mode}`, oid], danger: false,
    consequence: [mode === 'soft'
      ? t`${target} moves to ${short}. The changes of the commits it leaves behind stay staged, and no file in the working tree changes.`
      : t`${target} moves to ${short}. The changes of the commits it leaves behind, and everything staged now, become unstaged changes; no file in the working tree changes.`,
    mode === 'mixed' && staged ? t('What is staged now is unstaged too, so Undo cannot reverse this reset. The commits stay in Reflog for a while.')
      : t('Undo moves the branch back.')].join(' '),
    confirmLabel: mode === 'soft' ? t('Reset (soft)') : t('Reset (mixed)')
  };
}

/** Takes a resolution back: the file gets its markers and is conflicted again. */
export function restoreConflictConfirm(file) {
  return {
    type: 'confirm', title: t`Put the conflict back in ${file}`, command: ['checkout', '--merge', '--', `:(literal)${file}`],
    consequence: t('The file gets its conflict markers back and is listed as conflicted again. What is in it now is replaced.'),
    confirmLabel: t('Put the conflict back')
  };
}
