// What keeps a refresh from re-rendering the whole window dozens of times:
// journal events applied in batches, repositories that keep their identity,
// memoized tabs and graph rows with handlers that keep theirs. Measured on
// 8 tabs before this: one Refresh re-rendered HistoryWorkspace 145 times
// (~410 ms of renderer script); after it, 16 times.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { CONSOLE_LIMIT, applyConsoleUpdates } from '../../renderer/src/app/console-entries.js';
import { keepUnchangedRepositories } from '../../renderer/src/app/workspace-identity.js';
import { localDayKey, relativeTime } from '../../renderer/src/ui/relative-time.js';

// --- journal events in batches ------------------------------------------------
// The one-event-at-a-time version this replaced, as the reference.
function applyOne(entries, update) {
  if (update.type === 'start') return [...entries, { ...update.entry, stdout: '', stderr: '', state: 'running', code: null, ms: null }].slice(-CONSOLE_LIMIT);
  if (update.type === 'output') return entries.map(entry => (entry.id === update.id ? { ...entry, [update.stream]: entry[update.stream] + update.chunk } : entry));
  if (update.type === 'finish') return entries.map(entry => (entry.id === update.id ? { ...entry, ...update.result, state: 'finished' } : entry));
  return entries;
}
const start = id => ({ type: 'start', entry: { id, argv: ['status'], cwd: '/r', operation: 'Read', startedAt: '2026-10-10T10:00:00Z' } });
const events = [start('a'), { type: 'output', id: 'a', stream: 'stdout', chunk: 'one ' }, start('b'),
  { type: 'output', id: 'a', stream: 'stdout', chunk: 'two' }, { type: 'output', id: 'b', stream: 'stderr', chunk: 'oops' },
  { type: 'finish', id: 'a', result: { code: 0, ms: 5 } }, { type: 'output', id: 'missing', stream: 'stdout', chunk: 'x' },
  { type: 'finish', id: 'b', result: { code: 1, ms: 9 } }, { type: 'unknown' }];
const existing = [{ id: 'old', argv: [], cwd: '/r', operation: 'Commit', stdout: 'done', stderr: '', state: 'finished', code: 0, ms: 3 }];
assert.deepEqual(applyConsoleUpdates(existing, events), events.reduce(applyOne, existing), 'a batch equals the events one by one');
for (let cut = 0; cut <= events.length; cut++) {
  const split = applyConsoleUpdates(applyConsoleUpdates(existing, events.slice(0, cut)), events.slice(cut));
  assert.deepEqual(split, events.reduce(applyOne, existing), `split at ${cut}`);
}
const after = applyConsoleUpdates(existing, events);
assert.equal(after[0], existing[0], 'an untouched entry keeps its identity');
assert.equal(applyConsoleUpdates(existing, []), existing, 'no events, same list');
const many = Array.from({ length: CONSOLE_LIMIT + 50 }, (_, index) => start(`e${index}`));
const trimmed = applyConsoleUpdates([], many);
assert.equal(trimmed.length, CONSOLE_LIMIT);
assert.equal(trimmed[0].id, 'e50', 'the oldest entries go first');

// --- repositories keep their identity ------------------------------------------
const repo = (id, entries = []) => ({ id, path: id, name: id, available: true, status: { branch: { name: 'main' }, entries } });
const previous = { repositories: [repo('/a'), repo('/b')], activeId: '/a' };
const next = { repositories: [repo('/a', [{ path: 'x' }]), repo('/b')], activeId: '/a' };
const kept = keepUnchangedRepositories(previous, next);
assert.equal(kept.repositories[1], previous.repositories[1], 'an unchanged repository keeps its object');
assert.equal(kept.repositories[0], next.repositories[0], 'a changed one is the new object');
assert.equal(keepUnchangedRepositories(null, next), next);
assert.equal(keepUnchangedRepositories(previous, null), null);

// --- dates ---------------------------------------------------------------------
const now = Date.parse('2026-10-10T12:00:00Z');
assert.equal(relativeTime(now / 1000 - 2410 * 86400, now), '7 years ago', 'years, not "2,410 days ago"');
assert.equal(relativeTime(now / 1000 - 45 * 86400, now), '1 month ago');
assert.equal(relativeTime(now / 1000 - 3 * 86400, now), '3 days ago');
// A day break is the reader's calendar day. The first pair is 30 minutes apart
// (Git's text says 2026-10-09 and 2026-10-10): one day everywhere. The second
// pair crosses midnight in UTC but not in Los Angeles or Tokyo.
const pairs = [['2026-10-09T23:30:00-07:00', '2026-10-10T08:00:00+02:00'], ['2026-10-09T23:00:00Z', '2026-10-10T01:00:00Z']];
const zones = { 'America/Los_Angeles': 'true,true', 'Asia/Tokyo': 'true,true', UTC: 'true,false' };
for (const [zone, expected] of Object.entries(zones)) {
  const script = `import { localDayKey } from ${JSON.stringify(new URL('../../renderer/src/ui/relative-time.js', import.meta.url).href)};
    process.stdout.write(${JSON.stringify(pairs)}.map(([a, b]) => localDayKey(a) === localDayKey(b)).join(','));`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, TZ: zone }, encoding: 'utf8' });
  assert.equal(result.stdout, expected, `${zone}: day breaks by the local clock`);
}
assert.equal(localDayKey('not a date'), 'not a date');

// --- the code that keeps the budget (a regression here is silent otherwise) -----
const source = async file => readFile(new URL(`../../renderer/src/${file}`, import.meta.url), 'utf8');
const workspace = await source('features/graph/HistoryWorkspace.jsx');
assert.match(workspace, /export default memo\(HistoryWorkspace\);/, 'a tab is memoized');
for (const element of workspace.match(/<CommitGraph [^>]*\/>/gs)) {
  assert.ok(!/=>/.test(element), 'the graph gets no inline function: its rows are memoized');
}
const app = await source('app/App.jsx');
assert.match(app, /filterRef=\{filterRefFor\(item\.id\)\}/, 'one ref callback per tab');
assert.ok(!/onConsoleUpdate\(\(update\) => \{ if \(alive\) setEntries/.test(app), 'journal events are not applied one by one');
assert.match(app, /keepUnchangedRepositories\(previous, next\)/);
const drag = await source('features/graph/useGitDrag.js');
assert.match(drag, /return useMemo\(\(\) => \{/, 'the drag object keeps its identity');
const graph = await source('features/graph/CommitGraph.jsx');
assert.match(graph, /const CommitRow = memo\(/);
assert.ok(!/new Intl\./.test(graph), 'no Intl formatter is built per row');
console.log('Render budget checks passed: batched journal events, kept identities, local day breaks, wording, memoized tabs and rows.');
