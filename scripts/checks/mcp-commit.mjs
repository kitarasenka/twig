import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
import { actionLabels, outcomeNote, primaryAction, proposalCommands, pushLine, releaseState, replacedLines, staleLine, stepLabel, totalsLine } from '../../renderer/src/features/proposal/proposal-view.js';
import { parseVersionTag, pickPreviousTag, releaseTagName, releaseVersion, tagNameProblem, tagPushArgv } from '../../renderer/src/features/automations/release-tag.js';
import { buildPushRefArgv } from '../../main/git/sync.js';
import { createBumper } from '../../main/automation/bump.js';

// propose_commit end to end on real Git: the proposal is shown, nothing happens
// until the "person" decides, and then the app's own commit path runs — with
// automations, Undo, a stale-tree check and push to a real (local) remote.

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-mcp-commit-'));
try {
  // The catalog: three write tools, honestly annotated; everything else still reads.
  const WRITES = ['propose_commit', 'new_version', 'await_commit'];
  for (const name of WRITES) {
    const tool = TOOLS.find(item => item.name === name);
    assert.equal(tool.annotations.readOnlyHint, false, name);
    assert.equal(tool.annotations.destructiveHint, false, name);
  }
  assert.ok(TOOLS.filter(tool => tool.annotations.readOnlyHint === false).every(tool => WRITES.includes(tool.name)));
  assert.deepEqual(TOOLS.find(tool => tool.name === 'new_version').inputSchema.required, [], 'new_version needs no argument');

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

    // With a tag: the tag after the commit, its push after the branch's, spelled as sync.js pushes a ref.
    const tagged = { ...view, pushTarget: { ...view.pushTarget, remote: 'origin' } };
    assert.deepEqual(proposalCommands(tagged, true, { tag: 'v1.2.4' }), ['git add --all', 'git commit --file=- --cleanup=strip', 'git tag -- v1.2.4 HEAD',
      'git push --set-upstream origin x', 'git push --progress origin -- refs/tags/v1.2.4:refs/tags/v1.2.4']);
    assert.deepEqual(proposalCommands(tagged, false, { commit: false, tag: 'v1.2.4' }), ['git tag -- v1.2.4 HEAD'], 'a release with nothing to commit only tags');
    assert.deepEqual(tagPushArgv('my/remote', 'v1'), buildPushRefArgv({ remote: 'my/remote', ref: 'refs/tags/v1' }));
    assert.deepEqual(actionLabels(false), { commit: 'Create tag', push: 'Tag & Push' });
  }

  // Release tags: the previous tag's pattern carries over, a pre-release suffix does not.
  {
    assert.deepEqual(parseVersionTag('twig-v0.16.2'), { name: 'twig-v0.16.2', prefix: 'twig-v', version: '0.16.2', suffix: '' });
    assert.equal(parseVersionTag('v2.0.0-rc.1').suffix, '');
    assert.equal(parseVersionTag('release-1.2.3_final').suffix, '_final');
    assert.equal(parseVersionTag('nightly'), null);
    assert.equal(pickPreviousTag(['nightly', 'app-v3.1.0', 'v1.0.0']).name, 'app-v3.1.0', 'the newest tag with a version');
    assert.equal(pickPreviousTag(['nightly']), null);
    const previous = parseVersionTag('twig-v0.16.2');
    assert.equal(releaseTagName(previous, '0.16.3'), 'twig-v0.16.3');
    assert.equal(releaseTagName(null, '1.0.1'), 'v1.0.1', 'no earlier tag: v<version>');
    assert.equal(releaseVersion({ current: '0.16.2', tag: previous }, 'minor'), '0.17.0');
    assert.equal(releaseVersion({ current: '0.16.3', tag: previous }, 'none'), '0.16.3', 'a version the files already say is tagged as is');
    assert.equal(releaseVersion({ current: null, tag: previous }, 'patch'), '0.16.3', 'no package.json: the tag carries the version');
    assert.equal(releaseVersion({ current: null, tag: null }, 'patch'), null);
    assert.equal(tagNameProblem('v1 2'), 'Not a valid tag name: no spaces, ~ ^ : ? * [ \\ or ..');
    assert.equal(tagNameProblem('-v1'), 'Not a valid tag name: no spaces, ~ ^ : ? * [ \\ or ..');
    assert.equal(tagNameProblem('twig-v0.16.2', 'twig-v0.16.2'), 'twig-v0.16.2 already exists');
    assert.equal(tagNameProblem('twig-v0.16.3', 'twig-v0.16.2'), null);
    assert.equal(tagNameProblem(''), 'Write a tag name');

    // What the switches add up to.
    const bumpPlan = { source: 'package', choice: 'none', targets: [{ path: 'package.json', current: '1.4.0', next: { patch: '1.4.1', minor: '1.5.0', major: '2.0.0' }, lock: null }] };
    const clean = { files: [], message: null, bump: bumpPlan, versioning: { current: '1.4.0', tag: parseVersionTag('v1.4.0') } };
    assert.deepEqual(releaseState(clean, { choice: 'patch', tagOn: true }),
      { version: '1.4.1', tag: 'v1.4.1', commit: true, message: 'chore(release): 1.4.1', tagProblem: null });
    assert.deepEqual(releaseState(clean, { choice: 'none', tagOn: true }),
      { version: '1.4.0', tag: 'v1.4.0', commit: false, message: 'chore(release): 1.4.0', tagProblem: 'v1.4.0 already exists' }, 'no bump on a clean tree: only a tag, and that one exists');
    assert.equal(releaseState(clean, { choice: 'major', tagOn: true, tagName: 'release/2' }).tag, 'release/2', 'a typed name wins');
    assert.equal(releaseState({ ...clean, files: [{}], message: 'feat: x' }, { choice: 'none', tagOn: false }).tag, null);
    assert.equal(stepLabel(clean, 'minor'), 'Minor — package.json 1.4.0 → 1.5.0');
    assert.equal(stepLabel({ bump: null, versioning: { current: null, tag: parseVersionTag('v0.9.9') } }, 'patch'), 'Patch — 0.9.9 → 0.9.10');
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
  const proposals = createCommitProposals({ log, undo, automations, runs, minIntervalMs: 0, isAllowed: () => allowed, present: view => { if (!windowOpen) return false; shown.push(view); return true; } });
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
    assert.deepEqual(view.files.map(file => file.line), ['D +0 -1 README.md', 'A +1 -0 notes/new.txt', 'M +1 -0 src/app.js']);
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
    assert.equal((await runGit({ cwd: bare, log, argv: [`--git-dir=${bare}`, 'rev-parse', 'main'] })).stdout.trim(), oid);

    await git('switch', '-q', '-c', 'topic');
    await write('topic.txt', 'topic\n');
    await call('propose_commit', { message: 'feat: topic', push: true });
    const view = shown.at(-1);
    assert.equal(view.pushTarget.mode, 'push-upstream');
    const pushed = await proposals.decide(view.id, { action: 'commit-push', message: 'feat: topic' });
    assert.match(pushed.outcome, /\npushed to origin\/topic$/);
    assert.equal(await git('rev-parse', '--abbrev-ref', 'topic@{upstream}'), 'origin/topic');
  }

  // A tag on a commit, without push: its own Undo, taken back before the commit.
  {
    await write('tagged.txt', 'tagged\n');
    const start = await head();
    await call('propose_commit', { message: 'feat: tagged' });
    const view = shown.at(-1);
    assert.equal(view.defaults.tag, false, 'propose_commit starts with no tag');
    assert.equal(view.versioning.tag, null, 'no version tag yet');
    const done = await proposals.decide(view.id, { action: 'commit', message: 'feat: tagged', tag: 'v0.1.0' });
    const oid = await head();
    assert.equal(done.outcome, `committed ${oid.slice(0, 12)} on topic: feat: tagged\ntagged v0.1.0 at ${oid.slice(0, 12)}`);
    assert.equal(await git('rev-parse', 'v0.1.0^{commit}'), oid);
    assert.deepEqual(await undo.move(cwd, 'undo', async () => true), { ok: true, cancelled: false });
    assert.equal((await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', 'refs/tags/v0.1.0'] })).code, 1, 'Undo deleted the tag');
    assert.equal(await head(), oid, 'and left the commit');
    assert.deepEqual(await undo.move(cwd, 'redo', async () => true), { ok: true, cancelled: false });
    assert.equal(await git('rev-parse', 'v0.1.0'), oid, 'Redo made it again');
    await undo.move(cwd, 'undo', async () => true);
    await undo.move(cwd, 'undo', async () => true);
    assert.equal(await head(), start, 'the next Undo took the commit back');
    await git('reset', '-q');
    await rm(path.join(cwd, 'tagged.txt'));
  }

  // new_version: package.json bumped, the commit tagged after the previous tag, both pushed.
  {
    const bumper = createBumper({ log, automations });
    const releases = createCommitProposals({ log, undo, automations, runs, bump: bumper, minIntervalMs: 0, isAllowed: () => true, present: view => { shown.push(view); return true; } });
    const releaseCtx = createToolContext({ repositories: { snapshot: () => ({ repositories: repos }) }, journal: log, getActiveId: () => cwd, getUiContext: () => null, proposals: releases, waitMs: 30 });
    const releaseSession = createMcpSession({ version: '9.9.9', tools: bindTools(releaseCtx) });
    const release = async args => {
      const response = await releaseSession.handle({ jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name: 'new_version', arguments: { repository: cwd, ...args } } });
      const raw = response.result.content[0].text;
      return response.result.isError ? { error: JSON.parse(raw).error } : raw;
    };
    await write('package.json', '{\n  "name": "repo",\n  "version": "1.4.0"\n}\n');
    await git('add', 'package.json');
    await git('commit', '-q', '-m', 'chore: package');
    await git('tag', 'app-v1.4.0');
    assert.equal((await release({ bump: 'huge' })).error.code, 'INVALID_ARGUMENT', 'bump is one of patch, minor, major');
    assert.equal((await release({ tag: 'bad tag' })).error.code, 'INVALID_ARGUMENT');

    // A clean tree is fine for a release: the commit is the bump alone.
    assert.match(await release({ bump: 'minor' }), /^waiting:/);
    const view = shown.at(-1);
    assert.equal(view.kind, 'release');
    assert.deepEqual(view.files, []);
    assert.equal(view.message, null, 'the dialog words the message');
    assert.deepEqual(view.defaults, { bump: 'minor', tag: true, tagName: null });
    assert.deepEqual(view.versioning, { current: '1.4.0', tag: { name: 'app-v1.4.0', prefix: 'app-v', version: '1.4.0', suffix: '' } });
    assert.equal(view.pushTarget.remote, 'origin');
    const state = releaseState(view, { choice: 'minor', tagOn: true });
    assert.equal(state.tag, 'app-v1.5.0');
    assert.deepEqual(await releases.decide(view.id, { action: 'commit-push', message: state.message, bump: 'minor', tag: 'app-v1.4.0' }),
      { invalid: 'The tag app-v1.4.0 already exists. Choose another name.' }, 'an existing tag keeps the dialog open');
    const done = await releases.decide(view.id, { action: 'commit-push', message: state.message, bump: 'minor', tag: state.tag });
    const oid = await head();
    assert.equal(done.outcome, [`committed ${oid.slice(0, 12)} on topic: chore(release): 1.5.0`, 'version package.json: 1.4.0 → 1.5.0',
      `tagged app-v1.5.0 at ${oid.slice(0, 12)}`, 'pushed to origin/topic', 'pushed tag app-v1.5.0 to origin'].join('\n'));
    assert.match(await readFile(path.join(cwd, 'package.json'), 'utf8'), /"version": "1\.5\.0"/);
    assert.equal(await git('status', '--porcelain'), '');
    assert.equal((await runGit({ cwd: bare, log, argv: [`--git-dir=${bare}`, 'rev-parse', 'app-v1.5.0'] })).stdout.trim(), oid, 'the tag reached the remote');
    assert.equal((await runGit({ cwd: bare, log, argv: [`--git-dir=${bare}`, 'rev-parse', 'topic'] })).stdout.trim(), oid, 'and the commit');

    // No bump on a clean tree: only HEAD is tagged — no commit, no message needed.
    await release({});
    const tagOnly = shown.at(-1);
    assert.equal(releaseState(tagOnly, { choice: 'patch', tagOn: true }).tag, 'app-v1.5.1');
    const tagDone = await releases.decide(tagOnly.id, { action: 'commit', message: '', bump: 'none', tag: 'app-v1.5.0-docs' });
    assert.equal(tagDone.outcome, `tagged app-v1.5.0-docs at ${oid.slice(0, 12)} on topic`);
    assert.equal(await head(), oid, 'nothing was committed');
    await release({});
    assert.deepEqual(await releases.decide(shown.at(-1).id, { action: 'commit', message: '', bump: 'none', tag: null }),
      { invalid: 'There is nothing to commit. Choose a version to bump or a tag to create.' });
    await releases.decide(shown.at(-1).id, { action: 'cancel', message: '' });
    await git('tag', '-d', 'app-v1.5.0-docs');
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

  // A newer proposal from the same worktree replaces the one on screen; turning the permission off answers what is open.
  {
    const first = proposalId(await call('propose_commit', { message: 'feat: one' }));
    const second = proposalId(await call('propose_commit', { message: 'feat: two' }));
    assert.equal(await call('await_commit', { proposalId: first }), 'superseded: a newer proposal replaced it\n');
    proposals.revokeAll();
    assert.match(await call('await_commit', { proposalId: second }), /^not committed: commits from agents were turned off/);
    assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), 'x\n', 'and nothing was committed');
    assert.equal(shown.at(-1), null, 'and the dialog closed');
  }

  // Agents in two worktrees: the second proposal waits in line instead of replacing the first.
  {
    const other = path.join(root, 'other-worktree');
    await git('worktree', 'add', '-q', '-b', 'other', other);
    await writeFile(path.join(other, 'other.txt'), 'other\n');
    const here = await proposals.propose({ repo: { id: cwd, name: 'repo', path: cwd }, message: 'feat: here', push: false });
    const there = await proposals.propose({ repo: { id: other, name: 'other (worktree of repo)', path: other }, message: 'feat: there', push: false });
    assert.equal(shown.at(-1).id, here, 'the first stays on screen');
    assert.equal(shown.at(-1).waiting, 1, 'showing one more waiting');
    assert.equal(proposals.current().id, here);
    assert.deepEqual([...proposals.pendingPaths()].sort(), [cwd, other].sort(), 'the board can tell both worktrees have one');
    const done = await proposals.decide(here, { action: 'cancel', message: 'feat: here' });
    assert.equal(done.outcome, 'cancelled by user');
    assert.equal(shown.at(-1).id, there, 'answering it opens the next one');
    assert.equal(shown.at(-1).waiting, 0);
    const committed = await proposals.decide(there, { action: 'commit', message: 'feat: there' });
    assert.match(committed.outcome, /^committed [0-9a-f]{12} on other: feat: there$/, committed.outcome);
    assert.equal((await runGit({ cwd: other, log, argv: ['log', '-1', '--format=%s'] })).stdout.trim(), 'feat: there', 'committed in its own worktree');
    assert.equal(shown.at(-1), null, 'nothing else is waiting');
    assert.equal(await readFile(path.join(cwd, 'x.txt'), 'utf8'), 'x\n', 'the first worktree is untouched');
  }
  assert.ok(log.list().some(entry => entry.operation === 'Stage all changes'), 'the commands are in the journal');

  // --- what is shown is what is committed and where it goes -------------------------------------
  const sh = (folder, ...argv) => execFileSync('git', argv, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let stands = 0;
  async function stand({ clock = null } = {}) {
    const base = path.join(root, `stand-${++stands}`);
    const folder = path.join(base, 'repo');
    const remote = path.join(base, 'remote.git');
    await mkdir(folder, { recursive: true });
    sh(base, 'init', '-q', '--bare', remote);
    sh(folder, 'init', '-q', '-b', 'main');
    sh(folder, 'config', 'user.name', 'Ada'); sh(folder, 'config', 'user.email', 'a@example.com'); sh(folder, 'config', 'commit.gpgSign', 'false');
    await writeFile(path.join(folder, 'README.md'), '# r\n');
    await writeFile(path.join(folder, 'app.js'), 'export const a = 1;\n');
    sh(folder, 'add', '-A'); sh(folder, 'commit', '-qm', 'init');
    sh(folder, 'remote', 'add', 'origin', remote); sh(folder, 'push', '-q', '-u', 'origin', 'main');
    const own = new AutomationsStore(path.join(base, 'auto')); const ownRuns = new AutomationRunsStore(path.join(base, 'auto'));
    await Promise.all([own.load(), ownRuns.load()]);
    const ownUndo = new UndoService({ directory: path.join(base, 'undo'), log }); await ownUndo.load();
    const views = [];
    const focused = [];
    const service = createCommitProposals({ log, undo: ownUndo, automations: own, runs: ownRuns, isAllowed: () => true, minIntervalMs: clock ? 5000 : 0, now: clock ?? Date.now,
      present: (view, options = {}) => { views.push(view); focused.push(Boolean(options.focus)); return true; } });
    const repo = { id: folder, name: 'repo', path: folder };
    const propose = async (text, push = false) => {
      const proposalId = await service.propose({ repo, message: text, push });
      return views.at(-1).id === proposalId ? views.at(-1) : service.current();
    };
    return { base, folder, remote, automations: own, service, views, focused, propose, repo, write: (file, text) => writeFile(path.join(folder, file), text) };
  }
  const refsOf = folder => sh(folder, 'for-each-ref', '--format=%(refname)').split('\n');

  // remote.origin.mirror set after the dialog was shown: asked again, and then one branch goes, not a mirror.
  {
    const s = await stand();
    sh(s.folder, 'branch', 'colleague'); sh(s.folder, 'push', '-q', 'origin', 'colleague'); sh(s.folder, 'branch', '-qD', 'colleague');
    sh(s.folder, 'tag', 'v1'); sh(s.folder, 'push', '-q', 'origin', 'v1'); sh(s.folder, 'tag', '-d', 'v1');
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    assert.deepEqual(view.pushTarget.urls, [s.remote], 'the dialog names the address');
    assert.deepEqual(view.pushTarget.argv, ['push', 'origin', 'refs/heads/main:refs/heads/main']);
    sh(s.folder, 'config', 'remote.origin.mirror', 'true');
    const stale = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.equal(stale.stale.staleWhy, 'push', 'the configuration moved, so the person is asked again');
    assert.deepEqual(stale.stale.pushTarget.argv, ['-c', 'remote.origin.mirror=false', 'push', 'origin', 'refs/heads/main:refs/heads/main']);
    assert.match(stale.stale.pushTarget.notes.join(), /mirror/, 'and told');
    assert.equal(sh(s.folder, 'log', '-1', '--format=%s'), 'init', 'nothing happened yet');
    const done = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.equal(done.ok, true, done.outcome);
    assert.deepEqual(refsOf(s.remote), ['refs/heads/colleague', 'refs/heads/main', 'refs/tags/v1'], 'what only the remote had is still there');
    assert.equal(sh(s.folder, 'status', '-sb'), '## main...origin/main', 'the remote-tracking ref followed: no "1 to push" badge');
  }

  // remote.origin.pushurl moved to another repository: the address is shown before anything reaches it.
  {
    const s = await stand();
    const evil = path.join(s.base, 'evil.git');
    sh(s.base, 'init', '-q', '--bare', evil);
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    sh(s.folder, 'config', 'remote.origin.pushurl', evil);
    const stale = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.deepEqual(stale.stale.pushTarget.urls, [evil], 'the new address is on screen');
    assert.equal(sh(evil, 'for-each-ref'), '', 'and nothing went there');
    await s.service.decide(view.id, { action: 'cancel', message: view.message });
  }

  // A + in remote.origin.push does not force: a colleague's commit stays, the push is refused.
  {
    const s = await stand();
    const other = path.join(s.base, 'other');
    sh(s.base, 'clone', '-q', '-b', 'main', s.remote, other);
    sh(other, 'config', 'user.name', 'B'); sh(other, 'config', 'user.email', 'b@example.com');
    await writeFile(path.join(other, 'theirs.txt'), 'x\n'); sh(other, 'add', '-A'); sh(other, 'commit', '-qm', 'colleague'); sh(other, 'push', '-q');
    sh(s.folder, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/main');
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    assert.match(view.pushTarget.notes.join(), /force/, 'the dialog says the force is not used');
    const done = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.equal(done.ok, false);
    assert.match(done.outcome, /push failed/);
    assert.equal(sh(s.remote, 'log', '-1', '--format=%s', 'main'), 'colleague', 'the colleague\'s commit is still on the remote');
  }

  // Changed while a pre-push automation runs, past the check at the click: committed, not pushed.
  {
    const s = await stand();
    const evil = path.join(s.base, 'evil.git');
    sh(s.base, 'init', '-q', '--bare', evil);
    await writeFile(path.join(s.folder, '.git', 'move.cjs'), `require('node:child_process').execFileSync('git', ['config', 'remote.origin.pushurl', ${JSON.stringify(evil)}]);\n`);
    await s.automations.saveConfig(s.folder, { pipelines: [{ event: 'pre-push', name: 'Late', onFailure: 'block', actions: [{ type: 'command', name: 'move', command: 'node .git/move.cjs' }] }] });
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    const done = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.equal(done.ok, false);
    assert.match(done.outcome, /^committed .*\nnot pushed: where it would go changed/);
    assert.equal(sh(evil, 'for-each-ref'), '', 'nothing reached the new address');
  }

  // Bytes of the same length with the time put back to the nanosecond: the tree sees them.
  {
    const s = await stand();
    const file = path.join(s.folder, 'app.js');
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: bump');
    const before = await stat(file, { bigint: true });
    await s.write('app.js', 'export const a = 9;\n');
    execFileSync('python3', ['-I', '-c', 'import os,sys; os.utime(sys.argv[1], ns=(int(sys.argv[2]), int(sys.argv[3])))', file, String(before.atimeNs), String(before.mtimeNs)]);
    assert.equal((await stat(file, { bigint: true })).mtimeNs, before.mtimeNs);
    const stale = await s.service.decide(view.id, { action: 'commit', message: view.message });
    assert.ok(stale.stale, 'a swapped file is seen');
    assert.equal(sh(s.folder, 'log', '-1', '--format=%s'), 'init');
  }

  // Staged by someone else during a slow automation: not committed, the person sees it first.
  {
    const s = await stand();
    await writeFile(path.join(s.folder, '.git', 'sleep.cjs'), 'setTimeout(() => {}, 1200);\n');
    await s.automations.saveConfig(s.folder, { pipelines: [{ event: 'pre-commit', name: 'Tests', onFailure: 'block', actions: [{ type: 'command', name: 'tests', command: 'node .git/sleep.cjs' }] }] });
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small');
    const pending = s.service.decide(view.id, { action: 'commit', message: view.message });
    await new Promise(resolve => setTimeout(resolve, 700));
    await s.write('late.js', 'late\n');
    sh(s.folder, 'add', 'late.js');
    const answer = await pending;
    assert.equal(answer.stale?.staleWhy, 'checks', 'asked again');
    assert.deepEqual(answer.stale.files.map(file => file.line), ['M +1 -1 app.js', 'A +1 -0 late.js'], 'with the file that arrived');
    assert.equal(sh(s.folder, 'log', '-1', '--format=%s'), 'init');
    await s.automations.saveConfig(s.folder, { pipelines: [] });
    const done = await s.service.decide(view.id, { action: 'commit', message: view.message });
    assert.equal(done.ok, true, done.outcome);
    assert.equal(sh(s.folder, 'show', '--name-only', '--format=', 'HEAD'), 'app.js\nlate.js');
  }

  // An automation that formats and stages: the same question, and the second click commits.
  {
    const s = await stand();
    await writeFile(path.join(s.folder, '.git', 'format.cjs'), `const fs = require('node:fs'); fs.writeFileSync('app.js', fs.readFileSync('app.js', 'utf8').replace('a=2', 'a = 2')); require('node:child_process').execFileSync('git', ['add', 'app.js']);\n`);
    await s.automations.saveConfig(s.folder, { pipelines: [{ event: 'pre-commit', name: 'Format', onFailure: 'block', actions: [{ type: 'command', name: 'format', command: 'node .git/format.cjs' }] }] });
    await s.write('app.js', 'export const a=2;\n');
    const view = await s.propose('style: format');
    const answer = await s.service.decide(view.id, { action: 'commit', message: view.message });
    assert.equal(answer.stale?.staleWhy, 'checks');
    const done = await s.service.decide(view.id, { action: 'commit', message: view.message });
    assert.equal(done.ok, true, done.outcome);
    assert.equal(sh(s.folder, 'show', 'HEAD:app.js'), 'export const a = 2;');
  }

  // A Git hook runs inside the commit: it cannot be stopped there, so it is told, and nothing is pushed.
  {
    const s = await stand();
    const hook = path.join(s.folder, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nprintf evil > backdoor.js\ngit add backdoor.js\n'); await chmod(hook, 0o755);
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    const done = await s.service.decide(view.id, { action: 'commit-push', message: view.message, tag: 'v9' });
    assert.equal(done.ok, false);
    assert.match(done.outcome, /A Git hook changed what this commit takes, so it is not what you confirmed: backdoor\.js/);
    assert.notEqual(sh(s.remote, 'rev-parse', 'main'), sh(s.folder, 'rev-parse', 'HEAD'), 'not pushed');
    assert.equal(sh(s.folder, 'tag'), '', 'not tagged');
  }
  {
    const s = await stand();
    const hook = path.join(s.folder, '.git', 'hooks', 'commit-msg');
    await writeFile(hook, '#!/bin/sh\nprintf "\\nChange-Id: I1\\n" >> "$1"\n'); await chmod(hook, 0o755);
    await s.write('app.js', 'export const a = 2;\n');
    const view = await s.propose('fix: small', true);
    const done = await s.service.decide(view.id, { action: 'commit-push', message: view.message });
    assert.equal(done.ok, true, 'a trailer from a hook is said, and the push goes');
    assert.match(done.outcome, /\(message changed by a Git hook\)\npushed to origin\/main$/);
  }

  // New files have sizes; a skip-worktree entry is in the list; the file view reads the shown tree.
  {
    const s = await stand();
    await s.write('app.js', 'export const a = 2;\n');
    await s.write('new.txt', 'one\ntwo\nthree\n');
    await s.write('logo.bin', Buffer.from([0, 1, 2, 3, 0]));
    await s.write('big.txt', 'x\n'.repeat(600));
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: s.folder, input: 'hidden\n', encoding: 'utf8' }).trim();
    sh(s.folder, 'update-index', '--cacheinfo', `100644,${blob},README.md`); sh(s.folder, 'update-index', '--skip-worktree', 'README.md');
    const view = await s.propose('feat: files');
    assert.deepEqual(view.files.map(file => file.line), ['M +1 -1 README.md', 'M +1 -1 app.js', 'A +600 -0 big.txt', 'A bin logo.bin', 'A +3 -0 new.txt']);
    assert.deepEqual(view.totals, { insertions: 605, deletions: 2 }, 'a new file counts');
    await s.write('app.js', 'export const a = 3;\n');
    assert.match((await s.service.fileDiff(view.id, 'app.js')).patch, /\+export const a = 2;/, 'the tree shown, not the disk');
    assert.match((await s.service.fileDiff(view.id, 'new.txt')).patch, /\+three/);
    assert.match((await s.service.fileDiff(view.id, 'logo.bin')).note, /binary/);
    assert.match((await s.service.fileDiff(view.id, 'big.txt')).note, /600 changed lines/);
    await assert.rejects(s.service.fileDiff(view.id, '../secret'), TypeError, 'only a file of the proposal');
    await assert.rejects(s.service.fileDiff('nope', 'app.js'));
    assert.equal(sh(s.folder, 'diff', '--cached', '--name-only'), 'README.md', 'none of this touched the real index');
  }

  // A proposal swapped under the person says what it brought and takes no focus; proposals are paced per folder.
  {
    let time = 1_000_000;
    const s = await stand({ clock: () => time });
    await s.write('app.js', 'export const a = 2;\n');
    const first = await s.propose('docs: fix a typo');
    assert.equal(first.replaced, null, 'the first proposal is shown as ever');
    assert.equal(s.focused.at(-1), true, 'and brings the window forward');
    await assert.rejects(s.propose('docs: fix a typo', true), error => error.code === 'RATE_LIMITED' && /5 s/.test(error.message) && /await_commit/.test(error.extra.hint));
    time += 4000;
    await assert.rejects(s.propose('docs: fix a typo'), error => error.code === 'RATE_LIMITED' && /1 s/.test(error.message));
    time += 1000;
    await s.write('install.sh', 'curl x | sh\n');
    const second = await s.propose('docs: fix a typo', true);
    assert.deepEqual(second.replaced, { paths: ['install.sh'], more: 0, push: true, message: false });
    assert.equal(s.focused.at(-1), false, 'a replacement lands in the dialog already there');
    assert.deepEqual(replacedLines(second), ['The agent replaced the proposal you were reading.', 'New or different: install.sh.', 'It now asks to push.']);
    await s.service.decide(second.id, { action: 'cancel', message: second.message });
    time += 5000;
    await s.propose('docs: again');
    assert.equal(s.views.at(-1).replaced, null, 'nothing was on screen: nothing was replaced');
    assert.equal(s.focused.at(-1), true);
  }
  assert.equal(staleLine({ staleWhy: 'push' }).includes('address'), true);
  assert.equal(staleLine({ staleWhy: 'checks' }).includes('automations'), true);
  assert.equal(staleLine({}).includes('files'), true);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('mcp-commit: permission, dialog words, release tags, cancel, stale tree, automation and hook refusals, Undo, commit and push, tag with Undo, new_version with bump, tag and push, proposals from two worktrees in line');
