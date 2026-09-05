import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-repository-smoke-'));
let app;
try {
  const cwd = path.join(root, 'source'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, directory = cwd) => {
    const result = await runGit({ cwd: directory, log, argv });
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']); await git(['config', 'user.email', 'twig@example.invalid']);
  await writeFile(path.join(cwd, 'readme.txt'), 'A cloned repository\n');
  await git(['add', '--', 'readme.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'A cloned history']);
  const bare = path.join(root, 'remote.git'); await git(['clone', '--bare', '--', cwd, bare]);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  const args = ['.', `--user-data-dir=${path.join(root, 'app')}`];
  app = await electron.launch({ args, env });
  const page = await app.firstWindow(); page.setDefaultTimeout(20000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, root);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Clone repository', exact: true }).click();
  const clone = page.getByRole('dialog', { name: 'Clone repository' });
  await clone.getByRole('textbox', { name: 'Repository URL', exact: true }).fill(bare);
  await clone.getByRole('textbox', { name: 'New folder name', exact: true }).fill('twig-clone');
  await clone.getByRole('button', { name: 'Choose parent folder', exact: true }).click();
  await mkdir('artifacts', { recursive: true });
  await page.setViewportSize({ width: 1000, height: 640 });
  await page.screenshot({ path: 'artifacts/m5-clone.png', animations: 'disabled' });
  await clone.getByRole('button', { name: 'Clone and open', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).getByRole('option', { name: /A cloned history/ }).waitFor();
  const workspace = await page.evaluate(() => window.twig.getWorkspace());
  const clonedPath = workspace.repositories[0].path;
  assert.equal(workspace.repositories[0].name, 'twig-clone');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage remotes', exact: true }).click();
  const remotes = page.getByRole('dialog', { name: 'Remotes', exact: true });
  await remotes.getByRole('textbox', { name: 'Remote name', exact: true }).fill('backup');
  await remotes.getByRole('textbox', { name: 'Remote URL', exact: true }).fill(bare);
  await remotes.getByRole('button', { name: 'Add remote', exact: true }).click();
  const backup = remotes.getByRole('listitem').filter({ has: page.getByText('backup', { exact: true }) });
  await backup.waitFor();
  await backup.getByRole('button', { name: 'Fetch and prune', exact: true }).click();
  await remotes.getByText('backup: fetch finished.', { exact: true }).waitFor();
  assert.equal(await git(['rev-parse', 'refs/remotes/backup/main'], clonedPath), await git(['rev-parse', 'HEAD']));
  await page.locator('.real-branch[title="refs/remotes/backup/main"]').waitFor();
  await backup.getByRole('textbox', { name: 'Primary fetch URL', exact: true }).fill(cwd);
  await backup.getByRole('button', { name: 'Save URL', exact: true }).click();
  await remotes.getByText('backup: set-url finished.', { exact: true }).waitFor();
  assert.equal(await git(['config', 'remote.backup.url'], clonedPath), cwd);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `artifacts/m5-remotes-${theme}.png`, animations: 'disabled' });
    assert.equal(await remotes.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  }
  await backup.getByRole('button', { name: 'Remove remote', exact: true }).click();
  await backup.getByRole('button', { name: 'Confirm remote removal', exact: true }).click();
  await backup.waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Manage repositories', exact: true }).click();
  const manager = page.getByRole('dialog', { name: 'Repositories', exact: true });
  await manager.getByRole('textbox', { name: 'Filter repositories' }).fill('no-match');
  await manager.getByText('No repositories match this filter.', { exact: true }).waitFor();
  await manager.getByRole('textbox', { name: 'Filter repositories' }).fill('twig');
  await page.screenshot({ path: 'artifacts/m5-repositories.png', animations: 'disabled' });
  await manager.getByRole('button', { name: 'Remove from list', exact: true }).click();
  await manager.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await manager.getByText('No connected repositories. Open a folder or clone a repository to begin.', { exact: true }).waitFor();
  await access(path.join(clonedPath, '.git')); await access(path.join(clonedPath, 'readme.txt'));
  const refused = await page.evaluate(async () => {
    const calls = [() => window.twig.cloneRepository('invalid-token', 'new', 'https://host/repo'),
      () => window.twig.removeRepository('/unknown'), () => window.twig.getRemotes('/unknown'),
      () => window.twig.changeRemote('/unknown', 'add', 'name', 'https://host/repo')];
    return Promise.all(calls.map(async call => { try { await call(); return false; } catch { return true; } }));
  });
  assert.deepEqual(refused, [true, true, true, true]);
  const commands = await page.evaluate(() => window.twig.getConsoleEntries());
  assert.ok(commands.some(entry => entry.argv.includes('clone') && entry.code === 0));
  assert.ok(commands.some(entry => entry.argv.includes('fetch') && entry.code === 0));
  assert.deepEqual(errors, []);
  await app.close(); app = await electron.launch({ args, env });
  const restarted = await app.firstWindow();
  await restarted.waitForFunction(() => Boolean(window.twig));
  assert.deepEqual((await restarted.evaluate(() => window.twig.getWorkspace())).repositories, []);
  console.log('M5 repositories Electron passed: clone and history, remote add/edit/fetch/remove, repository filtering/removal, restart, disk preservation, journal, IPC and themes.');
} finally { await app?.close(); await rm(root, { recursive: true, force: true }); }
