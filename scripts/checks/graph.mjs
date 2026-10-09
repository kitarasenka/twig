import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AUTHOR_TINTS, ROW_HEIGHT, authorTint, createLaneLayout, createRowMetrics, segmentPath } from '../../renderer/src/features/graph/layout.js';
import { BADGE_GAP, REF_LINE_HEIGHT, badgeWidth, extraHeight, packRefLines } from '../../renderer/src/features/graph/ref-lines.js';

const c = (oid, ...parents) => ({ oid, parents });
const fixtures = [
  [c('a', 'b'), c('b', 'c'), c('c')],
  [c('merge', 'main', 'feature'), c('feature', 'base'), c('main', 'base'), c('base')],
  [c('octopus', 'a', 'b', 'c'), c('a', 'root'), c('b', 'root'), c('c', 'root'), c('root')],
  [c('left', 'root'), c('right', 'root'), c('root'), c('independent')],
  [c('x', 'y', 'y'), c('y', 'missing')]
];
for (const commits of fixtures) {
  const graph = createLaneLayout();
  const rows = graph.append(commits);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    const bottom = row.segments.filter(segment => segment.half === 'bottom');
    assert.equal(bottom.length, new Set(commits[index].parents).size);
    assert.ok(bottom.every(segment => segment.from === row.lane));
    assert.ok(row.segments.every(segment => !segmentPath(segment).includes('NaN')));
    if (index < rows.length - 1) {
      const exits = new Set(row.segments.filter(segment => segment.half !== 'top').map(segment => segment.to));
      const entrances = new Set(rows[index + 1].segments.filter(segment => segment.half !== 'bottom').map(segment => segment.from));
      assert.deepEqual(entrances, exits, 'Every open lane continues on the next row');
    }
  }
  for (let cut = 1; cut < commits.length; cut++) {
    const paged = createLaneLayout();
    assert.deepEqual([...paged.append(commits.slice(0, cut)), ...paged.append(commits.slice(cut))], rows, 'Paging preserves graph geometry and color');
  }
}
const started = performance.now();
const linear = Array.from({ length: 100000 }, (_, i) => c(String(i), ...(i < 99999 ? [String(i + 1)] : [])));
const graph = createLaneLayout();
assert.equal(graph.append(linear).length, 100000);
assert.equal(graph.width, 1);
const uniform = createRowMetrics();
for (const top of [0, 1000000, 2999000]) {
  const range = uniform.range(100000, top, 600);
  assert.ok(range.end - range.start <= 38);
}
assert.deepEqual(uniform.range(0, 0, 600), { start: 0, end: 0 });
assert.equal(uniform.totalHeight(100000), 100000 * ROW_HEIGHT);

// Rows that wrap their refs are taller, and every row below them moves down by
// exactly that much — the sparse metrics must agree with a naive prefix sum.
const extras = [[2, REF_LINE_HEIGHT], [5, REF_LINE_HEIGHT * 3], [9, REF_LINE_HEIGHT]];
const metrics = createRowMetrics(extras);
const heights = Array.from({ length: 12 }, (_, index) => ROW_HEIGHT + (extras.find(([at]) => at === index)?.[1] ?? 0));
let sum = 0;
for (let index = 0; index < heights.length; index++) {
  assert.equal(metrics.height(index), heights[index]);
  assert.equal(metrics.top(index), sum);
  sum += heights[index];
}
assert.equal(metrics.totalHeight(heights.length), sum);
// A viewport landing inside a tall row still starts on that row.
for (let y = 0; y < sum; y += 7) {
  const { start, end } = metrics.range(heights.length, y, 60, 0);
  assert.ok(metrics.top(start) <= y && metrics.top(end - 1) <= y + 60);
  assert.ok(end === heights.length || metrics.top(end) >= y + 60);
}
// The node stays centred however tall the row is, and the lanes reach the edges.
assert.equal(segmentPath({ from: 0, to: 0, half: 'top' }, 48), 'M12 0V24');
assert.equal(segmentPath({ from: 0, to: 0, half: 'full' }, 48), 'M12 0V48');
assert.ok(segmentPath({ from: 0, to: 1, half: 'bottom' }, 48).endsWith('30 48'));

// Ref badges wrap instead of collapsing into a `+N` stub.
const measure = text => text.length * 6;
const names = ['main', 'origin/main', 'v1.0.0', 'release/2026-09'];
const widths = names.map(name => badgeWidth(name, measure));
assert.deepEqual(packRefLines(widths, 10000), [[0, 1, 2, 3]], 'A wide column keeps every badge on one line');
const narrow = packRefLines(widths, widths[0] + BADGE_GAP + widths[1], 0);
assert.deepEqual(narrow[0], [0, 1]);
assert.deepEqual(narrow.flat(), [0, 1, 2, 3], 'Every ref is placed, none is dropped');
assert.equal(extraHeight(narrow.length), (narrow.length - 1) * REF_LINE_HEIGHT);
// The HEAD tick and the mark chip take room away from the first line only.
assert.equal(packRefLines(widths, 10000, 9999)[0].length, 1);
// A badge wider than the column gets its own line rather than vanishing.
assert.deepEqual(packRefLines([500, 20], 40), [[0], [1]]);
assert.deepEqual(packRefLines([], 140), [[]]);

// History rows are 28 px; the row metrics and the inline row height share it.
assert.equal(ROW_HEIGHT, 28);

// Author tints: stable, keyed by email regardless of case, by name without one,
// in range, and not all the same for a handful of different people.
assert.equal(authorTint({ name: 'Ann', email: 'Ann@Example.com' }), authorTint({ name: 'Annie', email: 'ann@example.com' }));
assert.equal(authorTint({ name: 'Bob', email: '' }), authorTint({ name: 'bob' }));
for (const author of [{}, null, undefined, { name: 'Ж' }]) {
  const tint = authorTint(author);
  assert.ok(Number.isInteger(tint) && tint >= 0 && tint < AUTHOR_TINTS);
}
assert.ok(new Set(['a@x', 'b@x', 'c@x', 'd@x', 'e@x', 'f@x', 'g@x', 'h@x'].map(email => authorTint({ email }))).size >= 3);
// Every tint has its CSS rule, and the --text initials keep 4.5:1 on each
// tint (22 % of a mark colour into --bg) in both themes.
const historyCss = readFileSync(new URL('../../renderer/src/ui/history.css', import.meta.url), 'utf8');
const tokensCss = readFileSync(new URL('../../renderer/src/ui/tokens.css', import.meta.url), 'utf8');
const tintColors = [];
for (let index = 0; index < AUTHOR_TINTS; index++) {
  const rule = historyCss.match(new RegExp(`\\.author-tint-${index} \\{ --author-tint: var\\(--([\\w-]+)\\); \\}`));
  assert.ok(rule, `history.css defines .author-tint-${index}`);
  tintColors.push(rule[1]);
}
assert.match(historyCss, /\.real-lane circle\.author-tint \{ fill: color-mix\(in srgb, var\(--author-tint\) 22%, var\(--bg\)\); \}/);
const channels = hex => hex.match(/\w\w/g).map(part => parseInt(part, 16));
const luminance = rgb => {
  const [r, g, b] = rgb.map(value => value / 255).map(value => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
};
for (const theme of ['dark', 'light']) {
  const block = tokensCss.split(`:root[data-theme='${theme}'] {`)[1].split('}')[0];
  const palette = Object.fromEntries([...block.matchAll(/--([\w-]+): #(\w{6});/g)].map(match => [match[1], channels(match[2])]));
  for (const name of tintColors) {
    const fill = palette[name].map((value, channel) => value * 0.22 + palette.bg[channel] * 0.78);
    const [light, dark] = [luminance(fill), luminance(palette.text)].sort((a, b) => b - a);
    assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, `${theme}: --text initials on the ${name} author tint`);
  }
}
console.log(`Graph checks passed: merges, roots, page continuity, 100k linear commits (${Math.round(performance.now() - started)}ms), bounded visible rows, wrapped ref lines, author tints.`);
