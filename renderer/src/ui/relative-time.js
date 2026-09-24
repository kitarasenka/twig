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
