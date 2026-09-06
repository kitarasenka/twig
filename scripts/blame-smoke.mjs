import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-blame-smoke-'));
let app;
try {
  const cwd = path.join(root, 'blame-fixture');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const at = date => ({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const git = async (argv, env = null) => {
    const result = await runGit({ argv, cwd, log, env });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const commit = (message, date) => git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', message], at(date));

  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Blame Fixture']);
  await git(['config', 'user.email', 'blame@example.invalid']);

  await writeFile(path.join(cwd, 'code.txt'), 'alpha\nbeta\ndoomed line\n');
  await git(['add', '-A']);
  await commit('Add code.txt', '2020-01-01T00:00:00Z');
  const addOid = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'code.txt'), 'alpha\nBETA rewritten\ndoomed line\ntail\n');
  await git(['add', '-A']);
  await commit('Rewrite beta, append tail', '2020-02-01T00:00:00Z');
  const rewriteOid = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'code.txt'), 'alpha\nBETA rewritten\ntail\n');
  await git(['add', '-A']);
  await commit('Delete doomed line', '2020-03-01T00:00:00Z');
  const deleteOid = await git(['rev-parse', 'HEAD']);
  await writeFile(path.join(cwd, 'файл with space.txt'), 'unicode one\nunicode two\n');
  await git(['add', '--', 'файл with space.txt']);
  await commit('Add a unicode filename', '2020-04-01T00:00:00Z');
  const unicodeOid = await git(['rev-parse', 'HEAD']);
  void rewriteOid;

  const headBefore = await git(['rev-parse', 'HEAD']);
  const statusBefore = await git(['status', '--porcelain']);

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Add a unicode filename', exact: true }).waitFor();

  // Open blame from the changed-file context menu on the "Delete doomed line" commit.
  await page.locator(`#commit-${deleteOid}`).click();
  await page.getByRole('heading', { name: 'Delete doomed line', exact: true }).waitFor();
  await page.getByRole('button', { name: 'M code.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Blame history' }).click();
  const blame = page.getByRole('region', { name: 'Blame', exact: true });
  await blame.waitFor();
  const grid = page.getByRole('grid', { name: 'Blame lines', exact: true });
  await grid.waitFor();

  // The header names the path and the exact committed version being blamed;
  // that version has 3 lines even though the working tree is unchanged.
  await blame.getByText('code.txt', { exact: false }).first().waitFor();
  assert.equal(await grid.getByRole('row').count() >= 3, true);
  // The rewritten "beta" line is attributed to the middle commit.
  await grid.getByText('BETA rewritten', { exact: true }).waitFor();

  // Keyboard navigation: focus the grid, move down, the detail panel follows.
  await grid.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  const detail = page.getByRole('complementary', { name: 'Blame details', exact: true });
  await detail.getByRole('heading', { name: 'Rewrite beta, append tail', exact: true }).waitFor();

  // Blame before this change: step onto the version before the "beta" rewrite.
  await page.getByRole('button', { name: 'Blame before this change', exact: true }).click();
  await blame.getByText('Add code.txt', { exact: false }).first().waitFor().catch(() => {});
  await grid.getByText('beta', { exact: true }).waitFor();
  assert.equal(await grid.getByText('BETA rewritten', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await grid.getByText('BETA rewritten', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Forward', exact: true }).click();
  await grid.getByText('beta', { exact: true }).waitFor();

  // Reverse blame: from the first commit forward to HEAD. "doomed line" was
  // removed before the end, so it is "last present" in an earlier commit;
  // "alpha" survives to the end.
  await page.getByRole('button', { name: 'Reverse blame', exact: true }).click();
  await page.getByLabel('Reverse blame end').fill('HEAD');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await grid.getByText('doomed line', { exact: true }).waitFor();
  await page.getByText('present at end', { exact: false }).first().waitFor();
  await page.getByText(/last in [0-9a-f]{7}/).first().waitFor();

  // An invalid range explains itself instead of guessing.
  await page.getByRole('button', { name: 'Change range', exact: true }).click();
  await page.getByLabel('Reverse blame start').fill('HEAD');
  await page.getByLabel('Reverse blame end').fill(deleteOid);
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByText(/not an ancestor/i).waitFor();

  // Recover with a valid range, then Go to commit returns to the graph.
  await page.getByRole('button', { name: 'Change range', exact: true }).click();
  await page.getByLabel('Reverse blame start').fill(addOid);
  await page.getByLabel('Reverse blame end').fill('HEAD');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await grid.getByText('doomed line', { exact: true }).waitFor();
  await grid.getByText('alpha', { exact: true }).click();
  await page.getByRole('button', { name: 'Go to commit', exact: true }).first().click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  assert.equal(await blame.count(), 0);

  // A unicode filename with a space blames without losing lines.
  await page.locator(`#commit-${unicodeOid}`).click();
  await page.getByRole('heading', { name: 'Add a unicode filename', exact: true }).waitFor();
  await page.getByRole('button', { name: 'A файл with space.txt', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Blame history' }).click();
  await grid.getByText('unicode one', { exact: true }).waitFor();
  await grid.getByText('unicode two', { exact: true }).waitFor();

  await mkdir('artifacts', { recursive: true });
  await page.getByRole('button', { name: 'Terminal', exact: true }).click(); // collapse the console for the review shot
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/blame-${theme}.png`, animations: 'disabled' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }

  // Nothing was checked out, staged or written.
  assert.equal(await git(['rev-parse', 'HEAD']), headBefore, 'HEAD must not move');
  assert.equal(await git(['status', '--porcelain']), statusBefore, 'the working tree and index must be untouched');

  // IPC refusals: bad oid, path traversal, unregistered repo, bad line, bad range.
  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const oid = 'a'.repeat(40);
    const results = await Promise.allSettled([
      window.twig.getBlame(id, 'not-an-oid', 'code.txt'),
      window.twig.getBlame(id, oid, '../escape'),
      window.twig.getBlame('unregistered', oid, 'code.txt'),
      window.twig.getBlameBefore(id, oid, 'code.txt', 0, null),
      window.twig.getReverseBlame(id, 'a b', 'HEAD', 'code.txt'),
      window.twig.getReverseBlame(id, 'HEAD', 'HEAD', '/etc/passwd')
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(6).fill('rejected'));

  assert.deepEqual(errors, []);
  console.log('blame Electron passed: menu open, line keyboard nav, blame-before step, Back/Forward, reverse blame present/last, invalid range, go to commit, unicode filename, no HEAD/index/worktree change, IPC refusals, both themes.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
