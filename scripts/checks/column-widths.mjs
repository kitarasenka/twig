import assert from 'node:assert/strict';
import {
  HISTORY_COLUMNS, HISTORY_COLUMN_KEYS, HISTORY_COLUMNS_KEY,
  clampColumnWidth, defaultColumnWidths, normalizeColumnWidths,
  readColumnWidths, writeColumnWidths, dragColumnWidth, nudgeColumnWidth,
} from '../../renderer/src/features/graph/column-widths.js';

// The five columns are present; every numeric default sits in its range, and
// the graph column defaults to null ("size to the lanes").
assert.deepEqual(HISTORY_COLUMN_KEYS, ['branch', 'graph', 'message', 'author', 'date']);
assert.equal(HISTORY_COLUMNS.graph.defaultWidth, null);
for (const key of HISTORY_COLUMN_KEYS) {
  const size = HISTORY_COLUMNS[key];
  if (size.defaultWidth === null) continue;
  assert.ok(size.min <= size.defaultWidth && size.defaultWidth <= size.max, key);
}

// Clamp holds both ends, rounds to whole pixels, and rejects unknown columns.
assert.equal(clampColumnWidth('branch', 10), HISTORY_COLUMNS.branch.min);
assert.equal(clampColumnWidth('branch', 9000), HISTORY_COLUMNS.branch.max);
assert.equal(clampColumnWidth('message', 260.6), 261);
assert.equal(clampColumnWidth('message', Number.NaN), HISTORY_COLUMNS.message.defaultWidth);
assert.equal(clampColumnWidth('nope', 100), null);

// The graph column clamps a real drag but falls back to null (auto) without one.
assert.equal(clampColumnWidth('graph', 300), 300);
assert.equal(clampColumnWidth('graph', 5000), HISTORY_COLUMNS.graph.max);
assert.equal(clampColumnWidth('graph', 10), HISTORY_COLUMNS.graph.min);
assert.equal(clampColumnWidth('graph', Number.NaN), null);
assert.equal(dragColumnWidth('graph', 120, 40), 160);

// Every handle is on its column's right edge: dragging right widens, left narrows.
assert.equal(dragColumnWidth('branch', 140, 30), 170);
assert.equal(dragColumnWidth('branch', 140, -30), 110);
assert.equal(dragColumnWidth('message', 260, 120), 380);
assert.equal(dragColumnWidth('author', 100, -20), 80);
assert.equal(dragColumnWidth('message', 260, 9000), HISTORY_COLUMNS.message.max);
assert.equal(dragColumnWidth('author', 100, -9000), HISTORY_COLUMNS.author.min);
assert.equal(dragColumnWidth('nope', 100, 10), null);

// Keyboard nudges: ArrowRight grows, ArrowLeft shrinks.
assert.equal(nudgeColumnWidth('message', 260, 12), 272);
assert.equal(nudgeColumnWidth('message', 260, -12), 248);

// normalize fills gaps with defaults, drops junk, and pulls values into range.
assert.deepEqual(normalizeColumnWidths(null), defaultColumnWidths());
assert.deepEqual(normalizeColumnWidths('nope'), defaultColumnWidths());
assert.deepEqual(normalizeColumnWidths({ message: 'wide' }), defaultColumnWidths());
assert.equal(normalizeColumnWidths({ message: 500 }).message, 500);
assert.equal(normalizeColumnWidths({ message: 50000 }).message, HISTORY_COLUMNS.message.max);
// The graph column keeps its null default unless a real number overrides it.
assert.equal(normalizeColumnWidths({}).graph, null);
assert.equal(normalizeColumnWidths({ graph: null }).graph, null);
assert.equal(normalizeColumnWidths({ graph: 220 }).graph, 220);
assert.equal(normalizeColumnWidths({ graph: 9000 }).graph, HISTORY_COLUMNS.graph.max);

// A fake storage round-trips (graph auto and graph pinned); a throwing storage
// falls back to defaults.
const mem = new Map();
const storage = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
writeColumnWidths(storage, { branch: 210, graph: null, message: 420, author: 90, date: 130 });
assert.deepEqual(readColumnWidths(storage), { branch: 210, graph: null, message: 420, author: 90, date: 130 });
writeColumnWidths(storage, { branch: 210, graph: 180, message: 420, author: 90, date: 130 });
assert.equal(readColumnWidths(storage).graph, 180);

const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
assert.deepEqual(readColumnWidths(broken), defaultColumnWidths());
writeColumnWidths(broken, defaultColumnWidths()); // must not throw

// A stored value outside the range is pulled back in on read.
mem.set(HISTORY_COLUMNS_KEY, JSON.stringify({ branch: -50, message: 99999, author: 100, date: 104 }));
assert.deepEqual(readColumnWidths(storage),
  { branch: HISTORY_COLUMNS.branch.min, graph: null, message: HISTORY_COLUMNS.message.max, author: 100, date: 104 });

// Corrupt JSON on disk reads as defaults, not a throw.
mem.set(HISTORY_COLUMNS_KEY, '{not json');
assert.deepEqual(readColumnWidths(storage), defaultColumnWidths());

console.log('column-widths check passed');
