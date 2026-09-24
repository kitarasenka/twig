import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  EDITOR_PRESETS, applicationName, editorLabel, findEditorExecutable, isLaunchable, normalizeEditorSettings,
  planOpen, resolveRepositoryFile, validPreset
} from '../../main/editor.js';
import { EditorStore } from '../../main/editor-store.js';
import { absolutePath, buildFileMenu, fileManagerName } from '../../renderer/src/features/diff/file-menu.js';
import { buildRefMenu, buildSectionMenu } from '../../renderer/src/features/refs/ref-menu.js';
import { buildCommitMenu, refActionItems } from '../../renderer/src/features/ops/commit-menu.js';

const A = '82df62445b05a04be53291bb36b5db80e46dad77';
const B = 'ebb6e9d3dec115ba8b429d3b143db9d27777a083';
const keys = items => items.filter(item => !item.separator).map(item => item.key);
const byKey = (items, key) => items.find(item => item.key === key);
const recorder = () => {
  const calls = [];
  return { calls, handlers: new Proxy({}, { get: (_target, name) => (name === 'moveReason' ? undefined : (...args) => calls.push([name, ...args])) }) };
};

// --- editor settings ---------------------------------------------------------
assert.deepEqual(normalizeEditorSettings(null), { preset: 'system', customPath: null });
assert.deepEqual(normalizeEditorSettings({ preset: 'vscode' }), { preset: 'vscode', customPath: null });
assert.deepEqual(normalizeEditorSettings({ preset: 'rm -rf' }), { preset: 'system', customPath: null }, 'unknown preset falls back');
assert.deepEqual(normalizeEditorSettings({ preset: 'custom', customPath: 'relative/app' }), { preset: 'system', customPath: null },
  'a custom editor without an absolute path is no editor at all');
assert.deepEqual(normalizeEditorSettings({ preset: 'custom', customPath: '/Applications/Nova.app' }), { preset: 'custom', customPath: '/Applications/Nova.app' });
assert.deepEqual(normalizeEditorSettings({ preset: 'custom', customPath: 'C:\\Tools\\notepad++.exe' }).preset, 'custom');
assert.equal(normalizeEditorSettings({ preset: 'custom', customPath: '/bin/x\0y' }).preset, 'system', 'NUL in the path is refused');
assert.equal(validPreset('zed'), true);
assert.equal(validPreset('../../bin/sh'), false);
assert.equal(validPreset(42), false);
assert.equal(editorLabel({ preset: 'sublime' }), 'Sublime Text');
assert.equal(editorLabel({ preset: 'custom', customPath: '/Applications/Nova.app' }), 'Nova');
assert.equal(applicationName('C:\\Program Files\\Notepad++\\notepad++.exe'), 'notepad++');
assert.equal(EDITOR_PRESETS[0].id, 'system', 'System default is the first choice');
assert.equal(EDITOR_PRESETS.at(-1).id, 'custom', 'Other application… is the last choice');

// --- paths stay inside the working tree ---------------------------------------
assert.equal(resolveRepositoryFile('/repo', 'src/a b.js'), '/repo/src/a b.js');
assert.equal(resolveRepositoryFile('C:\\repo', 'src/a.js', path.win32), 'C:\\repo\\src\\a.js');
for (const bad of ['../etc/passwd', 'src/../../x', '/etc/passwd', '', 'a\0b', 42]) {
  assert.throws(() => resolveRepositoryFile('/repo', bad), TypeError, String(bad));
}
assert.throws(() => resolveRepositoryFile('C:\\repo', 'D:\\secret.txt', path.win32), TypeError, 'a drive letter leaves the tree');

// --- how a file is opened -------------------------------------------------------
const file = '/repo/src/app.js';
assert.deepEqual(planOpen({ settings: { preset: 'system' }, file, platform: 'darwin' }),
  { kind: 'spawn', executable: 'open', args: ['-t', file], wait: true }, 'macOS system default is the default TEXT editor, never "run"');
assert.deepEqual(planOpen({ settings: { preset: 'system' }, file: '/repo/run.command', platform: 'darwin' }).args, ['-t', '/repo/run.command']);
assert.equal(planOpen({ settings: { preset: 'system' }, file: '/repo/notes.md', platform: 'linux' }).kind, 'shell');
for (const [name, platform] of [['setup.exe', 'win32'], ['install.BAT', 'win32'], ['go.ps1', 'win32'], ['x.lnk', 'win32'],
  ['app.desktop', 'linux'], ['Tool.AppImage', 'linux'], ['build.sh', 'linux']]) {
  const plan = planOpen({ settings: { preset: 'system' }, file: `/repo/${name}`, platform });
  assert.equal(plan.kind, 'refused', name);
  assert.equal(plan.reason, 'launchable', name);
}
assert.equal(planOpen({ settings: { preset: 'system' }, file: '/repo/script', platform: 'linux', executableBit: true }).kind, 'refused',
  'an executable bit means "run me" on Linux');
assert.equal(planOpen({ settings: { preset: 'system' }, file: 'C:\\repo\\script', platform: 'win32', executableBit: true }).kind, 'shell');
assert.equal(isLaunchable('/repo/readme.md'), false);
assert.equal(isLaunchable('/repo/.bashrc'), false, 'a dotfile has no extension');

assert.deepEqual(planOpen({ settings: { preset: 'vscode' }, file, platform: 'darwin' }),
  { kind: 'spawn', executable: 'open', args: ['-a', 'Visual Studio Code', file], wait: true });
assert.deepEqual(planOpen({ settings: { preset: 'custom', customPath: '/Applications/Nova.app' }, file, platform: 'darwin' }).args,
  ['-a', '/Applications/Nova.app', file]);
assert.deepEqual(planOpen({ settings: { preset: 'custom', customPath: '/opt/kate/bin/kate' }, file, platform: 'linux' }),
  { kind: 'spawn', executable: '/opt/kate/bin/kate', args: [file], wait: false });
// Editors are opened with the file only — even an editor chosen for a program file opens it as text.
assert.equal(planOpen({ settings: { preset: 'vscode' }, file: '/repo/setup.exe', platform: 'darwin' }).kind, 'spawn');

const onDisk = set => candidate => set.has(candidate);
assert.deepEqual(planOpen({ settings: { preset: 'zed' }, file, platform: 'linux', pathString: '/usr/bin:/home/me/.local/bin',
  exists: onDisk(new Set(['/home/me/.local/bin/zed'])) }), { kind: 'spawn', executable: '/home/me/.local/bin/zed', args: [file], wait: false });
const missing = planOpen({ settings: { preset: 'cursor' }, file, platform: 'linux', pathString: '/usr/bin', exists: () => false });
assert.equal(missing.kind, 'refused');
assert.match(missing.message, /Cursor was not found on PATH \(cursor\)/);
// Windows: a `.cmd` shim cannot run without a shell, so the real `.exe` next to it is used.
const vscode = EDITOR_PRESETS.find(preset => preset.id === 'vscode');
assert.equal(findEditorExecutable(vscode, { platform: 'win32', pathString: 'C:\\Windows;C:\\VS Code\\bin',
  exists: onDisk(new Set(['C:\\VS Code\\bin\\code.cmd', 'C:\\VS Code\\Code.exe'])) }), 'C:\\VS Code\\Code.exe');
assert.equal(findEditorExecutable(vscode, { platform: 'win32', pathString: 'C:\\VS Code\\bin',
  exists: onDisk(new Set(['C:\\VS Code\\bin\\code.cmd'])) }), null, 'a lone .cmd is never run');
assert.equal(findEditorExecutable(EDITOR_PRESETS.find(preset => preset.id === 'sublime'), { platform: 'win32', pathString: 'C:\\ST',
  exists: onDisk(new Set(['C:\\ST\\subl.exe'])) }), 'C:\\ST\\subl.exe');

// --- the store ----------------------------------------------------------------------
const directory = await mkdtemp(path.join(os.tmpdir(), 'twig-editor-'));
try {
  const store = new EditorStore(directory);
  assert.deepEqual(await store.load(), { preset: 'system', customPath: null }, 'no file means System default');
  await store.save({ preset: 'custom', customPath: '/Applications/Nova.app' });
  assert.deepEqual(await new EditorStore(directory).load(), { preset: 'custom', customPath: '/Applications/Nova.app' }, 'survives a restart');
  await store.save({ preset: 'nonsense', customPath: 7 });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'editor.json'), 'utf8')), { preset: 'system', customPath: null },
    'what is written is always a valid setting');
  await writeFile(path.join(directory, 'editor.json'), '{ torn', 'utf8');
  assert.deepEqual(await new EditorStore(directory).load(), { preset: 'system', customPath: null }, 'a torn file does not stop the app');
} finally { await rm(directory, { recursive: true, force: true }); }

// --- file menu ------------------------------------------------------------------------
assert.equal(fileManagerName('darwin'), 'Finder');
assert.equal(fileManagerName('win32'), 'Explorer');
assert.equal(fileManagerName('linux'), 'file manager');
assert.equal(absolutePath('/Users/me/repo', 'src/a.js'), '/Users/me/repo/src/a.js');
assert.equal(absolutePath('/Users/me/repo/', 'a.js'), '/Users/me/repo/a.js');
assert.equal(absolutePath('C:\\work\\repo', 'src/a.js'), 'C:\\work\\repo\\src\\a.js');
assert.equal(absolutePath('\\\\server\\share\\repo', 'a/b.txt'), '\\\\server\\share\\repo\\a\\b.txt');

{
  const { calls, handlers } = recorder();
  const items = buildFileMenu({ path: 'src/app.js', platform: 'darwin', editor: 'Zed', blameOid: A, handlers });
  assert.deepEqual(keys(items), ['open-editor', 'reveal', 'copy-path', 'copy-full-path', 'file-history', 'blame']);
  assert.equal(byKey(items, 'open-editor').text, 'Open in Zed');
  assert.equal(byKey(items, 'reveal').text, 'Reveal in Finder');
  for (const item of items.filter(entry => !entry.separator)) item.run();
  assert.deepEqual(calls.map(call => call[0]), ['openInEditor', 'reveal', 'copyPath', 'copyFullPath', 'fileHistory', 'blame']);
  assert.deepEqual(calls.at(-1), ['blame', 'src/app.js', A], 'blame reads the committed version the row belongs to');
}
assert.equal(byKey(buildFileMenu({ path: 'a', platform: 'win32', handlers: {} }), 'reveal').text, 'Show in Explorer');
assert.equal(byKey(buildFileMenu({ path: 'a', platform: 'linux', handlers: {} }), 'reveal').text, 'Show in file manager');
assert.equal(byKey(buildFileMenu({ path: 'a', platform: 'linux', editor: 'System default', handlers: {} }), 'open-editor').text, 'Open in default editor');
assert.equal(byKey(buildFileMenu({ path: 'a', platform: 'linux', blameOid: null, handlers: {} }), 'blame').reason, 'Select a committed version first');
{
  const untracked = buildFileMenu({ path: 'new.txt', platform: 'darwin', tracked: false, move: 'stage', handlers: {} });
  assert.deepEqual(keys(untracked), ['open-editor', 'reveal', 'copy-path', 'copy-full-path', 'stage'], 'no history for a file Git never recorded');
  const staged = buildFileMenu({ path: 'a.js', platform: 'darwin', move: 'unstage', blameOid: B, handlers: { moveReason: 'Git is working' } });
  assert.equal(byKey(staged, 'unstage').reason, 'Git is working');
}

{
  // Discard sits under the staging move, is marked destructive, and names what it does.
  const changes = buildFileMenu({ path: 'a.txt', platform: 'darwin', move: 'stage', discard: 'changes', handlers: {} });
  assert.deepEqual(keys(changes).slice(4, 6), ['stage', 'discard']);
  assert.equal(byKey(changes, 'discard').text, 'Discard changes…');
  assert.equal(byKey(changes, 'discard').danger, true);
  assert.equal(byKey(buildFileMenu({ path: 'n.txt', platform: 'darwin', tracked: false, move: 'stage', discard: 'untracked', handlers: {} }), 'discard').text, 'Delete file…');
  assert.equal(byKey(buildFileMenu({ path: 'build/', platform: 'darwin', tracked: false, move: 'stage', discard: 'untracked', handlers: {} }), 'discard').text, 'Delete folder…');
  assert.equal(byKey(buildFileMenu({ path: 'a.txt', platform: 'darwin', move: 'unstage', handlers: {} }), 'discard'), undefined, 'staged work has no discard');
  assert.equal(byKey(buildFileMenu({ path: 'a.txt', platform: 'darwin', discard: 'changes', handlers: { discardReason: 'Resolve the conflict first' } }), 'discard').reason,
    'Resolve the conflict first');
}

// --- sidebar ref menu -------------------------------------------------------------------
const head = { branch: 'main', oid: A, detached: false };
const main = { type: 'local', name: 'main', fullName: 'refs/heads/main', target: A };
const feature = { type: 'local', name: 'feature/x', fullName: 'refs/heads/feature/x', target: B };
const remote = { type: 'remote', name: 'origin/feature/x', fullName: 'refs/remotes/origin/feature/x', target: B };
const tag = { type: 'tag', name: 'v1.0', fullName: 'refs/tags/v1.0', target: B };
{
  const items = buildRefMenu({ ref: feature, head, remotes: ['origin'], handlers: {} });
  assert.deepEqual(keys(items), ['show', 'checkout', 'ref-rename-refs/heads/feature/x', 'merge', 'merge-noff', 'rebase', 'compare',
    'branch-from', 'tag-at', 'ref-upstream-refs/heads/feature/x', 'ref-publish-refs/heads/feature/x-origin',
    'ref-delete-refs/heads/feature/x', 'copy-name', 'copy-sha']);
  assert.ok(items.filter(item => !item.separator).every(item => !item.reason), 'everything applies to another branch');
  assert.equal(byKey(items, 'merge').text, 'Merge feature/x into main');
  assert.equal(byKey(items, 'rebase').text, 'Rebase main onto feature/x');
  // Rename sits right under Check out and names its shortcut; it appears once.
  const rename = byKey(items, 'ref-rename-refs/heads/feature/x');
  assert.equal(rename.text, 'Rename feature/x…');
  assert.equal(rename.hint, 'F2');
  assert.equal(items.filter(item => item.key === 'ref-rename-refs/heads/feature/x').length, 1);
}
{
  const { calls, handlers } = recorder();
  byKey(buildRefMenu({ ref: main, head, handlers }), 'ref-rename-refs/heads/main').run();
  assert.deepEqual(calls, [['renameBranch', 'main']], 'the checked-out branch can be renamed too');
  assert.equal(byKey(buildRefMenu({ ref: main, head, operation: { kind: 'rebase' }, handlers: {} }), 'ref-rename-refs/heads/main').reason,
    'Finish or abort the rebase first');
  assert.equal(keys(buildRefMenu({ ref: remote, head, remotes: ['origin'], handlers: {} })).some(key => key.startsWith('ref-rename-')), false,
    'a remote branch has no rename: Git cannot rename a ref on the server');
}
{
  const items = buildRefMenu({ ref: main, head, remotes: [], handlers: {} });
  assert.equal(byKey(items, 'checkout').reason, 'Already checked out');
  assert.equal(byKey(items, 'merge').reason, 'This is the current branch');
  assert.equal(byKey(items, 'rebase').reason, 'This is the current branch');
  assert.equal(byKey(items, 'compare').reason, 'main and main are the same commit');
  assert.equal(byKey(items, 'ref-delete-refs/heads/main').reason, 'A checked-out branch cannot be deleted');
  assert.equal(items.some(item => item.key?.startsWith('ref-publish-')), false, 'no publish without a remote');
}
{
  const items = buildRefMenu({ ref: remote, head, remotes: ['origin'], handlers: {} });
  assert.deepEqual(keys(items), ['show', 'merge', 'merge-noff', 'rebase', 'compare',
    'ref-checkout-remote-refs/remotes/origin/feature/x', 'ref-delete-remote-refs/remotes/origin/feature/x', 'copy-name', 'copy-sha']);
}
{
  const items = buildRefMenu({ ref: tag, head, remotes: ['origin', 'fork'], handlers: {} });
  assert.deepEqual(keys(items), ['show', 'checkout', 'compare', 'branch-from',
    'ref-tag-publish-refs/tags/v1.0-origin', 'ref-tag-publish-refs/tags/v1.0-fork', 'ref-tag-delete-refs/tags/v1.0',
    'ref-tag-delete-remote-refs/tags/v1.0-origin', 'ref-tag-delete-remote-refs/tags/v1.0-fork', 'copy-name', 'copy-sha']);
  assert.equal(byKey(items, 'checkout').text, 'Check out v1.0 (detached)');
  assert.equal(byKey(items, 'copy-name').text, 'Copy tag name');
  assert.equal(byKey(buildRefMenu({ ref: tag, head: { oid: B, detached: true }, handlers: {} }), 'checkout').reason, 'Already checked out');
}
{
  // Mid-merge Git refuses everything that writes; reading and copying still work.
  const items = buildRefMenu({ ref: feature, head, remotes: ['origin'], operation: { kind: 'merge' }, handlers: {} });
  for (const key of ['checkout', 'merge', 'rebase', 'branch-from', 'ref-rename-refs/heads/feature/x', 'ref-delete-refs/heads/feature/x']) {
    assert.equal(byKey(items, key).reason, 'Finish or abort the merge first', key);
  }
  for (const key of ['show', 'compare', 'copy-name', 'copy-sha']) assert.equal(byKey(items, key).reason, undefined, key);
}
{
  const unborn = buildRefMenu({ ref: feature, head: { branch: 'main', oid: null }, handlers: {} });
  assert.equal(byKey(unborn, 'merge').reason, 'Nothing is checked out yet');
  assert.equal(byKey(unborn, 'compare').reason, 'Nothing is checked out yet');
}
{
  const { calls, handlers } = recorder();
  const items = buildRefMenu({ ref: feature, head, remotes: ['origin'], handlers });
  for (const key of ['show', 'checkout', 'merge-noff', 'rebase', 'compare', 'branch-from', 'copy-name', 'copy-sha']) byKey(items, key).run();
  assert.deepEqual(calls, [['show', feature], ['checkoutBranch', 'feature/x'], ['merge', 'feature/x', true], ['rebaseOnto', feature],
    ['compare', feature], ['createBranchFrom', feature], ['copy', 'feature/x', 'Branch name'], ['copy', B, 'SHA']]);
}
// The sidebar and the commit menu offer the very same management items for a ref.
{
  const shared = refActionItems({ ref: feature, remotes: ['origin'], head, handlers: {} }).map(item => item.key);
  const commitItems = keys(buildCommitMenu({ commit: { oid: B, parents: [A] }, refs: [feature], remotes: ['origin'], head, handlers: {} }));
  const sidebarItems = keys(buildRefMenu({ ref: feature, head, remotes: ['origin'], handlers: {} }));
  for (const key of shared) {
    assert.ok(commitItems.includes(key), `commit menu has ${key}`);
    assert.ok(sidebarItems.includes(key), `sidebar menu has ${key}`);
  }
}

// --- sidebar section headers ---------------------------------------------------------------
assert.deepEqual(keys(buildSectionMenu({ type: 'local', head, handlers: {} })), ['new-branch', 'manage']);
assert.equal(byKey(buildSectionMenu({ type: 'local', head, handlers: {} }), 'new-branch').text, 'Create branch at main…');
assert.deepEqual(keys(buildSectionMenu({ type: 'tag', head, handlers: {} })), ['new-tag', 'manage']);
assert.equal(byKey(buildSectionMenu({ type: 'remote', head, remotes: [], handlers: {} }), 'fetch').reason, 'No remote is configured');
assert.equal(byKey(buildSectionMenu({ type: 'remote', head, remotes: ['origin'], handlers: {} }), 'fetch').reason, undefined);
assert.equal(byKey(buildSectionMenu({ type: 'local', head: { oid: null }, handlers: {} }), 'new-branch').reason, 'Nothing is checked out yet');
assert.equal(byKey(buildSectionMenu({ type: 'tag', head, operation: { kind: 'rebase' }, handlers: {} }), 'new-tag').reason,
  'Finish or abort the rebase first');

// --- rename dialog starts on the current name ------------------------------------------------
{
  const workspace = readFileSync(new URL('../../renderer/src/features/graph/HistoryWorkspace.jsx', import.meta.url), 'utf8');
  const refsScreen = readFileSync(new URL('../../renderer/src/features/refs/RefsScreen.jsx', import.meta.url), 'utf8');
  const dialogs = readFileSync(new URL('../../renderer/src/features/ops/dialogs.jsx', import.meta.url), 'utf8');
  for (const [name, source] of [['HistoryWorkspace', workspace], ['RefsScreen', refsScreen]]) {
    assert.match(source, /title: `Rename \$\{name\}`.*initialValue: name/, `${name} prefills the rename dialog`);
  }
  assert.match(dialogs, /useState\(initialValue\)/);
  assert.match(dialogs, /'That is the current name'/, 'an unchanged name is refused');
  assert.match(workspace, /event\.key === 'F2' && ref\.type === 'local'/, 'F2 renames a local branch in the sidebar');
}

// --- wiring parity -----------------------------------------------------------------------------
// The bridge names the renderer calls exist in preload, and the channels behind
// them are the ones main registers — a renamed channel must fail here, not in a menu.
const preload = readFileSync(new URL('../../preload/index.js', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../../main/files-ipc.js', import.meta.url), 'utf8');
for (const [bridge, channel] of [['getEditor', 'editor:get'], ['setEditor', 'editor:set'], ['openInEditor', 'file:open'], ['revealFile', 'file:reveal']]) {
  assert.match(preload, new RegExp(`${bridge}: .*'${channel}'`), bridge);
  assert.match(ipc, new RegExp(`ipcMain\\.handle\\('${channel}'`), channel);
}
assert.doesNotMatch(ipc, /shell:\s*true/, 'the editor never runs through a shell');
assert.match(ipc, /shell:\s*false/);

console.log('Context menu checks passed.');
