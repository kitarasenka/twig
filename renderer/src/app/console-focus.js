// Which console entry the "Show output" button should jump to.
// No imports on purpose: Vite and the Node check both load this file.

// A failure older than this is not the one the visible banner is about: the
// banner is dismissed by the next action, the journal keeps 2000 entries.
export const FOCUS_WINDOW_MS = 60000;

export function entryFinishedAt(entry) {
  const started = Date.parse(entry?.startedAt);
  if (Number.isNaN(started)) return null;
  return started + (typeof entry.ms === 'number' && entry.ms >= 0 ? entry.ms : 0);
}

// Newest command that actually failed, skipping the ones that ran fine after it
// (a reload runs several). `null` when the only failures are old or none exist:
// jumping to an unrelated entry would be a guess, and the console must not lie.
export function pickFailedEntry(entries, now = Date.now()) {
  if (!Array.isArray(entries)) return null;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry || entry.code === null || entry.code === undefined || entry.code === 0) continue;
    const finished = entryFinishedAt(entry);
    if (finished === null || now - finished > FOCUS_WINDOW_MS) return null;
    return entry;
  }
  return null;
}
