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
  // File history: the changed-file context menu lists every commit that touched
  // it. hello.txt changed twice — once at the root, once at the tip.
  await page.getByRole('button', { name: 'M hello.txt', exact: true }).click({ button: 'right' });
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
  await fileDiff.getByRole('button', { name: 'Go to commit', exact: true }).click();
  await page.getByRole('heading', { name: 'Real history 🌱', exact: true }).waitFor();
  assert.equal(await fileHistory.count(), 0);

  await page.getByRole('button', { name: 'A renamed.txt', exact: true }).click({ button: 'right' });
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
  await page.getByRole('button', { name: /Uncommitted changes, 1 files/ }).click();
  await page.getByText('untracked.txt', { exact: true }).waitFor();
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
  await page.getByRole('button', { name: 'Clear search results', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.search-results'));
  assert.equal(await search.inputValue(), '');

  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const results = await Promise.allSettled([
      window.twig.getHistoryPage(id, -1, 250), window.twig.getHistoryPage('unregistered', 0, 250),
      window.twig.getCommit(id, '--help'), window.twig.getFileDiff(id, 'a'.repeat(40), '../escape'),
      window.twig.getFileHistory(id, '../escape'), window.twig.getFileHistory(id, '/etc/passwd'),
      window.twig.setMark(id, 'not-an-oid', 'red', ''), window.twig.setMark(id, 'a'.repeat(40), 'crimson', ''),
      window.twig.setMark('unregistered', 'a'.repeat(40), 'red', ''),
      window.twig.searchHistory(id, '   '), window.twig.searchHistory(id, 'x'.repeat(201))
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(11).fill('rejected'));

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

  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme); await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/m2-${theme}.png`, animations: 'disabled' });
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: 'artifacts/m2-compact.png', animations: 'disabled' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  console.log('M2 Electron passed: real repository, two pages, merge, annotated tag, selection, keyboard, tabs, files, diff, worktree, IPC validation, age colours, commit marks, themes.');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
