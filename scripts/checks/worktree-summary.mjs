import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SECTIONS, conflictCount, summarizeStatus, summaryChips, summaryLabel }
  from '../../renderer/src/features/worktree/worktree-summary.js';
import { parseStatusV2 } from '../../main/git/status-parser.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = name => readFile(path.join(root, name), 'utf8');

const entry = (kind, path, indexStatus = '.', worktreeStatus = '.') =>
  ({ kind, path, originalPath: null, indexStatus, worktreeStatus, submodule: null, score: null });

// The three lists follow the rule loadWorktree applies, and a path with both an
// index and a worktree change is in both of them — that is how Git models it.
const both = summarizeStatus([entry('ordinary', 'a.txt', 'M', 'M')]);
assert.deepEqual(both.staged.map(f => f.status), ['M']);
assert.deepEqual(both.unstaged.map(f => f.status), ['M']);
assert.equal(both.paths, 1, 'paths counts paths, not list rows');

const mixed = summarizeStatus([
  entry('ordinary', 'src/b.js', 'A', '.'),
  entry('ordinary', 'src/a.js', '.', 'M'),
  entry('untracked', 'notes.todo'),
  entry('unmerged', 'conflict.txt', 'U', 'U'),
  entry('ignored', 'build/out.js')
]);
assert.deepEqual(mixed.staged.map(f => f.path), ['src/b.js']);
assert.deepEqual(mixed.unstaged.map(f => f.path), ['conflict.txt', 'src/a.js'], 'sorted by path');
assert.deepEqual(mixed.untracked.map(f => f.path), ['notes.todo']);
assert.equal(mixed.paths, 4, 'the ignored file is not an uncommitted change');
assert.equal(mixed.unstaged.find(f => f.path === 'conflict.txt').status, 'U', 'an unmerged path is one conflict row');
assert.equal(conflictCount(mixed), 1);
assert.equal(conflictCount(null), 0);

// Junk in, nothing out: the panel renders whatever this returns, so it never
// returns a hole for it to crash on.
for (const input of [null, undefined, 'nope', [null], [{ kind: 'ordinary' }], [{ kind: 'ordinary', path: '' }]]) {
  const empty = summarizeStatus(input);
  assert.deepEqual([empty.staged, empty.unstaged, empty.untracked], [[], [], []]);
  assert.equal(empty.paths, 0);
}

// The breakdown names every list in words; an empty list is left out, not
// printed as a zero.
assert.deepEqual(summaryChips(mixed).map(chip => chip.text), ['1 staged', '2 changed', '1 untracked']);
assert.equal(summaryLabel(mixed), '1 staged · 2 changed · 1 untracked');
assert.deepEqual(summaryChips(summarizeStatus([entry('untracked', 'x')])).map(c => c.key), ['untracked']);
assert.equal(summaryLabel(summarizeStatus([])), 'no changes');
assert.deepEqual(summaryChips(null), []);
assert.deepEqual(SECTIONS.map(section => section.key), ['staged', 'unstaged', 'untracked']);

// Parity with main: the same porcelain-v2 output must split the same way here
// as it does in loadWorktree, or the row would count one thing and the staging
// screen show another. Real `git status --porcelain=v2 -z --branch` text.
const porcelain = [
  '# branch.oid 1111111111111111111111111111111111111111',
  '# branch.head main',
  '1 M. N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 staged-only.txt',
  '1 .M N... 100644 100644 100644 1111111111111111111111111111111111111111 1111111111111111111111111111111111111111 changed-only.txt',
  '1 MM N... 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 both-sides.txt',
  '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 3333333333333333333333333333333333333333 added.txt',
  'u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 merge-me.txt',
  '? fresh.todo',
  '! ignored.log'
].join('\0') + '\0';
const status = parseStatusV2(porcelain);

/** loadWorktree's split, copied from main/git/worktree.js so the two can diverge only loudly. */
function mainSplit(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const item of entries) {
    if (item.kind === 'ignored') continue;
    if (item.kind === 'untracked') { untracked.push(item.path); continue; }
    if (item.kind === 'unmerged') { unstaged.push(item.path); continue; }
    if (item.indexStatus !== '.') staged.push(item.path);
    if (item.worktreeStatus !== '.') unstaged.push(item.path);
  }
  return { staged: staged.sort(), unstaged: unstaged.sort(), untracked: untracked.sort() };
}
const mine = summarizeStatus(status.entries);
const theirs = mainSplit(status.entries);
for (const key of ['staged', 'unstaged', 'untracked']) {
  assert.deepEqual(mine[key].map(file => file.path), theirs[key], `${key} matches loadWorktree`);
}
assert.equal(mine.paths, 6, 'six uncommitted paths, the ignored one excluded');
assert.equal(summaryLabel(mine), '3 staged · 3 changed · 1 untracked');

// The source of truth for that copy: if loadWorktree's rule changes, this file
// has to be revisited rather than quietly drift.
const worktreeSource = await read('main/git/worktree.js');
for (const line of [
  "if (entry.kind === 'ignored') continue;",
  "if (entry.kind === 'untracked') { untracked.push(changeFrom(entry, '?')); continue; }",
  "if (entry.kind === 'unmerged') { unstaged.push(changeFrom(entry, 'U')); continue; }",
  "if (entry.indexStatus !== '.') staged.push(changeFrom(entry, entry.indexStatus));",
  "if (entry.worktreeStatus !== '.') unstaged.push(changeFrom(entry, entry.worktreeStatus));"
]) {
  assert.ok(worktreeSource.includes(line), `loadWorktree still splits with: ${line}`);
}
// The read-only panel renders the patch text; the diff reader has to carry it.
assert.match(worktreeSource, /digest, text: result\.stdout/, 'loadWorktreeDiff carries the raw patch');

// Every class the row and the panel emit is styled, and the row is the band it
// is meant to be rather than one more line of text.
const css = await read('renderer/src/ui/history.css');
for (const name of ['worktree-row', 'worktree-row-icon', 'worktree-row-text', 'worktree-row-chips',
  'worktree-chip', 'chip-staged', 'worktree-panel-actions', 'worktree-panel-conflicts', 'worktree-panel-section',
  'worktree-panel-file', 'worktree-panel-error']) {
  assert.match(css, new RegExp(`\\.${name}\\b`), `history.css styles .${name}`);
}
const band = css.match(/\n\.worktree-row \{([^}]*)\}/)[1];
assert.match(band, /background: var\(--accent-bg\)/, 'the row is tinted, not bare');
assert.match(band, /box-shadow: inset 3px 0 var\(--accent\)/, 'the row carries an accent bar');

const graph = await read('renderer/src/features/graph/CommitGraph.jsx');
assert.match(graph, /export const UNCOMMITTED = 'uncommitted';/);
assert.match(graph, /summaryChips\(summary\)/, 'the row prints the breakdown');
const workspace = await read('renderer/src/features/graph/HistoryWorkspace.jsx');
assert.ok(!/const SCREENS = \[[^\]]*'uncommitted'/.test(workspace),
  'the uncommitted row is a selection, not a screen: it keeps the graph on screen');
assert.match(workspace, /onUncommitted=\{\(\) => choose\(UNCOMMITTED\)\}/);
assert.match(workspace, /<WorktreePanel /, 'the detail pane gets the uncommitted panel');

// Staging from the panel goes through the staging screen's own channels: no new
// IPC, no second Git path for the same job.
const panel = await read('renderer/src/features/worktree/WorktreePanel.jsx');
const screen = await read('renderer/src/features/worktree/WorktreeScreen.jsx');
for (const call of ['stageFile', 'unstageFile', 'stageAll', 'unstageAll']) {
  assert.match(workspace, new RegExp(`window\\.twig\\.${call}\\(`), `the panel stages through window.twig.${call}`);
  assert.match(screen, new RegExp(`window\\.twig\\.${call}\\(`), `the staging screen still uses window.twig.${call}`);
}
assert.ok(!/window\.twig\./.test(panel), 'the panel itself calls no channel: the workspace hands it the actions');
// Direction cannot differ between the two screens: staged moves out, the rest in.
assert.match(panel, /staged: \{ icon: Minus/);
assert.match(panel, /unstaged: \{ icon: Plus/);
assert.match(panel, /untracked: \{ icon: Plus/);
// The two bulk refusals the staging screen makes, made here as well: `git add`
// must not resolve a conflict unseen, and `Unstage all` is a mixed reset, which
// would cancel a merge, rebase, cherry-pick or revert mid-flight.
assert.match(workspace, /const stageAllReason = stageReason\s*\n\s*\|\| \(conflicts \?/);
assert.match(workspace, /const unstageAllReason = stageAllReason\s*\n\s*\|\| \(operation\.kind !== 'none'/);
assert.match(workspace, /unstageFile\(repository\.id, file\.path, Boolean\(repository\.status\?\.branch\?\.unborn\)\)/,
  'unstaging before the first commit needs the unborn flag, as on the staging screen');
// Staging moves no commit and no ref, so it must not reload history and throw
// away what is open; it re-reads the status and the open diff instead.
assert.match(workspace, /await onRepositoryChanged\?\.\(\);\s*\n\s*const open = diffRef\.current;/);

console.log('Worktree-summary checks passed: split parity with loadWorktree, breakdown, guards, CSS and wiring.');
