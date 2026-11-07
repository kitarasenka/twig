import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANE_ORIGIN, LANE_WIDTH, headLinePath } from '../../renderer/src/features/graph/layout.js';
import { MAX_WORKTREE_ROWS, branchWorktrees, isWorktreeSelection, otherWorktrees, pickRows, selectedFolder, stripPaths, tipIndex,
  worktreeLanes, worktreeSelection } from '../../renderer/src/features/graph/worktree-lanes.js';

// Which worktrees get a row above the commits and how their dashed lanes run.

const card = (name, more = {}) => ({ path: `/w/${name}`, branch: `agent/${name}`, head: name, changes: { files: 0, conflicts: 0 }, ahead: 0, lastActivity: 0, ...more });

// A selection names a folder, and nothing else reads as one.
assert.equal(selectedFolder(worktreeSelection('/w/a b')), '/w/a b');
assert.equal(isWorktreeSelection('uncommitted'), false);
assert.equal(isWorktreeSelection('a'.repeat(40)), false);
assert.equal(selectedFolder(null), null);

// This tab's own worktree, a bare main one and a missing folder get no row.
assert.deepEqual(otherWorktrees([card('here', { current: true }), card('bare', { bare: true }), card('gone', { prunable: 'gone' }), card('kept')]).map(entry => entry.path), ['/w/kept']);

// Branches: a detached worktree holds none.
const held = branchWorktrees([card('a'), card('b', { branch: null })]);
assert.deepEqual([...held.keys()], ['agent/a']);

// Up to the limit all show, in Git's order.
const few = [card('b'), card('a')];
assert.deepEqual(pickRows(few), { rows: few, hidden: 0 });

// Over it the most urgent stay, still in Git's order: a row does not jump when its agent connects.
const many = [card('clean'), card('ahead', { ahead: 2 }), card('dirty', { changes: { files: 1, conflicts: 0 } }), card('agent', { connected: { count: 1 } }),
  card('conflict', { changes: { files: 1, conflicts: 1 } }), card('asked', { proposal: true })];
const picked = pickRows(many);
assert.equal(picked.hidden, many.length - MAX_WORKTREE_ROWS);
assert.deepEqual(picked.rows.map(entry => entry.path), ['/w/dirty', '/w/agent', '/w/conflict', '/w/asked']);
// The newest of equals, and the selected one whatever it holds.
assert.deepEqual(pickRows([card('old', { lastActivity: 1 }), card('new', { lastActivity: 2 })], null, 1).rows.map(entry => entry.path), ['/w/new']);
assert.ok(pickRows(many, '/w/clean').rows.some(entry => entry.path === '/w/clean'), 'the selected worktree keeps its row');
assert.equal(pickRows(many, '/w/clean').rows.length, MAX_WORKTREE_ROWS);

// Where a tip stands: a row, a page not read yet, or nowhere in this history.
const indexMap = new Map([['top', 0], ['mid', 5], ['low', 9]]);
assert.equal(tipIndex('top', indexMap, false), 0);
assert.equal(tipIndex('later', indexMap, true), Infinity);
assert.equal(tipIndex('later', indexMap, false), null);
assert.equal(tipIndex(null, indexMap, true), null);

// The tip farthest down takes the leftmost lane, after HEAD's; rows keep their order.
const rows = [{ path: 'a', head: 'top' }, { path: 'b', head: 'low' }, { path: 'c', head: 'later' }, { path: 'd', head: 'mid' }];
const lanes = worktreeLanes(rows, indexMap, true, 1);
assert.deepEqual(lanes.map(lane => lane.path), ['a', 'b', 'c', 'd']);
const lane = n => LANE_ORIGIN + n * LANE_WIDTH;
assert.deepEqual(lanes.map(entry => entry.x), [lane(4), lane(2), lane(1), lane(3)]);
assert.equal(new Set(lanes.map(entry => entry.x)).size, 4, 'no two lanes share a column');
// A commit the history does not hold still gets a lane for its node, on the far right.
const gone = worktreeLanes([{ path: 'x', head: 'nowhere' }, { path: 'y', head: 'mid' }], indexMap, false);
assert.equal(gone[0].tip, null);
assert.ok(gone[0].x > gone[1].x);

// In the strip: a row's own line starts at its node, those above run through, one with no commit has none.
const strip = [{ path: 'a', x: 30, tip: 2 }, { path: 'b', x: 48, tip: null }, { path: 'c', x: 66, tip: 0 }];
assert.deepEqual(stripPaths(strip, 0, 28).map(line => line.d), ['M30 14V28']);
assert.deepEqual(stripPaths(strip, 1, 28).map(line => line.d), ['M30 0V28']);
assert.deepEqual(stripPaths(strip, 2, 28).map(line => line.d), ['M30 0V28', 'M66 14V28']);
assert.deepEqual(stripPaths(strip, 3, 28).map(line => line.d), ['M30 0V28', 'M66 0V28'], 'the "more" row carries them all');

// In the commits: straight down its lane, then across to the node, at any row — the first one too.
assert.equal(headLinePath(0, 3, 28, 100, 30), 'M30 0V28');
assert.equal(headLinePath(3, 3, 28, 100, 30), 'M30 0V14H92');
assert.equal(headLinePath(4, 3, 28, 100, 30), null);
assert.equal(headLinePath(0, 0, 28, 100, 30), 'M30 0V14H92', 'a worktree on the top commit still meets it');
assert.equal(headLinePath(7, Infinity, 28, 100, 30), 'M30 0V28', 'a tip on a later page runs on');
assert.equal(headLinePath(1, 3, 28, 100), `M${LANE_ORIGIN} 0V28`, 'HEAD keeps its own lane');

// The classes the rows are drawn with exist.
const css = await readFile('renderer/src/ui/history.css', 'utf8');
for (const name of ['worktree-strip', 'worktree-lane-row', 'worktree-link', 'worktree-node', 'worktree-lane-words', 'worktree-detail']) assert.ok(css.includes(`.${name}`), name);

console.log('worktree-lanes checks passed: selection, rows and urgency, tips, lane order, dashed lines.');
