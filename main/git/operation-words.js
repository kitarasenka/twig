import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * Whole sentences per operation, in main and in the window: a kind (`am`,
 * `cherry-pick`) is a state file's name, not a word to put in a sentence, and
 * each language builds these its own way.
 */
const FINISH_FIRST = {
  merge: ui`Finish or abort the merge first.`, 'cherry-pick': ui`Finish or abort the cherry-pick first.`, revert: ui`Finish or abort the revert first.`,
  rebase: ui`Finish or abort the rebase first.`, am: ui`Finish or abort applying the patches first.`
};
const STEPS = {
  merge: { continue: ui`Merge finished.`, abort: ui`Merge aborted.` },
  'cherry-pick': { continue: ui`Cherry-pick finished.`, skip: ui`Cherry-pick skipped a commit.`, abort: ui`Cherry-pick aborted.` },
  revert: { continue: ui`Revert finished.`, skip: ui`Revert skipped a commit.`, abort: ui`Revert aborted.` },
  rebase: { continue: ui`Rebase finished.`, skip: ui`Rebase skipped a commit.`, abort: ui`Rebase aborted.` },
  am: { continue: ui`Patches applied.`, skip: ui`Skipped a patch.`, abort: ui`Applying the patches aborted.` }
};

export const finishFirst = kind => FINISH_FIRST[kind] ?? ui`Finish or abort the current operation first.`;

/** What a Continue, Skip or Abort on the operation banner did. */
export const stepNote = (kind, step) => STEPS[kind]?.[step] ?? ui`The operation moved on.`;
