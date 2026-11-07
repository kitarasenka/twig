import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// The dead ends of everyday work, in a real window against real repositories:
// a refused push and its way out, conflicts with nothing to continue, edits
// that must survive leaving the screen, checks that say what they do, a folder
// with no repository, a repository that moved, and a screen that fails to draw.

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-flows-smoke-')));
let app;
try {
  const log = new CommandLog(root);
  await log.load();
  const git = async (cwd, ...args) => {
    const argv = cwd.endsWith('.git') ? [`--git-dir=${cwd}`, ...args] : args;
    const result = await runGit({ argv, cwd, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  const write = (cwd, file, text) => writeFile(path.join(cwd, file), text, 'utf8');
  const commit = async (cwd, file, text, message) => { await write(cwd, file, text); await git(cwd, 'add', '--', file); await git(cwd, 'commit', '--message', message); };
  async function fixture(name) {
    const cwd = path.join(root, name);
    await mkdir(cwd);
    await git(cwd, 'init', '--initial-branch=main');
    await git(cwd, 'config', 'user.name', 'Twig Fixture');
    await git(cwd, 'config', 'user.email', 'fixture@example.invalid');
    await git(cwd, 'config', 'commit.gpgsign', 'false');
    await commit(cwd, 'a.txt', 'one\ntwo\nthree\n', 'first');
    return cwd;
  }
  const snapshot = async (page, name) => {
    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    for (const shade of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, shade);
      await page.screenshot({ path: `artifacts/flows-${name}-${shade}.png`, animations: 'disabled' });
    }
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
  };
  await mkdir('artifacts', { recursive: true });

  const env = { ...process.env, TWIG_LANGUAGE: 'en' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const pick = directory => app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, directory);
  const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
  const tool = name => page.locator('.toolbar button.tool', { hasText: new RegExp(`^${name}`) }).first();
  const dismissNotes = async () => { for (const close of await page.locator('.note-dismiss').all()) await close.click().catch(() => {}); };
  async function open(directory) {
    await pick(directory);
    await button('New repository tab').click();
    await button('Open repository').click();
  }
  const history = () => page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  // Through the window's own input path: Playwright's keyboard goes round `before-input-event`.
  const pressRefresh = () => app.evaluate(({ BrowserWindow }, modifier) => {
    const { webContents } = BrowserWindow.getAllWindows()[0];
    webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R', modifiers: [modifier] });
    webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R', modifiers: [modifier] });
  }, process.platform === 'darwin' ? 'meta' : 'control');
  const refresh = () => page.locator('.repo-refresh').click();
  const openStaging = async () => {
    await page.locator('.real-commit-row:visible').first().waitFor();
    await page.getByRole('button', { name: /^Uncommitted changes/ }).click();
    await button('Open staging').click();
    await page.getByRole('region', { name: 'Staged changes', exact: true }).waitFor();
  };

  // --- a push the remote refused, and the way out of it ---------------------
  const bare = path.join(root, 'server.git');
  const mine = await fixture('mine');
  await git(root, 'init', '--bare', '--initial-branch=main', bare);
  await git(mine, 'remote', 'add', 'origin', bare);
  await git(mine, 'push', '--set-upstream', 'origin', 'main');
  const theirs = path.join(root, 'theirs');
  await git(root, 'clone', '--', bare, theirs);
  await git(theirs, 'config', 'user.name', 'Their Name');
  await git(theirs, 'config', 'user.email', 'their@example.invalid');
  await git(theirs, 'config', 'commit.gpgsign', 'false');
  await commit(theirs, 'b.txt', 'theirs\n', 'their work');
  await git(theirs, 'push');
  await commit(mine, 'c.txt', 'mine\n', 'my work');

  await open(mine);
  await history();

  // The Branch button works, at the selected commit, and says nothing false.
  const branchTool = tool('Branch');
  assert.equal(await branchTool.isDisabled(), false, 'Branch is live in an open repository');
  await branchTool.click();
  await page.getByRole('dialog').getByLabel('Branch name').fill('from-toolbar');
  await button('Create branch').click();
  await page.locator('.operation-note', { hasText: 'Branch from-toolbar created.' }).waitFor();
  assert.ok((await git(mine, 'branch', '--list', 'from-toolbar')).includes('from-toolbar'));
  await dismissNotes();

  await tool('Push').click();
  await page.locator('.operation-note', { hasText: 'origin/main has commits you do not have yet' }).waitFor();
  assert.equal(await button('Push with lease…').count(), 0, 'somebody else’s work is not offered for replacing');
  await snapshot(page, 'push-refused');
  await button('Pull with rebase').click();
  await page.locator('.operation-note', { hasText: 'Pull finished.' }).waitFor();
  assert.equal(await git(mine, 'log', '-1', '--format=%s', 'HEAD~1'), 'their work', 'the pull really went through');
  await tool('Push').click();
  await page.locator('.operation-note', { hasText: 'Push finished.' }).waitFor();
  await dismissNotes();

  // Both sides moved: Pull asks instead of failing.
  await commit(theirs, 'b.txt', 'theirs again\n', 'more of theirs').catch(() => {});
  await git(theirs, 'pull', '--rebase');
  await git(theirs, 'push');
  await commit(mine, 'c.txt', 'mine again\n', 'more of mine');
  await git(mine, 'fetch');
  await refresh();
  await page.locator('.toolbar button.tool', { hasText: /^Pull/ }).locator('.badge').waitFor();
  await tool('Pull').click();
  const pullDialog = page.getByRole('dialog', { name: 'Pull' });
  await pullDialog.getByText('git pull --rebase', { exact: false }).waitFor();
  await pullDialog.getByText('git pull --no-rebase', { exact: false }).waitFor();
  await snapshot(page, 'pull-choice');
  await button('Pull with rebase', pullDialog).click();
  await page.locator('.operation-note', { hasText: 'Pull finished.' }).waitFor();
  await dismissNotes();
  await tool('Push').click();
  await page.locator('.operation-note', { hasText: 'Push finished.' }).waitFor();
  await dismissNotes();

  // An amend of what was pushed: only now is the lease offered, with its command.
  await git(mine, 'commit', '--amend', '--message', 'more of mine, reworded');
  await refresh();
  await tool('Push').click();
  await page.locator('.operation-note', { hasText: 'was rewritten' }).waitFor();
  await snapshot(page, 'push-rewritten');
  await button('Push with lease…').click();
  const lease = page.getByRole('dialog', { name: 'Push with lease' });
  await lease.getByText('$ git push --force-with-lease origin refs/heads/main:refs/heads/main', { exact: true }).waitFor();
  await button('Push with lease', lease).click();
  await page.locator('.operation-note', { hasText: 'Push finished.' }).waitFor();
  assert.equal(await git(bare, 'rev-parse', 'main'), await git(mine, 'rev-parse', 'HEAD'));
  await dismissNotes();

  // --- Stash says the truth ---------------------------------------------------
  await refresh();
  await page.waitForFunction(() => document.querySelector('.toolbar button.tool[title^="Stash:"]') !== null);
  assert.equal(await tool('Stash').isDisabled(), true, 'a clean tree has nothing to stash');
  assert.match(await tool('Stash').getAttribute('title'), /nothing to put away/);

  // --- a stash that does not apply: the editor is reachable, the stash is kept --
  await write(mine, 'a.txt', 'stashed\ntwo\nthree\n');
  await refresh();
  await page.waitForFunction(() => document.querySelector('.toolbar button.tool[title="Stash every change, untracked files included"]') !== null);
  await tool('Stash').click();
  await page.locator('.operation-note', { hasText: 'Changes stashed.' }).waitFor();
  await commit(mine, 'a.txt', 'moved on\ntwo\nthree\n', 'moved on');
  await dismissNotes();
  await tool('Pop').click();
  await page.locator('.operation-note', { hasText: 'The stash did not apply cleanly' }).waitFor();
  const banner = page.getByRole('status', { name: 'Conflict in the working tree' });
  await banner.waitFor();
  await snapshot(page, 'stash-conflict');
  assert.equal(await banner.getByRole('button', { name: 'Continue', exact: true }).count(), 0, 'nothing runs, so nothing continues');
  // The row in the panel opens the editor; its plus cannot stage the markers.
  await page.getByRole('button', { name: /^Uncommitted changes/ }).click();
  const panel = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  assert.equal(await panel.getByRole('button', { name: /^Stage a\.txt/ }).isDisabled(), true, 'a conflicted file is not staged with its markers');
  await panel.locator('.commit-file').filter({ hasText: 'a.txt' }).click();
  await page.getByRole('region', { name: 'Resolve conflict in a.txt' }).waitFor();
  await page.getByLabel('Result — this is what will be written to disk').fill('resolved\ntwo\nthree\n');
  await button('Save and mark resolved').click();
  await page.locator('.operation-note', { hasText: 'Every conflict is resolved' }).waitFor();
  await banner.waitFor({ state: 'detached' });
  assert.equal((await git(mine, 'stash', 'list')).split('\n').length, 1, 'the stash is still in the list, as the note says');
  await git(mine, 'stash', 'drop');
  await git(mine, 'commit', '--message', 'resolved');
  await refresh();
  await dismissNotes();

  // --- editing a conflict and walking away from it ---------------------------
  const clash = await fixture('clash');
  await write(clash, 'f.txt', 'base f\n'); await write(clash, 'g.txt', 'base g\n');
  await commit(clash, 'gone.txt', 'base\n', 'more files');
  await git(clash, 'add', '--', 'f.txt', 'g.txt');
  await git(clash, 'commit', '--message', 'f and g');
  await git(clash, 'switch', '--create', 'feature');
  await write(clash, 'f.txt', 'feature f\n'); await write(clash, 'g.txt', 'feature g\n');
  await git(clash, 'rm', '--quiet', '--', 'gone.txt');
  await git(clash, 'add', '--', 'f.txt', 'g.txt');
  await git(clash, 'commit', '--message', 'feature side');
  await git(clash, 'switch', 'main');
  await write(clash, 'f.txt', 'main f\n'); await write(clash, 'g.txt', 'main g\n'); await write(clash, 'gone.txt', 'changed on main\n');
  await git(clash, 'add', '--', 'f.txt', 'g.txt', 'gone.txt');
  await git(clash, 'commit', '--message', 'main side');
  await runGit({ argv: ['merge', '--no-edit', 'feature'], cwd: clash, log });
  await open(clash);
  await history();
  const list = page.locator('.conflict-list');
  await list.waitFor();
  await list.getByRole('button', { name: /f\.txt/ }).click();
  const result = page.getByLabel('Result — this is what will be written to disk');
  await result.fill('my careful resolution of f\n');
  await list.getByRole('button', { name: /g\.txt/ }).click();
  await page.getByRole('region', { name: 'Resolve conflict in g.txt' }).waitFor();
  assert.match(await list.getByRole('button', { name: /f\.txt/ }).innerText(), /Unsaved edits/, 'the banner says which file has work in it');
  await snapshot(page, 'conflict-unsaved');
  await list.getByRole('button', { name: /f\.txt/ }).click();
  await page.getByRole('region', { name: 'Resolve conflict in f.txt' }).waitFor();
  await page.waitForFunction(() => document.querySelector('#conflict-result')?.value === 'my careful resolution of f\n');
  assert.equal(await button('Undo in the conflict editor').isDisabled(), false, 'its Undo came back too');
  await button('Back to history').click();
  await page.locator('#conflict-result').waitFor({ state: 'detached' });
  await list.getByRole('button', { name: /f\.txt/ }).click();
  await page.waitForFunction(() => document.querySelector('#conflict-result')?.value === 'my careful resolution of f\n');
  // A click in the sidebar leaves the editor for what it picked, and nothing is lost.
  await page.locator('.sidebar-nav button:visible', { hasText: 'Stashes' }).click();
  await page.locator('#conflict-result').waitFor({ state: 'detached' });
  await list.getByRole('button', { name: /f\.txt/ }).click();
  await page.waitForFunction(() => document.querySelector('#conflict-result')?.value === 'my careful resolution of f\n');
  await button('Save and mark resolved').click();
  await page.locator('.operation-note', { hasText: 'f.txt marked resolved.' }).waitFor();
  assert.equal(await readFile(path.join(clash, 'f.txt'), 'utf8'), 'my careful resolution of f\n');
  await list.getByRole('button', { name: /g\.txt/ }).click();
  await button('Take all ours').click();
  await page.locator('.operation-note', { hasText: 'g.txt marked resolved.' }).waitFor();

  // Modify/delete: nothing to merge, two honest answers.
  await list.getByRole('button', { name: /gone\.txt/ }).click();
  await page.getByText('Theirs deleted this file and ours changed it.', { exact: false }).waitFor();
  assert.equal(await button('Take all theirs').count(), 0, 'the button that cannot work is gone');
  await snapshot(page, 'conflict-deleted');
  await button('Delete the file').click();
  await page.locator('.operation-note', { hasText: 'gone.txt marked resolved.' }).waitFor();
  assert.ok(!(await git(clash, 'ls-files')).includes('gone.txt'));
  await button('Continue').click();
  await page.locator('.operation-note', { hasText: 'merge finished.' }).waitFor();
  await dismissNotes();

  // --- blame gives way to what the sidebar picks -----------------------------
  await button('Back to history').click();
  await page.locator('.real-commit-row').filter({ hasText: 'f and g' }).click();
  await page.locator('.commit-file').filter({ hasText: 'f.txt' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Blame history' }).click();
  await page.getByRole('region', { name: /^Blame/ }).waitFor().catch(() => {});
  await page.locator('.blame-view, [aria-label^="Blame"]').first().waitFor();
  await button('Reflog').click();
  await page.locator('.blame-view, [aria-label^="Blame"]').first().waitFor({ state: 'detached' });

  // --- the message being written survives leaving and reloading --------------
  const notes = await fixture('notes');
  await write(notes, 'a.txt', 'one\ntwo\nthree\nfour\n');
  await write(notes, 'new.txt', 'line one\nline two\n');
  await open(notes);
  await history();
  await openStaging();
  const message = page.getByLabel('Commit message', { exact: true });
  await message.fill('a subject worth keeping\n\nand its body');
  await page.locator('.sidebar-nav button:visible', { hasText: 'Stashes' }).click();
  await message.waitFor({ state: 'detached' });
  await button('Back to history').click();
  await openStaging();
  assert.equal(await message.inputValue(), 'a subject worth keeping\n\nand its body', 'leaving the screen costs nothing');

  // Cmd/Ctrl+R is Refresh here, not a page reload that wipes the window.
  await page.evaluate(() => { window.__sameDocument = true; });
  await message.focus();
  await page.evaluate(() => { window.__refreshes = 0; window.twig.onRefreshKey(() => { window.__refreshes++; }); });
  await pressRefresh();
  await page.waitForFunction(() => window.__refreshes === 1);
  assert.equal(await page.evaluate(() => window.__sameDocument), true, 'the page did not reload, it refreshed');
  const viewMenu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.flatMap(item => item.submenu?.items || []).map(item => [item.role || '', item.label]));
  assert.equal(viewMenu.some(([role]) => role.toLowerCase() === 'reload'), false, 'no menu item reloads the page');
  assert.ok(viewMenu.some(([, label]) => label === 'Refresh'));
  assert.equal(await message.inputValue(), 'a subject worth keeping\n\nand its body');
  await page.reload();
  await page.locator('.tab', { hasText: 'notes' }).locator('button').first().click();
  await history();
  await openStaging();
  assert.equal(await message.inputValue(), 'a subject worth keeping\n\nand its body', 'nor does a reload of the window');

  // --- looking at an untracked file changes nothing --------------------------
  const untracked = page.getByRole('region', { name: 'Untracked files', exact: true });
  await untracked.locator('.worktree-open').filter({ hasText: 'new.txt' }).click();
  await page.locator('.stage-diff').getByText('line two', { exact: false }).waitFor();
  assert.ok((await git(notes, 'status', '--porcelain')).includes('?? new.txt'), 'it is still untracked');
  await tool('Stash').hover();
  assert.equal(await untracked.locator('.worktree-open').filter({ hasText: 'new.txt' }).count(), 1, 'and still where it was');
  // Picking a line is what brings it into the index, that line alone.
  await page.locator('.stage-diff').getByLabel('Stage line 1').check();
  await button('Stage 1 selected').click();
  await page.getByRole('region', { name: 'Staged changes', exact: true }).locator('.worktree-open').filter({ hasText: 'new.txt' }).waitFor();
  assert.equal(await git(notes, 'show', ':new.txt'), 'line one');

  // A file marked with `git add -N` elsewhere can have the mark taken off here.
  await write(notes, 'marked.txt', 'marked\n');
  await git(notes, 'add', '--intent-to-add', '--', 'marked.txt');
  await pressRefresh();
  await button('Stop tracking marked.txt').click();
  await page.getByRole('region', { name: 'Untracked files', exact: true }).locator('.worktree-open').filter({ hasText: 'marked.txt' }).waitFor();
  assert.ok((await git(notes, 'status', '--porcelain')).includes('?? marked.txt'));
  await rm(path.join(notes, 'marked.txt'));
  await pressRefresh();
  await page.getByRole('region', { name: 'Untracked files', exact: true }).locator('.worktree-open').filter({ hasText: 'marked.txt' }).waitFor({ state: 'detached' });

  // A commit clears the draft for good.
  await page.getByRole('region', { name: 'Unstaged changes', exact: true }).getByRole('button', { name: 'Stage all' }).click();
  await page.getByRole('button', { name: /^Commit \d+ files?$/ }).click();
  await page.getByText('Commit created.', { exact: true }).waitFor();
  assert.equal(await message.inputValue(), '');
  assert.equal(await page.evaluate(id => localStorage.getItem(`twig:commit-draft:${id}`), notes), null);
  await button('Back to history').click();

  // --- checks say what they do ------------------------------------------------
  const checks = await fixture('checks');
  await write(checks, 'a.txt', 'one\ntwo\nthree\nfour\n');
  await git(checks, 'add', '--', 'a.txt');
  await open(checks);
  await history();
  const id = checks;
  await page.evaluate(async repository => {
    const config = await window.twig.getAutomationConfig(repository);
    const action = { id: 'wait', type: 'custom', name: 'Wait', command: 'sleep 4' };
    await window.twig.saveAutomationConfig(repository, { ...config.config, pipelines: [{ id: 'slow', name: 'Slow', event: 'pre-commit', enabled: true, conditions: [], onFailure: 'block', actions: [action] }] });
  }, id);
  await openStaging();
  await message.fill('held back');
  await page.getByRole('button', { name: /^Commit \d+ files?$/ }).click();
  const checksDialog = page.getByRole('dialog', { name: /checks$/ });
  await checksDialog.waitFor();
  assert.equal(await button('Run in background').count(), 0, 'no promise that nothing keeps');
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog'))), true, 'the focus is inside the panel');
  await button('Cancel', checksDialog).click();
  await page.locator('.operation-note', { hasText: 'The checks were stopped, so the Git action did not run.' }).waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByRole('dialog', { name: /checks$/ }).count(), 0, 'the panel does not come back');
  assert.equal(await git(checks, 'log', '-1', '--format=%s'), 'first', 'and no commit appears later');
  await dismissNotes();
  await page.evaluate(async repository => {
    const config = await window.twig.getAutomationConfig(repository);
    const action = { id: 'no', type: 'custom', name: 'Refuse', command: 'false' };
    await window.twig.saveAutomationConfig(repository, { ...config.config, pipelines: [{ id: 'no', name: 'Refuse', event: 'pre-commit', enabled: true, conditions: [], onFailure: 'block', actions: [action] }] });
  }, id);
  await page.getByRole('button', { name: /^Commit \d+ files?$/ }).click();
  await button('Back to fix it').waitFor();
  await page.waitForFunction(() => document.activeElement?.textContent === 'Back to fix it');
  assert.equal(await page.getByRole('dialog', { name: /checks$/ }).getByRole('status').count() > 0, true, 'the verdict is announced');
  await snapshot(page, 'checks-blocked');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: /checks$/ }).waitFor({ state: 'detached' });
  await button('Back to history').click();

  // --- a folder with no repository, and a bare one -----------------------------
  const project = path.join(root, 'new project');
  await mkdir(project);
  await write(project, 'readme.txt', 'hello\n');
  await open(project);
  const initDialog = page.getByRole('dialog', { name: 'Create a repository here?' });
  await initDialog.locator('.confirm-command').waitFor();
  assert.match(await initDialog.locator('.confirm-command').innerText(), /^\$ git init --initial-branch=/);
  await snapshot(page, 'init');
  await button('Create repository', initDialog).click();
  // The first thing a new repository shows is where to start, not an empty commit panel.
  const fresh = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  await fresh.waitFor();
  await button('Open staging', fresh).waitFor();
  assert.equal(await page.locator('.commit-detail:visible', { hasText: /^COMMIT/ }).count(), 0);
  await snapshot(page, 'unborn');
  assert.equal(await tool('Publish').isDisabled(), true, 'an unborn branch has nothing to publish');
  assert.match(await tool('Publish').getAttribute('title'), /first commit/);
  assert.equal(await tool('Stash').isDisabled(), true);

  await open(bare);
  await page.locator('.operation-note', { hasText: 'bare repository' }).waitFor();
  assert.equal(await page.locator('.startup-error').count(), 0, 'a refused folder is a note, not a bar for the rest of the session');
  await dismissNotes();

  // --- Publish knows about remotes ---------------------------------------------
  const lonely = await fixture('lonely');
  await open(lonely);
  await history();
  await tool('Publish').click();
  await page.locator('.operation-note', { hasText: 'no remote yet' }).waitFor();
  await button('Add remote…').click();
  await page.getByRole('dialog', { name: 'Remotes' }).getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('dialog', { name: 'Remotes' }).waitFor({ state: 'detached' });
  const server = path.join(root, 'gitlab.git');
  const mirror = path.join(root, 'mirror.git');
  await git(root, 'init', '--bare', '--initial-branch=main', server);
  await git(root, 'init', '--bare', '--initial-branch=main', mirror);
  await git(lonely, 'remote', 'add', 'gitlab', server);
  await tool('Publish').click();
  await page.locator('.operation-note', { hasText: 'Push finished.' }).waitFor();
  assert.equal(await git(lonely, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'gitlab/main', 'the one remote there is, whatever its name');
  await dismissNotes();
  await git(lonely, 'switch', '--create', 'topic');
  await git(lonely, 'remote', 'add', 'mirror', mirror);
  await refresh();
  await page.locator('.toolbar button.tool', { hasText: /^Publish/ }).waitFor();
  await tool('Publish').click();
  const publishDialog = page.getByRole('dialog', { name: 'Publish' });
  await button('Publish to mirror', publishDialog).click();
  await page.locator('.operation-note', { hasText: 'Push finished.' }).waitFor();
  assert.equal(await git(lonely, 'rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'mirror/topic');
  await dismissNotes();

  // --- a repository that moved --------------------------------------------------
  const moving = await fixture('moving');
  await open(moving);
  await history();
  const tip = await git(moving, 'rev-parse', 'HEAD');
  await page.evaluate(async ([repository, oid]) => { await window.twig.setMark(repository, oid, 'green', 'follow me'); }, [moving, tip]);
  await page.evaluate(([repository]) => localStorage.setItem(`twig:commit-draft:${repository}`, JSON.stringify({ message: 'still here', coAuthors: [] })), [moving]);
  const moved = path.join(root, 'moved here');
  await rename(moving, moved);
  await refresh();
  await page.locator('.tab', { hasText: 'moving' }).getByText('MISSING', { exact: true }).waitFor();
  await page.getByText('MISSING REPOSITORY', { exact: true }).waitFor();
  await snapshot(page, 'missing');
  await pick(moved);
  await button('Locate…').click();
  const locate = page.getByRole('dialog', { name: 'Locate moving' });
  await locate.getByText(moved, { exact: true }).waitFor();
  await button('Connect here', locate).click();
  await page.locator('.operation-note', { hasText: 'connected at its new location' }).waitFor();
  await history();
  const names = await page.locator('.tab').allInnerTexts();
  assert.equal(names.filter(name => name.includes('moving')).length, 0, 'the old tab is gone');
  assert.equal(names.filter(name => name.includes('moved here')).length, 1, 'and there is one new tab, not a second entry');
  assert.equal((await page.evaluate(repository => window.twig.listMarks(repository), moved))[tip].note, 'follow me');
  assert.equal(await page.evaluate(repository => JSON.parse(localStorage.getItem(`twig:commit-draft:${repository}`)).message, moved), 'still here');
  await rename(moved, path.join(root, 'gone for good'));
  await refresh();
  await button('Remove from list').click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.tab')].some(tab => tab.textContent.includes('moved here')));

  // --- a part of the window that cannot draw ------------------------------------
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.send('mcp:proposal', { id: 'broken' }); });
  await page.locator('.error-boundary').waitFor();
  await button('Copy details').waitFor();
  await snapshot(page, 'error-boundary');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('.error-boundary').waitFor({ state: 'detached' });
  assert.ok(await page.getByRole('region', { name: 'Git actions' }).isVisible(), 'the toolbar is still there');

  assert.deepEqual(errors.filter(text => !text.includes('Cannot read properties of undefined')), [], 'no other page errors');
  console.log('Flows smoke passed: refused push and pull with a way out, Push with lease by its command, honest Stash, stash conflict through the editor, conflict drafts, modify/delete, blame giving way, commit draft, Refresh key, untracked without the index, checks that cancel, git init, unborn panel, bare, Publish to any remote, Locate with everything moved, Remove from list, a failed screen that keeps the window.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
