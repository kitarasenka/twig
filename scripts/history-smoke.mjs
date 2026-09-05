import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  const git = async argv => {
    const result = await runGit({ cwd, log, argv });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.replace(/\n$/, '');
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(cwd, 'hello.txt'), 'Hello Twig\r\n');
  await git(['add', '--', 'hello.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Root fixture']);
  const initial = await git(['rev-parse', 'HEAD']);
  const tree = await git(['rev-parse', 'HEAD^{tree}']);
  const feature = await git(['commit-tree', tree, '-p', initial, '-m', 'Feature branch']);
  await git(['update-ref', 'refs/heads/feat/graph/curves', feature]);
  let parent = await git(['commit-tree', tree, '-p', initial, '-p', feature, '-m', 'Merge feature branch']);
  for (let i = 0; i < 255; i++) parent = await git(['commit-tree', tree, '-p', parent, '-m', `History fixture ${i}`]);
  await git(['update-ref', 'refs/heads/main', parent]);
  await writeFile(path.join(cwd, 'hello.txt'), 'Hello real history\r\n');
  await git(['add', '--', 'hello.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Real history 🌱', '-m', 'Full body\nWith another line.']);
  const tip = await git(['rev-parse', 'HEAD']);
  await git(['-c', 'tag.gpgsign=false', 'tag', '-a', 'v-test', '-m', 'Annotated tag']);
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
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  assert.ok(await list.getByRole('option').count() < 60);
  await page.getByRole('button', { name: 'M hello.txt', exact: true }).click();
  await page.getByRole('region', { name: 'File diff' }).waitFor().catch(() => {});
  await page.getByText('+Hello real history', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  await list.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'History fixture 254', exact: true }).waitFor();
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'history-fixture', exact: true }).click();
  await page.getByRole('heading', { name: 'History fixture 254', exact: true }).waitFor();
  await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByText('259 loaded', { exact: true }).waitFor();
  await page.getByRole('button', { name: /curves/ }).click();
  await page.getByRole('heading', { name: 'Feature branch', exact: true }).waitFor();
  await page.getByRole('button', { name: /Uncommitted changes, 1 files/ }).click();
  await page.getByText('untracked.txt', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const results = await Promise.allSettled([
      window.twig.getHistoryPage(id, -1, 250), window.twig.getHistoryPage('unregistered', 0, 250),
      window.twig.getCommit(id, '--help'), window.twig.getFileDiff(id, 'a'.repeat(40), '../escape')
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(4).fill('rejected'));
  await mkdir('artifacts', { recursive: true });
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme); await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/m2-${theme}.png`, animations: 'disabled' });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: 'artifacts/m2-compact.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('M2 Electron passed: real repository, two pages, merge, annotated tag, selection, keyboard, tabs, files, diff, worktree, IPC validation, themes.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
