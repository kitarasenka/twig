import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';
import { expandRefTree } from './smoke-ref-tree.mjs';

// Worktrees in the graph, in a real Electron window on real worktrees: a row and
// a dashed lane each, marks on their branches, what they changed in the details
// panel, and an agent connected through the real MCP bridge from a worktree folder.

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-worktree-graph-')));
await mkdir('artifacts', { recursive: true });
let app;
let bridge;
try {
  const cwd = path.join(root, 'app');
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ argv, cwd: at, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  await git(['init', '--initial-branch=main', cwd], root);
  for (const [key, value] of [['user.name', 'Twig Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false']]) await git(['config', key, value]);
  const commit = async (file, text, message, at = cwd) => {
    await writeFile(path.join(at, file), text, 'utf8');
    await git(['add', '--', `:(literal)${file}`], at);
    await git(['commit', '--message', message], at);
  };
  for (let index = 1; index <= 6; index++) await commit('app.txt', `line ${index}\n`, `Main ${index}`);
  const folder = name => path.join(cwd, '.claude', 'worktrees', name);
  const addWorktree = (name, start = 'HEAD') => git(['worktree', 'add', '-b', `agent/${name}`, folder(name), start]);
  // One agent forked two commits back, committed and left work uncommitted; one has not started.
  await addWorktree('auth', 'HEAD~2');
  await commit('login.txt', 'login\n', 'Add login', folder('auth'));
  await writeFile(path.join(folder('auth'), 'app.txt'), 'edited by the agent\n');
  await writeFile(path.join(folder('auth'), 'notes.md'), 'todo\n');
  await addWorktree('fresh');
  await writeFile(path.join(cwd, '.git', 'info', 'exclude'), '/.claude/worktrees/\n');

  const env = { ...process.env, TWIG_LANGUAGE: 'en' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  await page.getByRole('option', { name: /Main 6/ }).waitFor();

  // A row each, on the commit columns, and the graph makes room for their lanes.
  const strip = page.getByRole('group', { name: 'Worktrees', exact: true });
  const row = name => strip.locator('.worktree-lane-row', { hasText: name });
  await row('auth').waitFor();
  assert.equal(await strip.locator('.worktree-lane-row').count(), 2);
  assert.match(await row('auth').innerText(), /agent\/auth/);
  assert.match(await row('auth').innerText(), /2 files not committed · \+1 −1 \(1 new\) · 1 commit ahead of main · 2 behind/);
  assert.match(await row('fresh').innerText(), /Nothing uncommitted · Merged into main/);
  const columns = selector => page.locator(selector).first().evaluate(node => {
    const box = cell => node.querySelector(cell).getBoundingClientRect();
    return { lanes: box('.lane-cell').left, width: box('.lane-cell').width, subject: box('.commit-subject').left };
  });
  assert.deepEqual(await columns('.worktree-lane-row'), await columns('.real-commit-row'), 'a worktree row stands on the columns of the commits');

  // Exactly a row tall, so the dashes run on from row to row, and the branch is not cut off.
  const fit = await page.evaluate(() => [...document.querySelectorAll('.worktree-lane-row')].map(row => ({ row: row.getBoundingClientRect().height,
    badge: row.querySelector('.ref-badge').getBoundingClientRect().height, line: row.querySelector('.ref-line').getBoundingClientRect().height })));
  for (const item of fit) { assert.equal(item.row, 28); assert.ok(item.badge <= item.line, `badge ${item.badge} in line ${item.line}`); }

  // Each lane runs from the node of its row into the commits, in a column of its own.
  const links = () => page.evaluate(() => {
    const paths = selector => [...document.querySelectorAll(selector)].map(node => node.getAttribute('d'));
    return { strip: paths('.worktree-strip .worktree-link'), commits: paths('.real-commit-row .worktree-link'),
      nodes: [...document.querySelectorAll('.worktree-node')].map(node => Number(node.getAttribute('cx'))) };
  });
  const lanes = await links();
  assert.equal(new Set(lanes.nodes).size, 2, 'two lanes, two columns');
  for (const x of lanes.nodes) {
    assert.ok(lanes.strip.some(line => line.startsWith(`M${x} `)), `lane ${x} leaves its row`);
    assert.ok(lanes.commits.some(line => line.startsWith(`M${x} 0V`) && line.includes('H')), `lane ${x} turns into its commit`);
  }
  // Fresh stands on the newest commit, and auth on its own, so the top row's line turns at once.
  assert.ok(lanes.commits.some(line => /^M\d+ 0V14H\d+$/.test(line)));

  // Their branches say so, in the graph and in the sidebar, in words and by icon.
  const plate = page.locator('.real-commit-row .ref-badge', { hasText: 'agent/auth' });
  assert.match(await plate.getAttribute('title'), /refs\/heads\/agent\/auth · Checked out in worktree auth/);
  assert.equal(await plate.locator('svg[aria-label="Checked out in worktree auth"]').count(), 1);
  assert.doesNotMatch(await page.locator('.real-commit-row .ref-badge', { hasText: /^main$/ }).getAttribute('title'), /worktree/, 'the branch of this tab is not marked');
  await expandRefTree(page);
  const leaf = page.locator('.real-branch[title^="refs/heads/agent/auth"]');
  assert.match(await leaf.getAttribute('title'), /Checked out in worktree auth/);
  assert.equal(await leaf.locator('svg[aria-label="Checked out in worktree auth"]').count(), 1);

  // A row opens what the worktree changed; the graph stays.
  await row('auth').click();
  const panel = page.getByRole('complementary', { name: 'Worktree auth', exact: true });
  await panel.getByRole('heading', { name: 'agent/auth', exact: true }).waitFor();
  assert.equal(await row('auth').getAttribute('aria-pressed'), 'true');
  await panel.getByText('Add login', { exact: true }).waitFor();
  assert.equal(await panel.locator('.tool-badge').filter({ hasText: /^Agent$/ }).count(), 0, 'no agent mark until one connects');
  const files = panel.getByRole('list', { name: 'Files this worktree changed' });
  assert.deepEqual((await files.getByRole('button').allInnerTexts()).map(text => text.split('\n').find(line => line.includes('.'))), ['app.txt', 'login.txt', 'notes.md']);
  await page.screenshot({ path: 'artifacts/worktree-graph.png', animations: 'disabled' });
  assert.ok(await page.getByRole('listbox', { name: 'Commit history' }).isVisible());

  // A file opens in the centre with whose it is: a change in a worktree has no versions to switch between here.
  await files.getByRole('button', { name: /app\.txt/ }).click();
  const fileDiff = page.getByRole('region', { name: 'File diff', exact: true });
  await fileDiff.getByText('+edited by the agent', { exact: true }).waitFor();
  assert.equal(await fileDiff.locator('.pill').innerText(), 'auth');
  assert.equal(await fileDiff.getByRole('button', { name: 'Full file' }).count(), 0);
  assert.equal(await fileDiff.getByRole('button', { name: 'Blame' }).count(), 0);
  assert.equal(await files.getByRole('button', { name: /app\.txt/ }).getAttribute('aria-pressed'), 'true');
  // An untracked file reads as added, without tracking it.
  await files.getByRole('button', { name: /notes\.md/ }).click();
  await fileDiff.getByText('+todo', { exact: true }).waitFor();
  assert.match(await git(['status', '--porcelain'], folder('auth')), /\?\? notes\.md/);
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await row('auth').waitFor();
  assert.ok(await panel.isVisible(), 'back to history keeps the worktree chosen');

  // All worktrees opens the board on this one; the board is where squash and remove live.
  await panel.getByRole('button', { name: 'All worktrees' }).click();
  await page.getByRole('heading', { name: 'Worktrees' }).waitFor();
  const card = page.getByRole('list', { name: 'Worktrees' }).getByRole('button', { name: /^auth/ });
  assert.equal(await card.getAttribute('aria-pressed'), 'true', 'the board opens on the worktree it came from');
  assert.equal(await strip.count(), 0, 'no rows behind a screen');
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await row('auth').waitFor();

  // A commit takes the panel back.
  await page.getByRole('option', { name: /Main 6/ }).click();
  await page.getByRole('heading', { name: 'Main 6', exact: true }).waitFor();
  assert.equal(await panel.count(), 0);
  assert.equal(await row('auth').getAttribute('aria-pressed'), 'false');

  // An agent's commit moves a branch, and the row follows by itself.
  await commit('more.txt', 'more\n', 'Another step', folder('fresh'));
  await row('fresh').getByText(/1 commit ahead of main/).waitFor();
  // Its edits touch no ref: Refresh reads them.
  await writeFile(path.join(folder('fresh'), 'wip.txt'), 'wip\n');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await row('fresh').getByText(/1 file not committed/).waitFor();

  // An agent connects from a worktree folder over the real bridge: the row, the node and the branch say so.
  await page.evaluate(() => window.twig.setMcpEnabled(true));
  const launch = (await page.evaluate(() => window.twig.getMcpSettings())).config.launch;
  bridge = spawn(launch.command, launch.args, { cwd: folder('auth'), env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } })}\n`);
  await row('auth').getByText('Agent connected', { exact: true }).waitFor();
  assert.equal(await row('fresh').getByText('Agent connected', { exact: true }).count(), 0, 'only the worktree it works in');
  assert.equal(await row('auth').locator('.worktree-node.connected').count(), 1);
  assert.equal(await plate.locator('svg.lucide-bot').count(), 1, 'the branch shows a robot, not only a colour');
  assert.match(await plate.getAttribute('title'), /Checked out in worktree auth · Agent connected/);
  await page.screenshot({ path: 'artifacts/worktree-graph-agent.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('light'); await page.keyboard.press('Escape');
  await page.screenshot({ path: 'artifacts/worktree-graph-light.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Appearance').selectOption('dark'); await page.keyboard.press('Escape');
  bridge.stdin.end();
  await new Promise(resolve => bridge.once('exit', resolve));
  bridge = null;
  await row('auth').getByText('Agent connected', { exact: true }).waitFor({ state: 'detached' });

  // Past four, the most urgent stay and the rest are a count that opens the board.
  for (const name of ['one', 'two', 'three']) await addWorktree(name);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  const more = strip.getByRole('button', { name: '1 more worktree', exact: true });
  await more.waitFor();
  assert.equal(await strip.locator('.worktree-lane-row:not(.worktree-lane-more)').count(), 4);
  await row('auth').waitFor(); await row('fresh').waitFor();
  await more.click();
  await page.getByRole('heading', { name: 'Worktrees' }).waitFor();
  await page.getByRole('button', { name: 'Back to history', exact: true }).click();
  await more.waitFor();

  // A worktree removed elsewhere takes its row and the selection with it.
  await row('one').or(row('two')).or(row('three')).first().click();
  const chosen = await strip.locator('.worktree-lane-row.selected strong').innerText();
  await git(['worktree', 'remove', folder(chosen)]);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('complementary', { name: `Worktree ${chosen}`, exact: true }).waitFor({ state: 'detached' });
  await page.locator('.commit-detail .commit-subject-heading').waitFor();
  assert.equal(await strip.locator('.worktree-lane-row.selected').count(), 0);

  // Opened as a tab, a worktree's own row goes and the main checkout gets one.
  await row('auth').click();
  await panel.getByRole('button', { name: 'Open as tab' }).click();
  await page.getByRole('tab', { name: /auth/ }).or(page.getByRole('button', { name: 'auth', exact: true })).first().waitFor();
  const here = page.locator('.worktree-strip:visible');
  await here.locator('.worktree-lane-row', { hasText: 'app' }).waitFor();
  assert.match(await here.locator('.worktree-lane-row', { hasText: 'app' }).innerText(), /Main/);
  assert.equal(await here.locator('.worktree-lane-row strong', { hasText: /^auth$/ }).count(), 0, 'no row for the tab itself');

  // The channel refuses what it should.
  const id = await page.evaluate(() => window.twig.getWorkspace().then(workspace => workspace.repositories.find(item => !item.sandbox).id));
  await assert.rejects(page.evaluate(value => window.twig.getGraphWorktrees(value, 'yes'), id), /Invalid worktree request/);
  await assert.rejects(page.evaluate(() => window.twig.getGraphWorktrees('/not/connected', true)));
  // A repository without worktrees has no rows and no extra lanes.
  assert.deepEqual(await page.evaluate(() => window.twig.getWorkspace().then(workspace => window.twig.getGraphWorktrees(workspace.repositories.find(item => item.sandbox).id, true)).then(board => board.worktrees)), []);

  assert.deepEqual(errors, []);
  console.log('Worktree graph Electron passed: rows on the commit columns, dashed lanes, branch marks, details panel, diffs, board focus, refresh, real MCP agent, more than four, removal, linked tab, IPC refusals.');
} finally {
  bridge?.kill();
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
