import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  const env = { ...process.env };
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
  console.log('Startup smoke passed: torn settings kept aside with the window open, a second launch hands over and exits.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
