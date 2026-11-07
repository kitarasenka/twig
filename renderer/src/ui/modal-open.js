/**
 * Whether a modal surface holds the window. App's shortcuts are read on `window`
 * and most dialogs live below it: an Undo pressed behind a `reset --hard` dialog
 * moved the repository under the command the dialog was still showing.
 */
export function modalOpen(root = document) {
  return Boolean(root.querySelector('dialog[open], .execution-overlay'));
}
