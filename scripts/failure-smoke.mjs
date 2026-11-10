/* global window -- page.evaluate callbacks run in the window */
import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';
import { expandRefTree } from './smoke-ref-tree.mjs';

// A failure says what happened and offers the way out, in a real window
// against a real repository: a lock Git left in .git (stage and commit both
// fail on it; Remove the lock… asks, removes, and the same action then works),
// a commit with nobody to commit as (Open Git profile), and a detached HEAD —
// the staging screen says a new commit would be on no branch, and checking
// out a branch from there asks before leaving commits to the reflog.

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-failure-smoke-')));
const exists = file => stat(file).then(() => true, () => false);
let app;
try {
  // Only the repository's own config says who commits: nothing from this computer.
  const globalConfig = path.join(root, 'gitconfig');
  await writeFile(globalConfig, '');
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  const log = new CommandLog(path.join(root, 'journal'));
  await log.load();
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const git = async (...argv) => {
    const result = await runGit({ argv, cwd: repo, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git('init', '--initial-branch=main');
  await git('config', 'user.name', 'Twig Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await git('config', 'user.useConfigOnly', 'true');
  await writeFile(path.join(repo, 'a.txt'), 'one\n');
  await git('add', 'a.txt');
  await git('commit', '--message', 'first');
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\n');
  const gitDir = path.join(repo, '.git');
  const lock = path.join(gitDir, 'index.lock');
  await mkdir('artifacts', { recursive: true });

  const env = { ...process.env, TWIG_LANGUAGE: 'en' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const button = (name, scope = page) => scope.getByRole('button', { name, exact: true });
  await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, repo);
  await button('New repository tab').click();
  await button('Open repository').click();
  await page.locator('.real-commit-row:visible').first().waitFor();
  await page.getByRole('button', { name: /^Uncommitted changes/ }).click();
  await button('Open staging').click();
  const staged = page.getByRole('region', { name: 'Staged changes', exact: true });
  await staged.waitFor();
  const strip = page.locator('.worktree-screen .history-error');
  const refresh = () => page.locator('.toolbar').getByRole('button', { name: 'Refresh', exact: true }).click();
  // Files changed behind the window's back: the staging screen reads them when it opens.
  async function reopenStaging() {
    await button('Back to history').click();
    await refresh();
    await page.getByRole('button', { name: /^Uncommitted changes/ }).click();
    await button('Open staging').click();
    await staged.waitFor();
  }

  // --- a lock left in .git: the reason, the button, and the same action again ---
  await writeFile(lock, '');
  await button('Stage a.txt').click();
  await strip.getByText('Git found index.lock left over', { exact: false }).waitFor();
  assert.match(await strip.locator('.note-detail').innerText(), /index\.lock': File exists/, 'Git’s own line is under the sentence');
  await page.screenshot({ path: 'artifacts/failure-lock.png', animations: 'disabled' });
  await button('Remove the lock…', strip).click();
  const lockDialog = page.getByRole('dialog', { name: 'Remove the Git lock?' });
  await lockDialog.waitFor();
  assert.ok((await lockDialog.locator('code').innerText()).endsWith(`${path.sep}index.lock`), 'the dialog names the file');
  await button('Cancel', lockDialog).click();
  assert.equal(await exists(lock), true, 'Cancel removes nothing');
  await button('Remove the lock…', strip).click();
  await button('Remove the lock', lockDialog).click();
  await page.getByText('Lock removed. Try the action again.').waitFor();
  assert.equal(await exists(lock), false);
  await button('Stage a.txt').click();
  await staged.getByText('a.txt').waitFor();
  assert.equal(await strip.count(), 0, 'the failure is gone once the action works');

  // Commit, with the lock back: same reason, same way out, then the commit.
  await page.locator('#commit-message').fill('second');
  await writeFile(lock, '');
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await strip.getByText('Git found index.lock left over', { exact: false }).waitFor();
  await button('Remove the lock…', strip).click();
  await button('Remove the lock', lockDialog).click();
  await page.getByText('Lock removed. Try the action again.').waitFor();
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await page.getByText('Commit created.').waitFor();
  assert.equal(await git('log', '-1', '--format=%s'), 'second');
  const removal = (await page.evaluate(() => window.twig.getConsoleEntries())).find(entry => entry.executable === '🌱 Twig' && entry.argv[0] === 'remove');
  assert.ok(removal, 'the removal is in the journal');

  // Main refuses what is not a lock of this repository, whatever the window sends.
  const id = await page.evaluate(async folder => (await window.twig.getWorkspace()).repositories.find(item => item.path === folder)?.id, repo);
  const outside = path.join(root, 'outside.lock');
  await writeFile(outside, '');
  assert.equal((await page.evaluate(([repository, file]) => window.twig.removeGitLock(repository, file), [id, outside])).ok, false);
  assert.equal(await exists(outside), true);
  for (const bad of [['relative.lock'], [42], [path.join(gitDir, 'HEAD')], []]) {
    await assert.rejects(page.evaluate(([repository, args]) => window.twig.removeGitLock(repository, ...args), [id, bad]), undefined, JSON.stringify(bad));
  }
  await assert.rejects(page.evaluate(() => window.twig.countDetachedCommits('no-such-repository')));

  // --- nobody to commit as: the note opens the Git profile ---
  await git('config', '--unset', 'user.email');
  await writeFile(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  await reopenStaging();
  await button('Stage a.txt').click();
  await staged.getByText('a.txt').waitFor();
  await page.locator('#commit-message').fill('third');
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await strip.getByText('Git does not know who you are yet', { exact: false }).waitFor();
  await button('Open Git profile', strip).click();
  await page.getByRole('dialog', { name: 'Git profile' }).waitFor();
  await page.keyboard.press('Escape');
  await git('config', 'user.email', 'fixture@example.invalid');
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await page.getByText('Commit created.').waitFor();

  // --- a detached HEAD: said on the staging screen, asked about before leaving ---
  await git('checkout', '--detach');
  await git('commit', '--allow-empty', '--message', 'detached work');
  const detachedOid = await git('rev-parse', 'HEAD');
  await button('Back to history').click();
  await refresh();
  await writeFile(path.join(repo, 'b.txt'), 'new\n');
  await refresh();
  await page.getByRole('button', { name: /^Uncommitted changes/ }).click();
  await button('Open staging').click();
  const detachedStrip = page.locator('.detached-strip');
  await detachedStrip.getByText('HEAD is detached', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/failure-detached.png', animations: 'disabled' });
  await button('Back to history').click();
  await rm(path.join(repo, 'b.txt'));
  await refresh();

  const sidebar = page.locator('.sidebar-sections');
  await expandRefTree(page);
  const leave = page.getByRole('dialog', { name: 'Leave commits on no branch?' });
  await sidebar.locator('.real-branch[title^="refs/heads/main"]').dblclick();
  await leave.getByText('1 commit here is on no branch', { exact: false }).waitFor();
  await page.screenshot({ path: 'artifacts/failure-leave-detached.png', animations: 'disabled' });
  await button('Cancel', leave).click();
  assert.equal(await git('rev-parse', '--symbolic-full-name', 'HEAD'), 'HEAD', 'Cancel stays where HEAD was');
  // Keep them on a branch, then go.
  await sidebar.locator('.real-branch[title^="refs/heads/main"]').dblclick();
  await button('Create branch first…', leave).click();
  await page.locator('#ref-name').fill('keep/work');
  await button('Create branch').click();
  await page.getByText('Checked out main.').waitFor();
  assert.equal(await git('rev-parse', 'keep/work'), detachedOid, 'the branch holds the detached commit');
  assert.equal(await git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  // Check out anyway: the commit is left to the reflog, as said.
  await git('checkout', '--detach');
  await git('commit', '--allow-empty', '--message', 'left behind');
  await refresh();
  await page.locator('.real-commit-row', { hasText: 'left behind' }).waitFor();
  await sidebar.locator('.real-branch[title^="refs/heads/main"]').dblclick();
  await button('Check out anyway', leave).click();
  await page.getByText('Checked out main.').waitFor();
  assert.equal(await git('rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  // On a branch nothing is asked.
  await expandRefTree(page);
  await sidebar.locator('.real-branch[title^="refs/heads/keep/work"]').dblclick();
  await page.getByText('Checked out keep/work.').waitFor();
  assert.equal(await leave.count(), 0);

  assert.deepEqual(errors, []);
  console.log('failure smoke: lock removed and retried, identity, detached HEAD strip and question');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
