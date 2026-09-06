import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// Drives the M3 staging screen in a real Electron window against a real
// repository: partial staging, unstaging, commit, and the divergence badges
// against a local bare remote.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-worktree-smoke-'));
let app;
try {
  const cwd = path.join(root, 'worktree-fixture');
  const bare = path.join(root, 'remote.git');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };

  await git(['init', '--bare', '--initial-branch=main', bare], root);
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'core.hooksPath', '']);

  const base = Array.from({ length: 10 }, (_, i) => `row${String(i + 1).padStart(2, '0')}`);
  await writeFile(path.join(cwd, 'grid.txt'), `${base.join('\n')}\n`, 'utf8');
  await git(['add', '--', ':(literal)grid.txt']);
  await git(['commit', '--message', 'base commit']);
  await git(['remote', 'add', 'origin', bare]);
  await git(['push', '--set-upstream', 'origin', 'main']);

  // Two independent edits in one file, plus an untracked file.
  const changed = [...base];
  changed[0] = 'ROW01';
  changed[9] = 'ROW10';
  await writeFile(path.join(cwd, 'grid.txt'), `${changed.join('\n')}\n`, 'utf8');
  await writeFile(path.join(cwd, 'fresh.txt'), 'brand new\n', 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);

  // When a step times out, the on-screen error explains why far better than
  // "locator not visible" does.
  const expect = async (text, description) => {
    try {
      await page.getByText(text, { exact: true }).waitFor();
    } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .worktree-notice, .sync-note').allInnerTexts();
      throw new Error(`${description}: expected "${text}". On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };

  const setTheme = async theme => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
  };

  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();

  // Enter the working tree through the row at the top of the graph.
  await page.getByRole('button', { name: /Uncommitted changes, 2 files/ }).click();
  await expect('Working tree · 0 staged, 2 not staged', 'entering the working tree');

  // Open the modified file and stage only the first hunk.
  await page.getByRole('button', { name: 'grid.txt', exact: false }).first().click();
  const diff = page.getByRole('region', { name: /Working tree diff for grid.txt/ });
  await diff.waitFor();
  const hunks = diff.locator('.stage-hunk');
  assert.equal(await hunks.count(), 2, 'the fixture should show two hunks');
  await hunks.first().getByRole('checkbox').first().check();
  await page.getByRole('button', { name: /^Stage 2 selected/ }).click();
  await expect('Staged the selected lines.', 'staging one hunk');
  await expect('Working tree · 1 staged, 2 not staged', 'counts after partial staging');

  // The index really holds only the first edit: ROW01 staged, row10 untouched.
  assert.equal(await git(['show', ':grid.txt']), ['ROW01', ...base.slice(1)].join('\n'),
    'only the first hunk reached the index');

  // Unstage it again from the staged list.
  await page.getByRole('button', { name: 'Unstage grid.txt', exact: true }).click();
  await expect('Working tree · 0 staged, 2 not staged', 'counts after unstaging');

  // The per-section bulk buttons: each covers its own section and nothing else.
  const section = name => page.getByRole('region', { name, exact: true });
  await section('Untracked files').getByRole('button', { name: 'Stage all', exact: true }).click();
  await expect('Staged 1 new path.', 'staging the untracked section');
  await expect('Working tree · 1 staged, 1 not staged', 'counts after staging only the untracked file');
  // Reviewed with the console collapsed: that is the height the lists really
  // get, and both sections carry a bulk button at this point.
  await mkdir('artifacts', { recursive: true });
  const terminal = page.getByRole('button', { name: /^Terminal/ });
  await terminal.click();
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await page.screenshot({ path: `artifacts/m3-bulk-${theme}.png`, animations: 'disabled' });
  }
  await setTheme('dark');
  await terminal.click();

  await section('Unstaged changes').getByRole('button', { name: 'Stage all', exact: true }).click();
  await expect('Staged 1 file.', 'staging the tracked section');
  await expect('Working tree · 2 staged, 0 not staged', 'counts after staging everything');
  assert.equal(await git(['diff', '--cached', '--name-only']), 'fresh.txt\ngrid.txt', 'both files reached the index');

  await section('Staged changes').getByRole('button', { name: 'Unstage all', exact: true }).click();
  await expect('Unstaged 2 files.', 'unstaging everything');
  await expect('Working tree · 0 staged, 2 not staged', 'counts after unstaging everything');
  assert.equal(await git(['diff', '--cached', '--name-only']), '', 'the index is empty again');
  assert.equal(await git(['status', '--porcelain', '--', 'fresh.txt']), '?? fresh.txt', 'the new file is untracked, not deleted');

  // Stage the whole file, then commit from the box.
  await page.getByRole('button', { name: 'Stage grid.txt', exact: true }).click();
  await expect('Working tree · 1 staged, 1 not staged', 'counts after staging the file');
  await page.getByRole('textbox', { name: 'Commit message' }).fill('feat: stage from the working tree screen');
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await expect('Commit created.', 'committing');
  assert.equal(await git(['log', '-1', '--format=%s']), 'feat: stage from the working tree screen');

  // The push badge counts the new local commit, and pushing clears it.
  const push = page.getByRole('button', { name: /^Push/ });
  await push.locator('.badge').getByText('1', { exact: true }).waitFor();
  await push.click();
  await expect('push finished.', 'pushing');
  assert.equal(await git(['rev-parse', 'HEAD']), await git(['rev-parse', 'origin/main']), 'the commit reached the remote');

  // Rejected IPC input: a stale digest and a traversal path must both fail.
  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const results = await Promise.allSettled([
      window.twig.applySelection(id, 'grid.txt', false, 'stale-digest', [{ index: 0, lines: [1] }]),
      window.twig.stageFile(id, '../escape'),
      window.twig.createCommit(id, '   ', false),
      window.twig.stageAll(id, 'everything')
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(4).fill('rejected'));

  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await page.screenshot({ path: `artifacts/m3-${theme}.png`, animations: 'disabled' });
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('M3 Electron passed: line staging, per-section bulk staging, unstaging, commit, push badge, IPC validation, themes.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
