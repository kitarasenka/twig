import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'vite';
import { buildPreload } from './build.mjs';

const profile = await mkdtemp(path.join(tmpdir(), 'git-desk-smoke-'));
await mkdir('artifacts', { recursive: true });
const errors = [];
let app;
let server;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.GIT_DESK_DEV;
  if (process.argv.includes('--dev')) {
    await buildPreload();
    server = await createServer();
    await server.listen();
    env.GIT_DESK_DEV = '1';
  }
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 20000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('listbox', { name: 'Demo commit history' }).waitFor();
  const info = await page.evaluate(() => window.gitDesk.getAppInfo());
  assert.equal(info.name, 'Git Desk');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
  assert.deepEqual(await page.evaluate(() => Object.keys(window.gitDesk)), ['getAppInfo']);
  const security = await app.evaluate(({ BrowserWindow }) => {
    const prefs = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { sandbox: prefs.sandbox, contextIsolation: prefs.contextIsolation, nodeIntegration: prefs.nodeIntegration };
  });
  assert.deepEqual(security, { sandbox: true, contextIsolation: true, nodeIntegration: false });
  await page.getByRole('listbox').getByRole('option').nth(2).click();
  await page.getByRole('heading', { name: 'Stream command output as it arrives' }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'Add keyboard navigation to commit details' }).waitFor();
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('heading', { name: 'A clear view of your code.' }).waitFor();
  await page.getByRole('button', { name: /workspace-demo/ }).click();
  await page.getByRole('heading', { name: 'Add keyboard navigation to commit details' }).waitFor();
  const filter = page.getByRole('textbox', { name: 'Filter branches and history' });
  await filter.fill('fonts');
  assert.equal(await page.getByRole('listbox').getByRole('option').count(), 1);
  await filter.fill('nothing matches this');
  await page.getByText('No matching commits.').waitFor();
  await filter.fill('');
  await page.getByRole('listbox').getByRole('option').first().click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByText('Your commands, in plain sight.').waitFor();
  await page.keyboard.press(`${info.platform === 'darwin' ? 'Meta' : 'Control'}+j`);
  assert.equal(await page.getByText('Your commands, in plain sight.').isVisible(), false);
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
    await page.screenshot({ path: `artifacts/m0-${theme}.png` });
  }
  await page.reload();
  await page.getByRole('listbox').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.screenshot({ path: 'artifacts/m0-compact.png' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(await page.evaluate(async () => { try { await fetch('https://example.com'); return true; } catch { return false; } }), false);
  assert.deepEqual(errors, []);
  console.log('Electron smoke passed: sandbox, bridge, selection, keyboard, tabs, search, console, themes, compact layout, network block.');
} finally {
  if (app) await app.close();
  if (server) await server.close();
  await rm(profile, { recursive: true, force: true });
}
