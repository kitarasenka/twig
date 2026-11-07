/**
 * Notes after an action in the toolbar (push, stash, Undo) belong to the
 * repository they ran on: a failed push used to stay on every tab, without a
 * word about which repository it was. The key '' holds what concerns the whole
 * window, such as the demo workspace closing. No imports: Node checks this file.
 */
export function placeNote(notes, key, note) {
  if (note) return { ...notes, [key]: note };
  if (!Object.hasOwn(notes, key)) return notes;
  const rest = { ...notes };
  delete rest[key];
  return rest;
}

/** What the tab `id` shows: its own note first, then the window's. */
export function noteFor(notes, id) {
  if (id && Object.hasOwn(notes, id)) return { key: id, note: notes[id] };
  return { key: '', note: Object.hasOwn(notes, '') ? notes[''] : '' };
}
