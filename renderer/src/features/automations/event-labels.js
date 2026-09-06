/**
 * The client-side Git hook events Twig can automate, with the plain-language
 * name shown in the UI and the raw hook name kept as a secondary label for
 * anyone who wants it (§ "UX terminology" of the brief).
 *
 * No imports: this module is loaded by Vite for the renderer and by Node in
 * `scripts/checks/automation.mjs`. Adding a hook later is one array entry —
 * nothing else in the UI or the engine hard-codes the list.
 *
 * `phase: 'pre'` events run before the Git operation and may block it;
 * `phase: 'post'` events run after it and are advisory only.
 */
export const HOOK_EVENTS = [
  { hook: 'pre-commit', label: 'Before Commit', phase: 'pre', hint: 'Runs on the staged changes before the commit is created.' },
  { hook: 'prepare-commit-msg', label: 'Prepare Commit Message', phase: 'pre', hint: 'Runs before the message editor, e.g. to seed a template.' },
  { hook: 'commit-msg', label: 'Validate Commit Message', phase: 'pre', hint: 'Checks the commit message; a failure blocks the commit.' },
  { hook: 'post-commit', label: 'After Commit', phase: 'post', hint: 'Runs once the commit exists. Cannot block anything.' },
  { hook: 'pre-rebase', label: 'Before Rebase', phase: 'pre', hint: 'Runs before a rebase starts replaying commits.' },
  { hook: 'post-rewrite', label: 'After History Rewrite', phase: 'post', hint: 'Runs after a rebase or amend rewrote commits.' },
  { hook: 'pre-merge-commit', label: 'Before Merge Commit', phase: 'pre', hint: 'Runs before a merge commit is written.' },
  { hook: 'post-merge', label: 'After Merge', phase: 'post', hint: 'Runs after a merge or pull updated the working tree.' },
  { hook: 'pre-push', label: 'Before Push', phase: 'pre', hint: 'Runs before commits are sent to a remote; a failure blocks the push.' },
  { hook: 'post-checkout', label: 'After Branch Switch', phase: 'post', hint: 'Runs after checkout moved HEAD.' }
];

const BY_HOOK = new Map(HOOK_EVENTS.map(event => [event.hook, event]));

export function eventLabel(hook) {
  return BY_HOOK.get(hook)?.label || hook;
}

export function eventPhase(hook) {
  return BY_HOOK.get(hook)?.phase || 'pre';
}

export function isKnownEvent(hook) {
  return BY_HOOK.has(hook);
}

/** A pre-* pipeline can block its Git operation; a post-* one never can. */
export function canBlock(hook) {
  return eventPhase(hook) === 'pre';
}
