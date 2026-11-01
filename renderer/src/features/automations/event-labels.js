/**
 * The client-side Git hook events Twig can automate, with the plain-language
 * name shown in the UI and the raw hook name kept as a secondary label for
 * anyone who wants it (§ "UX terminology" of the brief).
 *
 * Only the i18n import: this module is loaded by Vite for the renderer and by
 * Node in `scripts/checks/automation.mjs`. Adding a hook later is one array entry —
 * nothing else in the UI or the engine hard-codes the list.
 *
 * `phase: 'pre'` events run before the Git operation and may block it;
 * `phase: 'post'` events run after it and are advisory only.
 */
import { mark, t } from '../../i18n/i18n.js';

export const HOOK_EVENTS = [
  { hook: 'pre-commit', label: mark('Before Commit'), phase: 'pre', hint: mark('Runs on the staged changes before the commit is created.') },
  { hook: 'prepare-commit-msg', label: mark('Prepare Commit Message'), phase: 'pre', hint: mark('Runs before the message editor, e.g. to seed a template.') },
  { hook: 'commit-msg', label: mark('Validate Commit Message'), phase: 'pre', hint: mark('Checks the commit message; a failure blocks the commit.') },
  { hook: 'post-commit', label: mark('After Commit'), phase: 'post', hint: mark('Runs once the commit exists. Cannot block anything.') },
  { hook: 'pre-rebase', label: mark('Before Rebase'), phase: 'pre', hint: mark('Runs before a rebase starts replaying commits.') },
  { hook: 'post-rewrite', label: mark('After History Rewrite'), phase: 'post', hint: mark('Runs after a rebase or amend rewrote commits.') },
  { hook: 'pre-merge-commit', label: mark('Before Merge Commit'), phase: 'pre', hint: mark('Runs before a merge commit is written.') },
  { hook: 'post-merge', label: mark('After Merge'), phase: 'post', hint: mark('Runs after a merge or pull updated the working tree.') },
  { hook: 'pre-push', label: mark('Before Push'), phase: 'pre', hint: mark('Runs before commits are sent to a remote; a failure blocks the push.') },
  { hook: 'post-checkout', label: mark('After Branch Switch'), phase: 'post', hint: mark('Runs after checkout moved HEAD.') }
];

const BY_HOOK = new Map(HOOK_EVENTS.map(event => [event.hook, event]));

/** The event's name in the interface language; an unknown hook name as is. */
export function eventLabel(hook) {
  const label = BY_HOOK.get(hook)?.label;
  return label ? t(label) : hook;
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
