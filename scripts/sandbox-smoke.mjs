import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
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
  assert.equal(await page.getByRole('button', { name: 'Pop', exact: true }).isDisabled(), false, 'Pop is available while a stash exists');
  await page.getByRole('button', { name: 'Pop', exact: true }).click();
  await page.getByText('Stash popped.').waitFor();
  assert.equal(await stashCount(), 0, 'the stash is gone after Pop');

  // An empty list leaves nothing to restore: the button goes disabled and says why.
  const emptyPop = page.getByRole('button', { name: 'Pop: there are no stashes to restore' });
  await emptyPop.waitFor();
  assert.equal(await emptyPop.isDisabled(), true, 'Pop is disabled without a stash');
  assert.equal(await emptyPop.getAttribute('title'), 'Pop: there are no stashes to restore', 'the disabled Pop explains itself on hover');

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

  // Closing the demo tab: it is the only tab here, so the app falls back to the
  // New repository screen and Settings is where it comes back from.
  await page.getByRole('button', { name: 'Close workspace-demo tab', exact: true }).click();
  await page.getByRole('heading', { name: 'A clear view of your code.' }).waitFor();
  await page.getByText('Demo workspace closed. Settings brings it back.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Close workspace-demo tab' }).count(), 0, 'the demo tab is gone');
  assert.equal(await page.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.length)), 0);
  await access(path.join(profile, 'demo-sandbox', '.git')); // closing deletes nothing
  await page.screenshot({ path: 'artifacts/sandbox-closed.png', animations: 'disabled' });

  // It stays closed across a restart, and 🌱 Twig runs no git for it on the way up.
  assert.deepEqual(errors, []);
  const demoCommands = journal => journal.filter(entry => entry.cwd.includes('demo-sandbox')).length;
  const beforeRestart = demoCommands(await page.evaluate(() => window.twig.getConsoleEntries()));
  await app.close();
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const second = await app.firstWindow();
  second.setDefaultTimeout(15000);
  second.on('pageerror', e => errors.push(e.message));
  await second.getByRole('heading', { name: 'A clear view of your code.' }).waitFor();
  assert.equal(await second.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.length)), 0, 'the demo is still closed after a restart');
  // The journal survives restarts, so the proof is that it did not grow: not one
  // new command ran in the sandbox on the way up.
  const journal = await second.evaluate(() => window.twig.getConsoleEntries());
  assert.equal(demoCommands(journal), beforeRestart, 'a closed demo runs no git at startup');

  // Settings shows it again: the same sandbox, with the history from before.
  await second.getByRole('button', { name: 'Settings', exact: true }).click();
  assert.equal(await second.getByRole('button', { name: 'Reset demo workspace' }).count(), 0, 'nothing to reset while it is closed');
  await second.getByRole('button', { name: 'Show demo workspace', exact: true }).click();
  await second.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  await second.getByRole('heading', { name: 'Refine the workspace layout' }).waitFor();
  const restored = await second.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.find(r => r.sandbox)));
  assert.equal(restored.id, demoId, 'the same sandbox comes back');
  assert.equal(await second.evaluate(id => window.twig.stashList(id).then(list => list.length), demoId), 1, 'its seeded stash is still there');

  assert.deepEqual(errors, []);
  console.log('Sandbox smoke passed: seeded demo repo, real stash pop, reset demo workspace restores the sample history, closing the demo tab persists and shows again, both themes.');
} finally {
  if (app) await app.close();
  await rm(profile, { recursive: true, force: true });
}
