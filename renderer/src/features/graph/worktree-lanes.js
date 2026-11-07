import { LANE_ORIGIN, LANE_WIDTH } from './layout.js';

/**
 * Worktrees in the graph. Every worktree shares this history, so a worktree is
 * not a second tree: what sets one apart is where its HEAD stands and what it
 * has not committed. Each gets a row above the commits and a dashed lane of its
 * own down to the commit it stands on. This module decides which rows show and
 * how their lanes run. Imports only layout.js: Vite and the Node check load it.
 */

const SELECTION = 'worktree:';
/** The most rows above the commits: past this the rest are a count that opens the Worktrees screen. */
export const MAX_WORKTREE_ROWS = 4;

export const worktreeSelection = folder => `${SELECTION}${folder}`;
export const isWorktreeSelection = value => typeof value === 'string' && value.startsWith(SELECTION);
/** The folder a selection names, or null. */
export const selectedFolder = value => (isWorktreeSelection(value) ? value.slice(SELECTION.length) : null);

/** The worktrees worth a row: not this tab's own (HEAD and "Uncommitted changes" say that), nor one with no checkout to show. */
export const otherWorktrees = worktrees => worktrees.filter(entry => !entry.current && !entry.bare && !entry.prunable);

/** Branch name → its worktree, for the marks on branches. A detached worktree holds none. */
export function branchWorktrees(worktrees) {
  return new Map(worktrees.filter(entry => entry.branch).map(entry => [entry.branch, entry]));
}

/** What most needs a look: an answer the person owes, then a conflict, a working agent, unfinished work. */
function urgency(card) {
  if (card.proposal) return 0;
  if (card.changes?.conflicts) return 1;
  if (card.connected) return 2;
  if (card.changes?.files) return 3;
  return card.ahead ? 4 : 5;
}

/**
 * The rows to draw, in the order Git lists them, so a row does not move under
 * the pointer when its agent connects. Over the limit the most urgent stay,
 * and `pinned` (the selected worktree) always does.
 */
export function pickRows(worktrees, pinned = null, limit = MAX_WORKTREE_ROWS) {
  if (worktrees.length <= limit) return { rows: worktrees, hidden: 0 };
  const ranked = [...worktrees].sort((a, b) => Number(b.path === pinned) - Number(a.path === pinned)
    || urgency(a) - urgency(b) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  const kept = new Set(ranked.slice(0, limit));
  return { rows: worktrees.filter(entry => kept.has(entry)), hidden: worktrees.length - limit };
}

/** The row a worktree's HEAD is on: Infinity on a page not read yet, null when the history does not hold it. */
export function tipIndex(head, indexMap, hasMore) {
  if (!head) return null;
  const index = indexMap.get(head);
  if (index === undefined) return hasMore ? Infinity : null;
  return index;
}

/**
 * One lane per row, `first` lanes in from the left. The tip farthest down gets
 * the leftmost lane: a lane turns right into its commit, and so crosses no lane
 * that has already ended. Same order as `rows`.
 */
export function worktreeLanes(rows, indexMap, hasMore, first = 0) {
  const lanes = rows.map(row => ({ path: row.path, tip: tipIndex(row.head, indexMap, hasMore) }));
  const depth = lane => (lane.tip === null ? -1 : lane.tip);
  const order = [...lanes].sort((a, b) => (depth(a) === depth(b) ? 0 : depth(b) > depth(a) ? 1 : -1));
  order.forEach((lane, index) => { lane.x = LANE_ORIGIN + (first + index) * LANE_WIDTH; });
  return lanes;
}

/**
 * The dashed lines in the row at `index` of the strip: its own, from its node
 * down, and those of the rows above, straight through. A worktree whose commit
 * is not in the history has no line. `index` past the rows is the "more" row.
 */
export function stripPaths(lanes, index, height) {
  return lanes.flatMap((lane, row) => {
    if (lane.tip === null || row > index) return [];
    return [{ path: lane.path, d: `M${lane.x} ${row === index ? height / 2 : 0}V${height}` }];
  });
}
