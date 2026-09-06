/**
 * Commit age to a colour stop: brown roots, green new work.
 *
 * The scale is absolute — age measured against the clock — and not relative to
 * the commits currently loaded. A relative scale would repaint every row the
 * moment an older page arrives, and "old" would mean something different in
 * every repository. No imports on purpose: Vite loads this module and so does
 * the Node check, the same arrangement as `ui/panel-width.js`.
 */
export const AGE_STOPS = [
  { key: 'fresh', label: 'Today', maxDays: 1 },
  { key: 'young', label: 'This week', maxDays: 7 },
  { key: 'mature', label: 'This month', maxDays: 30 },
  { key: 'old', label: 'This year', maxDays: 365 },
  { key: 'root', label: 'Older', maxDays: Infinity }
];

const DAY = 86400000;

/** Index into AGE_STOPS, or null when the date is unusable: an unknown age claims no colour. */
export function ageStop(committedAt, now = Date.now()) {
  const time = committedAt instanceof Date ? committedAt.getTime()
    : typeof committedAt === 'string' ? Date.parse(committedAt) : NaN;
  if (!Number.isFinite(time) || !Number.isFinite(now)) return null;
  const days = (now - time) / DAY;
  // A commit dated in the future is a clock, not a fact: it stays the freshest.
  if (!(days > 0)) return 0;
  return AGE_STOPS.findIndex(stop => days < stop.maxDays);
}

/** SVG lanes are strokes and dates are text, so the ramp needs two class families. */
export function ageStrokeClass(stop) { return stop === null ? '' : `graph-age-${stop}`; }
export function ageTextClass(stop) { return stop === null ? '' : `age-text-${stop}`; }
