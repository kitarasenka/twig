import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkoutChoice } from '../../renderer/src/features/ops/checkout-choice.js';

const A = '82df62445b05a04be53291bb36b5db80e46dad77';
const B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const local = (name, target = A, upstream = null) => ({ type: 'local', name, fullName: `refs/heads/${name}`, target, upstream });
const remote = (name, target = A) => ({ type: 'remote', name, fullName: `refs/remotes/${name}`, target });
const tag = (name, target = A) => ({ type: 'tag', name, fullName: `refs/tags/${name}`, target });

// One local branch: checked out by name, the graph is told where it points.
assert.deepEqual(checkoutChoice([local('feature')], { headBranch: 'main' }), { kind: 'branch', name: 'feature', target: A });
// The current branch is not checked out again, and says why.
assert.equal(checkoutChoice([local('main')], { headBranch: 'main' }).kind, 'none');
assert.match(checkoutChoice([local('main')], { headBranch: 'main' }).reason, /already checked out/);
// A row with the current branch on it stays put, even with others beside it.
assert.equal(checkoutChoice([local('main'), local('feature'), remote('origin/main')], { headBranch: 'main' }).kind, 'none');
// A row whose local branch is unambiguous checks it out; its remote twin does not get in the way.
assert.deepEqual(checkoutChoice([local('feature'), remote('origin/feature'), tag('v1')], { headBranch: 'main' }),
  { kind: 'branch', name: 'feature', target: A });
// Two local branches on one row: no guess.
const two = checkoutChoice([local('a'), local('b')], { headBranch: 'main' });
assert.equal(two.kind, 'none'); assert.match(two.reason, /Several branches/);
// A remote branch nobody tracks opens the "new branch" dialog.
assert.deepEqual(checkoutChoice([remote('origin/topic', B)], { headBranch: 'main', locals: [local('main')] }), { kind: 'remote', ref: remote('origin/topic', B) });
// A remote branch a local one already tracks checks out that local branch, at the local tip.
assert.deepEqual(checkoutChoice([remote('origin/topic', B)], { headBranch: 'main', locals: [local('main'), local('topic', A, 'origin/topic')] }),
  { kind: 'branch', name: 'topic', target: A });
// …unless that local branch is the current one.
assert.equal(checkoutChoice([remote('origin/topic')], { headBranch: 'topic', locals: [local('topic', A, 'origin/topic')] }).kind, 'none');
// Two local branches tracking the same remote: the dialog, not a guess.
assert.equal(checkoutChoice([remote('origin/topic')], { headBranch: 'main', locals: [local('x', A, 'origin/topic'), local('y', A, 'origin/topic')] }).kind, 'remote');
// Two remote branches on a row and no local: no guess.
assert.equal(checkoutChoice([remote('origin/a'), remote('upstream/a')], { headBranch: 'main' }).kind, 'none');
// Tags and empty rows never check anything out, and say nothing.
assert.deepEqual(checkoutChoice([tag('v1')], { headBranch: 'main' }), { kind: 'none', reason: null });
assert.deepEqual(checkoutChoice([], { headBranch: 'main' }), { kind: 'none', reason: null });
assert.deepEqual(checkoutChoice(undefined), { kind: 'none', reason: null });
// Detached HEAD: any local branch can be checked out.
assert.equal(checkoutChoice([local('main')], { headBranch: null }).kind, 'branch');

// Wiring: the sidebar, the badges and the row all double-click into the same handler,
// and a checkout tells the reload which commit to show instead of the newest one.
const workspace = readFileSync(new URL('../../renderer/src/features/graph/HistoryWorkspace.jsx', import.meta.url), 'utf8');
const graph = readFileSync(new URL('../../renderer/src/features/graph/CommitGraph.jsx', import.meta.url), 'utf8');
assert.match(workspace, /onDoubleClick=\{\(\) => onCheckout\(\[ref\]\)\}/, 'sidebar branch double-click');
assert.equal((workspace.match(/onCheckout=\{checkoutOnDoubleClick\}/g) || []).length, 1, 'the sidebar');
assert.equal((workspace.match(/onCheckout=\{rowHandlers\.checkout\}/g) || []).length, 2, 'the graph and the search results');
assert.match(workspace, /checkout: refs => latest\.current\.checkoutOnDoubleClick\(refs\)/, 'one handler behind them all');
assert.match(graph, /onDoubleClick=\{event => \{ event\.stopPropagation\(\); onCheckout\?\.\(\[ref\]\); \}\}/, 'badge double-click stops at the badge');
assert.match(graph, /onDoubleClick=\{\(\) => onCheckout\?\.\(refs \|\| \[\]\)\}/, 'row double-click');
assert.match(workspace, /checkoutRef\(repository\.id, name, false\), `Checked out \$\{name\}\.`,\s*\{ select:/, 'branch checkout selects its commit');
// The reload never publishes an empty history: that collapses the scroller to the top.
const reload = workspace.slice(workspace.indexOf('const reload = useCallback'), workspace.indexOf('const refreshOperation'));
assert.ok(!/dataRef\.current = \{ commits: \[\][^\n]*\n\s*setData\(dataRef\.current\)/.test(reload), 'reload does not show an empty list first');
assert.match(reload, /missing\(\)/, 'reload reads back as many rows as were shown');
assert.match(reload, /const buffer = \{ current: \{ commits: \[\]/, 'into a buffer of its own');
assert.match(reload, /dataRef\.current = buffer\.current;/, 'swapped in once it is read');

console.log('checkout-choice: ok');
