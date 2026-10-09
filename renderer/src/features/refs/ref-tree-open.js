/**
 * What is open in the sidebar's LOCAL / REMOTE / TAGS tree.
 *
 * Everything starts closed. The ref that is selected — the one clicked in the
 * sidebar or on a graph badge, or else every ref on the selected commit — has
 * its section and every folder above it opened, however deep it lies. A
 * section or folder the person opened or closed by hand stays that way until
 * a new selection needs it open. While the search filters refs, everything is
 * open: a match hidden in a closed folder would look like no match.
 *
 * No imports: Vite and the Node check both load this file.
 */

/** Key of a section: `section:local`, `section:remote`, `section:tag`. */
export const sectionKey = type => `section:${type}`;

/** Key of a folder: its type and path, `local:feat/ui`. */
export const folderKey = (type, path) => `${type}:${path}`;

/** The section key and every folder key above a ref, outermost first. */
export function ancestorKeys(ref) {
  const keys = [sectionKey(ref.type)];
  const parts = ref.name.split('/');
  for (let depth = 1; depth < parts.length; depth++) keys.push(folderKey(ref.type, parts.slice(0, depth).join('/')));
  return keys;
}

/**
 * Full names of the selected refs. A ref picked by name wins while the
 * selection is still its commit; otherwise every ref pointing at the selected
 * commit is selected. No commit selected — nothing.
 */
export function selectedRefNames(refs, selectedOid, picked) {
  if (!selectedOid) return [];
  if (picked && picked.target === selectedOid && refs.some(ref => ref.fullName === picked.fullName)) return [picked.fullName];
  return refs.filter(ref => ref.target === selectedOid).map(ref => ref.fullName);
}

/** Keys to open so that each selected ref is visible. */
export function revealedKeys(refs, names) {
  const wanted = new Set(names);
  const keys = new Set();
  for (const ref of refs) if (wanted.has(ref.fullName)) for (const key of ancestorKeys(ref)) keys.add(key);
  return keys;
}

/** Whether a section or folder is open: filter, then a hand toggle, then the selection. */
export function isOpen(key, { manual, revealed, filtering }) {
  if (filtering) return true;
  if (manual.has(key)) return manual.get(key);
  return revealed.has(key);
}

/**
 * Hand toggles after a new selection: a folder closed by hand that the
 * selection needs open is forgotten, so it opens for the ref inside it. One
 * opened by hand stays opened by hand — it must not close once the selection
 * moves on.
 */
export function forgetRevealed(manual, revealed) {
  let next = manual;
  for (const key of revealed) {
    if (next.get(key) !== false) continue;
    if (next === manual) next = new Map(manual);
    next.delete(key);
  }
  return next;
}
