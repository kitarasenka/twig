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

export function segmentPath({ from, to, half }) {
  const x1 = 12 + from * LANE_WIDTH;
  const x2 = 12 + to * LANE_WIDTH;
  if (half === 'top') return `M${x1} 0V15`;
  if (half === 'full') return `M${x1} 0V30`;
  return `M${x1} 15C${x1} 24 ${x2} 21 ${x2} 30`;
}

export function visibleRange(count, scrollTop, height, overscan = 8) {
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  return { start: Math.min(start, count), end: Math.min(count, Math.ceil((scrollTop + height) / ROW_HEIGHT) + overscan) };
}
