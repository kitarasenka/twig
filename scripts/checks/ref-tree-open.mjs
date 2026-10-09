import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ancestorKeys, folderKey, forgetRevealed, isOpen, revealedKeys, sectionKey, selectedRefNames } from '../../renderer/src/features/refs/ref-tree-open.js';

const A = '82df62445b05a04be53291bb36b5db80e46dad77';
const B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const local = (name, target = A) => ({ type: 'local', name, fullName: `refs/heads/${name}`, target });
const remote = (name, target = A) => ({ type: 'remote', name, fullName: `refs/remotes/${name}`, target });
const tag = (name, target = A) => ({ type: 'tag', name, fullName: `refs/tags/${name}`, target });

// The section and every folder above a ref, however deep.
assert.deepEqual(ancestorKeys(local('main')), ['section:local']);
assert.deepEqual(ancestorKeys(local('feat/graph/curves')), ['section:local', 'local:feat', 'local:feat/graph']);
assert.deepEqual(ancestorKeys(remote('origin/feat/x')), ['section:remote', 'remote:origin', 'remote:origin/feat']);
assert.deepEqual(ancestorKeys(tag('release/v1')), ['section:tag', 'tag:release']);
// Same folder name in two sections is two folders.
assert.notEqual(folderKey('local', 'feat'), folderKey('remote', 'feat'));
assert.equal(sectionKey('tag'), 'section:tag');

const refs = [local('main', A), remote('origin/main', A), tag('v1', A), local('feat/deep/one', B), local('other', B)];
// No commit selected: nothing is selected, nothing opens.
assert.deepEqual(selectedRefNames(refs, null, null), []);
assert.equal(revealedKeys(refs, []).size, 0);
// A commit selected in the graph: every ref on it.
assert.deepEqual(selectedRefNames(refs, A, null), ['refs/heads/main', 'refs/remotes/origin/main', 'refs/tags/v1']);
// A ref picked by name: only it, while its commit is the selection…
assert.deepEqual(selectedRefNames(refs, A, { fullName: 'refs/remotes/origin/main', target: A }), ['refs/remotes/origin/main']);
// …and not once the selection moved to another commit.
assert.deepEqual(selectedRefNames(refs, B, { fullName: 'refs/remotes/origin/main', target: A }), ['refs/heads/feat/deep/one', 'refs/heads/other']);
// A picked ref that is gone (deleted, renamed) falls back to the commit.
assert.deepEqual(selectedRefNames(refs, A, { fullName: 'refs/heads/gone', target: A }), ['refs/heads/main', 'refs/remotes/origin/main', 'refs/tags/v1']);
// Revealing a deep ref opens its section and every folder on the way, nothing else.
assert.deepEqual([...revealedKeys(refs, ['refs/heads/feat/deep/one'])].sort(), ['local:feat', 'local:feat/deep', 'section:local']);

// Closed by default; opened by the selection; a hand toggle wins; the filter opens all.
const none = new Map();
const revealed = revealedKeys(refs, ['refs/heads/feat/deep/one']);
assert.equal(isOpen('section:remote', { manual: none, revealed, filtering: false }), false);
assert.equal(isOpen('local:feat/deep', { manual: none, revealed, filtering: false }), true);
assert.equal(isOpen('local:feat/deep', { manual: new Map([['local:feat/deep', false]]), revealed, filtering: false }), false);
assert.equal(isOpen('section:remote', { manual: new Map([['section:remote', true]]), revealed, filtering: false }), true);
assert.equal(isOpen('section:tag', { manual: new Map([['section:tag', false]]), revealed, filtering: true }), true);

// A new selection forgets a hand "closed" only where it needs the folder open;
// a hand "open" stays, so the folder does not close once the selection moves on.
const manual = new Map([['local:feat', false], ['section:local', true], ['section:remote', true]]);
const after = forgetRevealed(manual, revealed);
assert.deepEqual([...after], [['section:local', true], ['section:remote', true]]);
assert.equal(isOpen('section:local', { manual: after, revealed: new Set(), filtering: false }), true, 'opened by hand stays open after the selection leaves');
assert.deepEqual([...manual], [['local:feat', false], ['section:local', true], ['section:remote', true]], 'the old map is not mutated');
assert.equal(forgetRevealed(none, revealed), none, 'nothing to forget keeps the same map (no re-render)');

// The sidebar uses it: sections and folders are no longer always open.
const workspace = readFileSync(new URL('../../renderer/src/features/graph/HistoryWorkspace.jsx', import.meta.url), 'utf8');
assert.doesNotMatch(workspace, /<details className="branch-folder"[^>]*\bopen>/, 'folders are not hard-wired open');
assert.doesNotMatch(workspace, /<details key=\{type\} open>/, 'sections are not hard-wired open');
assert.match(workspace, /selected-ref/);
assert.match(readFileSync(new URL('../../renderer/src/ui/history.css', import.meta.url), 'utf8'), /\.real-branch\.selected-ref\s*\{/);

console.log('Ref tree: closed by default, the selected ref opened however deep, hand toggles, filter.');
