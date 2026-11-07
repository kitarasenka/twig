/* global window */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';

// A file from someone else's repository must not freeze the window: Prism's
// grammars take minutes on some repeated input and a regular expression cannot
// be interrupted. In a real window, a diff of such a file stays responsive,
// shows as plain text once the worker's deadline passes, and the next diff has
// its colours from a fresh worker.

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-highlight-smoke-')));
const profile = path.join(root, 'profile');
let app;
try {
  const env = { ...process.env, TWIG_LANGUAGE: 'en' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const demo = await page.evaluate(() => window.twig.getWorkspace().then(workspace => workspace.repositories.find(repository => repository.sandbox)));
  const git = (...argv) => execFileSync('git', argv, { cwd: demo.path, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  const line = '[['.repeat(1000);
  await writeFile(path.join(demo.path, 'hostile.md'), `${Array(100).fill(line).join('\n')}\n`);
  await writeFile(path.join(demo.path, 'plain.js'), 'export const after = 1;\n');
  git('add', 'hostile.md'); git('commit', '-q', '-m', 'Add a hostile file');
  git('add', 'plain.js'); git('commit', '-q', '-m', 'Add a plain file');
  await page.getByRole('button', { name: 'Refresh' }).click();

  const history = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await history.getByRole('option').filter({ hasText: 'Add a hostile file' }).click();
  // The longest gap between two ticks of the page: a blocked main thread cannot tick.
  await page.evaluate(() => {
    window.smokeGap = 0;
    let last = performance.now();
    window.smokeTimer = setInterval(() => { const now = performance.now(); window.smokeGap = Math.max(window.smokeGap, now - last); last = now; }, 20);
  });
  await page.getByRole('button', { name: 'Added hostile.md', exact: true }).click();
  const diff = page.getByRole('region', { name: 'File diff', exact: true });
  await diff.locator('.diff-added').first().waitFor();
  await page.waitForTimeout(2500);
  const gap = await page.evaluate(() => { clearInterval(window.smokeTimer); return window.smokeGap; });
  assert.ok(gap < 1000, `the window kept running: the longest stall was ${Math.round(gap)} ms`);
  assert.equal(await diff.locator('[class*="syn-"]').count(), 0, 'past the deadline the file shows plain');
  assert.equal(await diff.locator('.diff-added').first().textContent().then(text => text.includes('[[[[')), true);

  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await history.getByRole('option').filter({ hasText: 'Add a plain file' }).click();
  await page.getByRole('button', { name: 'Added plain.js', exact: true }).click();
  await diff.locator('.syn-keyword', { hasText: 'export' }).first().waitFor();
  console.log(`highlight-smoke: a hostile file left the window running (longest stall ${Math.round(gap)} ms), plain after the deadline, colours from a fresh worker`);
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
