import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { buildPreload } from './build.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'twig-smoke-'));
await mkdir('artifacts', { recursive: true });
const errors = [];
let app;
let server;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  if (process.argv.includes('--dev')) {
    await buildPreload();
    server = await createServer();
    await server.listen();
    env.TWIG_DEV = '1';
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  // The demo tab is a real seeded sandbox repository, not a mock: on first
  // launch the app runs git init and scripts a sample history under the temp
  // profile, then renders the same HistoryWorkspace every connected repo uses.
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const info = await page.evaluate(() => window.twig.getAppInfo());
  assert.equal(info.name, '🌱 Twig');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  // The exact bridge surface is asserted on purpose: anything accidentally
  // exposed to the renderer has to fail this check rather than ship.
  assert.deepEqual(await page.evaluate(() => Object.keys(window.twig).sort()), [
    'applySelection', 'cancelSync', 'checkoutRef', 'cherryPick', 'compareCommits', 'copyText', 'createBranch',
    'checkForUpdate', 'getUpdateState', 'downloadUpdate', 'cancelUpdate', 'installUpdate', 'setAutoUpdateCheck', 'onUpdateState', 'createCommit', 'createTag', 'getAppInfo', 'getCommit', 'getCommitFiles', 'getConsoleEntries',
    'getDivergence', 'getFileDiff', 'getFileHistory', 'getGitProfile', 'getHistoryPage', 'getOperationState', 'getRebaseCandidates', 'getRefs',
    'getWorkspace', 'getWorktreeDiff', 'markConflictResolved', 'searchHistory', 'mergeRevision', 'onConsoleUpdate', 'openRepository',
    'readConflict', 'readWorktree', 'rebaseOnto', 'resetTo', 'revertCommit', 'rewordCommit', 'runSequencer', 'runSync',
    'saveConflict', 'saveGitProfileValue', 'selectRepository', 'stageAll', 'stageFile', 'stashList', 'stashPop', 'stashPush', 'takeConflictSide',
    'trackFile', 'unstageAll', 'unstageFile', 'cancelClone', 'cancelRemote', 'changeRemote', 'chooseCloneDestination',
    'stashFiles', 'stashDiff', 'stashAction', 'pushRef', 'runDrop', 'deleteBranch', 'renameBranch', 'setUpstream', 'deleteTag',
    'getBisectState', 'runBisect', 'listMarks', 'setMark', 'clearMark',
    'getBlame', 'getReverseBlame', 'getBlameBefore', 'cancelBlame',
    'cloneRepository', 'getRemotes', 'removeRepository', 'resetDemoWorkspace', 'setDemoWorkspaceVisible', 'getUndoState', 'moveUndo', 'onUndoUpdate',
    'watchRepository', 'onRepositoryChange', 'getReflog', 'moveBranchTo',
    'getBackgroundFetch', 'setBackgroundFetch', 'getBackgroundFetchStatus', 'onBackgroundFetch',
    'getSshKeys', 'getSshConfig', 'generateSshKey', 'saveSshConfig', 'testSshConnection', 'cancelSshConnection', 'secureSshKey',
    'getAutomationConfig', 'saveAutomationConfig', 'trustAutomations', 'runAutomation', 'cancelAutomation', 'getAutomationRuns', 'getAutomationRun', 'onAutomationStep',
    'runConsoleCommand', 'getEditor', 'setEditor', 'openInEditor', 'revealFile',
    'discardFile', 'discardAll', 'discardSelection',
    'cherryPickMany', 'revertMany', 'getSignature', 'getLfsStatus', 'pullLfs', 'cancelRepositoryTool',
    'exportPatches', 'choosePatch', 'applyPatchCommits', 'applyPatchFiles',
    'getSubmodules', 'updateSubmodules', 'openSubmodule',
    'getWorktrees', 'planWorktree', 'addWorktree', 'removeWorktree', 'pruneWorktrees', 'openWorktree',
    'getTagDetails', 'getCoAuthors', 'addIgnoreRule', 'getRepositoryStats', 'runMaintenance'].sort());
  const security = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).getByRole('option').first().click();
  await page.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'Add keyboard navigation to commit details' }).waitFor();
  // The commit panel is resized by dragging the divider, not by a slider, so
  // both the pointer and the keyboard path are asserted against the real width.
  assert.equal(await page.getByRole('slider').count(), 0);
  const splitter = page.getByRole('separator', { name: 'Commit panel width' });
  const panelWidth = () => page.evaluate(() => document.querySelector('.commit-detail').getBoundingClientRect().width);
  const divider = await splitter.boundingBox();
  const started = await panelWidth();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + divider.height / 2);
  await page.mouse.down();
  await page.mouse.move(divider.x + divider.width / 2 - 60, divider.y + divider.height / 2, { steps: 8 });
  await page.mouse.up();
  assert.equal(Math.round(await panelWidth()), Math.round(started) + 60);
  await splitter.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(Math.round(await panelWidth()), Math.round(started) + 44);
  await splitter.dblclick();
  assert.equal(Math.round(await panelWidth()), Math.round(started));
  // The demo tab closes like any other; opening the New repository tab and
  // coming back keeps its selection.
  assert.equal(await page.getByRole('button', { name: 'Close workspace-demo tab' }).count(), 1);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('heading', { name: 'A clear view of your code.' }).waitFor();
  await page.getByRole('button', { name: 'Open workspace-demo', exact: true }).click();
  await page.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();
  // One search box drives the sidebar refs and a global commit search.
  const search = page.getByRole('textbox', { name: 'Search commits and references' });
  await search.fill('repository-tabs');
  await page.getByRole('button', { name: 'repository-tabs', exact: true }).waitFor();
  await search.fill('');
  // Syntax colours: a JavaScript change in the demo history is coloured by
  // role, the toolbar names the language, and Settings turns it off and on
  // for every diff at once.
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).getByRole('option').filter({ hasText: 'Add duration to command entries' }).click();
  await page.getByRole('button', { name: 'Modified app/console.js', exact: true }).click();
  const codeDiff = page.getByRole('region', { name: 'File diff', exact: true });
  await codeDiff.locator('.syn-keyword', { hasText: 'export' }).first().waitFor();
  assert.equal(await codeDiff.locator('.diff-language').textContent(), 'JavaScript');
  assert.ok(await codeDiff.locator('.diff-lines.diff-syntax').count() === 1);
  assert.equal(await codeDiff.locator('.diff-added .diff-marker').first().textContent(), '+');
  // The coloured text is still the text: every character of the added line is there.
  assert.equal(await codeDiff.locator('.diff-added').last().locator('> span:last-child').textContent(), '+export const showsDuration = true;');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Syntax highlighting').selectOption('off');
  await page.keyboard.press('Escape');
  assert.equal(await codeDiff.locator('[class*="syn-"]').count(), 0, 'off means plain text everywhere');
  assert.equal(await codeDiff.locator('.diff-language').textContent(), 'JavaScript · no highlighting');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Syntax highlighting').selectOption('on');
  await page.keyboard.press('Escape');
  await codeDiff.locator('.syn-keyword').first().waitFor();
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  // The console lives at the bottom and opens from its own status bar; the
  // toolbar has no second switch for it.
  assert.equal(await page.locator('.toolbar').getByRole('button', { name: /Terminal/ }).count(), 0);
  await page.locator('.console-status').click();
  await page.getByRole('textbox', { name: 'Search command log' }).waitFor();
  // It opens on "My": the startup Git check is 🌱 Twig's own command, so it is
  // in Full History only.
  const versionCheck = page.getByText(/git --no-pager -c color.ui=false -c log.showSignature=false --version/);
  assert.equal(await page.getByRole('button', { name: 'My', exact: true }).getAttribute('aria-pressed'), 'true', 'the console opens on My');
  assert.equal(await versionCheck.count(), 0, 'the startup check is not one of the user actions');
  await page.getByRole('button', { name: 'Full History', exact: true }).click();
  await versionCheck.first().waitFor();
  await page.keyboard.press(`${info.platform === 'darwin' ? 'Meta' : 'Control'}+j`);
  assert.equal(await page.getByRole('textbox', { name: 'Search command log' }).isVisible(), false);
  // The update check is manual: the button is there, and nothing presses it for
  // the person. It stays unclicked here — this run must make no network call.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const updateButton = page.getByRole('button', { name: 'Check for updates', exact: true });
  await updateButton.waitFor();
  assert.equal(await updateButton.isDisabled(), false, 'the update check is available from Settings');
  // The automatic check is opt-in: Off on a fresh profile, and so no update
  // button in the top bar and no request at all during this run.
  assert.equal(await page.getByLabel('Check automatically').inputValue(), 'off');
  const updateState = await page.evaluate(() => window.twig.getUpdateState());
  assert.equal(updateState.status, 'idle');
  assert.equal(updateState.auto, false);
  assert.equal(updateState.installable, false, 'running from source installs nothing');
  assert.equal(await page.locator('.update-button').count(), 0);
  // Invalid requests are refused, not answered.
  await assert.rejects(page.evaluate(() => window.twig.setAutoUpdateCheck('yes')), /Invalid update request/);
  await page.keyboard.press('Escape');
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    await page.screenshot({ path: `artifacts/m0-${theme}.png`, animations: 'disabled' });
  }
  await page.reload();
  await page.getByRole('listbox').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: 'artifacts/m0-compact.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return true; } catch { return false; } }), false);
  assert.deepEqual(errors, []);
  console.log('Electron smoke passed: sandbox, bridge, selection, keyboard, tabs, search, panel divider, console, manual update check, themes, compact layout, network block.');
} finally {
  if (app) await app.close();
  if (server) await server.close();
  await rm(profile, { recursive: true, force: true });
}
