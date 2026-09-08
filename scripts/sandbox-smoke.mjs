import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// The demo tab is a real seeded sandbox repository. This drives it through a
// real Git mutation and the "Reset demo workspace" reinit, asserting the
// sandbox state with the same preload bridge the UI uses.
const profile = await mkdtemp(path.join(tmpdir(), 'twig-sandbox-smoke-'));
await mkdir('artifacts', { recursive: true });
const errors = [];
let app;
try {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));

  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();

  const demoId = await page.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.find(r => r.sandbox).id));
  assert.ok(demoId, 'the demo sandbox is a registered repository');
  const stashCount = () => page.evaluate(id => window.twig.stashList(id).then(list => list.length), demoId);
  const branchNames = () => page.evaluate(id => window.twig.getRefs(id).then(refs => refs.filter(r => r.type === 'local').map(r => r.name).sort()), demoId);

  assert.equal(await stashCount(), 1, 'the seed leaves one stash');
  assert.deepEqual(await branchNames(), ['feature/command-log', 'feature/repository-tabs', 'main']);

  // A real mutation: pop the seeded stash from the toolbar.
  await page.getByRole('button', { name: 'Pop', exact: true }).click();
  await page.getByText('Stash popped.').waitFor();
  assert.equal(await stashCount(), 0, 'the stash is gone after Pop');

  // Reinit: Settings -> Reset demo workspace -> confirm.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Reset demo workspace' }).click();
  await page.getByText(/Deletes the .*sandbox/).waitFor();
  await page.getByRole('button', { name: 'Reset demo workspace' }).click();
  await page.getByText('Demo workspace reset to its sample history.').waitFor();

  assert.equal(await stashCount(), 1, 'reset restores the seeded stash');
  assert.deepEqual(await branchNames(), ['feature/command-log', 'feature/repository-tabs', 'main']);
  await page.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();
  const head = await page.evaluate(id => window.twig.getWorkspace().then(w => w.repositories.find(r => r.id === id).status.branch.name), demoId);
  assert.equal(head, 'main', 'HEAD is back on main');

  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/sandbox-${theme}.png`, animations: 'disabled' });
  }

  assert.deepEqual(errors, []);
  console.log('Sandbox smoke passed: seeded demo repo, real stash pop, reset demo workspace restores the sample history, both themes.');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
