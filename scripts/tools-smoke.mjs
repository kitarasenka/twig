import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';
import { expandRefTree } from './smoke-ref-tree.mjs';

// Worktrees, submodules, commit signatures, patches, cherry-pick and revert of
// a selection, and Git LFS — in a real Electron window against real
// repositories. git-lfs is a stand-in on PATH (Git runs `git-lfs` from there),
// so the run needs no LFS server and makes no network request.

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-tools-smoke-')));
let app;
try {
  const cwd = path.join(root, 'app');
  const lib = path.join(root, 'lib');
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  const init = async at => {
    await git(['init', '--initial-branch=main', at], root);
    for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value], at);
  };
  const commit = async (file, text, message, at = cwd, extra = []) => {
    await mkdir(path.dirname(path.join(at, file)), { recursive: true });
    await writeFile(path.join(at, file), text, 'utf8');
    await git(['add', '--', `:(literal)${file}`], at);
    await git(['commit', ...extra, '--message', message], at);
    return git(['rev-parse', 'HEAD'], at);
  };
  const pointer = (oid, size) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

  await init(lib); await commit('lib.txt', 'lib\n', 'lib v1', lib);
  await init(cwd);
  await commit('app.txt', 'base\n', 'Base');
  await git(['-c', 'protocol.file.allow=always', 'submodule', 'add', lib, 'vendor/lib']);
  await git(['commit', '--message', 'Add the lib submodule']);
  await commit('assets/.gitattributes', '*.psd filter=lfs diff=lfs merge=lfs -text\n', 'Track art in LFS');
  await commit('assets/art.psd', pointer('a'.repeat(64), 1000), 'Add art');
  await commit('assets/art.psd', pointer('b'.repeat(64), 2_500_000), 'New art');
  let signing = true;
  try {
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', path.join(root, 'signing')]);
    await writeFile(path.join(root, 'allowed_signers'), `fixture@example.invalid ${(await readFile(path.join(root, 'signing.pub'), 'utf8')).trim()}\n`);
    for (const [key, value] of [['gpg.format', 'ssh'], ['user.signingKey', path.join(root, 'signing.pub')], ['gpg.ssh.allowedSignersFile', path.join(root, 'allowed_signers')], ['gpg.ssh.program', 'ssh-keygen']]) await git(['config', key, value]);
    await commit('signed.txt', 'signed\n', 'Signed commit', cwd, ['-S']);
  } catch { signing = false; }
  await git(['checkout', '-b', 'side']);
  const sideOne = await commit('side.txt', 'one\n', 'Side one');
  const sideTwo = await commit('side.txt', 'one\ntwo\n', 'Side two');
  await git(['checkout', 'main']);
  const mainTip = await commit('app.txt', 'base\nmain work\n', 'Main work');

  // The stand-in git-lfs: pointers until `pull`, then content.
  const bin = path.join(root, 'bin'); await mkdir(bin);
  const pulled = path.join(root, 'lfs-pulled');
  await writeFile(path.join(bin, 'git-lfs'), `#!/bin/sh
case "$1" in
  version) echo "git-lfs/3.4.1 (stand-in)";;
  ls-files) if [ -f "${pulled}" ]; then echo "${'b'.repeat(64)} * assets/art.psd"; else echo "${'b'.repeat(64)} - assets/art.psd"; fi;;
  pull) touch "${pulled}";;
  *) exit 2;;
esac
`);
  await chmod(path.join(bin, 'git-lfs'), 0o755);

  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const stubOpen = file => app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, file);
  const stubSave = file => app.evaluate(({ dialog }, target) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: target }); }, file);
  const expect = async (text, description) => {
    try { await page.getByText(text).first().waitFor(); } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .operation-note').allInnerTexts();
      throw new Error(`${description}: expected ${text}. On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };
  const row = name => page.getByRole('option', { name });
  const menu = page.getByRole('menu');

  await stubOpen(cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const id = await page.evaluate(() => window.twig.getWorkspace()).then(workspace => workspace.repositories.find(item => !item.sandbox).id);
  if (await page.getByRole('textbox', { name: 'Search command log' }).isVisible()) await page.locator('.console-status').click();

  // --- Git LFS: the banner counts pointers, the download replaces them. ---
  await expect(/1 of 1\s+Git LFS file is still a pointer here/, 'LFS banner');
  await page.getByRole('button', { name: 'Download (git lfs pull)', exact: true }).click();
  await expect('Git LFS files downloaded.', 'lfs pull');
  await page.locator('.lfs-banner').waitFor({ state: 'detached' }); // nothing is a pointer any more
  await row(/New art/).click();
  await page.locator('.commit-file').filter({ hasText: 'assets/art.psd' }).click();
  await expect('Replaced in Git LFS: 1000 B → 2.4 MB', 'LFS pointer diff reads as a stored file');
  const lfsCard = page.getByRole('group', { name: 'Git LFS file' });
  await lfsCard.screenshot({ path: 'artifacts/tools-lfs-card.png' });
  await lfsCard.getByRole('button', { name: 'Show pointer text' }).click();
  await page.locator('.diff-lines').filter({ hasText: 'oid sha256:' }).first().waitFor();
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();

  // --- Signature: verified against the allowed signers file; others say Not signed. ---
  if (signing) {
    await row(/Signed commit/).click();
    await page.locator('.signature-line.signature-good').filter({ hasText: 'Verified signature' }).waitFor();
    await page.locator('.signature-line').screenshot({ path: 'artifacts/tools-signature.png' });
  } else console.log('ssh-keygen unavailable: the signature step is skipped.');
  await row(/Main work/).click();
  const toggle = page.locator('.details-toggle');
  await toggle.waitFor();
  if ((await toggle.innerText()) === 'Show details') await toggle.click();
  await page.locator('.metadata').filter({ hasText: 'SignatureNot signed' }).waitFor();
  assert.equal(await page.locator('.signature-line').count(), 0, 'an unsigned commit shows no verdict line, only the detail row');

  // --- Cherry-pick a selection, oldest first, then Undo it. ---
  await row(/Side one/).click();
  await row(/Side two/).click({ modifiers: ['ControlOrMeta'] });
  await row(/Side two/).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Revert 2 commits/ }).waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: /Revert 2 commits/ }).isDisabled(), true, 'commits off the branch are not reverted from here');
  await menu.getByRole('menuitem', { name: /Cherry-pick 2 commits onto main/ }).click();
  const pickDialog = page.getByRole('dialog', { name: 'Cherry-pick 2 commits' });
  await pickDialog.getByText(`$ git cherry-pick ${sideOne} ${sideTwo}`).waitFor();
  await pickDialog.getByRole('button', { name: 'Cherry-pick 2 commits', exact: true }).click();
  await expect('Cherry-picked 2 commits.', 'cherry-pick of a selection');
  assert.equal(await git(['log', '--format=%s', '-3']), 'Side two\nSide one\nMain work', 'both commits, in the order they were made');
  const undoState = await page.evaluate(repo => window.twig.getUndoState(repo), id);
  assert.equal(undoState.undo, true, `Undo is offered after the run: ${undoState.undoReason}`);
  // Undo is a reset --hard, which main confirms in a native box; the stub records what it showed.
  await app.evaluate(({ dialog }) => {
    globalThis.twigShownBoxes = [];
    dialog.showMessageBox = async (_window, options) => { globalThis.twigShownBoxes.push(options.detail); return { response: 1 }; };
  });
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect('Undo completed.', 'Undo of the whole run');
  assert.match((await app.evaluate(() => globalThis.twigShownBoxes))[0], new RegExp(`"reset" "--hard" "${mainTip}"`), 'the confirmation named the exact reset');
  assert.equal(await git(['rev-parse', 'HEAD']), mainTip, 'one Undo takes the whole run back');
  // The graph re-reads history after the Undo; its rows are used only once it has.
  await page.waitForFunction(() => [...document.querySelectorAll('[role="option"]')].filter(item => item.textContent.includes('Side one')).length === 1);

  // --- Patches: export a commit, then apply it back as a commit. ---
  const patchFile = path.join(root, 'side one.patch');
  await stubSave(patchFile);
  await row(/Side one/).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /^Export .* as a patch/ }).click();
  await expect(`Patch saved to ${patchFile}.`, 'export');
  assert.match(await readFile(patchFile, 'utf8'), /^From [0-9a-f]{40} /);
  await stubOpen(patchFile);
  await page.getByRole('button', { name: 'Patch', exact: true }).click();
  const patchDialog = page.getByRole('dialog', { name: 'Apply side one.patch' });
  await patchDialog.getByText('$ git am --3way -- "side one.patch"').waitFor();
  await patchDialog.getByText('Applies cleanly to the current files.').waitFor();
  await patchDialog.screenshot({ path: 'artifacts/tools-patch-dialog.png' });
  await patchDialog.getByRole('button', { name: 'Apply commit', exact: true }).click();
  await expect('Patch applied as commits.', 'am');
  assert.equal(await git(['log', '--format=%s|%an', '-1']), 'Side one|Twig Fixture');
  assert.notEqual(await git(['rev-parse', 'HEAD']), sideOne, 'a new commit on main with the same change');

  // --- Worktrees: open a branch in a new worktree from its menu. ---
  const sidebar = page.getByRole('complementary', { name: 'Repository navigation' });
  await expandRefTree(page);
  await sidebar.locator('.real-branch', { hasText: /^side/ }).first().click({ button: 'right' });
  await page.getByRole('menu', { name: 'Actions for side' }).getByRole('menuitem', { name: /Open side in a new worktree/ }).click();
  const worktreeDialog = page.getByRole('dialog', { name: 'New worktree' });
  await worktreeDialog.getByText(`$ git worktree add -- ${cwd}-side side`).waitFor();
  await worktreeDialog.screenshot({ path: 'artifacts/tools-worktree-dialog.png' });
  await worktreeDialog.getByRole('button', { name: 'Create and open', exact: true }).click();
  await page.locator('.tab.active').filter({ hasText: 'app-side' }).waitFor();
  assert.equal(await git(['branch', '--show-current'], `${cwd}-side`), 'side');
  await page.locator('.workspace-tab:not([hidden])').getByRole('button', { name: 'Worktrees' }).click();
  const worktreeList = page.locator('.workspace-tab:not([hidden])').getByRole('list', { name: 'Worktrees' });
  await worktreeList.locator('li').filter({ hasText: 'This tab' }).filter({ hasText: 'app-side' }).waitFor();
  assert.equal(await worktreeList.locator('li').count(), 2);
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/tools-worktrees-${theme}.png`, animations: 'disabled' });
  }
  // Remove it from the main worktree's tab: its own tab goes with it.
  await page.getByRole('button', { name: 'app', exact: true }).click();
  await page.locator('.tab.active').filter({ hasText: /^app$/ }).waitFor();
  await page.locator('.workspace-tab:not([hidden])').getByRole('button', { name: 'Worktrees' }).click();
  const mainList = page.locator('.workspace-tab:not([hidden])').getByRole('list', { name: 'Worktrees' });
  const boardDetail = page.locator('.workspace-tab:not([hidden]) .board-detail');
  await mainList.locator('li').filter({ hasText: 'app-side' }).getByRole('button').click();
  await boardDetail.getByRole('button', { name: 'Remove…', exact: true }).click();
  const removeDialog = page.getByRole('dialog', { name: 'Remove worktree app-side' });
  await removeDialog.getByText(`$ git worktree remove -- ${cwd}-side`).waitFor();
  await removeDialog.getByRole('button', { name: 'Remove worktree', exact: true }).click();
  await page.getByText('Worktree app-side removed.').waitFor();
  await assert.rejects(stat(`${cwd}-side`), /ENOENT/);
  assert.equal(await page.locator('.tab').filter({ hasText: 'app-side' }).count(), 0, 'its tab is gone too');
  assert.equal(await git(['rev-parse', 'side']), sideTwo, 'the branch stays');

  // --- An agent worktree: created on the board, worked in, reviewed, squashed into main, removed with its branch. ---
  await page.locator('.workspace-tab:not([hidden])').getByRole('button', { name: 'New agent worktree…' }).click();
  const agentDialog = page.getByRole('dialog', { name: 'New agent worktree' });
  await agentDialog.getByRole('textbox', { name: 'Task name' }).fill('fix-login');
  const agentFolder = path.join(cwd, '.claude', 'worktrees', 'fix-login');
  const baseTip = await git(["rev-parse", "HEAD"]);
  await agentDialog.getByText(`$ git worktree add -b agent/fix-login -- ${agentFolder} ${baseTip}`).waitFor();
  await agentDialog.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText(/Agent worktree created in .*fix-login on agent\/fix-login\./).waitFor();
  assert.equal(await page.locator('.tab').filter({ hasText: 'fix-login' }).count(), 0, 'an agent worktree does not open a tab');
  assert.equal(await git(['status', '--porcelain', '--', '.claude']), '', 'the main checkout ignores it');
  const agentCard = mainList.locator('li').filter({ hasText: 'fix-login' });
  await agentCard.getByText('Agent', { exact: true }).waitFor();
  await agentCard.getByRole('button').click();
  await boardDetail.getByText(`cd '${agentFolder}' && claude`, { exact: true }).waitFor();
  await boardDetail.getByRole('button', { name: 'Copy command' }).click();
  await page.locator('.operation-note').filter({ hasText: 'Copied: cd' }).waitFor().catch(async error => {
    console.log('notes:', await page.locator('.operation-note').allTextContents()); throw error;
  });
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), `cd '${agentFolder}' && claude`);
  // The agent works in its folder, outside 🌱 Twig.
  await commit('login.txt', 'login\n', 'feat: add login', agentFolder);
  await commit('login.txt', 'login\nlogout\n', 'feat: add logout', agentFolder);
  await writeFile(path.join(agentFolder, 'notes.md'), 'todo\n');
  await page.locator('.workspace-tab:not([hidden]) .worktree-board').getByRole('button', { name: 'Refresh', exact: true }).click();
  await agentCard.getByText(/^2 commits ahead of main/).waitFor();
  await agentCard.getByText('1 file not committed (1 new)').waitFor();
  await boardDetail.getByText('Since it left main: 2 commits, 1 file not committed — 2 files changed in all.').waitFor();
  const reviewFiles = boardDetail.getByRole('list', { name: 'Files this worktree changed' });
  await reviewFiles.getByRole('button', { name: /login\.txt/ }).click();
  await boardDetail.locator('.diff-view').getByText('logout').waitFor();
  await reviewFiles.getByRole('button', { name: /notes\.md/ }).click();
  await boardDetail.locator('.diff-view').getByText('todo').waitFor();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/worktree-board-${theme}.png`, animations: 'disabled' });
  }
  // A second agent on the same task: the two side by side.
  const twin = path.join(cwd, '.claude', 'worktrees', 'fix-login-b');
  await git(['worktree', 'add', '-q', '-b', 'agent/fix-login-b', twin, baseTip]);
  await commit('login.txt', 'login\n', 'feat: login only', twin);
  await page.locator('.workspace-tab:not([hidden]) .worktree-board').getByRole('button', { name: 'Refresh', exact: true }).click();
  await mainList.locator('li').filter({ hasText: 'fix-login-b' }).waitFor();
  await boardDetail.getByLabel('Compare with').selectOption({ label: 'fix-login-b (agent/fix-login-b)' });
  const compareTable = boardDetail.getByRole('table', { name: 'Files changed in fix-login or fix-login-b' });
  await compareTable.getByRole('row', { name: /notes\.md/ }).getByText('unchanged').waitFor();
  await compareTable.getByRole('row', { name: /login\.txt/ }).getByText('+2 −0').waitFor();
  await compareTable.getByRole('button', { name: 'login.txt' }).click();
  await boardDetail.locator('.diff-view').getByText('logout').waitFor();
  await page.screenshot({ path: 'artifacts/worktree-compare.png', animations: 'disabled' });
  await boardDetail.getByRole('button', { name: 'Stop comparing' }).click();
  await boardDetail.getByRole('list', { name: 'Files this worktree changed' }).waitFor();
  await git(['worktree', 'remove', '--force', twin]);
  await git(['branch', '-D', 'agent/fix-login-b']);
  await page.locator('.workspace-tab:not([hidden]) .worktree-board').getByRole('button', { name: 'Refresh', exact: true }).click();
  await mainList.locator('li').filter({ hasText: 'fix-login-b' }).waitFor({ state: 'detached' });

  await boardDetail.getByRole('button', { name: 'Squash into main…' }).click();
  const squashDialog = page.getByRole('dialog', { name: 'Squash agent/fix-login into main' });
  await squashDialog.getByText(/^1 file in this worktree is not committed and will not be included/).waitFor();
  assert.equal(await squashDialog.getByLabel(/Message/).inputValue(), 'feat: add login\n\n* feat: add login\n* feat: add logout');
  const agentTip = await git(['rev-parse', 'HEAD'], agentFolder);
  await squashDialog.getByText(`$ git merge --squash --no-autostash ${agentTip}`).waitFor();
  await squashDialog.screenshot({ path: 'artifacts/worktree-squash.png' });
  await squashDialog.getByLabel(/Message/).fill('feat: login and logout');
  await squashDialog.getByRole('button', { name: 'Squash into main', exact: true }).click();
  await page.getByText(/agent\/fix-login squashed into main as [0-9a-f]{7}\./).waitFor();
  assert.equal(await git(['log', '-1', '--format=%s']), 'feat: login and logout');
  assert.equal(await git(["rev-parse", "HEAD^"]), baseTip, "one commit on main");
  await agentCard.getByText('Squashed into main').waitFor();
  await rm(path.join(agentFolder, 'notes.md'));
  await page.locator('.workspace-tab:not([hidden]) .worktree-board').getByRole('button', { name: 'Refresh', exact: true }).click();
  await agentCard.getByText('Nothing uncommitted').waitFor();
  await boardDetail.getByRole('button', { name: 'Remove worktree and branch…' }).click();
  const finishDialog = page.getByRole('dialog', { name: 'Remove fix-login and agent/fix-login' });
  await finishDialog.getByText(`$ git worktree remove -- ${agentFolder}`).waitFor();
  await finishDialog.getByText('$ git branch -D -- agent/fix-login').waitFor();
  await finishDialog.getByRole('button', { name: 'Remove worktree and branch', exact: true }).click();
  await page.getByText('Worktree fix-login and branch agent/fix-login removed.').waitFor();
  await assert.rejects(stat(agentFolder), /ENOENT/);
  assert.equal((await runGit({ argv: ['rev-parse', '--verify', '--quiet', 'refs/heads/agent/fix-login'], cwd, log })).code, 1);
  await agentCard.waitFor({ state: 'detached' });
  assert.equal(await mainList.locator('li').count(), 1);

  // --- Submodules: pinned, and open as a tab of its own. ---
  await page.locator('.workspace-tab:not([hidden])').getByRole('button', { name: 'Submodules' }).click();
  const subList = page.locator('.workspace-tab:not([hidden])').getByRole('list', { name: 'Submodules' });
  const libRow = subList.locator('li').filter({ hasText: 'vendor/lib' });
  await libRow.getByText(/Checked out at the pinned commit/).waitFor();
  await page.screenshot({ path: 'artifacts/tools-submodules.png', animations: 'disabled' });
  await libRow.getByRole('button', { name: 'Open as tab' }).click();
  await page.locator('.tab.active').filter({ hasText: 'lib' }).waitFor();

  // --- Refusals at the channels. ---
  const one = sideOne;
  await assert.rejects(page.evaluate(([repo, oid]) => window.twig.cherryPickMany(repo, [oid]), [id, one]), /2 and 100/);
  await assert.rejects(page.evaluate(repo => window.twig.exportPatches(repo, ['--output=/tmp/x']), id), /Invalid commit/);
  await assert.rejects(page.evaluate(repo => window.twig.applyPatchCommits(repo, 'not-a-token'), id), /again/);
  await assert.rejects(page.evaluate(repo => window.twig.updateSubmodules(repo, ['../outside']), id), /Invalid submodule/);
  await assert.rejects(page.evaluate(repo => window.twig.openWorktree(repo, '/etc'), id), /no such worktree/);
  await assert.rejects(page.evaluate(repo => window.twig.addWorktree(repo, { token: 'x', branch: 'side', create: false }), id), /again/);
  await assert.rejects(page.evaluate(repo => window.twig.getSignature(repo, 'HEAD'), id), /Invalid commit/);
  await assert.rejects(page.evaluate(repo => window.twig.getWorktreeReview(repo, '/etc'), id), /no such worktree/);
  await assert.rejects(page.evaluate(repo => window.twig.getWorktreeFileDiff(repo, '/etc', 'x', 'yes'), id), /Invalid/);
  await assert.rejects(page.evaluate(repo => window.twig.squashWorktree(repo, '/etc', { message: 'x', branchOid: 'main', baseOid: 'main' }), id), /Invalid commit/);
  await assert.rejects(page.evaluate(repo => window.twig.planWorktree(repo, 'x', 'anywhere'), id), /Invalid worktree/);
  await assert.rejects(page.evaluate(repo => window.twig.finishWorktree(repo, '/etc'), id), /no such worktree/);
  await assert.rejects(page.evaluate(repo => window.twig.compareWorktrees(repo, '/etc', '/etc'), id), /two different/);
  await assert.rejects(page.evaluate(repo => window.twig.getWorktreeCompareDiff(repo, '/etc', '/tmp', '../x'), id), /Invalid file path/);
  await assert.rejects(page.evaluate(() => window.twig.getLfsStatus('not-a-repository')), /unavailable/);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Tools smoke passed: LFS banner and git lfs pull, LFS pointer card, verified SSH signature, cherry-pick of a selection with one Undo, patch export and am, worktree from the branch menu opened as a tab and removed with it, an agent worktree created, reviewed, compared with a second one, squashed into main and removed with its branch, submodule opened as a tab, 15 IPC refusals.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
