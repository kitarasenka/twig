/**
 * "3 hours ago" from unix seconds — for moves in the reflog and the last
 * background fetch. No imports: Vite and the Node checks load it.
 */
const UNITS = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day'], [4.35, 'week'], [12, 'month'], [Infinity, 'year']];

/** @param {?number} seconds unix time @param {number} now milliseconds */
export function relativeTime(seconds, now = Date.now()) {
  if (!Number.isFinite(seconds)) return 'at an unknown time';
  let value = Math.max(0, now / 1000 - seconds);
  if (value < 45) return 'just now';
  for (const [size, unit] of UNITS) {
    if (value < size) { const count = Math.round(value); return `${count} ${unit}${count === 1 ? '' : 's'} ago`; }
    value /= size;
  }
  return 'long ago';
}

/**
 * The calendar day an ISO date falls on by this machine's clock — the day a
 * person reads in the list. Git writes each date in its committer's own time
 * zone, so comparing the text before the `T` drew day breaks between two
 * commits made minutes apart from different zones.
 */
export function localDayKey(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value).slice(0, 10) : `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
