// The commit being written, kept per repository until it is committed: leaving
// the staging screen, a language switch or a restart must not cost the message.
// No imports: Vite and the Node check both load this module directly.

const KEY_PREFIX = 'twig:commit-draft:';
const EMPTY = { message: '', coAuthors: [], bump: null, amendOid: null, amendMessage: null };

const key = repositoryId => `${KEY_PREFIX}${repositoryId}`;

export function readCommitDraft(storage, repositoryId) {
  try {
    const value = JSON.parse(storage?.getItem(key(repositoryId)) ?? 'null');
    if (!value || typeof value.message !== 'string') return EMPTY;
    return {
      message: value.message,
      coAuthors: Array.isArray(value.coAuthors) ? value.coAuthors.filter(person => typeof person?.name === 'string' && typeof person?.email === 'string') : [],
      bump: typeof value.bump === 'string' ? value.bump : null,
      amendOid: typeof value.amendOid === 'string' ? value.amendOid : null,
      amendMessage: typeof value.amendMessage === 'string' ? value.amendMessage : null
    };
  } catch { return EMPTY; }
}

/** An empty draft removes the entry, which is also what a finished commit leaves. */
export function writeCommitDraft(storage, repositoryId, draft) {
  try {
    if (!draft.message.trim() && !draft.coAuthors.length && !draft.amendOid) storage?.removeItem(key(repositoryId));
    else storage?.setItem(key(repositoryId), JSON.stringify(draft));
  } catch { /* The draft stays in the screen's own state if storage is unavailable. */ }
}

/** A repository located elsewhere keeps the message under its new id. */
export function moveCommitDraft(storage, from, to) {
  if (from === to) return;
  try {
    const value = storage?.getItem(key(from));
    if (value === null || value === undefined) return;
    storage.setItem(key(to), value);
    storage.removeItem(key(from));
  } catch { /* Nothing moves if storage is unavailable. */ }
}
