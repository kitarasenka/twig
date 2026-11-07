import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { modalOpen } from '../../renderer/src/ui/modal-open.js';

const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');

// The built page's font-src is 'self': a small font inlined as data: would be refused.
assert.match(await read('vite.config.js'), /assetsInlineLimit: 0/);

// A dialog owns its heading id: two open at once used to share one.
const dialog = await read('renderer/src/ui/Dialog.jsx');
assert.match(dialog, /useId\(\)/);
assert.doesNotMatch(dialog, /id="dialog-title"/);
// Esc goes through `onClose` at the key, so a parent can keep the dialog with a question.
assert.match(dialog, /event\.key === 'Escape' && !event\.defaultPrevented/);

// A dialog with a field to type in opens in the field, not on its close button.
for (const [file, field] of [
  ['renderer/src/features/ops/dialogs.jsx', /<input id="ref-name" data-autofocus/],
  ['renderer/src/features/ops/dialogs.jsx', /<textarea id="reword-message" data-autofocus/],
  ['renderer/src/features/tools/WorktreeDialog.jsx', /<input id="worktree-agent-name" data-autofocus/],
  ['renderer/src/features/tools/WorktreeDialog.jsx', /<input id="worktree-new-branch" data-autofocus/],
  ['renderer/src/features/settings/CloneRepository.jsx', /autoFocus data-autofocus/],
  ['renderer/src/features/proposal/CommitProposalDialog.jsx', /<textarea id="proposal-message"[^>]*data-autofocus/]
]) assert.match(await read(file), field, file);
assert.doesNotMatch(await read('renderer/src/features/proposal/CommitProposalDialog.jsx'), /<textarea[^>]*\sautoFocus/,
  'autoFocus runs before showModal() and is lost');

// App's shortcuts stop at any modal surface, whichever component opened it.
assert.equal((await read('renderer/src/app/App.jsx')).match(/modalOpen\(\)/g).length, 2);
{
  const root = open => ({ querySelector: selector => (open && selector.includes('dialog[open]') ? {} : null) });
  assert.equal(modalOpen(root(true)), true);
  assert.equal(modalOpen(root(false)), false);
}

// A disabled quiet trash stays quieter than the enabled ones beside it.
assert.match(await read('renderer/src/ui/ops.css'), /\.danger\.quiet:disabled \{ border-color: transparent; \}/);

// Whole sentences in the source: a noun pasted into "{0} copied." takes the wrong gender.
const workspace = await read('renderer/src/features/graph/HistoryWorkspace.jsx');
assert.doesNotMatch(workspace, /\$\{tr\(what\)\} copied/);
assert.doesNotMatch(await read('renderer/src/features/automations/ExecutionPanel.jsx'), /label\.toLowerCase\(\)/, 'a German noun keeps its capital');
assert.doesNotMatch(workspace, /commit after them are replayed/);

// Messages from main that reach the window are marked, so the renderer can translate them.
for (const [file, message] of [
  ['main/automations-ipc.js', 'This repository has no automations to enable.'],
  ['main/history-ops-ipc.js', 'This file holds no commits; apply it to the files instead.'],
  ['main/git/discard-plan.js', 'Nothing to delete'],
  ['main/git/drop-plan.js', 'This action is not available for these endpoints'],
  ['main/git/blame.js', 'Reverse blame needs a non-empty range'],
  ['main/git/blame.js', 'The last line comes before the first']
]) assert.ok((await read(file)).includes(`ui\`${message}\``), `${file}: ${message}`);

// A screen has one heading, and it is the screen's: the graph's goes away with the graph.
// So does a view in the centre, whose heading then carries the way to the details panel.
assert.match(workspace, /\{!screen && !centreView && <header className="graph-heading">/);
assert.match(workspace, /const centreView = Boolean\(diff \|\| fileHistory \|\| blame \|\| conflict\);/);
assert.equal(workspace.match(/detailButton=\{detailButton\}/g).length, 3, 'the diff, file history and blame headings can open the details panel');
for (const file of ['features/refs/RefsScreen.jsx', 'features/stash/StashScreen.jsx', 'features/reflog/ReflogScreen.jsx', 'features/tools/WorktreesScreen.jsx',
  'features/tools/SubmodulesScreen.jsx', 'features/tools/MaintenanceScreen.jsx', 'features/automations/AutomationsScreen.jsx', 'features/worktree/WorktreeScreen.jsx']) {
  assert.match(await read(`renderer/src/${file}`), /<ScreenTitle /, file);
}
assert.equal(workspace.match(/aria-current=\{screen === '/g).length, 7, 'every sidebar screen says it is the current one');

console.log('ui-polish checks passed: inlined assets, dialog focus and ids, modal shortcuts, whole sentences, marked messages, one heading per screen.');
