export const ROW_HEIGHT = 30;
export const LANE_WIDTH = 18;

function colorKey(value) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.codePointAt(0)) | 0;
  return (hash >>> 0) % 4;
}

/** Incremental topology layout. Slots survive page boundaries; only trailing empty slots disappear. */
export function createLaneLayout(refs = []) {
  const colors = new Map();
  for (const ref of [...refs].sort((a, b) => a.fullName.localeCompare(b.fullName))) {
    if (!colors.has(ref.target)) colors.set(ref.target, colorKey(ref.fullName));
  }
  const slots = [];
  const pending = new Map();
  let width = 1;
  function reserve(oid, color) {
    let lane = slots.indexOf(null);
    if (lane < 0) lane = slots.length;
    slots[lane] = { oid, color };
    pending.set(oid, lane);
    return lane;
  }
  return {
    append(commits) {
      return commits.map(commit => {
        const incoming = slots.map(slot => slot && { ...slot });
        let lane = pending.get(commit.oid);
        if (lane === undefined) lane = reserve(commit.oid, colors.get(commit.oid) ?? colorKey(commit.oid));
        const color = slots[lane].color;
        const segments = [];
        incoming.forEach((slot, index) => {
          if (slot) segments.push({ from: index, to: index, half: slot.oid === commit.oid ? 'top' : 'full', color: slot.color });
        });
        pending.delete(commit.oid);
        slots[lane] = null;
        for (const parent of new Set(commit.parents)) {
          let target = pending.get(parent);
          if (target === undefined) target = reserve(parent, colors.get(parent) ?? (slots[lane] === null ? color : colorKey(parent)));
          segments.push({ from: lane, to: target, half: 'bottom', color: slots[target].color });
        }
        width = Math.max(width, slots.length, incoming.length, lane + 1);
        while (slots.length && slots.at(-1) === null) slots.pop();
        return { oid: commit.oid, lane, color, segments };
      });
    },
    get width() { return width; }
  };
}

/** Up to two uppercase letters for a commit-node badge: initials of the first
 * two name parts, or the first two letters of a single-word name. */
export function authorInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const raw = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return raw.toUpperCase();
}

/** The node sits in the middle of its row, whatever that row's height is:
 * a row grows downwards when its refs wrap, and the lanes have to follow. */
export function segmentPath({ from, to, half }, height = ROW_HEIGHT) {
  const x1 = 12 + from * LANE_WIDTH;
  const x2 = 12 + to * LANE_WIDTH;
  const middle = height / 2;
  if (half === 'top') return `M${x1} 0V${middle}`;
  if (half === 'full') return `M${x1} 0V${height}`;
  return `M${x1} ${middle}C${x1} ${middle + 9} ${x2} ${height - 9} ${x2} ${height}`;
}

/** Row geometry for a list where most rows are ROW_HEIGHT tall and a few are
 * taller. `extras` is the sparse, index-ascending list of the taller ones
 * (`[index, extraPixels]`), so a hundred thousand commits still cost one
 * binary search per lookup instead of a hundred thousand-entry prefix sum. */
export function createRowMetrics(extras = []) {
  const before = [];
  let total = 0;
  for (const [, extra] of extras) { before.push(total); total += extra; }
  // How many pixels of extra height sit above row `index`.
  function extraBefore(index) {
    let low = 0;
    let high = extras.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (extras[middle][0] < index) low = middle + 1; else high = middle;
    }
    return low ? before[low - 1] + extras[low - 1][1] : 0;
  }
  function height(index) {
    let low = 0;
    let high = extras.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (extras[middle][0] === index) return ROW_HEIGHT + extras[middle][1];
      if (extras[middle][0] < index) low = middle + 1; else high = middle - 1;
    }
    return ROW_HEIGHT;
  }
  const top = index => index * ROW_HEIGHT + extraBefore(index);
  function indexAt(y, count) {
    let low = 0;
    let high = count - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (top(middle) <= y) { found = middle; low = middle + 1; } else high = middle - 1;
    }
    return found;
  }
  return {
    top,
    height,
    totalHeight: count => count * ROW_HEIGHT + (count ? extraBefore(count) : 0),
    range(count, scrollTop, viewHeight, overscan = 8) {
      if (!count) return { start: 0, end: 0 };
      const start = Math.max(0, indexAt(scrollTop, count) - overscan);
      const end = Math.min(count, indexAt(scrollTop + viewHeight, count) + 1 + overscan);
      return { start, end };
    },
  };
}
