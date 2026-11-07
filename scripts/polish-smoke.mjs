import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { _electron as electron } from 'playwright';

/**
 * The window under long names and many repositories, at 1000×640: tabs, the
 * repository picker, a row with three branches, a long subject. Every one of
 * these once pushed something off the screen.
 */
const run = promisify(execFile);
const profile = await mkdtemp(path.join(tmpdir(), 'twig-polish-profile-'));
const base = await mkdtemp(path.join(tmpdir(), 'twig-polish-repos-'));
await mkdir('artifacts', { recursive: true });
const git = (cwd, ...args) => run('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd });
const SUBJECT = 'feat(payments): a very long commit subject that keeps going well past what any column could show, so that the panel has to decide what to do with all of it';

const repositories = [];
for (let index = 0; index < 8; index += 1) {
  const cwd = path.join(base, `platform-payments-service-backend-${index}`);
  await mkdir(cwd);
  await git(cwd, 'init', '-b', 'main');
  await writeFile(path.join(cwd, 'a.txt'), 'one\n');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-m', index === 7 ? SUBJECT : 'first');
  repositories.push(cwd);
}
const busy = repositories[7];
await git(busy, 'branch', 'aaa/before-main');
await git(busy, 'branch', 'feature/PAY-12345-rewrite-the-settlement-reconciliation-pipeline');
for (let index = 0; index < 9; index += 1) await writeFile(path.join(busy, `file-${index}.txt`), 'x\n');
await git(busy, 'add', '.');

const env = { ...process.env, TWIG_LANGUAGE: 'en' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.TWIG_DEV;
let app;
const errors = [];
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 640));
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  for (const cwd of repositories) {
    await app.evaluate(({ dialog }, folder) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] }); }, cwd);
    await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
    await page.getByRole('button', { name: 'Open repository', exact: true }).click();
    await page.getByRole('button', { name: `Close ${path.basename(cwd)} tab`, exact: true }).waitFor();
  }

  // A tab has a limit, its close button stays inside it, and more tabs than fit say so.
  const tabs = page.getByRole('navigation', { name: 'Repository tabs', exact: true });
  const tabWidths = await tabs.locator('.tab').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(Math.max(...tabWidths) <= 240, `a tab stays within its limit: ${Math.max(...tabWidths)}`);
  const list = page.getByRole('button', { name: 'All tabs', exact: true });
  await list.waitFor();
  await tabs.evaluate(node => { node.scrollLeft = 0; });
  await page.waitForFunction(() => document.querySelector('.tabs').classList.contains('tabs-more-right'));
  await tabs.evaluate(node => { node.scrollLeft = node.scrollWidth; });
  await page.waitForFunction(() => document.querySelector('.tabs').classList.contains('tabs-more-left'));
  assert.equal(await page.getByRole('button', { name: 'New repository tab', exact: true }).isVisible(), true, 'the plus does not scroll away with the tabs');
  await list.click();
  const tabMenu = page.getByRole('menu', { name: 'All tabs', exact: true });
  assert.equal(await tabMenu.getByRole('menuitemcheckbox').count(), 10, 'every tab is listed: the demo and the New repository tab too');
  assert.equal(await tabMenu.getByRole('menuitemcheckbox', { name: /backend-7/ }).getAttribute('aria-checked'), 'true', 'the open one is ticked');
  await tabMenu.getByRole('menuitemcheckbox', { name: /backend-0/ }).click();
  await page.locator('.tab.active', { hasText: 'backend-0' }).waitFor();
  assert.ok(await page.evaluate(() => {
    const strip = document.querySelector('.tabs').getBoundingClientRect();
    const box = document.querySelector('.tab.active').getBoundingClientRect();
    return box.left >= strip.left - 1 && box.right <= strip.right + 1;
  }), 'the tab chosen from the list scrolls into view');
  await list.click();
  await page.getByRole('menu', { name: 'All tabs', exact: true }).getByRole('menuitemcheckbox', { name: /backend-7/ }).click();
  await page.locator('.tab.active', { hasText: 'backend-7' }).waitFor();

  // The picker cuts a long name with an ellipsis and names it in full on hover.
  const picker = page.locator('#repository-select');
  assert.equal(await picker.getAttribute('title'), path.basename(busy));
  assert.equal(await picker.evaluate(node => getComputedStyle(node).textOverflow), 'ellipsis');

  // The checked-out branch is first on its row, next to the sprout, and filled.
  const row = page.getByRole('option').filter({ hasText: 'feat(payments)' });
  await row.waitFor();
  const badges = row.locator('.ref-badge');
  assert.equal(await badges.first().innerText(), 'main', 'the sprout stands beside the branch it means');
  assert.equal(await badges.first().evaluate(node => node.classList.contains('current-ref')), true);
  assert.equal(await row.locator('.current-ref').count(), 1);
  assert.equal(await badges.nth(1).innerText(), 'aaa/before-main');
  // The menu lists the refs in the same order, after what is done to the commit.
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu').first();
  await menu.waitFor();
  const names = await menu.getByRole('menuitem').evaluateAll(nodes => nodes.map(node => node.textContent));
  const refRows = names.filter(name => /^(main|aaa\/|feature\/)/.test(name));
  assert.deepEqual(refRows.map(name => name.slice(0, 4)), ['main', 'aaa/', 'feat']);
  assert.ok(names.findIndex(name => name.startsWith('Reset main')) < names.indexOf('main'), 'Reset is above the refs');
  const fits = await menu.evaluate(node => { const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, scroll: node.scrollHeight, height: node.clientHeight, window: innerHeight }; });
  assert.ok(fits.top >= 0 && fits.bottom <= fits.window, 'the menu is inside the window');
  assert.ok(fits.scroll <= fits.height + 1, `nothing hides below the fold at 640 px: ${fits.scroll} in ${fits.height}`);
  await page.screenshot({ path: 'artifacts/polish-menu.png', animations: 'disabled' });
  // The submenu opens on hover too, and stays inside the window.
  await menu.getByRole('menuitem', { name: 'aaa/before-main', exact: true }).hover();
  const refMenu = page.getByRole('menu', { name: 'aaa/before-main', exact: true });
  await refMenu.getByRole('menuitem', { name: 'Merge aaa/before-main into main', exact: true }).waitFor();
  const subBox = await refMenu.boundingBox();
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(subBox.x >= 0 && subBox.x + subBox.width <= viewport.width && subBox.y + subBox.height <= viewport.height, 'the submenu is inside the window');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  // A long subject stops at three lines and leaves the files in the panel; details give the rest.
  const tab = page.locator('.workspace-tab:not([hidden])');
  const heading = tab.locator('.commit-subject-heading');
  await heading.waitFor();
  assert.equal(await heading.getAttribute('title'), SUBJECT);
  const clamped = await heading.evaluate(node => ({ height: node.clientHeight, line: Number.parseFloat(getComputedStyle(node).lineHeight), full: node.scrollHeight }));
  assert.ok(clamped.height <= clamped.line * 3 + 1 && clamped.full > clamped.height, 'three lines of a longer subject');
  const filesTop = await tab.locator('.files-heading').evaluate(node => node.getBoundingClientRect().top);
  assert.ok(filesTop < viewport.height - 100, `the files stay on screen: ${filesTop}`);

  // One file needs no view switch, filter or sort; All files stays one click away.
  assert.equal(await tab.getByLabel('Filter commit files').count(), 0);
  assert.equal(await tab.getByLabel('All files').count(), 1);
  await tab.getByLabel('All files').check();
  await tab.getByLabel('Filter commit files').waitFor();
  await tab.getByLabel('All files').uncheck();

  // Close the tab of a repository that went away: the label does not push the cross out.
  await rm(repositories[3], { recursive: true, force: true });
  await page.getByRole('button', { name: `Close ${path.basename(repositories[3])} tab`, exact: true }).scrollIntoViewIfNeeded();
  await tabs.locator('.tab', { hasText: 'backend-3' }).locator('button').first().click();
  await page.getByRole('button', { name: 'Refresh', exact: true }).first().click().catch(() => {});
  const offline = tabs.locator('.tab', { hasText: 'MISSING' });
  await offline.waitFor();
  const inside = await offline.evaluate(node => {
    const tab = node.getBoundingClientRect();
    const strip = document.querySelector('.tabs').getBoundingClientRect();
    const cross = node.querySelector('.button-wrap button').getBoundingClientRect();
    const label = node.querySelector('small').getBoundingClientRect();
    return { inTab: cross.right <= tab.right + 1, inStrip: cross.right <= strip.right + 1, clear: label.right <= cross.left + 1 };
  });
  assert.deepEqual(inside, { inTab: true, inStrip: true, clear: true });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `artifacts/polish-tabs-${theme}.png`, animations: 'disabled' });
  }
  assert.deepEqual(errors, []);
  console.log('polish-smoke: tabs at their limit, list of tabs, picker, current branch first, short commit menu with submenus, long subject, file tools, offline tab.');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
  await rm(base, { recursive: true, force: true });
}
