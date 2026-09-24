import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// Five everyday tools in a real Electron window against a real repository:
// co-authors from history in the commit form, .gitignore rules from the
// untracked files' menus (with Undo), BugHunter's answers on the graph, tag
// messages and version order on the Branches and tags screen, and repository
// maintenance (Optimize, then git gc behind its confirmation).

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-everyday-smoke-')));
let app;
try {
  const cwd = path.join(root, 'app');
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const git = async (argv, env = null) => {
    const result = await runGit({ argv, cwd, log, env });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  await mkdir(cwd);
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Me Myself'], ['user.email', 'me@example.invalid'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false'],
    ['core.hooksPath', ''], ['gc.auto', '0'], ['maintenance.auto', 'false']]) await git(['config', key, value]);
  const commits = [];
  const authors = [['Ann Lee', 'ann@example.invalid'], ['Bob Builder', 'bob@example.invalid']];
  for (let i = 1; i <= 12; i += 1) {
    await writeFile(path.join(cwd, 'app.txt'), `line ${i}\n${i >= 7 ? 'BUG\n' : ''}`);
    await git(['add', '.']);
    const [name, email] = authors[i % 2];
    await git(['commit', '-q', '-m', `Change ${i}`], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email });
    commits.push(await git(['rev-parse', 'HEAD']));
  }
  const tag = async (name, oid, message) => assert.equal((await runGit({ argv: ['tag', '--annotate', '--file=-', name, oid], cwd, log, stdin: message })).code, 0);
  await tag('v1.2.0', commits[2], 'Release 1.2\n');
  await tag('v1.10.0', commits[9], 'Release 1.10\n\nFaster graph.\nFewer clicks.\n');
  await git(['tag', 'v1.9.0', commits[6]]);
  await writeFile(path.join(cwd, 'debug.log'), 'noise\n');
  await mkdir(path.join(cwd, 'scratch')); await writeFile(path.join(cwd, 'scratch', 'todo.txt'), 'later\n');
  await writeFile(path.join(cwd, 'feature.txt'), 'pairing\n');
  await git(['add', 'feature.txt']);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const expect = async (text, description) => {
    try { await page.getByText(text).first().waitFor(); } catch (failure) {
      const shown = await page.locator('[role="alert"], [role="status"], .history-error, .operation-note').allInnerTexts();
      throw new Error(`${description}: expected ${text}. On screen: ${JSON.stringify(shown)}. Page errors: ${JSON.stringify(errors)}. ${failure.message}`);
    }
  };
  const settle = async check => { for (let i = 0; i < 60 && !await check(); i++) await page.waitForTimeout(100); assert.ok(await check()); };
  const exists = file => lstat(path.join(cwd, file)).then(() => true, () => false);
  const workspace = () => page.locator('.workspace-tab:not([hidden])');
  const nav = name => workspace().getByRole('navigation', { name: 'Repository screens' }).getByRole('button', { name });
  const setTheme = async theme => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
  };

  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  const id = await page.evaluate(() => window.twig.getWorkspace()).then(state => state.repositories.find(item => !item.sandbox).id);
  if (await page.getByRole('textbox', { name: 'Search command log' }).isVisible()) await page.locator('.console-status').click();

  // --- Tags: version order, messages, lightweight said as such ---------------------------------
  await nav(/Branches and tags/).click();
  const refsScreen = page.getByRole('region', { name: 'Branches and tags' });
  await refsScreen.getByRole('tab', { name: /Tags/ }).click();
  await refsScreen.getByText('Release 1.10').waitFor();
  const tagNames = async () => refsScreen.locator('.refs-row .refs-name > strong').evaluateAll(nodes => nodes.map(node => node.firstChild.textContent));
  assert.deepEqual(await tagNames(), ['v1.10.0', 'v1.9.0', 'v1.2.0'], 'newest version first: 1.10 after 1.9, not before 1.2');
  await refsScreen.locator('.refs-row').filter({ hasText: 'v1.9.0' }).getByText('Lightweight tag').waitFor();
  await refsScreen.locator('.refs-row').filter({ hasText: 'v1.10.0' }).getByText('annotated', { exact: true }).waitFor();
  await refsScreen.getByText('Full message').first().click();
  await refsScreen.getByText(/Faster graph\.\s+Fewer clicks\./).waitFor();
  await refsScreen.getByRole('combobox', { name: 'Sort tags' }).selectOption('name');
  assert.deepEqual(await tagNames(), ['v1.10.0', 'v1.2.0', 'v1.9.0'], 'plain name order is still available');
  await refsScreen.getByRole('textbox', { name: 'Search branches and tags' }).fill('fewer clicks');
  assert.deepEqual(await tagNames(), ['v1.10.0'], 'search reaches tag messages');
  await refsScreen.getByRole('textbox', { name: 'Search branches and tags' }).fill('');
  await refsScreen.getByRole('combobox', { name: 'Sort tags' }).selectOption('version');
  await page.screenshot({ path: 'artifacts/everyday-tags.png', animations: 'disabled' });
  await refsScreen.getByRole('button', { name: 'Back to history', exact: true }).click();

  // --- .gitignore from the uncommitted panel's menu, then Undo ---------------------------------
  await page.getByRole('button', { name: /Uncommitted changes, 3 files/ }).click();
  const uncommitted = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  const untrackedList = uncommitted.getByRole('region', { name: 'Untracked files' });
  await untrackedList.getByRole('button', { name: 'Untracked debug.log', exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: /Ignore all \.log files/ }).getByText('*.log', { exact: true }).waitFor();
  await menu.screenshot({ path: 'artifacts/everyday-ignore-menu.png' });
  await menu.getByRole('menuitem', { name: /Ignore all \.log files/ }).click();
  await expect('Added *.log to .gitignore (new file). Undo takes it back out.', 'ignoring by extension');
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '*.log\n');
  assert.equal(await git(['status', '--porcelain', '--', 'debug.log']), '', 'debug.log is ignored now');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await settle(async () => !await exists('.gitignore'));
  assert.equal(await git(['status', '--porcelain', '--', 'debug.log']), '?? debug.log', 'Undo took the rule back out');

  // --- Staging screen: ignore a folder from its row menu, then commit with a co-author ----------
  await uncommitted.getByRole('button', { name: 'Open staging', exact: true }).click();
  const untrackedSection = page.getByRole('region', { name: 'Untracked files' });
  await untrackedSection.getByRole('button', { name: /^Untracked scratch\/$/ }).click({ button: 'right' });
  await menu.getByRole('menuitem', { name: /Ignore this folder/ }).click();
  await expect('Added /scratch/ to .gitignore. Undo takes it back out.', 'ignoring a folder from the staging screen');
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '/scratch/\n');

  await page.getByRole('textbox', { name: 'Commit message' }).fill('Pair on the feature');
  const picker = page.getByRole('combobox', { name: 'Add a co-author' });
  assert.equal(await picker.count(), 0, 'the picker costs no height until asked for');
  await page.getByRole('button', { name: 'Add co-authors', exact: true }).click();
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Add a co-author');
  const options = page.getByRole('listbox', { name: 'Authors in this history' });
  await options.getByRole('option').first().waitFor();
  assert.deepEqual(await options.getByRole('option').locator('strong').allInnerTexts(), ['Ann Lee', 'Bob Builder'],
    'people from history, yourself left out');
  await picker.fill('bob');
  await page.keyboard.press('Enter');
  await page.locator('.co-author-chip').filter({ hasText: 'Bob Builder' }).waitFor();
  await page.getByText('Co-authored-by: Bob Builder <bob@example.invalid>', { exact: true }).waitFor();
  await page.locator('.commit-box').screenshot({ path: 'artifacts/everyday-co-authors.png' });
  await page.getByRole('button', { name: 'Commit 1 file', exact: true }).click();
  await expect('Commit created.', 'commit with a co-author');
  assert.equal(await git(['log', '-1', '--format=%B']), 'Pair on the feature\n\nCo-authored-by: Bob Builder <bob@example.invalid>\n');
  assert.equal(await page.locator('.co-author-chip').count(), 0, 'the form starts empty again');
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await git(['add', '.gitignore']); await git(['commit', '-q', '-m', 'Ignore scratch']);
  await rm(path.join(cwd, 'debug.log'));

  // --- BugHunter's answers on the graph ------------------------------------------------------
  // Started and answered once in a terminal: the graph reads what Git recorded.
  const hasBug = async () => (await readFile(path.join(cwd, 'app.txt'), 'utf8')).includes('BUG');
  await setTheme('dark');
  await git(['bisect', 'start', commits.at(-1), commits[0]]);
  await git(['bisect', await hasBug() ? 'bad' : 'good']);
  await workspace().getByRole('button', { name: 'Refresh', exact: true }).click();
  const hunter = page.getByRole('region', { name: '🌱 BugHunter (bisect)', exact: true });
  await hunter.waitFor();
  const chip = kind => page.locator(`.bisect-chip.bisect-${kind}`);
  // Both ends given to `start`, the answer after it, and the revision on test.
  await settle(async () => await page.locator('.bisect-chip').count() === 4);
  await chip('good').first().waitFor();
  await chip('testing').first().waitFor();
  assert.equal(await page.locator('.real-commit-row').filter({ hasText: 'Change 12' }).locator('.bisect-chip').innerText(), 'bad',
    'the bad end given to start is drawn, with its word');
  await page.locator('.graph-panel').screenshot({ path: 'artifacts/everyday-bisect-dark.png', animations: 'disabled' });
  // Answer through the banner until Git names the culprit.
  const testing = () => hunter.locator('.bisect-test-heading code').innerText().catch(() => '');
  for (let guard = 0; guard < 10 && !await chip('culprit').count(); guard++) {
    const before = await testing();
    await hunter.getByRole('button', { name: await hasBug() ? /^Bug present$/ : /^Bug absent$/ }).click();
    await settle(async () => await chip('culprit').count() > 0 || (await testing() !== before && await testing() !== ''));
  }
  await chip('culprit').first().waitFor();
  assert.equal(await page.locator('.real-commit-row').filter({ has: chip('culprit') }).locator('.commit-subject').innerText().then(text => /Change 7\b/.test(text)), true,
    'the first bad commit is marked on its own row');
  assert.equal(await chip('culprit').innerText(), 'first bad');
  await setTheme('light');
  await page.locator('.graph-panel').screenshot({ path: 'artifacts/everyday-bisect-light.png', animations: 'disabled' });
  await setTheme('dark');
  await hunter.getByRole('button', { name: 'Finish and return', exact: true }).click();
  await settle(async () => await page.locator('.bisect-chip').count() === 0);

  // --- Maintenance: numbers, Optimize, then gc behind its confirmation -----------------------
  await nav(/Maintenance/).click();
  const care = page.getByRole('region', { name: 'Maintenance' });
  await care.getByText('On disk').waitFor();
  const loose = async () => Number((await care.locator('.maintenance-stats > div').filter({ hasText: 'Loose objects' }).locator('dd').innerText()).replace(/,/g, ''));
  assert.ok(await loose() > 30, 'a fresh repository keeps its objects loose');
  await care.getByRole('button', { name: 'Optimize', exact: true }).click();
  await expect(/Optimize finished in [\d.]+ s\. On disk: .+ → .+; loose objects: \d+ → \d+/, 'optimize');
  assert.ok(await loose() < 10, 'Optimize packed the loose objects and dropped their copies');
  await care.getByRole('button', { name: 'Clean up…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('$ git gc', { exact: true }).waitFor();
  await dialog.getByText(/unreachable objects older than two weeks are deleted/).waitFor();
  await dialog.screenshot({ path: 'artifacts/everyday-gc-confirm.png' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).waitFor({ state: 'detached' });
  await care.getByRole('button', { name: 'Clean up…', exact: true }).click();
  await dialog.getByRole('button', { name: 'Clean up', exact: true }).click();
  await expect(/Clean up finished in [\d.]+ s/, 'gc');
  assert.equal(await loose(), 0, 'gc leaves nothing loose');
  for (const theme of ['dark', 'light']) {
    await setTheme(theme);
    await page.screenshot({ path: `artifacts/everyday-maintenance-${theme}.png`, animations: 'disabled' });
  }
  await setTheme('dark');

  // --- Refusals at the channels ----------------------------------------------------------------
  await assert.rejects(page.evaluate(repo => window.twig.addIgnoreRule(repo, '../outside.txt', 'file'), id), /Invalid ignore request/);
  await assert.rejects(page.evaluate(repo => window.twig.addIgnoreRule(repo, 'app.txt', 'pattern'), id), /Invalid ignore request/);
  await assert.rejects(page.evaluate(repo => window.twig.addIgnoreRule(repo, 'app.txt', 'file'), id), /not untracked/);
  await assert.rejects(page.evaluate(repo => window.twig.runMaintenance(repo, 'prune'), id), /Invalid maintenance task/);
  await assert.rejects(page.evaluate(repo => window.twig.createCommit(repo, 'x', false, null, [{ name: 'Eve\nSigned-off-by: M', email: 'e@x' }]), id), /Invalid co-author/);
  await assert.rejects(page.evaluate(repo => window.twig.createCommit(repo, 'x', false, null, 'Ann'), id), /Invalid co-authors/);
  await assert.rejects(page.evaluate(() => window.twig.getTagDetails('not-a-repository')), /unavailable/);
  await assert.rejects(page.evaluate(() => window.twig.getRepositoryStats('not-a-repository')), /unavailable/);
  assert.equal(await git(['log', '-1', '--format=%s']), 'Ignore scratch', 'no refused request committed anything');

  assert.deepEqual(errors, [], 'no page errors');
  console.log('Everyday smoke passed: tags in version order with messages, .gitignore from both menus with Undo, a co-author from history as a trailer, BugHunter answers and the culprit on the graph, Optimize and git gc with sizes, 8 IPC refusals.');
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
