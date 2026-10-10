import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { spawnSync } from 'node:child_process';
import { access, constants, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// An outside change to a branch (a terminal command, a background fetch) that
// lands while Refresh is still restoring several pages. Two bugs lived here:
// the second reload it started picked up the first one's stale page, published
// an empty history and left `loading` on for good ("0 loaded", a skeleton,
// Refresh disabled); and once reloads were fast, a change landing just after
// one was dropped as its echo, so the new branch never showed up.
//
// The race needs a slow history read to be reproducible on any machine, so Git
// is wrapped: a `git` first on PATH sleeps before any `--topo-order` read and
// then runs the real one. Everything else goes straight through.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-reload-race-'));
let app;
try {
  const realGit = await findGit(process.env.PATH);
  const wrapper = path.join(root, 'bin');
  await mkdir(wrapper);
  await writeFile(path.join(wrapper, 'git'), `#!/bin/sh\ncase " $* " in *" --topo-order "*) sleep 0.8 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });

  await mkdir(path.join(root, 'fixture'));
  const cwd = await realpath(path.join(root, 'fixture'));
  const git = (args, input) => {
    const result = spawnSync(realGit, args, { cwd, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  // 1100 commits in one fast-import: five pages of history.
  let stream = '';
  for (let i = 1; i <= 1100; i++) {
    const message = `Commit ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter Race Fixture <race@example.invalid> ${1700000000 + i * 60} +0000\n`
      + `data ${Buffer.byteLength(message)}\n${message}${i > 1 ? `from :${i - 1}\n` : ''}M 100644 inline file.txt\ndata ${String(i).length + 1}\n${i}\n\n`;
  }
  git(['fast-import', '--quiet'], stream);
  git(['checkout', '-q', '-f', 'main']);

  const profile = path.join(root, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'repositories.json'), JSON.stringify({
    repositories: [{ id: cwd, path: cwd, name: 'race' }], activeId: cwd, sandboxHidden: true
  }));
  const env = { ...process.env, PATH: `${wrapper}${path.delimiter}${process.env.PATH}` };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const loaded = () => page.evaluate(() => Number.parseInt(document.querySelector('.graph-heading .count')?.textContent, 10) || 0);
  await page.locator('.real-commit-row').first().waitFor();

  // Scroll down until four pages are in: a reload then restores all four.
  while (await loaded() < 1000) {
    const before = await loaded();
    await page.evaluate(() => { const scroll = document.querySelector('.real-history-scroll'); scroll.scrollTop = scroll.scrollHeight; });
    await page.waitForFunction(count => Number.parseInt(document.querySelector('.graph-heading .count')?.textContent, 10) > count, before);
  }
  await page.evaluate(() => { document.querySelector('.real-history-scroll').scrollTop = 0; });
  const restored = await loaded();
  await page.waitForTimeout(1500); // past the watcher's "our own reload" quiet period

  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const refreshedAt = Date.now();
  await refresh.click();
  await page.waitForTimeout(1300);
  git(['branch', '-f', 'outside-change', 'HEAD~1']); // while the Refresh is still reading

  // Both reloads end: the history is back in full and Refresh works again.
  await page.waitForFunction(count => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === 'Refresh');
    return button && !button.disabled && Number.parseInt(document.querySelector('.graph-heading .count')?.textContent, 10) >= count;
  }, restored, { timeout: 20000 });
  assert.ok(await page.locator('.real-commit-row').count() > 0, 'rows are drawn');
  assert.equal(await page.locator('[aria-label="Loading history"]').count(), 0, 'no skeleton is left');
  await page.locator('.ref-badge', { hasText: 'outside-change' }).first().waitFor();

  // The change landed while the Refresh was reading: a second read followed it.
  const reads = (await page.evaluate(() => window.twig.getConsoleEntries()))
    .filter(entry => entry.operation === 'Read branches and tags').map(entry => Date.parse(entry.startedAt));
  assert.ok(reads.filter(start => start > refreshedAt).length >= 2, 'the outside change was read after the Refresh, not dropped');
  assert.deepEqual(errors, []);
  console.log(`Reload race smoke passed: ${restored} rows restored, an outside change during the reload shown, Refresh enabled.`);
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}

async function findGit(searchPath) {
  for (const folder of (searchPath || '').split(path.delimiter).filter(entry => path.isAbsolute(entry))) {
    const candidate = path.join(folder, 'git');
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* next */ }
  }
  throw new Error('git is not on PATH');
}
