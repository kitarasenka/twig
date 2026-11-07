import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Launch-time robustness:
// - torn JSON files in userData (a crash mid-write, a full disk, a hand edit)
//   used to make 🌱 Twig exit at launch with no window and no message; now the
//   window opens and the torn bytes are kept aside;
// - a second launch on the same userData used to start a second process
//   writing the same files; now it hands over to the open window and exits.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-startup-smoke-'));
let app;
try {
  const profile = path.join(root, 'profile');
  await mkdir(profile);
  await writeFile(path.join(profile, 'marks.json'), '{"/some/repo": {"aaaa');
  await writeFile(path.join(profile, 'repositories.json'), '{"repositories": [{"id": ');
  const env = { ...process.env, TWIG_LANGUAGE: 'en' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).waitFor();
  const names = await readdir(profile);
  for (const file of ['marks.json', 'repositories.json']) {
    assert.ok(names.some(name => name.startsWith(`${file}.broken-`)), `${file}: the torn file is kept aside`);
  }

  // A second launch on the same profile exits by itself and leaves the first running.
  const second = spawn(app.process().spawnfile, ['.', `--user-data-dir=${profile}`], { env, stdio: 'ignore' });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { second.kill(); reject(new Error('the second launch did not exit')); }, 15000);
    second.on('exit', exit => { clearTimeout(timer); resolve(exit); });
  });
  assert.equal(code, 0, 'the second launch exits cleanly');
  assert.equal(await page.evaluate(() => document.title), '🌱 Twig', 'the first window is still alive');
  assert.equal(app.windows().length, 1, 'and no second window was opened');
  await app.close();

  // No Git at all: the window opens and says so instead of dying on the demo
  // seed, nothing is seeded, and Check again picks Git up without a restart.
  const noGitProfile = path.join(root, 'no-git');
  const nothing = path.join(root, 'empty-bin');
  await mkdir(nothing);
  app = await electron.launch({ args: ['.', `--user-data-dir=${noGitProfile}`], env: { ...env, PATH: nothing, SHELL: '/nonexistent' } });
  const bare = await app.firstWindow();
  bare.setDefaultTimeout(20000);
  await bare.getByText('Install Git to get started', { exact: true }).waitFor();
  assert.equal(await bare.getByRole('button', { name: 'Check again', exact: true }).isEnabled(), true);
  assert.ok(!(await readdir(noGitProfile)).includes('demo-sandbox'), 'the demo is not seeded without Git');
  await bare.screenshot({ path: 'artifacts/startup-no-git.png', animations: 'disabled' });
  // Still missing: the same screen, no failure.
  await bare.getByRole('button', { name: 'Check again', exact: true }).click();
  await bare.getByRole('button', { name: 'Check again', exact: true }).waitFor();
  await app.evaluate((_electron, directories) => { process.env.PATH = directories; }, process.env.PATH);
  await bare.getByRole('button', { name: 'Check again', exact: true }).click();
  await bare.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  await app.close();

  // A demo that cannot be seeded for any other reason: the window opens all the
  // same, and its tab says what happened.
  const wrapper = path.join(root, 'wrapped-bin');
  await mkdir(wrapper);
  await writeFile(path.join(wrapper, 'git'), `#!/bin/sh\ncase " $* " in *" init "*) echo "no room left" >&2; exit 1;; esac\nPATH="${process.env.PATH}" exec git "$@"\n`);
  await chmod(path.join(wrapper, 'git'), 0o755);
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'no-seed')}`], env: { ...env, PATH: `${wrapper}:${process.env.PATH}` } });
  const unseeded = await app.firstWindow();
  unseeded.setDefaultTimeout(20000);
  await unseeded.getByText('The demo workspace could not be created.', { exact: true }).waitFor();
  await unseeded.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await unseeded.getByRole('button', { name: 'Open repository', exact: true }).waitFor();
  console.log('Startup smoke passed: torn settings kept aside with the window open, a second launch hands over and exits, no Git and a failed seed both open the window.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
