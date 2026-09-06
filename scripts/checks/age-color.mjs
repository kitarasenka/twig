import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { AGE_STOPS, ageStop, ageStrokeClass, ageTextClass } from '../../renderer/src/features/graph/age-color.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const DAY = 86400000;
const now = Date.parse('2026-09-06T12:00:00Z');
const ago = (hours) => new Date(now - hours * 3600000).toISOString();

// Boundaries of the absolute scale: today, this week, this month, this year, older.
for (const [hours, expected] of [[0, 0], [1, 0], [23.9, 0], [24.1, 1], [24 * 6, 1], [24 * 7.1, 2],
  [24 * 29, 2], [24 * 30.1, 3], [24 * 364, 3], [24 * 365.1, 4], [24 * 3650, 4]]) {
  assert.equal(ageStop(ago(hours), now), expected, `${hours}h`);
}
assert.equal(ageStop(new Date(now), now), 0);
// A commit dated in the future is a clock, not a fact.
assert.equal(ageStop(new Date(now + DAY).toISOString(), now), 0);
// An unknown age claims no colour at all, so the graph keeps its lane colours for that row.
for (const value of ['', 'not a date', null, undefined, 0, {}, [], NaN]) assert.equal(ageStop(value, now), null, String(value));
assert.equal(ageStop(ago(1), NaN), null);
assert.equal(ageStop(ago(1)), ageStop(ago(1), Date.now()));

// The ramp never goes backwards as commits get older.
let previous = 0;
for (let hours = 0; hours < 24 * 800; hours += 7) {
  const stop = ageStop(ago(hours), now);
  assert.ok(stop >= previous, `${hours}h went back to ${stop}`);
  previous = stop;
}
assert.equal(previous, AGE_STOPS.length - 1);
assert.equal(AGE_STOPS.at(-1).maxDays, Infinity, 'the last stop must catch every older commit');
assert.deepEqual(AGE_STOPS.map(stop => stop.maxDays), [...AGE_STOPS.map(stop => stop.maxDays)].sort((a, b) => a - b));

assert.equal(ageStrokeClass(null), '');
assert.equal(ageTextClass(null), '');
assert.equal(ageStrokeClass(3), 'graph-age-3');
assert.equal(ageTextClass(3), 'age-text-3');

// Every stop needs a token in both themes and both class families, or a colour silently
// falls back to inherited text and the ramp lies about the age it shows.
const tokens = await read('renderer/src/ui/tokens.css');
const history = await read('renderer/src/ui/history.css');
const themes = [tokens.split(":root[data-theme='light'] {")[0], tokens.split(":root[data-theme='light'] {")[1]];
AGE_STOPS.forEach((stop, index) => {
  for (const block of themes) assert.match(block, new RegExp(`--age-${stop.key}: #[0-9a-f]{6};`), stop.key);
  assert.match(history, new RegExp(`\\.graph-age-${index} \\{ stroke: var\\(--age-${stop.key}\\); \\}`), stop.key);
  assert.match(history, new RegExp(`\\.age-text-${index} \\{ color: var\\(--age-${stop.key}\\); \\}`), stop.key);
});
assert.equal(history.match(/\.graph-age-\d+ \{/g).length, AGE_STOPS.length);
assert.equal(history.match(/\.age-text-\d+ \{/g).length, AGE_STOPS.length);
assert.equal([...tokens.matchAll(/--age-[a-z]+:/g)].length, AGE_STOPS.length * 2);

const graph = await read('renderer/src/features/graph/CommitGraph.jsx');
assert.match(graph, /data-colors=\{commitColors\}/, 'the working tree row is coloured through the container attribute');
assert.match(history, /\.real-history\[data-colors='age'\] \.worktree-row/);
const app = await read('renderer/src/app/App.jsx');
assert.match(app, /twig:commit-colors/, 'the choice has to survive a restart');
console.log(`Age colour checks passed: ${AGE_STOPS.length} stops, boundaries, unknown dates, token and class parity.`);
