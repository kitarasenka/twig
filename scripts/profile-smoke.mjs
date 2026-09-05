import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-profile-smoke-'));
let app;
try {
  const cwd = path.join(root, 'profile-fixture'); await mkdir(cwd);
  const isolation = { GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1' };
  const log = new CommandLog(root); await log.load();
  const git = async argv => {
    const result = await runGit({ cwd, log, env: isolation, argv });
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '--initial-branch=main']);
  const env = { ...process.env, ...isolation }; delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'app')}`], env });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const openProfile = () => page.getByRole('button', { name: 'Git profile', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Git profile' });
  const name = dialog.locator('input[id="profile-user.name"]');
  const saveName = () => dialog.getByRole('button', { name: 'Save Name', exact: true }).click();
  await openProfile(); await name.fill('Global Twig'); await saveName();
  await dialog.getByText('user.name saved globally.', { exact: true }).waitFor();
  assert.equal(await git(['config', '--global', 'user.name']), 'Global Twig');
  await page.keyboard.press('Escape');
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  await openProfile(); await name.waitFor(); assert.equal(await name.inputValue(), '');
  await name.fill('Local Twig'); await saveName();
  await dialog.getByText('user.name saved for this repository.', { exact: true }).waitFor();
  assert.equal(await git(['config', '--local', 'user.name']), 'Local Twig');
  assert.equal(await git(['config', '--global', 'user.name']), 'Global Twig');
  await git(['config', '--local', 'user.name', 'External Twig']);
  await name.fill('Stale change'); await saveName(); await dialog.getByRole('alert').waitFor();
  assert.equal(await git(['config', '--local', 'user.name']), 'External Twig');
  await dialog.getByRole('button', { name: 'Reload profile', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('profile-user.name')?.value === 'External Twig');
  await dialog.getByRole('button', { name: 'Remove Name setting', exact: true }).click();
  await dialog.getByText('user.name removed for this repository.', { exact: true }).waitFor();
  assert.equal(await git(['config', 'user.name']), 'Global Twig');
  await mkdir('artifacts', { recursive: true }); await page.setViewportSize({ width: 1000, height: 640 });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `artifacts/m5-profile-${theme}.png`, animations: 'disabled' });
    assert.equal(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    await dialog.getByRole('button', { name: 'Reload profile', exact: true }).scrollIntoViewIfNeeded();
    await dialog.getByRole('combobox', { name: /Pull strategy/ }).focus();
    await page.keyboard.press('Tab');
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true);
    await name.scrollIntoViewIfNeeded();
  }
  const failures = await page.evaluate(async () => {
    const { activeId } = await window.twig.getWorkspace();
    const calls = [() => window.twig.getGitProfile('/unknown/repository', 'local'),
      () => window.twig.getGitProfile(null, 'local'), () => window.twig.getGitProfile(null, 'system'),
      () => window.twig.saveGitProfileValue(activeId, 'local', 'credential.helper', 'bad', null)];
    return Promise.all(calls.map(async call => { try { await call(); return false; } catch { return true; } }));
  });
  assert.deepEqual(failures, [true, true, true, true]); assert.deepEqual(errors, []);
  console.log('M5 profile Electron passed: global/local save, inheritance, stale edits, invalid IPC, compact layout and themes.');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
