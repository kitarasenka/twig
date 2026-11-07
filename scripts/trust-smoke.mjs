import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// In the real window: a folder with a hook asks once and the answer is kept
// across a launch; a filter written into `.git/config` afterwards stops the
// repository before Git reads it, says so, and Open repository asks again.
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-trust-smoke-')));
let app;
try {
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const env = { ...process.env, TWIG_LANGUAGE: 'en', GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  const git = (...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'T');
  git('config', 'user.email', 't@example.com');
  await writeFile(path.join(cwd, 'a.txt'), 'hello\n');
  git('add', '.');
  git('commit', '-qm', 'Trusted history');
  await writeFile(path.join(cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(cwd, '.git/hooks/pre-commit'), 0o755);

  const launch = async () => {
    app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await app.evaluate(({ dialog }, directory) => {
      globalThis.asked = [];
      globalThis.answer = 1;
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] });
      dialog.showMessageBox = async (_window, options) => { globalThis.asked.push(`${options.message}\n${options.detail}`); return { response: globalThis.answer }; };
    }, cwd);
    return page;
  };
  const asked = () => app.evaluate(() => globalThis.asked);

  let page = await launch();
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const history = () => page.getByRole('listbox', { name: 'Commit history', exact: true }).getByRole('option', { name: /Trusted history/ });
  await history().waitFor();
  const first = await asked();
  assert.equal(first.length, 1);
  assert.match(first[0], /run programs or send your work elsewhere/);
  assert.match(first[0], /hooks\/pre-commit = exit 0/, 'the hook is named with what it runs');
  assert.equal(first[0].includes('fresh clone'), false, 'the window no longer promises anything about clones');
  await app.close();

  page = await launch();
  await page.locator('.tab button', { hasText: 'repo' }).first().click();
  await history().waitFor();
  assert.deepEqual(await asked(), [], 'the kept answer holds across a launch');

  // Written from outside: refused before Git reads it, the window asks, and "Keep stopped" holds.
  const marker = path.join(root, 'filter-ran');
  await app.evaluate(() => { globalThis.answer = 0; });
  git('config', 'filter.x.clean', `touch ${marker}; cat`);
  await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=x\n');
  await new Promise(resolve => setTimeout(resolve, 1100));
  await writeFile(path.join(cwd, 'a.txt'), 'changed\n');
  await page.locator('.tab.active small', { hasText: 'STOPPED' }).waitFor();
  await page.getByText('🌱 Twig stopped reading this repository.', { exact: true }).waitFor();
  const stopped = await asked();
  assert.equal(stopped.length, 1);
  assert.match(stopped[0], /stopped reading repo/);
  assert.match(stopped[0], /filter\.x\.clean/);
  assert.equal(existsSync(marker), false, 'nothing ran the filter');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/trust-stopped.png', animations: 'disabled' });

  // Open repository asks again; allowed, the tab works, with the filter the person accepted.
  await git('config', 'filter.x.clean', 'cat');
  await app.evaluate(() => { globalThis.answer = 1; globalThis.asked = []; });
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await history().waitFor();
  assert.equal((await asked()).length, 1);
  assert.equal(await page.locator('.tab.active small').count(), 0, 'the tab is no longer stopped');
  console.log('Trust smoke passed: asked once, kept across a launch, stopped on a later change, reopened after the answer.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
