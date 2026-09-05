import assert from 'node:assert/strict';
import { createLaneLayout, visibleRange, segmentPath } from '../../renderer/src/features/graph/layout.js';

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
for (const top of [0, 1000000, 2999000]) {
  const range = visibleRange(100000, top, 600);
  assert.ok(range.end - range.start <= 37);
}
assert.deepEqual(visibleRange(0, 0, 600), { start: 0, end: 0 });
console.log(`Graph checks passed: merges, roots, page continuity, 100k linear commits (${Math.round(performance.now() - started)}ms), bounded visible rows.`);
