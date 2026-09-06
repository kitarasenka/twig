import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-drop-smoke-'));
let app;
let page;
try {
  const cwd = path.join(root, 'drag-fixture'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async argv => {
    const result = await runGit({ argv, cwd, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trimEnd();
  };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const add = async (name, text) => { await writeFile(path.join(cwd, name), text); await git(['add', '--', name]); await git(['commit', '-m', text]); return git(['rev-parse', 'HEAD']); };
  const base = await add('base.txt', 'initial garden');
  await git(['switch', '-c', 'feature']);
  const picked = await add('picked.txt', 'single change to copy');
  const feature = await add('feature.txt', 'feature tip');
  await git(['switch', 'main']);
  const main = await add('main.txt', 'main tip');
  await git(['branch', 'target', base]);
  const bare = path.join(root, 'remote.git');
  await git(['init', '--bare', bare]); await git(['remote', 'add', 'origin', bare]);
  await git(['push', 'origin', 'main']);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const graph = page.getByRole('listbox', { name: 'Commit history', exact: true }); await graph.waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('dark'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  const sidebar = ref => page.locator(`.sidebar [data-drag-ref="${ref}"]`);
  const badge = ref => page.locator(`.real-history .ref-badge[data-drag-ref="${ref}"]`);
  const row = oid => page.locator(`#commit-${oid}`);
  const menu = page.getByRole('menu', { name: 'Drag and drop actions' });
  const menuItem = text => menu.getByRole('menuitem').filter({ has: page.getByText(text, { exact: true }) });
  await mkdir('artifacts', { recursive: true });

  await sidebar('refs/heads/feature').dragTo(badge('refs/heads/main'));
  await menu.waitFor();
  await menuItem('Merge feature into main').waitFor();
  assert.equal(await row(feature).evaluate(el => el.classList.contains('drag-source-row')), true);
  assert.equal(await row(main).evaluate(el => el.classList.contains('drag-target-row')), true);
  assert.equal(await git(['rev-parse', 'main']), main, 'drop itself never mutates Git');
  await page.screenshot({ path: 'artifacts/drag-menu-dark.png', animations: 'disabled' });
  await page.keyboard.press('Escape'); await menu.waitFor({ state: 'detached' });
  assert.equal(await page.locator('.drag-source-row, .drag-target-row').count(), 0);

  // Exact remote/local direction is retained even though their tips coincide.
  await sidebar('refs/remotes/origin/main').dragTo(badge('refs/heads/main'));
  await menuItem('Pull origin/main into main').waitFor();
  await page.keyboard.press('Escape');
  await badge('refs/heads/main').dragTo(sidebar('refs/remotes/origin/main'));
  await menuItem('Push main to origin/main').waitFor();
  await page.keyboard.press('Escape');

  // Keyboard uses the same endpoints and action menu.
  await sidebar('refs/heads/feature').focus(); await page.keyboard.press('Alt+d');
  await badge('refs/heads/target').focus(); await page.keyboard.press('Alt+Enter');
  await menuItem('Merge feature into target').click();
  await page.getByRole('dialog').waitFor();
  assert.match(await page.getByRole('dialog').innerText(), /git switch --no-guess -- target/);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await git(['branch', '--show-current']), 'main');

  await row(picked).dragTo(badge('refs/heads/main'));
  await menuItem(`Cherry-pick ${picked.slice(0, 7)} onto main`).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: 'Run cherry-pick', exact: true }).click();
  await page.getByText('Drag and drop action finished.', { exact: true }).waitFor();
  assert.equal(await git(['show', 'main:picked.txt']), 'single change to copy');
  assert.equal(await git(['rev-parse', 'feature']), feature);

  // Mouse drag inside the graph can target a branch other than HEAD.
  await badge('refs/heads/feature').dragTo(badge('refs/heads/target'));
  await menuItem('Merge feature into target').click();
  await page.getByRole('button', { name: 'Run merge', exact: true }).click();
  await page.locator('.git-drag-status').waitFor({ state: 'detached' });
  assert.equal(await git(['rev-parse', 'target']), feature);
  assert.equal(await git(['branch', '--show-current']), 'target');

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('light'); await page.keyboard.press('Escape');
  await sidebar('refs/heads/main').dragTo(sidebar('refs/heads/target'));
  await menu.waitFor();
  await page.screenshot({ path: 'artifacts/drag-menu-light.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.waitForFunction(() => innerWidth === 1000);
  await page.screenshot({ path: 'artifacts/drag-compact-before.png', animations: 'disabled' });
  await sidebar('refs/heads/main').dragTo(sidebar('refs/heads/target'));
  await menu.waitFor();
  const box = await menu.boundingBox(); const size = page.viewportSize() || await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height);
  await page.screenshot({ path: 'artifacts/drag-menu-compact.png', animations: 'disabled' });
  await page.keyboard.press('Escape');

  // Starting from the sidebar reveals the graph even on the branches screen.
  await page.getByRole('button', { name: 'Branches and tags', exact: false }).click();
  await sidebar('refs/heads/main').focus(); await page.keyboard.press('Alt+d');
  await graph.waitFor();
  await sidebar('refs/heads/target').focus(); await page.keyboard.press('Alt+Enter');
  await menuItem('Compare main with target').click();
  await page.getByText('feature.txt', { exact: true }).waitFor();
  assert.equal(await git(['branch', '--show-current']), 'target', 'comparison keeps the current branch');

  // A real held mouse drag scrolls a virtualized history without polling Git.
  await git(['switch', '-c', 'archive', base]);
  for (let index = 0; index < 36; index++) await git(['commit', '--allow-empty', '-m', `older history ${index}`]);
  await git(['switch', 'target']);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await sidebar('refs/heads/archive').waitFor();
  await graph.evaluate(node => { node.scrollTop = 0; });
  const from = await sidebar('refs/heads/main').boundingBox();
  const historyBox = await graph.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2); await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(historyBox.x + 100, historyBox.y + historyBox.height - 12, { steps: 6 });
  await page.mouse.move(historyBox.x + 102, historyBox.y + historyBox.height - 12);
  await page.waitForFunction(() => document.querySelector('.real-history-scroll').scrollTop > 20);
  await page.mouse.move(historyBox.x + 100, historyBox.y - 60, { steps: 3 }); await page.mouse.up();
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.drag-source-row, .drag-target-row').count(), 0);

  const refused = await page.evaluate(async ({ id, oid }) => {
    const request = { action: 'merge', source: { kind: 'local', ref: 'refs/heads/--detach', oid }, target: { kind: 'local', ref: 'refs/heads/main', oid }, head: { oid, branch: 'main' }, mainline: null };
    const rejects = async action => { try { await action(); return false; } catch { return true; } };
    return [await rejects(() => window.twig.runDrop(id, request)), await rejects(() => window.twig.runDrop('/unknown', request))];
  }, { id: cwd, oid: feature });
  assert.deepEqual(refused, [true, true]);
  assert.deepEqual(errors, []);
  console.log('Drop Electron passed: native sidebar/graph drags, highlights, remote direction, keyboard, cancellation, cherry-pick, non-current merge, comparison, autoscroll, themes, compact layout and IPC refusals.');
} catch (error) {
  if (page) {
    console.error(await page.locator('.menu, .git-drag-status, .operation-note, .history-error').allInnerTexts());
    await page.screenshot({ path: 'artifacts/drag-failure.png', animations: 'disabled' });
  }
  throw error;
} finally { if (app) await app.close(); await rm(root, { recursive: true, force: true }); }
