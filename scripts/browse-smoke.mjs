import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// Drives the browsing half of M5 in a real Electron window: the branches and
// tags screen, the stash screen with the contents of a stash, and a complete
// bisect that has to land on the commit this fixture deliberately broke.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-browse-smoke-'));
let app;
try {
  const cwd = path.join(root, 'browse-fixture');
  const bare = path.join(root, 'remote.git');
  await mkdir(cwd);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };

  await git(['init', '--bare', '--initial-branch=main', bare], root);
  await git(['init', '--initial-branch=main', cwd], root);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);

  // Twelve commits; the seventh breaks the file and every later one keeps it broken.
  const commits = [];
  for (let i = 1; i <= 12; i += 1) {
    await writeFile(path.join(cwd, 'app.txt'), `line ${i}\n${i >= 7 ? 'BUG\n' : ''}`, 'utf8');
    await git(['add', '--', ':(literal)app.txt']);
    await git(['commit', '--message', `step ${i}`]);
    commits.push(await git(['rev-parse', 'HEAD']));
  }
  const firstBroken = commits[6];

  // A branch that is fully merged (safe to delete) and one that is not.
  await git(['branch', '--', 'merged/early', commits[2]]);
  await git(['checkout', '-b', 'feature/old', commits[3], '--']);
  await writeFile(path.join(cwd, 'side.txt'), 'only here\n', 'utf8');
  await git(['add', '--', ':(literal)side.txt']);
  await git(['commit', '--message', 'work that lives nowhere else']);
  await git(['checkout', 'main', '--']);
  await git(['tag', '--annotate', '--message', 'first release', '--', 'v1.0.0', commits.at(-1)]);

  await git(['remote', 'add', '--', 'origin', bare]);
  await git(['push', '--', 'origin', 'refs/heads/main']);
  await git(['push', '--', 'origin', 'refs/heads/feature/old:refs/heads/stale']);
  await git(['fetch', '--', 'origin']);

  // Two stashes, the older one carrying an untracked file.
  await writeFile(path.join(cwd, 'app.txt'), 'line 12\nBUG\nunfinished\n', 'utf8');
  await writeFile(path.join(cwd, 'scratch.txt'), 'brand new\n', 'utf8');
  await git(['stash', 'push', '--include-untracked', '--message', 'older work']);
  await writeFile(path.join(cwd, 'app.txt'), 'line 12\nBUG\nsomething else\n', 'utf8');
  await git(['stash', 'push', '--message', 'newer work']);

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
  const shot = name => page.screenshot({ path: `artifacts/m5-${name}.png`, animations: 'disabled' });
  const expect = async (text, description) => {
    try {
      await page.getByText(text).first().waitFor();
    } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .operation-note').allInnerTexts();
      throw new Error(`${description}: expected "${text}". On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };
  const row = name => page.locator('.refs-row').filter({ hasText: name }).first();
  const hunterTool = page.locator('.toolbar .bughunter-tool');
  await hunterTool.waitFor();
  assert.equal(await hunterTool.isDisabled(), true, 'BugHunter needs a real repository');
  assert.equal(await hunterTool.locator('..').getAttribute('title'), 'Connect a repository to use this action', 'disabled hover explains how to enable it');

  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();

  // A stash hangs off the commit it was based on, by a dashed link into an
  // extra lane. Both stashes here share one base, so there is one marker.
  const stashNode = page.locator('.real-commit-row .stash-node');
  await stashNode.first().waitFor();
  assert.equal(await stashNode.count(), 1, 'one marker for the shared base commit');
  assert.match(await stashNode.first().getAttribute('title'), /newer work/, 'the marker names the stashes it carries');
  assert.equal(await page.locator('.real-commit-row .stash-link').count() >= 1, true, 'a dashed link reaches the marker');
  await shot('stash-graph');

  // --- branches and tags -----------------------------------------------------
  await page.getByRole('button', { name: /Branches and tags/ }).click();
  await page.getByRole('tab', { name: /Branches/ }).first().waitFor();
  await row('feature/old').waitFor();
  await expect('current', 'the checked-out branch is marked');

  // Search narrows the list to what was asked for.
  await page.getByRole('textbox', { name: 'Search branches and tags' }).fill('merged');
  await row('merged/early').waitFor();
  assert.equal(await page.locator('.refs-row').filter({ hasText: 'feature/old' }).count(), 0, 'search hides the rest');
  await page.getByRole('textbox', { name: 'Search branches and tags' }).fill('');
  await shot('branches');

  // The branch that is checked out can be neither checked out nor deleted, and
  // both buttons say why instead of vanishing.
  const currentRow = page.locator('.refs-row').filter({ hasText: 'current' }).first();
  assert.equal(await currentRow.getByRole('button', { name: /Check out/ }).isDisabled(), true);
  assert.equal(await currentRow.getByRole('button', { name: 'Delete main' }).isDisabled(), true);

  // A merged branch deletes without ceremony, because Git guarantees nothing is lost.
  await row('merged/early').getByRole('button', { name: 'Delete merged/early' }).click();
  await expect('Branch merged/early deleted.', 'a merged branch is deleted straight away');
  await page.locator('.refs-row').filter({ hasText: 'merged/early' }).waitFor({ state: 'detached' });

  // An unmerged one is refused, and only then is force offered — behind §6.5.
  await row('feature/old').getByRole('button', { name: 'Delete feature/old' }).click();
  await expect('Git refused to delete feature/old: it is not fully merged.', 'the refusal is explained');
  await page.getByRole('button', { name: 'Delete anyway', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /\$ git branch -D -- feature\/old/, 'the exact command is shown');
  await page.getByRole('button', { name: 'Delete the branch anyway', exact: true }).click();
  await expect('Branch feature/old force-deleted.', 'the forced delete ran');

  // Renaming, then an upstream chosen from the remote-tracking branches.
  await row('main').getByRole('button', { name: 'Upstream for main' }).click();
  await page.getByRole('combobox', { name: 'Track this remote-tracking branch' }).selectOption('origin/main');
  await page.getByRole('button', { name: 'Track it', exact: true }).click();
  await expect('main now tracks origin/main.', 'the upstream was set');
  await row('main').getByText('tracks origin/main').waitFor();

  // Deleting a branch on the remote states exactly what will run.
  await page.getByRole('tab', { name: /Remote branches/ }).click();
  await row('origin/stale').getByRole('button', { name: 'Delete origin/stale on its remote' }).click();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /\$ git push --progress --delete origin -- refs\/heads\/stale/, 'the push command is shown in full');
  await page.getByRole('button', { name: 'Delete on origin', exact: true }).click();
  await expect('origin/stale deleted on origin.', 'the remote branch was deleted');
  assert.equal((await git(['ls-remote', '--heads', '--', 'origin', 'stale'])).length, 0, 'it is gone on the remote too');

  // A tag can finally leave the machine it was made on.
  await page.getByRole('tab', { name: /Tags/ }).click();
  await row('v1.0.0').getByRole('button', { name: 'Push', exact: true }).click();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /\$ git push --progress origin -- refs\/tags\/v1\.0\.0/, 'the tag push command is shown');
  await page.getByRole('button', { name: 'Push to origin', exact: true }).click();
  await expect('v1.0.0 pushed to origin.', 'the tag was published');
  assert.match(await git(['ls-remote', '--tags', '--', 'origin']), /refs\/tags\/v1\.0\.0/);
  await page.waitForFunction(() => document.querySelector('.bughunter-tool')?.title === 'Select a commit with the bug in the history first');
  assert.equal(await hunterTool.isDisabled(), true, 'the branch screen has no selected commit');

  // --- bisect ----------------------------------------------------------------
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  const history = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await history.waitFor();
  // Rows are addressed by object id: `git log --all` also lists the stash
  // commits, whose subjects quote the commit they were made on.
  const commitRow = oid => page.locator(`#commit-${oid}`);
  await history.press('Home');
  await commitRow(commits.at(-1)).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.waitFor();
  // Starting from a commit means "this one is broken", so the banner asks for
  // the other end of the range straight away.
  await menu.getByRole('menuitem', { name: /BugHunter \(bisect\)/ }).click();
  await expect(`${commits.at(-1).slice(0, 7)} has the bug. Select an older commit where the same bug is absent.`, 'the start explains how to choose the range');
  const hunter = page.getByRole('region', { name: '🌱 BugHunter (bisect)', exact: true });
  await page.waitForFunction(() => document.querySelector('.bughunter-tool')?.title === 'BugHunter is already running. Use the panel below.');
  assert.equal(await hunterTool.isDisabled(), true, 'the toolbar cannot restart an active search');
  await hunterTool.locator('..').hover();
  assert.equal(await hunterTool.locator('..').getAttribute('title'), 'BugHunter is already running. Use the panel below.', 'hover on the disabled button reaches its explanation');
  await hunter.getByText('How to use BugHunter', { exact: true }).click();
  await hunter.getByText(/16 candidate commits usually need about 4 tests/).waitFor();
  await shot('bughunter-help');
  await hunter.getByText('How to use BugHunter', { exact: true }).click();

  await history.press('End');
  await commitRow(commits[0]).click();
  await hunter.getByRole('button', { name: `Bug absent at ${commits[0].slice(0, 7)}`, exact: true }).click();
  await hunter.getByText(/About \d+ more tests? after this one/).waitFor();
  await hunter.getByRole('button', { name: 'Show test commit', exact: true }).click();
  const testOid = await git(['rev-parse', 'HEAD']);
  await page.locator(`#commit-${testOid}[aria-selected="true"]`).waitFor();
  await history.press('Home');
  await commitRow(commits.at(-1)).click();
  assert.match(await hunter.innerText(), new RegExp(`Testing ${testOid.slice(0, 7)}`), 'browsing history does not change the test target');
  await hunter.getByRole('button', { name: 'Cannot test · Skip', exact: true }).click();
  await hunter.getByText(/1 skipped/).waitFor();
  assert.notEqual(await git(['rev-parse', 'HEAD']), testOid, 'Skip checks out another test revision');
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await shot(`bughunter-${theme}`);
  }
  await shot('bisect');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 640));
  await page.waitForFunction(() => innerWidth === 1000);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'the toolbar fits at compact width');
  assert.equal(await hunter.evaluate(node => node.scrollWidth > node.clientWidth), false, 'BugHunter has no horizontal overflow at compact width');
  assert.ok(await history.evaluate(node => node.clientHeight) >= 30, 'the history remains usable below BugHunter');
  await hunter.getByRole('button', { name: 'Bug present', exact: true }).scrollIntoViewIfNeeded();
  await shot('bughunter-compact');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 888));
  await page.waitForFunction(() => innerWidth === 1440);
  await hunter.getByRole('button', { name: 'Stop and return', exact: true }).click();
  await hunter.waitFor({ state: 'detached' });
  assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'stopping also restores the original branch');
  await history.press('Home');
  await commitRow(commits.at(-1)).click();
  await page.waitForFunction(() => !document.querySelector('.bughunter-tool')?.disabled);
  assert.match(await hunterTool.getAttribute('title'), new RegExp(commits.at(-1).slice(0, 7)), 'the tooltip identifies the selected starting commit');
  await hunterTool.click();
  await hunter.getByText(/Select an older commit/).waitFor();
  await history.press('End');
  await commitRow(commits[0]).click();
  await hunter.getByRole('button', { name: `Bug absent at ${commits[0].slice(0, 7)}`, exact: true }).click();
  await hunter.getByText(/About \d+ more tests? after this one/).waitFor();

  // Answer for each revision Git checks out, reading the file it just placed
  // in the working tree — the same thing a person would look at.
  for (let guard = 0; guard < 20; guard += 1) {
    // Read the verdict only once the banner has settled: while the answer is
    // being applied its buttons are disabled, and asking then can catch the
    // step between "not done yet" and the buttons this loop clicks.
    await page.locator('.bisect-banner[aria-busy="false"]').waitFor();
    if (await page.locator('.bisect-banner.done').count()) break;
    const content = await readFile(path.join(cwd, 'app.txt'), 'utf8');
    await page.getByRole('button', { name: content.includes('BUG') ? /^Bug present$/ : /^Bug absent$/ }).click();
    await page.waitForTimeout(120);
  }
  const verdict = page.locator('.bisect-banner.done');
  await verdict.waitFor();
  assert.match(await verdict.innerText(), new RegExp(`First bad commit: ${firstBroken.slice(0, 7)}`), 'bisect landed on the planted commit');
  await shot('bisect-done');
  await page.getByRole('button', { name: 'Finish and return', exact: true }).click();
  await verdict.waitFor({ state: 'detached' });
  assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'ending a bisect puts the branch back');

  // --- stashes ---------------------------------------------------------------
  await page.getByRole('button', { name: /Stashes/ }).first().click();
  // The toolbar has its own Stash and Pop, so everything below is scoped to the screen.
  const stashScreen = page.getByRole('region', { name: 'Stashes', exact: true });
  await page.getByRole('button', { name: /stash@\{1\}/ }).click();
  await page.getByRole('button', { name: /scratch\.txt/ }).click();
  await expect('+brand new', 'an untracked file inside a stash still has a diff');
  await shot('stash');

  // The review images are taken while both screens still have rows on them.
  for (const theme of ['dark', 'light']) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await shot(`stash-${theme}`);
    await page.getByRole('button', { name: /Branches and tags/ }).click();
    await page.getByRole('tab', { name: /Branches/ }).first().waitFor();
    await shot(`branches-${theme}`);
    await page.getByRole('button', { name: /Stashes/ }).first().click();
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal scroll');
  await page.getByRole('button', { name: /stash@\{1\}/ }).click();

  // Dropping states the command and the loss; the list renumbers afterwards.
  await stashScreen.getByRole('button', { name: 'Drop', exact: true }).click();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /\$ git stash drop stash@\{1\}/, 'the exact stash is named');
  await page.getByRole('button', { name: 'Drop the stash', exact: true }).click();
  await expect('stash@{1} dropped.', 'the older stash was dropped');
  await stashScreen.getByRole('button', { name: /stash@\{1\}/ }).waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /stash@\{0\}/ }).waitFor();
  assert.equal(await page.locator('.stash-list li').count(), 1, 'one stash is left');

  // Pop restores the work and empties the list.
  await stashScreen.getByRole('button', { name: 'Pop', exact: true }).click();
  await expect('stash@{0} popped.', 'the stash was popped');
  await page.getByText('No stashes.').waitFor();
  assert.match(await readFile(path.join(cwd, 'app.txt'), 'utf8'), /something else/, 'the stashed work is back in the file');

  // --- rejected IPC input ---------------------------------------------------
  const rejected = await page.evaluate(async () => {
    const workspace = await window.twig.getWorkspace();
    const id = workspace.activeId;
    const oid = '0'.repeat(40);
    const results = await Promise.allSettled([
      window.twig.stashAction(id, 'clear', 0, oid, null),
      window.twig.stashAction(id, 'drop', -1, oid, null),
      window.twig.stashAction(id, 'drop', 0, 'not-an-oid', null),
      window.twig.stashAction(id, 'branch', 0, oid, '-D'),
      window.twig.stashDiff(id, oid, '../escape', false),
      window.twig.runBisect(id, 'run', null),
      window.twig.runBisect(id, 'good', 'not-an-oid'),
      window.twig.setUpstream(id, 'has space', 'origin/main'),
      window.twig.renameBranch(id, 'main', 'a..b'),
      window.twig.deleteTag(id, '-f'),
      window.twig.pushRef(id, 'origin', 'main', true),
      window.twig.pushRef(id, '-origin', 'refs/tags/v1.0.0', false)
    ]);
    return results.map(result => result.status);
  });
  assert.deepEqual(rejected, Array(12).fill('rejected'), 'malformed calls are refused, not answered');
  assert.deepEqual(errors, [], 'no page errors');
  console.log('browse smoke: branches, tags, remote refs, stashes and a full bisect passed');
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
