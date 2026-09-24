import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// The reflog screen and the background fetch in a real Electron window,
// against a real repository whose remote is a local bare repository — so the
// "network" the fetch reaches is a directory, and this run makes no request.
//
// The fixture loses work the two ways people do from a terminal: a branch
// deleted with -D and a commit dropped by reset --hard.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-reflog-smoke-'));
let app;
try {
  const cwd = path.join(root, 'reflog-fixture');
  const bare = path.join(root, 'remote.git');
  const other = path.join(root, 'teammate');
  await mkdir(cwd); await mkdir(other);
  const log = new CommandLog(root);
  await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  const configure = async at => {
    for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value], at);
  };
  const commit = async (file, text, message, at = cwd) => {
    await writeFile(path.join(at, file), text, 'utf8');
    await git(['add', '--', `:(literal)${file}`], at);
    await git(['commit', '--message', message], at);
    return git(['rev-parse', 'HEAD'], at);
  };

  await git(['init', '--bare', '--initial-branch=main', bare], root);
  await git(['init', '--initial-branch=main']); await configure(cwd);
  const c1 = await commit('app.txt', 'one\n', 'One');
  await git(['remote', 'add', 'origin', bare]);
  await git(['push', '--set-upstream', 'origin', 'main']);
  const c2 = await commit('app.txt', 'two\n', 'Two');
  const c3 = await commit('app.txt', 'three\n', 'Three');
  await git(['checkout', '-b', 'feat']);
  const f1 = await commit('feat.txt', 'feature\n', 'Feature work');
  await git(['checkout', 'main']);
  await git(['branch', '-D', 'feat']);
  await git(['reset', '--hard', c2]);
  await git(['clone', bare, other], root); await configure(other);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  const expect = async (text, description, timeout = undefined) => {
    try { await page.getByText(text, { exact: true }).first().waitFor({ timeout }); } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .operation-note, .sync-note').allInnerTexts();
      throw new Error(`${description}: expected "${text}". On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };

  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const fixtureId = await page.evaluate(() => window.twig.getWorkspace()).then(workspace => workspace.repositories.find(item => !item.sandbox).id);
  const settings = async () => { await page.getByRole('button', { name: 'Settings', exact: true }).click(); return page.getByRole('dialog', { name: 'Settings' }); };

  // --- Background fetch: Off until chosen, then it keeps the badges current. ---
  const pull = page.getByRole('button', { name: /^Pull/ }).first();
  assert.match(await pull.getAttribute('title'), /last fetch knew/, 'Off: the Pull tooltip says the badge is only as fresh as the last fetch');
  const theirs = await commit('app.txt', 'theirs\n', 'Teammate change', other);
  await git(['push', 'origin', 'main'], other);
  let dialog = await settings();
  const fetchChoice = dialog.getByLabel('Background fetch');
  assert.equal(await fetchChoice.inputValue(), '0', 'background fetch starts Off');
  await dialog.getByText(/does not reach the network by itself/).waitFor();
  await page.waitForTimeout(12000);
  assert.equal((await page.evaluate(() => window.twig.getConsoleEntries())).filter(entry => entry.operation === 'Background: fetch all remotes').length, 0,
    'Off means no fetch at all, however long the window stays open');
  await fetchChoice.selectOption('5');
  await dialog.getByText(/git fetch --all --no-tags for the repository in the open tab every 5 minutes/).waitFor();
  await page.keyboard.press('Escape');
  await pull.locator('.badge', { hasText: '1' }).waitFor({ timeout: 40000 });
  assert.equal(await git(['rev-parse', 'origin/main']), theirs, 'the remote-tracking branch moved without a click');
  assert.equal(await git(['rev-parse', 'main']), c2, 'the local branch did not');
  assert.match(await pull.getAttribute('title'), /remote checked just now/);
  const fetches = (await page.evaluate(() => window.twig.getConsoleEntries())).filter(entry => entry.operation === 'Background: fetch all remotes');
  assert.equal(fetches.length, 1, 'one fetch, a few seconds after it was turned on');
  assert.ok(fetches[0].argv.includes('--no-tags'), 'journaled with its exact argv');
  dialog = await settings();
  await dialog.getByText(/reflog-fixture: Last fetched just now\./).waitFor();
  await dialog.getByLabel('Background fetch').selectOption('0');
  await dialog.getByText(/does not reach the network by itself/).waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(() => window.twig.getBackgroundFetch()).then(value => value.interval), 0);
  await assert.rejects(page.evaluate(() => window.twig.setBackgroundFetch(7)), /Invalid fetch interval/);
  await assert.rejects(page.evaluate(() => window.twig.setBackgroundFetch('5')), /Invalid fetch interval/);
  await assert.rejects(page.evaluate(() => window.twig.getBackgroundFetchStatus('not-a-repository')), /unavailable/);

  // --- Reflog: see what was lost, bring it back. ---
  await page.getByRole('button', { name: /^Reflog/ }).click();
  const screen = page.getByRole('region', { name: 'Reflog', exact: true });
  const list = screen.getByRole('list', { name: 'Reflog of HEAD' });
  await list.getByRole('listitem').first().waitFor();
  const first = await list.getByRole('listitem').first().innerText();
  assert.match(first, /HEAD@\{0\}/); assert.match(first, /Reset/);
  await screen.getByLabel('Only commits on no branch').check();
  const lost = await list.getByRole('listitem').allInnerTexts();
  // Every move is listed: the reset-away commit was HEAD three times (commit,
  // checkout to feat, checkout back), the deleted branch's commit once.
  assert.equal(lost.length, 4);
  assert.deepEqual([...new Set(lost.map(text => /Feature work|Three/.exec(text)?.[0]))].sort(), ['Feature work', 'Three'],
    'the deleted branch’s commit and the reset-away commit');
  assert.ok(lost.every(text => text.includes('On no branch')), 'said in words, not only in colour');
  await list.getByRole('button', { name: /Feature work/ }).click();
  const detail = screen.getByLabel(/HEAD@\{\d+\} details/);
  await detail.getByRole('heading', { name: 'Feature work' }).waitFor();
  await detail.getByText(/No branch, tag or remote holds this commit/).waitFor();
  await detail.getByRole('button', { name: /feat\.txt/ }).click();
  await detail.locator('.diff-view[aria-label="Diff of feat.txt"]').waitFor();
  assert.ok(await detail.getByRole('button', { name: /Show in history/ }).isDisabled(), 'a lost commit is not in the graph to show');

  await detail.getByRole('button', { name: 'Create branch here…' }).click();
  const name = page.getByRole('dialog', { name: `Create a branch at ${f1.slice(0, 7)}` });
  assert.equal(await name.getByLabel('Branch name').inputValue(), 'feat', 'the deleted branch is offered back under its own name');
  await name.getByRole('button', { name: 'Create branch', exact: true }).click();
  await expect(`Branch feat now holds ${f1.slice(0, 7)}.`, 'create a branch from a lost commit');
  assert.equal(await git(['rev-parse', 'feat']), f1);
  // feat was built on Three, so the recovered branch holds both lost commits.
  await screen.getByText('Every commit loaded here is still on a branch, tag or remote. Nothing on this page is at risk.').waitFor();
  await screen.getByLabel('Only commits on no branch').uncheck();

  await list.getByRole('button', { name: /Three/ }).first().click();
  await detail.getByRole('button', { name: 'Move main here…' }).click();
  let confirm = page.getByRole('dialog', { name: `Move main to ${c3.slice(0, 7)}` });
  assert.equal(await confirm.locator('.confirm-command').innerText(), `$ git reset --keep ${c3}`, 'the exact command, before it runs');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await git(['rev-parse', 'main']), c2, 'Cancel moves nothing');
  await detail.getByRole('button', { name: 'Move main here…' }).click();
  confirm = page.getByRole('dialog', { name: `Move main to ${c3.slice(0, 7)}` });
  await confirm.getByRole('button', { name: 'Move main', exact: true }).click();
  await expect(`main moved to ${c3.slice(0, 7)}. Undo moves it back.`, 'move the branch back');
  assert.equal(await git(['rev-parse', 'main']), c3);
  const undo = page.locator('.toolbar').getByRole('button', { name: /^Undo/ });
  await page.waitForFunction(() => [...document.querySelectorAll('.toolbar button')].some(button => button.textContent.trim() === 'Undo' && !button.disabled));
  await undo.click();
  await expect('Undo completed.', 'Undo the reflog move');
  assert.equal(await git(['rev-parse', 'main']), c2, 'Undo puts main back');

  // A branch's own reflog, and a move that has nowhere to go.
  await screen.getByLabel('Reflog of', { exact: true }).selectOption('feat');
  const feat = screen.getByRole('list', { name: 'Reflog of feat' });
  await feat.getByText('feat@{0}').waitFor();
  assert.match(await screen.getByRole('button', { name: /Move feat here/ }).getAttribute('title'), /already points here/);

  // Show in history works for a commit the graph has.
  await screen.getByLabel('Reflog of', { exact: true }).selectOption('');
  await list.getByRole('button', { name: /Two/ }).first().click();
  await detail.getByRole('button', { name: 'Show in history' }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();

  await assert.rejects(page.evaluate(id => window.twig.getReflog(id, '--all', 0), fixtureId), /Invalid ref name|Error/);
  await assert.rejects(page.evaluate(id => window.twig.getReflog(id, null, -1), fixtureId), /Invalid reflog request/);
  await assert.rejects(page.evaluate(([id, oid]) => window.twig.moveBranchTo(id, 'main', 'HEAD~1', oid), [fixtureId, c2]), /Invalid commit identifier/);
  await assert.rejects(page.evaluate(([id, oid]) => window.twig.moveBranchTo(id, '--force', oid, oid), [fixtureId, c1]), /Invalid/);
  await assert.rejects(page.evaluate(oid => window.twig.moveBranchTo('not-a-repository', 'main', oid, oid), c1), /unavailable/);
  assert.equal(await git(['rev-parse', 'main']), c2, 'refused requests changed nothing');

  // Screens for review, with the console collapsed.
  if (await page.getByRole('textbox', { name: 'Search command log' }).isVisible()) await page.locator('.console-status').click();
  await page.getByRole('button', { name: /^Reflog/ }).click();
  await list.getByRole('button', { name: /Three/ }).first().click();
  for (const theme of ['dark', 'light']) {
    dialog = await settings();
    await dialog.getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: `artifacts/reflog-${theme}.png`, animations: 'disabled' });
  }
  dialog = await settings();
  await dialog.getByLabel('Background fetch').selectOption('15');
  await page.screenshot({ path: 'artifacts/background-fetch-settings.png', animations: 'disabled' });
  await dialog.getByLabel('Background fetch').selectOption('0');
  await page.keyboard.press('Escape');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Reflog smoke passed: background fetch Off by default, on → badge updated from a local remote, journaled, off again; reflog lists moves, marks lost commits, recovers a deleted branch under its name, moves main back with reset --keep, Undo, branch reflog, Show in history, IPC refusals.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
