import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { AutomationsStore } from '../../main/automations-store.js';
import { AutomationRunsStore } from '../../main/automation-runs-store.js';
import { createCommitProposals, readProposalState } from '../../main/mcp/commit-proposal.js';
import { createToolContext } from '../../main/mcp/context.js';
import { createMcpSession } from '../../main/mcp/session.js';
import { bindTools } from '../../main/mcp/tools/index.js';
import { TOOLS } from '../../main/mcp/protocol.mjs';
import { McpStore } from '../../main/mcp-store.js';
import { outcomeNote, primaryAction, proposalCommands, pushLine, totalsLine } from '../../renderer/src/features/proposal/proposal-view.js';

// propose_commit end to end on real Git: the proposal is shown, nothing happens
// until the "person" decides, and then the app's own commit path runs — with
// automations, Undo, a stale-tree check and push to a real (local) remote.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-mcp-commit-'));
try {
  // The catalog: two write tools, honestly annotated; everything else still reads.
  for (const name of ['propose_commit', 'await_commit']) {
    const tool = TOOLS.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.destructiveHint, false, name);
  }
  assert.ok(TOOLS.filter(tool => tool.annotations.readOnlyHint === false).every(tool => ['propose_commit', 'await_commit'].includes(tool.name)));

  // The permission is its own switch, off by default and kept apart from "enabled".
  {
    const store = new McpStore(path.join(root, 'store'));
    assert.deepEqual(await store.load(), { enabled: false, allowCommits: false });
    await store.save({ ...store.get(), enabled: true });
    assert.equal(store.get().allowCommits, false, 'turning the server on does not allow commits');
    await store.save({ ...store.get(), allowCommits: true });
    assert.deepEqual(new McpStore(path.join(root, 'store')).get(), { enabled: false, allowCommits: false }, 'a fresh store reads nothing until loaded');
    const reread = new McpStore(path.join(root, 'store'));
    assert.deepEqual(await reread.load(), { enabled: true, allowCommits: true });
  }

  // Pure words of the dialog.
  {
    const view = { files: [{ path: 'a', line: 'M +1 -0 a' }], totals: { insertions: 1, deletions: 0 }, push: true,
      commands: [['add', '--all'], ['commit', '--file=-', '--cleanup=strip']],
      pushTarget: { mode: 'push-upstream', label: 'origin/x (new upstream)', argv: ['push', '--set-upstream', 'origin', 'x'] } };
    assert.deepEqual(proposalCommands(view, true), ['git add --all', 'git commit --file=- --cleanup=strip', 'git push --set-upstream origin x']);
    assert.deepEqual(proposalCommands(view, false).length, 2);
    assert.equal(pushLine(view), 'Push goes to origin/x (new upstream).');
    assert.match(pushLine({ pushTarget: { mode: null, reason: 'x has no upstream.' } }), /not available: x has no upstream/);
    assert.equal(totalsLine(view), '1 file, +1 −0');
    assert.equal(primaryAction(view), 'commit-push');
    assert.equal(primaryAction({ ...view, pushTarget: { mode: null } }), 'commit', 'nowhere to push: Commit is the default');
    assert.equal(outcomeNote('committed abc on main: x\npushed to origin/main'), 'committed abc on main: x');
  }

  const log = new CommandLog(root); await log.load();
  const cwd = path.join(root, 'repo');
  const bare = path.join(root, 'remote.git');
  await mkdir(cwd);
  const git = async (...argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  const write = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Ada Lovelace');
  await git('config', 'user.email', 'ada@example.com');
  await git('config', 'commit.gpgSign', 'false');
  await write('README.md', '# Repo\n');
  await write('src/app.js', 'export const one = 1;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Initial');
  await runGit({ cwd: root, log, argv: ['init', '-q', '--bare', bare] });
  await git('remote', 'add', 'origin', bare);
  await git('push', '-q', '-u', 'origin', 'main');

  const undo = new UndoService({ directory: path.join(root, 'undo'), log }); await undo.load();
  const automations = new AutomationsStore(path.join(root, 'auto')); const runs = new AutomationRunsStore(path.join(root, 'auto'));
  await Promise.all([automations.load(), runs.load()]);
  let allowed = false;
  let windowOpen = true;
  const shown = [];
  const proposals = createCommitProposals({ log, undo, automations, runs, isAllowed: () => allowed, present: view => { if (!windowOpen) return false; shown.push(view); return true; } });
  const repos = [{ id: cwd, name: 'repo', path: cwd, available: true }];
  const ctx = createToolContext({ repositories: { snapshot: () => ({ repositories: repos }) }, journal: log, getActiveId: () => cwd, getUiContext: () => null, proposals, waitMs: 30 });
  const session = createMcpSession({ version: '9.9.9', tools: bindTools(ctx) });
  let id = 1;
  async function call(name, args = {}) {
    const response = await session.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: name === 'await_commit' ? args : { repository: cwd, ...args } } });
    const raw = response.result.content[0].text;
    return response.result.isError ? { error: JSON.parse(raw).error } : raw;
  }
  const proposalId = text => /proposalId "([0-9a-f-]{36})"/.exec(text)?.[1];
  const head = () => git('rev-parse', 'HEAD');
  const message = 'feat(app): add two\n\nTwo is the number after one.';

  // Off: no proposal reaches the window.
  await write('src/app.js', 'export const one = 1;\nexport const two = 2;\n');
  await write('notes/new.txt', 'new\n');
  await git('rm', '-q', 'README.md');
  assert.equal((await call('propose_commit', { message })).error.code, 'WRITE_DISABLED');
  assert.equal(shown.length, 0);
  assert.equal((await session.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'propose_commit', arguments: { message: '' } } })).result.isError, true);

  allowed = true;
  // Cancel changes nothing.
  {
    const before = await readProposalState({ cwd, log });
    const waiting = await call('propose_commit', { message, push: true });
    assert.match(waiting, /^waiting: the person has not answered/);
    const view = shown.at(-1);
    assert.equal(view.branch, 'main');
    assert.equal(view.message, message);
    assert.deepEqual(view.files.map(file => file.line), ['D +0 -1 README.md', 'A notes/new.txt', 'M +1 -0 src/app.js']);
    assert.equal(view.pushTarget.label, 'origin/main');
    assert.equal(proposals.current().id, view.id);
    await proposals.decide(view.id, { action: 'cancel', message });
    assert.equal(await call('await_commit', { proposalId: proposalId(waiting) }), 'cancelled by user\n');
    assert.equal(shown.at(-1), null, 'the dialog is closed');
    assert.equal((await readProposalState({ cwd, log })).fingerprint, before.fingerprint, 'cancel left the tree exactly as it was');
    assert.equal((await call('await_commit', { proposalId: 'nope' })).error.code, 'PROPOSAL_NOT_FOUND');
  }

  // A tree that changed after the proposal is shown again, never committed as it was.
  {
    const start = await head();
    const waiting = await call('propose_commit', { message });
    const view = shown.at(-1);
    await write('src/app.js', 'export const one = 1;\nexport const two = 2;\nexport const three = 3;\n');
    const stale = await proposals.decide(view.id, { action: 'commit', message });
    assert.ok(stale.stale, 'the person is asked again');
    assert.equal(stale.stale.files.find(file => file.path === 'src/app.js').line, 'M +2 -0 src/app.js');
    assert.equal(await head(), start, 'nothing was committed');
    const edited = 'feat(app): add two and three\n\nTwo and three follow one.';
    const done = await proposals.decide(view.id, { action: 'commit', message: edited });
    assert.equal(done.ok, true, done.outcome);
    const answer = await call('await_commit', { proposalId: proposalId(waiting) });
    const oid = await head();
    assert.equal(answer, `committed ${oid.slice(0, 12)} on main: feat(app): add two and three (message edited in 🌱 Twig)\n`);
    assert.equal(await git('log', '-1', '--format=%B'), edited, 'the edited message is what was committed');
    assert.equal(await git('status', '--porcelain'), '', 'everything was taken: modified, new and deleted');
    assert.equal(await git('log', '-1', '--format=%(trailers)'), '', 'no trailer was added');
    // Undo takes the agent's commit back like any other.
    assert.deepEqual(await undo.move(cwd, 'undo', async () => true), { ok: true, cancelled: false });
    assert.equal(await head(), start);
    assert.match(await git('status', '--porcelain'), /src\/app\.js/, 'its changes are back, staged');
    await git('reset', '-q');
  }

  // A blocking pre-commit automation: no commit, the agent learns why, the index is as it was.
  {
    // Kept inside .git so the script is not one of the changes being committed.
    await writeFile(path.join(cwd, '.git', 'lint-fail.cjs'), "console.error('lint: 2 problems'); process.exit(1);\n");
    await automations.saveConfig(cwd, { pipelines: [{ event: 'pre-commit', name: 'Checks', onFailure: 'block',
      actions: [{ type: 'command', name: 'lint', command: 'node .git/lint-fail.cjs' }] }] });
    await git('add', 'src/app.js');
    const indexBefore = await git('diff', '--cached', '--name-only');
    const start = await head();
    await call('propose_commit', { message });
    const done = await proposals.decide(shown.at(-1).id, { action: 'commit', message });
    assert.equal(done.ok, false);
    assert.match(done.outcome, /^not committed: a pre-commit automation blocked it\nChecks → lint: .*\nlint: 2 problems$/s);
    assert.equal(await head(), start);
    assert.equal(await git('diff', '--cached', '--name-only'), indexBefore, 'the index is back to what the person had staged');
    await automations.saveConfig(cwd, { pipelines: [] });
  }

  // A failing Git hook: the same, with what the hook printed.
  {
    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    await chmod(hook, 0o755);
    const start = await head();
    await call('propose_commit', { message });
    const done = await proposals.decide(shown.at(-1).id, { action: 'commit', message });
    assert.match(done.outcome, /^not committed: Commit failed\. See the command console\.\nhook says no$/);
    assert.equal(await head(), start);
    await rm(hook);
  }

  // Commit & Push: committed and pushed with the app's own push; a new branch gets origin as upstream.
  {
    await call('propose_commit', { message, push: true });
    const done = await proposals.decide(shown.at(-1).id, { action: 'commit-push', message });
    const oid = await head();
    assert.equal(done.outcome, `committed ${oid.slice(0, 12)} on main: feat(app): add two\npushed to origin/main`);
    assert.equal((await runGit({ cwd: bare, log, argv: ['rev-parse', 'main'] })).stdout.trim(), oid);

    await git('switch', '-q', '-c', 'topic');
    await write('topic.txt', 'topic\n');
    await call('propose_commit', { message: 'feat: topic', push: true });
    const view = shown.at(-1);
    assert.equal(view.pushTarget.mode, 'push-upstream');
    const pushed = await proposals.decide(view.id, { action: 'commit-push', message: 'feat: topic' });
    assert.match(pushed.outcome, /\npushed to origin\/topic$/);
    assert.equal(await git('rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
  }

  // Refusals before anything is shown.
  {
    const count = shown.length;
    assert.equal((await call('propose_commit', { message })).error.code, 'NOTHING_TO_COMMIT');
    await write('x.txt', 'x\n');
    await git('switch', '-q', '--detach');
    assert.equal((await call('propose_commit', { message })).error.code, 'REPOSITORY_BUSY');
    await git('switch', '-q', 'topic');
    windowOpen = false;
    assert.equal((await call('propose_commit', { message })).error.code, 'CONFIRMATION_UNAVAILABLE');
    windowOpen = true;
    assert.equal(shown.length, count, 'no refused proposal reached the window');
  }

  // A newer proposal replaces the one on screen; turning the permission off answers what is open.
  {
    const first = proposalId(await call('propose_commit', { message: 'feat: one' }));
    const second = proposalId(await call('propose_commit', { message: 'feat: two' }));
    assert.equal(await call('await_commit', { proposalId: first }), 'superseded: a newer proposal replaced it\n');
    proposals.revokeAll();
    assert.match(await call('await_commit', { proposalId: second }), /^not committed: commits from agents were turned off/);
    assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), 'x\n', 'and nothing was committed');
  }
  assert.ok(log.list().some(entry => entry.operation === 'Stage all changes'), 'the commands are in the journal');
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('mcp-commit: permission, dialog words, cancel, stale tree, automation and hook refusals, Undo, commit and push');
