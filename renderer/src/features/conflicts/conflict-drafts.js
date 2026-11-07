// Edits made in the conflict editor and not saved yet, per repository and file.
//
// The editor shows one file at a time and is closed by Back, by a click on
// another file in the banner and by every move in the sidebar; none of those
// may cost a person's work. A draft is kept here, outside any component, so it
// outlives the editor, the tab and a language switch that redraws the window.
// No imports: Vite and the Node check both load this module directly.

const drafts = new Map();
const key = (repositoryId, file) => `${repositoryId}\0${file}`;

export const readConflictDraft = (repositoryId, file) => drafts.get(key(repositoryId, file)) || null;

export function writeConflictDraft(repositoryId, file, draft) {
  drafts.set(key(repositoryId, file), draft);
}

export function dropConflictDraft(repositoryId, file) {
  drafts.delete(key(repositoryId, file));
}

export function unsavedConflicts(repositoryId) {
  const prefix = `${repositoryId}\0`;
  return new Set([...drafts.keys()].filter(item => item.startsWith(prefix)).map(item => item.slice(prefix.length)));
}

/** Drafts of files Git no longer lists as conflicted have nothing left to resolve. */
export function pruneConflictDrafts(repositoryId, conflicted) {
  const keep = new Set(conflicted);
  for (const file of unsavedConflicts(repositoryId)) if (!keep.has(file)) dropConflictDraft(repositoryId, file);
}
