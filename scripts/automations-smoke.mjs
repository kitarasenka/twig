import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// Drives increment 1 of the automation subsystem in a real Electron window:
// build a pipeline from a template, block a commit with it, bypass once, and
// read the run back from the log. Also exercises the IPC rejections.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-automations-smoke-'));
let app;
try {
  const cwd = path.join(root, 'fixture');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  await git(['init', '--initial-branch=main', cwd], root);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'seed.txt'), 'seed\n', 'utf8');
  await git(['add', '--', ':(literal)seed.txt']);
  await git(['commit', '--message', 'seed']);
  await git(['branch', 'feature/work']);
  await writeFile(path.join(cwd, 'note.txt'), 'a new file\n', 'utf8');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await mkdir('artifacts', { recursive: true });

  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();

  // --- build a pipeline from the "Protect main" template --------------------
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('region', { name: 'Automations', exact: true }).waitFor();
  await page.getByLabel('Add from template').selectOption('js-ts');
  await page.getByRole('button', { name: 'Add action', exact: true }).waitFor();
  await page.screenshot({ path: 'artifacts/m6-automations-editor.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Add from template').selectOption('protect-main');
  await page.getByRole('button', { name: 'Save pipeline', exact: true }).click();
  await page.locator('.pipeline-card').filter({ hasText: 'Protect main' }).waitFor();

  // --- manual run blocks on main -----------------------------------------
  await page.getByRole('button', { name: 'Run now', exact: true }).click();
  await page.getByText('Commit blocked').waitFor();
  await page.screenshot({ path: 'artifacts/m6-automations-blocked.png', animations: 'disabled' });
  await page.getByRole('button', { name: /Bypass once|Dismiss/ }).click();

  // --- a real commit is blocked, then bypassed --------------------------
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await page.getByRole('button', { name: /Uncommitted changes/ }).click();
  await page.getByRole('complementary', { name: 'Uncommitted changes', exact: true })
    .getByRole('button', { name: 'Open staging', exact: true }).click();
  await page.getByRole('region', { name: 'Untracked files', exact: true }).getByRole('button', { name: 'Stage all', exact: true }).click();
  await page.getByRole('textbox', { name: 'Commit message' }).fill('add a note');
  await page.getByRole('button', { name: /^Commit 1 file/ }).click();
  await page.getByText('Commit blocked').waitFor();
  await page.getByRole('button', { name: 'Bypass once', exact: true }).click();
  await page.getByText('Commit created.', { exact: true }).waitFor();
  assert.equal(await git(['log', '--format=%s', '-1']), 'add a note');

  // --- the run history records both the block and the bypass ------------
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('tab', { name: 'Run history', exact: true }).click();
  const entries = page.locator('.run-entry');
  await entries.first().waitFor();
  assert.ok(await entries.count() >= 2, 'the manual block and the bypass are both logged');
  await entries.first().click();
  await page.locator('.run-detail .step-list').waitFor();

  // --- IPC rejections ---------------------------------------------------
  const rejected = await page.evaluate(async () => {
    const id = (await window.twig.getWorkspace()).activeId;
    const results = await Promise.allSettled([
      window.twig.runAutomation(id, 'not-a-real-hook', null),
      window.twig.runAutomation('unregistered-repo', 'pre-commit', null),
      window.twig.saveAutomationConfig(id, { pipelines: [{ event: 'pre-commit', name: 'x', actions: [{ type: 'command', command: 'a && b' }] }] }),
      window.twig.saveAutomationConfig(id, { pipelines: [{ event: 'pre-commit', name: 'y', actions: [{ type: 'script', path: '../escape.sh' }] }] })
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(4).fill('rejected'));

  // --- both themes on the pipeline list --------------------------------
  await page.getByRole('tab', { name: 'Pipelines', exact: true }).click();
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/m6-automations-${theme}.png`, animations: 'disabled' });
  }

  assert.deepEqual(errors, [], `page errors: ${JSON.stringify(errors)}`);
  console.log('Automations Electron passed: template pipeline, blocked commit, bypass once, run history, IPC validation, themes.');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
