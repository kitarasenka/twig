import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Settings → AI agents (MCP) in the real app, and an agent's view of it: the
// bridge is started exactly as the copied configuration says — on 🌱 Twig's
// own executable with ELECTRON_RUN_AS_NODE=1 — and asked about the demo
// workspace while the window changes its selection.
// realpath: on macOS the temp folder is a symlink, and Electron reports userData resolved.
const profile = await realpath(await mkdtemp(path.join(tmpdir(), 'twig-mcp-smoke-')));
await mkdir('artifacts', { recursive: true });
const errors = [];
let app;
let bridge;

function startBridge(launch) {
  const child = spawn(launch.command, launch.args, { env: { ...process.env, ...launch.env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let id = 1;
  const request = (method, params) => new Promise((resolve, reject) => {
    const current = id++;
    const timer = setTimeout(() => reject(new Error(`bridge did not answer ${method}: ${stderr}`)), 15_000);
    waiting.set(current, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, ...(params ? { params } : {}) })}\n`);
  });
  return {
    request,
    async tool(name, args = {}) {
      const message = await request('tools/call', { name, arguments: args });
      const raw = message.result.content[0].text;
      if (message.result.isError) return { error: JSON.parse(raw).error };
      // Lists and diffs are plain text; the small state answers are JSON.
      try { return JSON.parse(raw); } catch { return raw; }
    },
    close: () => { child.stdin.end(); return new Promise(resolve => child.once('exit', resolve)); }
  };
}

async function launch() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  return page;
}

try {
  let page = await launch();
  const demo = await page.evaluate(() => window.twig.getWorkspace().then(w => w.repositories.find(r => r.sandbox)));

  // Off by default: no socket, no endpoint file.
  const initial = await page.evaluate(() => window.twig.getMcpSettings());
  assert.equal(initial.enabled, false);
  assert.equal(initial.status.listening, false);
  await assert.rejects(stat(path.join(profile, 'mcp', 'endpoint.json')), 'nothing is written while Off');

  // Settings names it too, but the toolbar button next to BugHunter is the way in.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByText('Off. Let coding agents such as Claude Code read your repositories, read-only.').waitFor();
  await page.keyboard.press('Escape');
  const tool = page.getByRole('button', { name: 'MCP: off — connect AI agents such as Claude Code' });
  await tool.waitFor();
  assert.equal(await page.locator('.mcp-tool .tool-dot').count(), 0, 'no "on" dot while Off');
  const order = await page.locator('section.toolbar .tool').evaluateAll(nodes => nodes.map(node => node.textContent.trim()));
  assert.equal(order[order.indexOf('BugHunter') + 1], 'MCP', 'the MCP button sits right after BugHunter');
  await tool.click();
  const dialog = page.getByRole('region', { name: 'AI agents (MCP)' });
  await dialog.waitFor();
  await dialog.getByRole('heading', { name: 'What your agent gets' }).waitFor();
  await dialog.getByText('Explain the commit I have selected in Twig.', { exact: false }).waitFor();
  await page.getByLabel('MCP server').selectOption('on');
  await page.getByText('Listening. No agent connected yet.').waitFor();
  await page.getByRole('button', { name: 'MCP: on — AI agents can read your repositories' }).waitFor();
  assert.equal(await page.locator('.mcp-tool .tool-dot').count(), 1, 'the toolbar shows the server is on right away');
  const settings = await page.evaluate(() => window.twig.getMcpSettings());
  assert.equal(settings.enabled, true);
  assert.equal(settings.config.launch.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(settings.config.launch.args[0], path.join(profile, 'mcp', 'twig-mcp.mjs'));
  assert.match(settings.config.claude, /^claude mcp add --scope user twig --env ELECTRON_RUN_AS_NODE=1 -- /);
  await dialog.getByText(settings.config.claude, { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Copy Claude Code configuration' }).click();
  await page.getByRole('button', { name: 'Copy Claude Code configuration' }).getByText('Copied').waitFor();
  await dialog.getByRole('status').filter({ hasText: 'Claude Code configuration copied.' }).waitFor();
  await page.getByLabel('Codex configuration', { exact: true }).focus();
  assert.equal(await page.evaluate(() => document.activeElement.className), 'mcp-config', 'a config block takes focus, so the keyboard can scroll it');
  assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), settings.config.claude);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `artifacts/mcp-settings-${theme}.png`, animations: 'disabled' });
    await dialog.evaluate(node => node.closest('dialog')?.querySelector('.mcp-heading')?.scrollIntoView());
    await page.screenshot({ path: `artifacts/mcp-gives-${theme}.png`, animations: 'disabled' });
  }
  await page.keyboard.press('Escape');

  // An agent connects through the configured command.
  bridge = startBridge(settings.config.launch);
  const init = await bridge.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'twig');
  assert.equal(init.result.serverInfo.version, await page.evaluate(() => window.twig.getAppInfo().then(info => info.version)));
  const tools = (await bridge.request('tools/list')).result.tools.map(tool => tool.name);
  assert.deepEqual(tools, ['get_workspace_context', 'list_changes', 'get_commit', 'search_history', 'get_blame', 'get_ui_context', 'propose_commit', 'new_version', 'await_commit']);

  // The workspace the window has open, with the demo's README edit and untracked note.
  const context = await bridge.tool('get_workspace_context');
  assert.equal(context.repository.path, demo.path);
  assert.equal(context.repository.openInTwig, true);
  assert.equal(context.branch.name, 'main');
  assert.equal(context.branch.behind, 0);
  assert.equal(context.workingTree.unstaged, 1);
  assert.equal(context.workingTree.untracked, 1);
  // This bridge runs in the source folder, which is not connected: the answer names the repository it read instead.
  const changes = await bridge.tool('list_changes', { diffs: true });
  assert.ok(changes.startsWith(`repository: ${demo.path}\nnote: Your working directory `), changes.slice(0, 300));
  assert.deepEqual(changes.split('\n').filter(line => line.startsWith('## ')).map(line => line.split(' ')[1] + ' ' + line.split(' ').at(-1)).sort(), ['? notes.todo', 'M README.md']);
  assert.ok(changes.includes('\n@@ '), 'the patches are in the same answer');
  const top = await bridge.tool('get_commit', { repository: demo.path, hash: 'HEAD' });
  assert.match(top, /^[0-9a-f]{40} Refine the workspace layout\n/);
  assert.match(top, /\n## M \+\d+ -\d+ \S+\n@@ /, 'the commit comes with its patch');
  const found = await bridge.tool('search_history', { repository: demo.path, query: 'Add keyboard navigation to commit details', mode: 'message' });

  // What is selected follows the window.
  const head = (await bridge.tool('get_workspace_context')).branch.head;
  const list = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await list.getByRole('option', { name: /Add keyboard navigation to commit details/ }).click();
  const keyboard = found.split('\n').find(line => line.endsWith(': Add keyboard navigation to commit details')).slice(0, 12);
  await page.waitForFunction(() => true);
  let ui = await bridge.tool('get_ui_context');
  for (let i = 0; i < 20 && !ui.selectedCommit?.startsWith(keyboard); i++) { await page.waitForTimeout(100); ui = await bridge.tool('get_ui_context'); }
  assert.ok(ui.selectedCommit?.startsWith(keyboard), 'the clicked commit is what the agent sees');
  assert.equal(ui.view, 'history');
  assert.equal(ui.repository.path, demo.path);
  assert.equal(ui.selectedBranch, null);
  assert.equal(ui.selectedHunk, null);
  assert.notEqual(keyboard, head.slice(0, 12));

  await page.getByRole('button', { name: /Uncommitted changes, 2 files/ }).click();
  const panel = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  await panel.getByRole('button', { name: /README\.md/ }).first().click();
  for (let i = 0; i < 20 && ui.view !== 'changes'; i++) { await page.waitForTimeout(100); ui = await bridge.tool('get_ui_context'); }
  for (let i = 0; i < 20 && !ui.selectedFile; i++) { await page.waitForTimeout(100); ui = await bridge.tool('get_ui_context'); }
  assert.equal(ui.view, 'changes');
  assert.equal(ui.selectedCommit, null);
  assert.deepEqual(ui.selectedFile, { path: 'README.md', commit: null, side: 'unstaged' });
  assert.deepEqual((await bridge.tool('get_workspace_context')).selection, { view: 'changes', commit: null, file: 'README.md' });

  // Malformed reports from the window are dropped, and the IPC refuses bad arguments.
  await page.evaluate(() => window.twig.reportUiContext({ repositoryId: 42, view: 'settings' }));
  assert.equal((await bridge.tool('get_ui_context')).view, 'changes', 'a malformed report does not replace the last good one');
  await assert.rejects(page.evaluate(() => window.twig.setMcpEnabled('yes')), /Invalid MCP request/);
  await assert.rejects(page.evaluate(() => window.twig.setMcpEnabled(null)), /Invalid MCP request/);

  // Agent reads are journaled, marked MCP, and kept out of "My".
  const journal = await page.evaluate(() => window.twig.getConsoleEntries());
  assert.ok(journal.some(entry => entry.operation === 'MCP: Read working tree'));
  await page.locator('.console-status').click();
  await page.getByRole('button', { name: 'Full History' }).click();
  await page.getByLabel('Search command log').fill('MCP:');
  await page.locator('.console-tag').first().waitFor();
  assert.match(await page.locator('.console-tag').first().getAttribute('title'), /^MCP: .*AI agent/);
  await page.getByRole('button', { name: 'My', exact: true }).click();
  await page.getByText('No commands match this search.').waitFor();
  assert.equal(await page.locator('.console-tag').count(), 0, 'agent reads are not the person’s own commands');
  await page.getByLabel('Search command log').fill('');
  await page.locator('.console-status').click();

  // Nothing an agent did changed the demo repository.
  const after = await page.evaluate(id => window.twig.readWorktree(id), demo.id);
  assert.deepEqual([...after.unstaged.map(file => file.path), ...after.untracked.map(file => file.path)].sort(), ['README.md', 'notes.todo']);
  assert.equal(after.staged.length, 0);

  // Writes are a second switch, off even while reading is on: a proposal is refused until the person allows it.
  const proposal = { repository: demo.path, message: 'docs: note the README edit\n\nProposed by the smoke test.' };
  assert.equal((await bridge.tool('propose_commit', proposal)).error.code, 'WRITE_DISABLED');
  await assert.rejects(page.evaluate(() => window.twig.setMcpCommitsAllowed('yes')), /Invalid MCP request/);
  await assert.rejects(page.evaluate(() => window.twig.decideCommitProposal('x', { action: 'explode', message: '' })), /Invalid MCP request/);
  await page.getByRole('button', { name: /^MCP: on/ }).click();
  await page.getByLabel('Allow agents to propose commits').selectOption('on');
  await page.getByText(/nothing is committed until you press Commit/).waitFor();
  await page.getByText('You confirm every commit.').waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await page.evaluate(() => window.twig.getMcpSettings())).allowCommits, true);

  // The proposal brings up a dialog; Cancel changes nothing and tells the agent so.
  const proposalDialog = page.getByRole('dialog', { name: 'Commit proposed by an agent' });
  let answer = bridge.request('tools/call', { name: 'propose_commit', arguments: proposal });
  await proposalDialog.waitFor();
  await proposalDialog.getByText('M +1 -0 README.md', { exact: true }).waitFor();
  await proposalDialog.getByText('A notes.todo', { exact: true }).waitFor();
  assert.equal(await proposalDialog.getByLabel(/^Message/).inputValue(), proposal.message);
  await proposalDialog.getByText('$ git add --all').waitFor();
  await proposalDialog.getByText(/Push goes to origin\/main\./).waitFor();
  assert.equal(await proposalDialog.getByLabel('Tag this commit').isChecked(), false, 'propose_commit starts without a tag');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `artifacts/mcp-proposal-${theme}.png`, animations: 'disabled' });
  }
  await proposalDialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal((await answer).result.content[0].text, 'cancelled by user\n');
  await proposalDialog.waitFor({ state: 'hidden' });
  const untouched = await page.evaluate(id => window.twig.readWorktree(id), demo.id);
  assert.deepEqual([untouched.staged.length, untouched.unstaged.length, untouched.untracked.length], [0, 1, 1], 'cancel left the files alone');

  // Commit with an edited message: the agent gets the hash and the subject that was used, and Undo takes it back.
  const headBefore = (await bridge.tool('get_workspace_context')).branch.head;
  answer = bridge.request('tools/call', { name: 'propose_commit', arguments: proposal });
  await proposalDialog.waitFor();
  await proposalDialog.getByLabel(/^Message/).fill('docs: README edit from an agent');
  await proposalDialog.getByRole('button', { name: 'Commit', exact: true }).click();
  const committed = (await answer).result.content[0].text;
  assert.match(committed, /^committed [0-9a-f]{12} on main: docs: README edit from an agent \(message edited in 🌱 Twig\)\n$/);
  await proposalDialog.waitFor({ state: 'hidden' });
  const clean = await page.evaluate(id => window.twig.readWorktree(id), demo.id);
  assert.deepEqual([clean.staged.length, clean.unstaged.length, clean.untracked.length], [0, 0, 0], 'all changes went into the commit');
  assert.equal((await page.evaluate(id => window.twig.getUndoState(id), demo.id)).undo, true);
  await page.evaluate(id => window.twig.moveUndo(id, 'undo'), demo.id);
  assert.equal((await bridge.tool('get_workspace_context')).branch.head, headBefore, 'Undo took the agent’s commit back');

  // new_version: the same dialog with the version and the tag on. The demo has no package.json,
  // so the version comes from its last tag (v0.0.2) and the tag follows the chosen step.
  const releaseDialog = page.getByRole('dialog', { name: 'New version proposed by an agent' });
  answer = bridge.request('tools/call', { name: 'new_version', arguments: { repository: demo.path, push: false } });
  await releaseDialog.waitFor();
  assert.equal(await releaseDialog.getByLabel('Tag this commit').isChecked(), true);
  assert.equal(await releaseDialog.getByLabel('Bump version').isChecked(), true);
  assert.equal(await releaseDialog.getByLabel('Tag name').inputValue(), 'v0.0.3');
  assert.equal(await releaseDialog.getByLabel(/^Message/).inputValue(), 'chore(release): 0.0.3', 'the message follows the version');
  await releaseDialog.getByLabel('Version step').selectOption('minor');
  assert.equal(await releaseDialog.getByLabel('Tag name').inputValue(), 'v0.1.0');
  await releaseDialog.getByText('previous: v0.0.2').waitFor();
  await releaseDialog.getByText('$ git tag -- v0.1.0 HEAD').waitFor();
  await releaseDialog.getByLabel('Tag name').fill('v0.0.2');
  await releaseDialog.getByText('v0.0.2 already exists').waitFor();
  assert.equal(await releaseDialog.getByRole('button', { name: 'Commit: v0.0.2 already exists' }).isDisabled(), true, 'an existing tag cannot be pressed through');
  await releaseDialog.getByRole('button', { name: 'Follow the version' }).click();
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await page.screenshot({ path: `artifacts/mcp-release-${theme}.png`, animations: 'disabled' });
  }
  await releaseDialog.getByRole('button', { name: 'Commit', exact: true }).click();
  const released = (await answer).result.content[0].text;
  assert.match(released, /^committed ([0-9a-f]{12}) on main: chore\(release\): 0\.1\.0\ntagged v0\.1\.0 at \1\n$/);
  await releaseDialog.waitFor({ state: 'hidden' });
  await page.evaluate(id => window.twig.moveUndo(id, 'undo'), demo.id);
  assert.equal((await page.evaluate(id => window.twig.getTagDetails(id), demo.id)).some(tag => tag.name === 'v0.1.0'), false, 'the first Undo deletes the tag');
  await page.evaluate(id => window.twig.moveUndo(id, 'undo'), demo.id);
  assert.equal((await bridge.tool('get_workspace_context')).branch.head, headBefore, 'the second takes the commit back');

  // The choice survives a restart, and the same bridge reattaches by itself.
  await app.close();
  const offline = await bridge.tool('get_workspace_context');
  assert.equal(offline.error.code, 'TWIG_UNAVAILABLE', 'while 🌱 Twig is closed the bridge says so');
  page = await launch();
  assert.equal((await page.evaluate(() => window.twig.getMcpSettings())).status.listening, true);
  assert.equal(JSON.parse(await readFile(path.join(profile, 'mcp', 'endpoint.json'), 'utf8')).version, init.result.serverInfo.version);
  let back = await bridge.tool('get_workspace_context');
  for (let i = 0; i < 30 && back.error; i++) { await page.waitForTimeout(100); back = await bridge.tool('get_workspace_context'); }
  assert.equal(back.repository.path, demo.path);

  // Off again from Settings: the socket goes away and tools say why.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Set up AI agents' }).click();
  await page.getByLabel('MCP server').selectOption('off');
  await page.getByText('Off — nothing listens, and agents get a message that 🌱 Twig is off.').waitFor();
  assert.equal((await bridge.tool('list_changes')).error.code, 'TWIG_UNAVAILABLE');
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
  console.log('mcp-smoke: settings, bridge on the app executable, workspace and UI context, journal, commit proposal (refused, cancelled, committed, undone), new_version (version from the tag, tag, undone), restart, off');
} finally {
  await bridge?.close().catch(() => {});
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
