import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, realpath, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';
import { loadHistoryPage } from '../main/git/history.js';
import { loadRefs } from '../main/git/refs.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-history-smoke-'));
let app;
try {
  const cwd = path.join(root, 'history-fixture'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, env = null) => {
    const result = await runGit({ cwd, log, argv, env });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.replace(/\n$/, '');
  };
  // Backdated commits give the age ramp something to colour: roots from years
  // ago, a linear history from months ago, a tip committed today.
  const at = (date) => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const ancient = at('2019-03-04T10:00:00+00:00');
  const recent = at(new Date(Date.now() - 45 * 86400000).toISOString());
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'hello.txt'), 'Hello Twig\r\n');
  await writeFile(path.join(cwd, 'old [name].txt'), 'Rename history content\n');
  await git(['add', '--', 'hello.txt', 'old [name].txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Root fixture'], ancient);
  const initial = await git(['rev-parse', 'HEAD']);
  const tree = await git(['rev-parse', 'HEAD^{tree}']);
  const feature = await git(['commit-tree', tree, '-p', initial, '-m', 'Feature branch'], ancient);
  await git(['update-ref', 'refs/heads/feat/graph/curves', feature]);
  let parent = await git(['commit-tree', tree, '-p', initial, '-p', feature, '-m', 'Merge feature branch'], ancient);
  for (let i = 0; i < 255; i++) parent = await git(['commit-tree', tree, '-p', parent, '-m', `History fixture ${i}`], recent);
  await git(['update-ref', 'refs/heads/main', parent]);
  await writeFile(path.join(cwd, 'hello.txt'), 'Hello real history\r\n');
  await git(['mv', '--', 'old [name].txt', 'renamed.txt']);
  await git(['add', '--', 'hello.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Real history 🌱', '-m', 'Full body\nWith another line.']);
  const tip = await git(['rev-parse', 'HEAD']);
  await git(['-c', 'tag.gpgsign=false', 'tag', '-a', 'v-test', '-m', 'Annotated tag']);
  // More refs than fit on one line of the Branch / tag column: the graph has to
  // wrap them, not hide the names behind a count.
  for (const name of ['release/2026-09', 'hotfix/fontconfig']) await git(['branch', name, tip]);
  await writeFile(path.join(cwd, 'untracked.txt'), 'Pending changes\n');
  const page1 = await loadHistoryPage({ cwd, log, limit: 250 });
  const page2 = await loadHistoryPage({ cwd, log, limit: 250, skip: page1.nextSkip });
  assert.equal(page1.commits[0].oid, tip);
  assert.equal(page2.nextSkip, null);
  assert.ok(page2.commits.some(commit => commit.parents.length === 2));
  assert.equal((await loadRefs({ cwd, log })).find(ref => ref.name === 'v-test').target, tip);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await list.waitFor();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  await page.locator('.console-status').click();
  assert.ok(await list.getByRole('option').count() < 60);
  // Wrapped refs: every ref on the tip is named, the badges sit on more than one
  // line, and the row is taller than a plain one so nothing is clipped.
  const tipRow = list.getByRole('option').first();
  await tipRow.locator('.ref-badge').first().waitFor();
  const tipNames = await tipRow.locator('.ref-badge > span').allTextContents();
  for (const name of ['main', 'v-test', 'release/2026-09', 'hotfix/fontconfig']) {
    assert.ok(tipNames.includes(name), `${name} is named in the graph, not folded into a count`);
  }
  assert.equal(await tipRow.getByText(/^\+\d+$/).count(), 0, 'no "+N" stub is left');
  assert.ok(await tipRow.locator('.ref-line').count() > 1, 'the badges wrap onto several lines');
  const tipBox = await tipRow.boundingBox();
  const plainBox = await list.getByRole('option').nth(1).boundingBox();
  assert.ok(tipBox.height > plainBox.height, `the wrapped row grew: ${tipBox.height} > ${plainBox.height}`);
  assert.ok(Math.abs(plainBox.y - (tipBox.y + tipBox.height)) < 1, 'the next row starts below it, without overlap');
  for (const badge of await tipRow.locator('.ref-badge').all()) {
    const box = await badge.boundingBox();
    assert.ok(box.y >= tipBox.y - 0.5 && box.y + box.height <= tipBox.y + tipBox.height + 0.5, 'every badge stays inside its row');
  }
  await page.getByRole('button', { name: 'Modified hello.txt', exact: true }).click();
  await page.getByRole('region', { name: 'File diff' }).waitFor().catch(() => {});
  await page.getByText('+Hello real history', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  // File history: the changed-file context menu lists every commit that touched
  // it. hello.txt changed twice — once at the root, once at the tip.
  await page.getByRole('button', { name: 'Modified hello.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'File history' }).click();
  const fileHistory = page.getByRole('region', { name: 'File history', exact: true });
  await fileHistory.getByRole('listitem').first().waitFor();
  assert.equal(await fileHistory.getByRole('listitem').count(), 2);
  await fileHistory.getByRole('listitem').first().getByRole('button').click();
  const fileDiff = page.getByRole('region', { name: 'File diff', exact: true });
  await fileDiff.getByText('+Hello real history', { exact: true }).waitFor();
  assert.ok(await fileHistory.isVisible());
  assert.equal(await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).count(), 0);
  await fileHistory.getByRole('listitem').last().getByRole('button').focus();
  await page.keyboard.press('Enter');
  await fileDiff.getByText('+Hello Twig', { exact: true }).waitFor();
  assert.equal(await fileDiff.getByText('+Hello real history', { exact: true }).count(), 0);
  assert.equal(await fileDiff.getByText('+Rename history content', { exact: true }).count(), 0);
  assert.equal(await fileHistory.getByRole('button', { pressed: true }).count(), 1);
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  assert.ok(await fileHistory.isVisible());
  await fileHistory.getByRole('listitem').first().getByRole('button').click();
  await fileDiff.getByText('+Hello real history', { exact: true }).waitFor();
  // The tip edits hello.txt in place: the diff marks only the characters that
  // changed, not the whole line.
  assert.ok(await fileDiff.locator('.diff-seg-add').count() > 0, 'added characters are highlighted inside the line');
  assert.ok(await fileDiff.locator('.diff-seg-del').count() > 0, 'removed characters are highlighted inside the line');
  // Every line of the diff is numbered on the side it belongs to: a removed
  // line on the old side only, an added one on the new side only.
  const removedRow = fileDiff.locator('.diff-deleted').first();
  const addedRow = fileDiff.locator('.diff-added').first();
  assert.match(await removedRow.locator('.diff-line-old').innerText(), /^\d+$/, 'the removed line has an old line number');
  assert.equal((await removedRow.locator('.diff-line-new').innerText()).trim(), '', 'the removed line has no new line number');
  assert.match(await addedRow.locator('.diff-line-new').innerText(), /^\d+$/, 'the added line has a new line number');
  assert.equal((await addedRow.locator('.diff-line-old').innerText()).trim(), '', 'the added line has no old line number');
  assert.equal((await fileDiff.locator('.diff-hunk').first().locator('.diff-line-old').innerText()).trim(), '', 'the hunk header itself is not numbered');
  // Word mode folds the edited pair into one line — removed words struck,
  // added words underlined, both line numbers kept — and the choice is shared.
  assert.equal(await fileDiff.locator('.diff-language').textContent(), 'Plain text');
  await fileDiff.getByRole('button', { name: 'Words', exact: true }).click();
  const changedRow = fileDiff.locator('.diff-changed');
  await changedRow.waitFor();
  assert.equal(await changedRow.count(), 1);
  assert.equal(await fileDiff.locator('.diff-deleted, .diff-added').count(), 0, 'the pair is one row now');
  assert.match(await changedRow.locator('.diff-seg-del').first().textContent(), /Twig/);
  assert.match(await changedRow.locator('.diff-seg-add').first().textContent(), /real/);
  assert.match(await changedRow.locator('.diff-line-old').innerText(), /^\d+$/);
  assert.match(await changedRow.locator('.diff-line-new').innerText(), /^\d+$/);
  await fileDiff.getByRole('button', { name: 'Lines', exact: true }).click();
  await fileDiff.locator('.diff-deleted').first().waitFor();
  assert.equal(await fileDiff.locator('.diff-changed').count(), 0);
  await fileDiff.getByRole('button', { name: 'Go to commit', exact: true }).click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  assert.equal(await fileHistory.count(), 0);

  // File menu: open in the editor chosen in Settings, reveal, copy both paths.
  // The "editor" is a script that writes the path it was given, picked through
  // the same native dialog a person would use (stubbed here); the file manager
  // is stubbed too, so nothing outside the test opens.
  const editorOut = path.join(root, 'editor-called-with.txt');
  const fakeEditor = path.join(root, 'fake-editor');
  await writeFile(fakeEditor, `#!/bin/sh\nprintf '%s' "$1" > '${editorOut}'\n`, { mode: 0o755 });
  await app.evaluate(({ dialog, shell }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    globalThis.revealed = [];
    shell.showItemInFolder = target => globalThis.revealed.push(target);
  }, fakeEditor);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const editorSelect = page.getByRole('combobox', { name: /Open files with/ });
  assert.equal(await editorSelect.inputValue(), 'system', 'System default until a person chooses otherwise');
  await editorSelect.selectOption('custom');
  await page.getByText(fakeEditor, { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  const helloRow = page.getByRole('button', { name: 'Modified hello.txt', exact: true });
  await helloRow.click({ button: 'right' });
  const fileActions = page.getByRole('menu', { name: 'Actions for hello.txt' });
  for (const name of ['Open in fake-editor', 'Copy path', 'Copy full path', 'File history', 'Blame history']) {
    // An item's hint is part of its accessible name, so match the start only.
    await fileActions.getByRole('menuitem', { name: new RegExp(`^${name}`) }).waitFor();
  }
  const revealName = process.platform === 'darwin' ? 'Reveal in Finder' : process.platform === 'win32' ? 'Show in Explorer' : 'Show in file manager';
  await fileActions.getByRole('menuitem', { name: /^Open in fake-editor/ }).click();
  await page.getByText('Opened hello.txt in fake-editor.', { exact: true }).waitFor();
  let opened = '';
  for (let i = 0; i < 50 && !opened; i++) { opened = await readFile(editorOut, 'utf8').catch(() => ''); if (!opened) await new Promise(r => setTimeout(r, 100)); }
  assert.equal(await realpath(opened), await realpath(path.join(cwd, 'hello.txt')), 'the editor got the working-tree file');
  const fullPath = await page.evaluate(() => window.twig.getWorkspace()).then(workspace => workspace.repositories.find(item => !item.sandbox).path);
  await helloRow.click({ button: 'right' });
  await fileActions.getByRole('menuitem', { name: revealName, exact: true }).click();
  assert.deepEqual(await app.evaluate(() => globalThis.revealed), [path.join(fullPath, 'hello.txt')]);
  await helloRow.focus();
  await page.keyboard.press('Shift+F10');
  await fileActions.getByRole('menuitem', { name: /^Copy path/ }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'hello.txt');
  await helloRow.click({ button: 'right' });
  await fileActions.getByRole('menuitem', { name: 'Copy full path', exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), path.join(fullPath, 'hello.txt'));
  // Main resolves the path itself: a file gone from the tree is a reason, a
  // path out of the tree is not a request at all.
  const fixtureId = await page.evaluate(() => window.twig.getWorkspace()).then(workspace => workspace.repositories.find(item => !item.sandbox).id);
  const gone = await page.evaluate(id => window.twig.openInEditor(id, 'old [name].txt'), fixtureId);
  assert.equal(gone.reason, 'missing');
  for (const bad of [['../outside.txt'], ['/etc/hosts'], ['a\0b']]) {
    await assert.rejects(page.evaluate(([id, file]) => window.twig.openInEditor(id, file), [fixtureId, bad[0]]), /Invalid file/, bad[0]);
  }
  await assert.rejects(page.evaluate(() => window.twig.setEditor('/bin/sh')), /Invalid editor/);
  await assert.rejects(page.evaluate(() => window.twig.openInEditor('not-a-repository', 'hello.txt')), /Unknown repository/);

  // Sidebar: every branch, tag and section header has its own context menu.
  const sidebar = page.getByRole('complementary', { name: 'Repository navigation' });
  const curves = sidebar.locator('.real-branch', { hasText: 'curves' });
  await curves.click({ button: 'right' });
  const branchActions = page.getByRole('menu', { name: 'Actions for feat/graph/curves' });
  for (const name of ['Show in history', 'Check out feat/graph/curves', 'Merge feat/graph/curves into main', 'Rebase main onto feat/graph/curves',
    'Compare with main', 'Create branch from feat/graph/curves…', 'Delete feat/graph/curves', 'Copy branch name']) {
    await branchActions.getByRole('menuitem', { name, exact: true }).waitFor();
  }
  // Rename sits right under Check out and names its F2 shortcut.
  const menuNames = await branchActions.getByRole('menuitem').allTextContents();
  assert.equal(menuNames[2], 'Rename feat/graph/curves…F2', 'Rename is the third item, under Check out');
  await page.keyboard.press('Escape');
  // F2 on the focused branch opens the dialog on the current name; the rename is real.
  await curves.focus();
  await page.keyboard.press('F2');
  const renameDialog = page.getByRole('dialog', { name: 'Rename feat/graph/curves' });
  const renameField = renameDialog.getByRole('textbox', { name: 'New branch name' });
  assert.equal(await renameField.inputValue(), 'feat/graph/curves', 'the field starts on the current name');
  assert.ok(await renameDialog.getByRole('button', { name: /^Rename branch/ }).isDisabled(), 'an unchanged name is refused');
  await renameField.fill('feat/graph/arcs');
  await renameDialog.getByRole('button', { name: 'Rename branch', exact: true }).click();
  await page.getByText('Branch feat/graph/curves renamed to feat/graph/arcs.', { exact: true }).waitFor();
  assert.equal(await git(['rev-parse', 'refs/heads/feat/graph/arcs']), feature);
  assert.equal((await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', 'refs/heads/feat/graph/curves'] })).code, 1);
  // And back, through the menu item this time, so the rest of the run finds it.
  const arcs = sidebar.locator('.real-branch', { hasText: 'arcs' });
  await arcs.click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for feat/graph/arcs' }).getByRole('menuitem', { name: /^Rename feat\/graph\/arcs…/ }).click();
  await page.getByRole('dialog', { name: 'Rename feat/graph/arcs' }).getByRole('textbox', { name: 'New branch name' }).fill('feat/graph/curves');
  await page.getByRole('dialog', { name: 'Rename feat/graph/arcs' }).getByRole('button', { name: 'Rename branch', exact: true }).click();
  await page.getByText('Branch feat/graph/arcs renamed to feat/graph/curves.', { exact: true }).waitFor();
  assert.equal(await git(['rev-parse', 'refs/heads/feat/graph/curves']), feature);
  await curves.click({ button: 'right' });
  await branchActions.getByRole('menuitem', { name: 'Copy branch name', exact: true }).click();
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), 'feat/graph/curves');
  await curves.click({ button: 'right' });
  await branchActions.getByRole('menuitem', { name: 'Compare with main', exact: true }).click();
  await page.getByRole('complementary', { name: 'Commit details' }).getByText('COMPARE').waitFor();
  await sidebar.locator('.real-branch', { hasText: /^main/ }).click({ button: 'right' });
  const mainActions = page.getByRole('menu', { name: 'Actions for main' });
  assert.ok(await mainActions.getByRole('menuitem', { name: /^Check out main: Already checked out/ }).isDisabled());
  assert.ok(await mainActions.getByRole('menuitem', { name: /^Delete main: A checked-out branch cannot be deleted/ }).isDisabled());
  await page.keyboard.press('Escape');
  await sidebar.locator('.real-branch', { hasText: 'v-test' }).focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menu', { name: 'Actions for v-test' }).getByRole('menuitem', { name: 'Check out v-test (detached)', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await sidebar.locator('summary', { hasText: 'LOCAL' }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for LOCAL' }).getByRole('menuitem', { name: 'Create branch at main…', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await sidebar.locator('summary', { hasText: 'REMOTE' }).click({ button: 'right' });
  assert.ok(await page.getByRole('menu', { name: 'Actions for REMOTE' }).getByRole('menuitem', { name: /^Fetch: No remote is configured/ }).isDisabled());
  await page.keyboard.press('Escape');
  await list.getByRole('option').first().click();

  await page.getByRole('button', { name: 'Added renamed.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'File history' }).click();
  await fileHistory.getByRole('listitem').last().getByRole('button').click();
  await fileDiff.getByText('+Rename history content', { exact: true }).waitFor();
  assert.equal(await fileDiff.locator('header code').textContent(), 'old [name].txt');
  assert.equal(await fileDiff.getByText('+Hello Twig', { exact: true }).count(), 0);
  await mkdir('artifacts', { recursive: true });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme); await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/file-history-${theme}.png`, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const historyBox = await fileHistory.boundingBox();
    const diffBox = await fileDiff.boundingBox();
    assert.ok(diffBox.x >= historyBox.x + historyBox.width, 'File changes stay beside the history');
  }
  await fileDiff.getByRole('button', { name: 'Go to commit', exact: true }).click();
  await page.getByRole('heading', { name: 'Root fixture', exact: true }).waitFor();
  await page.locator('.real-branch[title^="refs/heads/main"]').click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 920));
  await list.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'History fixture 254', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'history-fixture', exact: true }).click();
  await page.getByRole('heading', { name: 'History fixture 254', exact: true }).waitFor();
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByText('259 loaded', { exact: true }).waitFor();
  await page.getByRole('button', { name: /curves/ }).click();
  await page.getByRole('heading', { name: 'Feature branch', exact: true }).waitFor();
  // The uncommitted row selects instead of navigating: the graph stays on
  // screen and the details panel on the right lists what changed.
  await page.getByRole('button', { name: /Uncommitted changes, 1 files/ }).click();
  const uncommitted = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  await uncommitted.waitFor();
  assert.ok(await list.isVisible(), 'selecting the uncommitted row keeps the graph on screen');
  // The file row and its Stage button are named separately, so the row is
  // addressed by its own class rather than by "some button naming the file".
  await uncommitted.getByRole('region', { name: 'Untracked files', exact: true })
    .locator('.commit-file').filter({ hasText: 'untracked.txt' }).click();
  await page.getByText(/Untracked — Git has no diff/).waitFor();
  // Reading an untracked file must not have tracked it behind our back.
  assert.equal(await git(['status', '--porcelain', '--', 'untracked.txt']), '?? untracked.txt');
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  await uncommitted.getByRole('button', { name: 'Open staging', exact: true }).click();
  await page.getByText(/Working tree · 0 staged, 1 not staged/).waitFor();
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();

  // Local commit marks: a colour and a note kept in userData, drawn over the
  // lane/age colour and surviving a reload. No Git runs for any of this.
  await list.evaluate(node => { node.scrollTop = 0; });
  await page.locator(`#commit-${tip}`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Mark this commit…' }).click();
  await page.getByRole('group', { name: 'Commit mark colour', exact: true }).getByRole('button', { name: 'Red', exact: true }).click();
  await page.waitForFunction(id => document.getElementById(`commit-${id}`)?.classList.contains('mark-red'), tip);
  assert.ok(await page.locator(`#commit-${tip}`).evaluate(node => node.classList.contains('marked')));
  await page.getByLabel('Mark note').fill('regression starts here');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`#commit-${id} .mark-chip`)?.title === 'regression starts here', tip);
  await page.reload();
  await list.waitFor();
  await list.getByRole('option').first().waitFor();
  await list.evaluate(node => { node.scrollTop = 0; });
  await page.waitForFunction(id => document.getElementById(`commit-${id}`)?.classList.contains('mark-red'), tip);
  await page.locator(`#commit-${tip}`).click();
  await page.getByRole('button', { name: 'Remove mark', exact: true }).click();
  await page.waitForFunction(id => !document.getElementById(`commit-${id}`)?.classList.contains('marked'), tip);

  // Global search: one box searches every commit message and hash across all
  // refs — not just the loaded page — and collapses the graph to the matches.
  const search = page.getByRole('textbox', { name: 'Search commits and references' });
  await search.fill('Feature branch');
  await page.getByText(/2 commits match/).waitFor();
  await list.getByRole('option').first().waitFor();
  assert.equal(await list.getByRole('option').count(), 2);
  // A hash prefix resolves to its own commit even though no message holds it.
  await search.fill(tip.slice(0, 12));
  await page.getByText(/1 commit matches/).waitFor();
  await list.getByRole('option').first().click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  // Search in other places: a changed path, the author, the code itself.
  const searchIn = page.getByRole('combobox', { name: 'Search in' });
  await searchIn.selectOption('file');
  await search.fill('renamed');
  await page.getByText('1 commit matches “renamed” in the changed file path', { exact: true }).waitFor();
  await searchIn.selectOption('author');
  await search.fill('fixture');
  await page.getByText('200+ commits match “fixture” in the author', { exact: true }).waitFor();
  assert.ok(await page.getByRole('complementary', { name: 'Repository navigation' }).locator('.real-branch', { hasText: /^main/ }).count() > 0,
    'an author query does not filter branch names in the sidebar');
  await searchIn.selectOption('content');
  await search.fill('real history');
  await page.getByText('1 commit matches “real history” in the added or removed code', { exact: true }).waitFor();
  await list.getByRole('option').first().click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  await searchIn.selectOption('regex');
  await search.fill('Hello [');
  await page.getByText(/^Git cannot use that pattern: /).first().waitFor();
  await searchIn.selectOption('message');
  await page.getByRole('button', { name: 'Clear search results', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.search-results'));
  assert.equal(await search.inputValue(), '');

  // Console command bar: a read-only command runs and joins the journal; a
  // mutating one is refused in place and never reaches git; ↑ recalls history.
  const consoleInput = page.getByRole('textbox', { name: 'Run a read-only git command' });
  if (await consoleInput.count() === 0) await page.locator('.console-status').click();
  await consoleInput.fill('log --oneline -3');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('article').filter({ hasText: 'log --oneline -3' }).first().waitFor();
  // The entry is journalled the moment git starts; the field clears when the
  // call returns, so wait for that rather than racing it.
  await page.waitForFunction(() => document.querySelector('.console-command')?.value === '');
  await consoleInput.fill('commit -m nope');
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'not an allowed read-only git command' }).waitFor();
  assert.equal(await page.getByRole('article').filter({ hasText: 'git commit -m nope' }).count(), 0);
  await consoleInput.press('ArrowUp');
  assert.equal(await consoleInput.inputValue(), 'log --oneline -3');

  // "My" keeps the command that was typed and drops the reads 🌱 Twig runs to
  // draw the graph; Full History holds both.
  const graphRead = page.getByRole('article').filter({ hasText: '--topo-order' });
  await page.getByRole('button', { name: 'My', exact: true }).click();
  assert.equal(await graphRead.count(), 0, 'reading the history is not one of my actions');
  await page.getByRole('button', { name: 'Full History', exact: true }).click();
  await graphRead.first().waitFor();
  await page.getByRole('button', { name: 'My', exact: true }).click();
  await page.getByRole('article').filter({ hasText: 'log --oneline -3' }).first().waitFor();

  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const results = await Promise.allSettled([
      window.twig.getHistoryPage(id, -1, 250), window.twig.getHistoryPage('unregistered', 0, 250),
      window.twig.getCommit(id, '--help'), window.twig.getFileDiff(id, 'a'.repeat(40), '../escape'),
      window.twig.getFileHistory(id, '../escape'), window.twig.getFileHistory(id, '/etc/passwd'),
      window.twig.setMark(id, 'not-an-oid', 'red', ''), window.twig.setMark(id, 'a'.repeat(40), 'crimson', ''),
      window.twig.setMark('unregistered', 'a'.repeat(40), 'red', ''),
      window.twig.searchHistory(id, '   '), window.twig.searchHistory(id, 'x'.repeat(201)), window.twig.searchHistory(id, 'x', 'shell'),
      window.twig.runConsoleCommand(id, 123), window.twig.runConsoleCommand(id, '-c core.pager=sh log'),
      window.twig.runConsoleCommand(id, 'push origin main'), window.twig.runConsoleCommand('unregistered', 'status')
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(16).fill('rejected'));

  // Commit age colours: the default ramp, the switch back to branch lanes and
  // the choice surviving a restart. Colour classes are the only honest witness
  // that the ramp reached the SVG at all.
  const laneClasses = () => page.evaluate(() =>
    [...new Set([...document.querySelectorAll('.real-lane circle')].map(node => node.getAttribute('class')))].sort());
  await list.evaluate(node => { node.scrollTop = 0; });
  assert.deepEqual(await laneClasses(), ['graph-age-0', 'graph-age-3']);
  assert.match(await page.evaluate(() => document.querySelector('.real-commit-row .date-cell').className), /age-text-0/);
  assert.equal(await page.evaluate(() => document.querySelector('.real-history').dataset.colors), 'age');
  await mkdir('artifacts', { recursive: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('list', { name: 'Commit age colors', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/m2-age-settings.png', animations: 'disabled' });
  await page.getByLabel('Commit colors').selectOption('lanes');
  assert.equal(await page.getByRole('list', { name: 'Commit age colors', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await list.evaluate(node => { node.scrollTop = 0; });
  const lanesOnly = async (why) => {
    const classes = await laneClasses();
    assert.ok(classes.length && classes.every(name => name.startsWith('graph-color-')), `${why}: ${classes.join(' ')}`);
  };
  await lanesOnly('branch lanes must come back');
  await page.reload();
  await list.waitFor();
  await list.getByRole('option').first().waitFor();
  await list.evaluate(node => { node.scrollTop = 0; });
  await lanesOnly('the choice must survive a restart');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Commit colors').selectOption('age');
  await page.keyboard.press('Escape');
  await list.evaluate(node => { node.scrollTop = 0; });
  assert.deepEqual(await laneClasses(), ['graph-age-0', 'graph-age-3']);
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByText('259 loaded', { exact: true }).waitFor();
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  // The roots of this fixture are years old, so the ramp has to reach its last stop.
  await page.waitForFunction(() => [...document.querySelectorAll('.real-lane circle')].some(node => node.classList.contains('graph-age-4')));
  await list.evaluate(node => { node.scrollTop = 0; });

  // Adjustable columns: drag two handles wider and the widths stick across a reload.
  const colVar = name => page.evaluate(prop =>
    parseInt(getComputedStyle(document.querySelector('.real-history')).getPropertyValue(prop), 10), name);
  const dragColumn = async (label, dx) => {
    const box = await page.getByRole('separator', { name: `Resize ${label} column` }).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
  };
  const beforeBranch = await colVar('--col-branch');
  const beforeMessage = await colVar('--col-message');
  const beforeGraph = await colVar('--graph-width');
  await dragColumn('Branch / tag', 70);
  await dragColumn('Commit message', 90);
  await dragColumn('Graph', 60);
  const afterBranch = await colVar('--col-branch');
  const afterMessage = await colVar('--col-message');
  const afterGraph = await colVar('--graph-width');
  assert.ok(afterBranch >= beforeBranch + 50, `branch column widened: ${beforeBranch} -> ${afterBranch}`);
  assert.ok(afterMessage >= beforeMessage + 60, `message column widened: ${beforeMessage} -> ${afterMessage}`);
  assert.ok(afterGraph >= beforeGraph + 40, `graph column widened: ${beforeGraph} -> ${afterGraph}`);
  await page.reload();
  await list.waitFor();
  await list.getByRole('option').first().waitFor();
  assert.equal(await colVar('--col-branch'), afterBranch, 'the branch width survives a restart');
  assert.equal(await colVar('--col-message'), afterMessage, 'the message width survives a restart');
  assert.equal(await colVar('--graph-width'), afterGraph, 'the pinned graph width survives a restart');
  // Double-click the Graph handle to drop back to the automatic width.
  await page.getByRole('separator', { name: 'Resize Graph column' }).dblclick();
  assert.equal(await colVar('--graph-width'), beforeGraph, 'double-click restores the automatic graph width');
  await list.evaluate(node => { node.scrollTop = 0; });

  // Column visibility: right-click the header to hide/show Branch, Author and Date.
  await page.locator('.real-history-columns').click({ button: 'right' });
  const columnMenu = page.getByRole('menu', { name: 'Show columns' });
  await columnMenu.waitFor();
  const authorItem = columnMenu.getByRole('menuitemcheckbox', { name: 'Author' });
  assert.equal(await authorItem.getAttribute('aria-checked'), 'true');
  await authorItem.click();
  assert.equal(await colVar('--col-author'), 0, 'unchecking Author collapses the column');
  assert.equal(await authorItem.getAttribute('aria-checked'), 'false');
  await columnMenu.getByRole('menuitemcheckbox', { name: 'Date' }).click();
  assert.equal(await colVar('--col-date'), 0, 'unchecking Date collapses the column');
  await page.keyboard.press('Escape');
  await columnMenu.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.real-commit-row .author-col').first().innerText(), '', 'author text is gone from rows too');
  await page.reload();
  await list.waitFor();
  await list.getByRole('option').first().waitFor();
  assert.equal(await colVar('--col-author'), 0, 'hidden columns survive a restart');
  assert.equal(await colVar('--col-date'), 0, 'hidden columns survive a restart');
  await page.locator('.real-history-columns').click({ button: 'right' });
  await columnMenu.waitFor();
  await columnMenu.getByRole('menuitemcheckbox', { name: 'Author' }).click();
  await columnMenu.getByRole('menuitemcheckbox', { name: 'Date' }).click();
  await page.keyboard.press('Escape');
  await columnMenu.waitFor({ state: 'hidden' });
  assert.ok((await colVar('--col-author')) > 0, 'Author comes back on toggle');
  assert.ok((await colVar('--col-date')) > 0, 'Date comes back on toggle');
  await list.evaluate(node => { node.scrollTop = 0; });

  // Auto-refresh: a commit made in a terminal shows up on its own. `main` watches
  // the git directory; the workspace reloads on the event, with no Refresh click
  // and no polling timer.
  const openCommit = page.getByRole('heading', { name: 'Real history 🌱', exact: true });
  await openCommit.waitFor();
  await page.waitForTimeout(1500); // clear the short guard that skips a reload right after one
  await writeFile(path.join(cwd, 'external.txt'), 'made outside Twig\n');
  await git(['add', '--', 'external.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Committed from a terminal']);
  await page.locator('.real-commit-row', { hasText: 'Committed from a terminal' }).first().waitFor();
  // A refresh nobody asked for must not close what is open: the commit panel
  // still shows the commit the user had selected before the outside commit.
  await openCommit.waitFor();

  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme); await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/m2-${theme}.png`, animations: 'disabled' });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: 'artifacts/m2-compact.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('M2 Electron passed: real repository, two pages, merge, annotated tag, selection, keyboard, tabs, files, diff, worktree, IPC validation, age colours, commit marks, console command bar, wrapped ref badges, adjustable columns, column visibility, external-change auto-refresh, themes.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
