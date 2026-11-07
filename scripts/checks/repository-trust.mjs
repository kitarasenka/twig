// What a repository's own `.git` can make 🌱 Twig run, on real Git: each scenario
// plants a command that touches a marker file and proves it did not run, and
// that ordinary repositories — linked worktrees, submodules, partial clones —
// keep working. The scenarios come from the 2026-11 audit.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { MAX_TEXT_OUTPUT, runGit, setGitGate, streamGit } from '../../main/git/exec.js';
import { findFetchRisks, findRiskyConfig, inspectRepository, repoTrustDigest } from '../../main/git/config-risk.js';
import { backgroundFetch, runSync } from '../../main/git/sync.js';
import { createRepositoryService } from '../../main/git/repository.js';
import { RepositoryStore } from '../../main/store.js';
import { createRepositoryTrust, TrustStore } from '../../main/repository-trust.js';
import { INDEX_KINDS } from '../../main/git/undo-plan.js';
import { loadOperationState, resolveGitDir } from '../../main/git/operation-state.js';
import { merge, sequencer } from '../../main/git/history-ops.js';
import { loadRefs } from '../../main/git/refs.js';
import { deleteTag } from '../../main/git/refs-ops.js';
import { cloneRepository } from '../../main/git/clone.js';
import { discardAll } from '../../main/git/discard.js';
import { discardInverse } from '../../main/git/discard-plan.js';
import { agentBranch, checkAgentFolder, suggestWorktreePath } from '../../main/git/worktrees.js';
import { finishWorktree, loadWorktreeBoard, loadWorktreeFileDiff, loadWorktreeReview, planSquash, squashWorktree } from '../../main/git/worktree-board.js';
import { loadCommit, loadFileDiff } from '../../main/git/commit.js';
import { createCommitReader, createHistoryStreams } from '../../main/git/history-stream.js';
import { createToolContext } from '../../main/mcp/context.js';
import { createMcpSession } from '../../main/mcp/session.js';
import { bindTools } from '../../main/mcp/tools/index.js';
import { boardBadges } from '../../renderer/src/features/tools/tools-view.js';
import { buildRefMenu } from '../../renderer/src/features/refs/ref-menu.js';

const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'twig-trust-')));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
Object.assign(process.env, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
const wait = () => new Promise(resolve => setTimeout(resolve, 1100));
let count = 0;
const log = new CommandLog(path.join(directory, 'state'));
await log.load();
const marker = name => path.join(directory, `fired-${name}`);
const fired = name => existsSync(marker(name));
const status = cwd => runGit({ argv: ['status', '--porcelain=v2', '--branch', '-z'], cwd, log, operation: 'Background: read working tree status' });

async function repository(name = `repo-${++count}`) {
  const cwd = path.join(directory, name);
  await mkdir(cwd);
  git(cwd, 'init', '-q', '-b', 'main');
  await writeFile(path.join(cwd, 'a.txt'), 'hello\n');
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'one');
  return cwd;
}

try {
  // --- a partial clone's lazy fetch runs `remote.*.uploadpack` on a plain status (SEC-A1)
  {
    const cwd = await repository();
    const tree = git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
    git(cwd, 'config', 'core.repositoryformatversion', '1');
    git(cwd, 'config', 'extensions.partialClone', 'origin');
    git(cwd, 'config', 'remote.origin.url', cwd);
    git(cwd, 'config', 'remote.origin.promisor', 'true');
    git(cwd, 'config', 'remote.origin.uploadpack', `touch ${marker('lazy')}; exit 1; git-upload-pack`);
    await rm(path.join(cwd, '.git/index'));
    await rm(path.join(cwd, '.git/objects', tree.slice(0, 2), tree.slice(2)));
    const keys = (await findRiskyConfig(cwd, log)).map(item => item.key);
    for (const key of ['extensions.partialclone', 'remote.origin.promisor', 'remote.origin.uploadpack']) assert.ok(keys.includes(key), key);
    await status(cwd);
    assert.equal(fired('lazy'), false, 'a read does not fetch missing objects by itself');
  }

  // --- what the old check let through (SEC-A2)
  {
    const cwd = await repository();
    await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=Evil\n');
    git(cwd, 'config', 'filter.Evil.clean', `touch ${marker('filter')}; cat`);
    git(cwd, 'config', 'diff.Foo.textconv', 'evil');
    git(cwd, 'config', 'credential.https://Example.com.helper', '!evil');
    git(cwd, 'config', `includeIf.gitdir:${directory}/.path`, 'inc');
    await writeFile(path.join(cwd, '.git/inc'), '[core]\n\tgitProxy = evil\n');
    const keys = (await findRiskyConfig(cwd, log)).map(item => item.key);
    for (const key of ['filter.Evil.clean', 'diff.Foo.textconv', 'credential.https://Example.com.helper', `includeif.gitdir:${directory}/.path`, 'core.gitproxy']) {
      assert.ok(keys.includes(key), `the subsection keeps its case: ${key}`);
    }
    const journal = JSON.stringify(log.list());
    assert.equal(journal.includes(`touch ${marker('filter')}`), false, 'values of the config stay out of the journal');
  }
  {
    const cwd = await repository();
    git(cwd, 'config', 'core.repositoryformatversion', '1');
    git(cwd, 'config', 'extensions.worktreeConfig', 'true');
    await writeFile(path.join(cwd, '.git/config.worktree'), `[filter "x"]\n\tclean = "touch ${marker('wt')}; cat"\n`);
    assert.ok((await findRiskyConfig(cwd, log)).some(item => item.key === 'filter.x.clean'), 'config.worktree counts');
  }
  {
    const inner = await repository();
    const cwd = await repository();
    git(cwd, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'sub');
    git(cwd, 'commit', '-qm', 'sub');
    assert.deepEqual(await findRiskyConfig(cwd, log), [], 'a submodule as Git makes it has nothing to show');
    assert.equal((await status(cwd)).code, 0, 'status goes through submodules as before');
    git(path.join(cwd, 'sub'), 'config', 'filter.x.clean', `touch ${marker('sub')}; cat`);
    assert.ok((await findRiskyConfig(cwd, log)).some(item => item.key.endsWith('filter.x.clean')), 'a submodule’s own config counts');
    assert.ok(await inspectRepository(path.join(cwd, 'sub'), log), 'a submodule opens as a repository of its own');
    assert.deepEqual((await inspectRepository(path.join(cwd, 'sub'), log)).findings.map(item => item.key), ['filter.x.clean'], 'its core.worktree inside the checkout is no finding');
    // The old layout: a gitlink whose `.git` is a folder in the working tree.
    const other = await repository();
    const embedded = path.join(other, 'emb');
    git(other, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'emb');
    git(other, 'commit', '-qm', 'emb');
    await rm(path.join(embedded, '.git'));
    await cp(path.join(other, '.git/modules/emb'), path.join(embedded, '.git'), { recursive: true });
    await rm(path.join(other, '.git/modules'), { recursive: true });
    git(other, 'config', '--file', 'emb/.git/config', '--unset', 'core.worktree');
    git(other, 'config', '--file', 'emb/.git/config', 'filter.y.clean', 'evil');
    assert.ok((await findRiskyConfig(other, log)).some(item => item.key.endsWith('filter.y.clean')), 'a nested .git folder counts');
  }
  {
    const cwd = await repository();
    git(cwd, 'config', 'filter.lfs.clean', `git-lfs clean ; touch ${marker('lfs')}; cat`);
    git(cwd, 'config', 'filter.lfs.smudge', 'git-lfs smudge -- %f');
    git(cwd, 'config', 'filter.lfs.process', 'git-lfs filter-process');
    git(cwd, 'config', 'filter.lfs.required', 'true');
    assert.deepEqual((await findRiskyConfig(cwd, log)).map(item => item.key), ['filter.lfs.clean'], 'LFS filters match whole, not by prefix');
    for (const value of ['ssh -F .git/x.conf', 'ssh -A']) {
      git(cwd, 'config', 'core.sshCommand', value);
      assert.ok((await findRiskyConfig(cwd, log)).some(item => item.key === 'core.sshcommand'), value);
    }
    git(cwd, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes');
    assert.equal((await findRiskyConfig(cwd, log)).some(item => item.key === 'core.sshcommand'), false);
    for (const [key, value, risky] of [['push.default', 'current', false], ['push.default', 'matching', true], ['remote.origin.pushurl', 'x', true],
      ['remote.origin.mirror', 'true', true], ['remote.origin.push', '+refs/heads/main:refs/heads/main', true], ['remote.pushDefault', 'fork', true], ['branch.main.pushRemote', 'fork', true]]) {
      git(cwd, 'config', key, value);
      assert.equal((await findRiskyConfig(cwd, log)).some(item => item.key === key.toLowerCase() || item.key === key), risky, `${key} = ${value}`);
      git(cwd, 'config', '--unset', key);
    }
    git(cwd, 'config', 'submodule.x.update', '!evil');
    assert.ok((await findRiskyConfig(cwd, log)).some(item => item.key === 'submodule.x.update'));
    git(cwd, 'config', 'submodule.x.update', 'rebase');
    assert.equal((await findRiskyConfig(cwd, log)).some(item => item.key === 'submodule.x.update'), false);
    git(cwd, 'config', 'core.worktree', '/tmp');
    assert.ok((await findRiskyConfig(cwd, log)).some(item => item.key === 'core.worktree'), 'a working tree elsewhere is shown');
  }

  // What `git lfs install` writes asks nothing; the same file with a line added does.
  {
    const cwd = await repository();
    const hook = path.join(cwd, '.git/hooks/pre-push');
    const lfs = `#!/bin/sh\ncommand -v git-lfs >/dev/null 2>&1 || { printf >&2 "\\n%s\\n\\n" "This repository is configured for Git LFS but 'git-lfs' was not found on your path."; exit 2; }\ngit lfs pre-push "$@"\n`;
    await writeFile(hook, lfs);
    await chmod(hook, 0o755);
    assert.deepEqual(await findRiskyConfig(cwd, log), []);
    await writeFile(hook, `${lfs}touch ${marker('lfs-hook')}\n`);
    assert.deepEqual((await findRiskyConfig(cwd, log)).map(item => item.key), ['hooks/pre-push']);
    await rm(hook);
    git(cwd, 'config', 'core.hooksPath', '');
    assert.deepEqual(await findRiskyConfig(cwd, log), [], 'an empty hooks path names nothing');
  }

  // --- a folder in a clone that looks like a Git directory (SEC-A3)
  {
    const server = await repository();
    const demo = path.join(server, 'demo');
    await mkdir(path.join(demo, 'objects'), { recursive: true });
    await mkdir(path.join(demo, 'refs/heads'), { recursive: true });
    await writeFile(path.join(demo, 'objects/.keep'), '');
    await writeFile(path.join(demo, 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(path.join(demo, 'refs/heads/main'), `${'1'.repeat(40)}\n`);
    await writeFile(path.join(demo, 'config'), `[core]\n\trepositoryformatversion=1\n\tbare=false\n\tworktree=.\n[extensions]\n\tpartialClone=origin\n[remote "origin"]\n\turl=.\n\tpromisor=true\n\tuploadpack=touch ${marker('clone')}; false\n`);
    git(server, 'add', '.');
    git(server, 'commit', '-qm', 'fixtures');
    const parent = path.join(directory, 'clones');
    await mkdir(parent);
    const clone = await cloneRepository({ parent, name: 'c', url: server, log });
    assert.equal(clone.ok, true);
    assert.equal(await inspectRepository(path.join(clone.path, 'demo'), log), null, 'the folder is no repository to open');
    assert.match((await status(path.join(clone.path, 'demo'))).stderr, /safe\.bareRepository/);
    assert.equal(fired('clone'), false);
    assert.equal((await status(clone.path)).code, 0, 'the clone around it is fine');
    const bare = path.join(directory, 'bare.git');
    git(directory, 'init', '-q', '--bare', bare);
    const inBare = await runGit({ argv: ['status'], cwd: bare, log, operation: 'Check' });
    assert.notEqual(inBare.code, 0, 'a bare repository is not found by walking into it');
    assert.match(inBare.stderr, /safe\.bareRepository/);
    assert.equal((await runGit({ argv: [`--git-dir=${bare}`, 'rev-parse', '--git-dir'], cwd: bare, log, operation: 'Check' })).code, 0, 'an explicit --git-dir reaches it');
  }

  // --- background fetch, and every other fetch (SEC-A4)
  {
    const other = await repository();
    const cwd = await repository();
    git(cwd, 'config', 'protocol.ext.allow', 'always');
    git(cwd, 'config', 'remote.origin.url', `ext::sh -c touch% ${marker('ext')}`);
    git(cwd, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    assert.equal((await backgroundFetch({ cwd, log })).ok, false);
    assert.equal((await runSync({ cwd, log, mode: 'fetch' })).ok, false);
    assert.equal(fired('ext'), false, 'an ext:: remote runs nothing');
    assert.equal((await runGit({ argv: ['fetch', 'origin'], cwd, log, operation: 'Check' })).code === 0, false);
    assert.equal(fired('ext'), false, 'not even when the check is passed by');
    git(cwd, 'config', 'remote.origin.url', other);
    git(cwd, 'config', `url.ext::sh -c touch% ${marker('insteadof')}.insteadOf`, other);
    assert.equal((await runGit({ argv: ['fetch', 'origin'], cwd, log, operation: 'Check' })).code === 0, false);
    assert.equal(fired('insteadof'), false, 'nor can insteadOf turn an address into one');
  }
  {
    const other = await repository();
    const cwd = await repository();
    git(cwd, 'config', 'remote.origin.url', other);
    git(cwd, 'config', 'remote.origin.uploadpack', `touch ${marker('uploadpack')}; git-upload-pack`);
    git(cwd, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
    const result = await backgroundFetch({ cwd, log });
    assert.equal(result.ok, false);
    assert.match(result.message, /remote\.origin\.uploadpack/, 'the reason names the setting');
    assert.equal(fired('uploadpack'), false);
    assert.equal((await findFetchRisks(cwd, log)).length, 1);
  }
  for (const [name, plant] of [
    ['hook', async cwd => { await writeFile(path.join(cwd, '.git/hooks/reference-transaction'), `#!/bin/sh\ntouch ${marker('hook')}\n`); await chmod(path.join(cwd, '.git/hooks/reference-transaction'), 0o755); }],
    ['hooks-path', async cwd => { await mkdir(path.join(cwd, '.ci')); await writeFile(path.join(cwd, '.ci/reference-transaction'), `#!/bin/sh\ntouch ${marker('hooks-path')}\n`); await chmod(path.join(cwd, '.ci/reference-transaction'), 0o755); git(cwd, 'config', 'core.hooksPath', '.ci'); }],
    ['alternate', async cwd => { const alternate = await repository(); await writeFile(path.join(cwd, '.git/objects/info/alternates'), `${alternate}/.git/objects\n`); git(cwd, 'config', 'core.alternateRefsCommand', `touch ${marker('alternate')}; true`); }]
  ]) {
    const other = await repository();
    const cwd = await repository();
    git(cwd, 'remote', 'add', 'origin', other);
    await plant(cwd);
    assert.notDeepEqual(await findRiskyConfig(cwd, log), [], `${name} is shown on opening`);
    const result = await backgroundFetch({ cwd, log });
    assert.equal(result.ok, true, `${name}: ${result.message}`);
    assert.ok(git(cwd, 'rev-parse', 'origin/main').trim(), 'the fetch itself happened');
    assert.equal(fired(name), false, `${name} did not run`);
  }
  {
    const cwd = await repository();
    await writeFile(path.join(cwd, 'a.txt'), 'two\n');
    git(cwd, 'commit', '-qam', 'two');
    const head = git(cwd, 'rev-parse', 'HEAD').trim();
    const folder = path.join(cwd, '.git/rebase-merge');
    await mkdir(folder);
    for (const [name, text] of [['git-rebase-todo', `exec touch ${marker('todo')}\n`], ['head-name', 'refs/heads/main\n'], ['onto', `${head}\n`], ['orig-head', `${head}\n`],
      ['interactive', ''], ['msgnum', '1\n'], ['end', '2\n'], ['done', `pick ${head} two\n`]]) await writeFile(path.join(folder, name), text);
    assert.ok((await findRiskyConfig(cwd, log)).some(item => item.value.startsWith('exec touch')), 'shown on opening');
    const gitDir = await resolveGitDir({ cwd, log });
    assert.equal((await loadOperationState({ cwd, log, gitDir })).kind, 'rebase');
    const answer = await sequencer({ cwd, log, gitDir, kind: 'rebase', step: 'continue' });
    assert.equal(answer.ok, false);
    assert.match(answer.message, /exec touch/, 'Continue says what it would have run');
    assert.equal(fired('todo'), false);
    assert.equal((await sequencer({ cwd, log, gitDir, kind: 'rebase', step: 'abort' })).ok, true, 'Abort still works');
  }

  // --- a repository that changes after it was accepted (SEC-B4)
  {
    const stateDir = path.join(directory, 'trust');
    const store = new TrustStore(stateDir);
    await store.load();
    const trust = createRepositoryTrust({ store, log });
    setGitGate(trust.gate);
    try {
      const cwd = await repository();
      const service = createRepositoryService({ log, store: new RepositoryStore(path.join(directory, 'trust-repos')), trust });
      await service.load();
      assert.equal((await service.add(cwd)).repositories[0].available, true, 'a clean repository needs no answer');
      assert.equal((await status(cwd)).code, 0);

      // 🌱 Twig's own writes change the file, not the findings: nobody is asked.
      for (const [key, value] of [['remote.fork.url', 'https://example.invalid/x.git'], ['branch.main.remote', 'fork'], ['user.name', 'Ada'], ['core.editor', 'vim']]) git(cwd, 'config', key, value);
      assert.equal((await status(cwd)).code, 0, 'ordinary config writes ask nothing');
      assert.equal(trust.blocked(cwd), false);

      const spawned = () => log.list().filter(entry => entry.cwd === cwd).length;
      const before = spawned();
      await status(cwd);
      assert.equal(spawned(), before + 1, 'with nothing changed, the check runs no Git');

      // A filter written into the config: no read reaches Git.
      const filterMark = marker('after-open');
      git(cwd, 'config', 'filter.x.clean', `touch ${filterMark}; cat`);
      await writeFile(path.join(cwd, '.gitattributes'), '*.txt filter=x\n');
      await wait();
      await writeFile(path.join(cwd, 'a.txt'), 'changed\n');
      const refused = await status(cwd);
      assert.equal(refused.code, -1);
      assert.equal(refused.refused, true);
      assert.match(refused.stderr, /settings changed/);
      assert.equal(fired('after-open'), false, 'the changed config runs nothing');
      assert.equal(trust.blocked(cwd), true);
      let streamEnd;
      const ended = new Promise(resolve => { streamEnd = resolve; });
      streamGit({ argv: ['log', '-1'], cwd, log, operation: 'Read commit history', onData: () => assert.fail('a stopped repository streams nothing'), onEnd: streamEnd });
      assert.equal((await ended).code, -1, 'the history stream is stopped too');
      const shown = (await service.select(cwd)).repositories[0];
      assert.equal(shown.available, false, 'the tab stops being available');
      assert.equal(shown.blocked, true);

      // The read-only MCP tools go through the same check.
      const repos = [{ id: cwd, name: 'repo', path: cwd, available: true }];
      const context = createToolContext({ repositories: { snapshot: () => ({ repositories: repos }) }, journal: log, getActiveId: () => cwd, getUiContext: () => null });
      const session = createMcpSession({ version: '9', tools: bindTools(context) });
      const answer = await session.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_changes', arguments: { repository: cwd } } });
      assert.equal(answer.result.isError, true, 'list_changes does not read a stopped repository');
      assert.equal(fired('after-open'), false, 'and the filter did not run');
      repos[0].blocked = true;
      const named = await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_changes', arguments: { repository: cwd } } });
      assert.match(named.result.content[0].text, /Git settings changed/, 'the agent is told why');

      // Asked once per change, and "keep stopped" holds.
      const question = trust.pending(cwd);
      assert.deepEqual(question.findings.map(item => item.key), ['filter.x.clean']);
      assert.equal(trust.pending(cwd), null, 'not twice at once');
      await trust.answer(cwd, false);
      assert.equal(trust.pending(cwd), null, 'not again after the answer');
      assert.equal((await status(cwd)).code, -1);
      git(cwd, 'config', '--unset', 'filter.x.clean');
      assert.equal((await status(cwd)).code, 0, 'taking it away needs no answer');
      git(cwd, 'config', 'filter.x.clean', 'cat');
      assert.equal((await status(cwd)).code, -1);
      trust.pending(cwd);
      await trust.answer(cwd, true);
      assert.equal((await status(cwd)).code, 0, 'allowed, it works');
      assert.equal((await service.select(cwd)).repositories[0].available, true);

      // A hook appears, is changed, and the file's times are put back.
      const hook = path.join(cwd, '.git/hooks/pre-commit');
      await writeFile(hook, '#!/bin/sh\nexit 0\n');
      await chmod(hook, 0o755);
      assert.equal((await status(cwd)).code, -1, 'a new hook stops it');
      trust.pending(cwd);
      await trust.answer(cwd, true);
      assert.equal((await status(cwd)).code, 0);
      const { atime, mtime } = await stat(hook);
      await writeFile(hook, '#!/bin/sh\nexit 1\n');
      const { utimes } = await import('node:fs/promises');
      await utimes(hook, atime, mtime);
      assert.equal((await status(cwd)).code, -1, 'a hook rewritten with its time put back still shows');
      trust.pending(cwd);
      await trust.answer(cwd, true);

      // The answer survives a restart, and a launch with nothing changed asks Git nothing.
      const reloaded = new TrustStore(stateDir);
      await reloaded.load();
      const again = createRepositoryTrust({ store: reloaded, log });
      setGitGate(again.gate);
      await new Promise(resolve => setTimeout(resolve, 50));
      await again.guard(cwd);
      const entries = spawned();
      assert.equal((await status(cwd)).code, 0);
      assert.equal(spawned(), entries + 1, 'the kept answer holds without reading the settings again');
      assert.equal(again.blocked(cwd), false);

      // Connected before these checks existed: with findings, asked once.
      setGitGate(null);
      const older = await repository();
      await writeFile(path.join(older, '.git/hooks/post-commit'), '#!/bin/sh\n');
      await chmod(path.join(older, '.git/hooks/post-commit'), 0o755);
      setGitGate(again.gate);
      await again.guard(older);
      assert.equal(again.blocked(older), true);
      assert.equal((await status(older)).code, -1);
      assert.deepEqual(again.pending(older).findings.map(item => item.key), ['hooks/post-commit']);
      await again.answer(older, true);
      assert.equal((await status(older)).code, 0);
      await again.forget(older);
      assert.equal(reloaded.get(path.join(older, '.git')), null, 'leaving the list forgets the answer');
      assert.equal((await repoTrustDigest(cwd, log)).length, 64);
    } finally { setGitGate(null); }
  }

  // --- a real partial clone works once accepted, and only then
  {
    const server = await repository();
    git(server, 'config', 'uploadpack.allowFilter', 'true');
    git(server, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const cwd = path.join(directory, 'partial');
    git(directory, '-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${server}`, cwd);
    const store = new TrustStore(path.join(directory, 'trust-partial'));
    await store.load();
    const trust = createRepositoryTrust({ store, log });
    const blob = ['cat-file', '-p', 'HEAD:a.txt'];
    const inspection = await inspectRepository(cwd, log);
    assert.equal(inspection.partialClone, true);
    assert.notEqual((await runGit({ argv: blob, cwd, log, operation: 'Check' })).code, 0, 'before the answer a missing object stays missing');
    await trust.approve(inspection);
    setGitGate(trust.gate);
    try {
      const read = await runGit({ argv: ['-c', 'protocol.file.allow=always', ...blob], cwd, log, operation: 'Check' });
      assert.equal(read.code, 0, read.stderr);
      assert.equal(read.stdout, 'hello\n', 'the accepted partial clone fetches what it lacks');
    } finally { setGitGate(null); }
  }

  // --- a forged `.git` file in an agent's worktree (SEC-B1)
  {
    const cwd = await repository();
    const folder = path.join(cwd, '.claude/worktrees/task');
    await mkdir(path.dirname(folder), { recursive: true });
    await writeFile(path.join(cwd, '.git/info/exclude'), '/.claude/worktrees/\n');
    git(cwd, 'worktree', 'add', '-q', '-b', 'agent/task', folder);
    await writeFile(path.join(folder, 'work.txt'), 'work\n');
    git(folder, 'add', '.');
    git(folder, 'commit', '-qm', 'agent work');
    await writeFile(path.join(folder, 'a.txt'), 'edited\n');
    await writeFile(path.join(folder, 'new.txt'), 'new\n');

    // A real linked worktree reads as ever, through `--git-dir`.
    const board = await loadWorktreeBoard({ cwd, log });
    const card = board.worktrees[1];
    assert.equal(card.forged, false);
    assert.equal(card.changes.files, 2);
    assert.equal(card.ahead, 1);
    assert.equal('git' in card, false, 'the options stay in main');
    const entry = log.list().filter(item => item.cwd === folder).at(-1);
    assert.ok(entry.argv.some(word => word.startsWith('--git-dir=')), 'the journal shows how Git was told');
    const review = await loadWorktreeReview({ cwd, log, folder });
    assert.deepEqual(review.files.map(file => file.path), ['a.txt', 'new.txt', 'work.txt']);
    assert.match((await loadWorktreeFileDiff({ cwd, log, folder, path: 'a.txt', untracked: false })).patch, /\+edited/);
    assert.match((await loadWorktreeFileDiff({ cwd, log, folder, path: 'new.txt', untracked: true })).patch, /\+new/);

    // Everything below is written inside the worktree folder alone.
    const fake = path.join(folder, '.g');
    await mkdir(path.join(fake, 'refs/heads/agent'), { recursive: true });
    await cp(path.join(cwd, '.git/objects'), path.join(fake, 'objects'), { recursive: true });
    await writeFile(path.join(fake, 'HEAD'), 'ref: refs/heads/agent/task\n');
    await writeFile(path.join(fake, 'refs/heads/agent/task'), `${git(cwd, 'rev-parse', 'agent/task').trim()}\n`);
    await writeFile(path.join(fake, 'config'), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[filter "x"]\n\tclean = "touch ${marker('forged')}; cat"\n`);
    await writeFile(path.join(fake, 'index'), await readFile(path.join(cwd, '.git/worktrees/task/index')));
    await writeFile(path.join(folder, '.gitattributes'), '*.txt filter=x\n');
    await writeFile(path.join(folder, '.git'), 'gitdir: .g\n');
    assert.match(git(folder, 'rev-parse', '--git-dir'), /\.g/, 'Git itself now follows the file');

    const after = await loadWorktreeBoard({ cwd, log });
    assert.equal(fired('forged'), false, 'the board runs nothing from the forged directory');
    assert.equal(after.worktrees[1].forged, true);
    assert.equal(after.worktrees[1].branch, 'agent/task', 'the card is about the real worktree');
    assert.ok(boardBadges(after.worktrees[1]).includes('.git leads elsewhere'), 'and says so in words');
    await loadWorktreeReview({ cwd, log, folder });
    await loadWorktreeFileDiff({ cwd, log, folder, path: 'a.txt', untracked: false });
    await planSquash({ cwd, log, folder });
    assert.equal(fired('forged'), false, 'nor do review, diff and the squash plan');

    // The gate refuses anything else that would read that file.
    const store = new TrustStore(path.join(directory, 'trust-forged'));
    await store.load();
    const trust = createRepositoryTrust({ store, log });
    await trust.guard(cwd);
    setGitGate(trust.gate);
    try {
      const plain = await status(folder);
      assert.equal(plain.refused, true);
      assert.match(plain.stderr, /does not lead to its repository/);
      assert.equal(fired('forged'), false);
      assert.equal((await status(cwd)).code, 0, 'the main checkout goes on');
      assert.equal((await loadWorktreeBoard({ cwd, log })).worktrees[1].forged, true, 'and so does the board');
    } finally { setGitGate(null); }

    // Back to normal: squash and finish on a real linked worktree.
    await writeFile(path.join(folder, '.git'), `gitdir: ${cwd}/.git/worktrees/task\n`);
    await rm(fake, { recursive: true });
    await rm(path.join(folder, '.gitattributes'));
    git(folder, 'checkout', '--', 'a.txt');
    await rm(path.join(folder, 'new.txt'));
    const plan = await planSquash({ cwd, log, folder });
    assert.equal(plan.problem, null);
    const squashed = await squashWorktree({ cwd, log, folder, message: 'agent work', branchOid: plan.branchOid, baseOid: plan.baseOid });
    assert.equal(squashed.ok, true, squashed.message);
    assert.equal((await finishWorktree({ cwd, log, folder })).ok, true);
    assert.equal(existsSync(folder), false);
  }

  // --- an option-looking tag from a clone (SEC-A7)
  {
    const server = await repository();
    const oid = git(server, 'rev-parse', 'HEAD').trim();
    await writeFile(path.join(server, 'b.txt'), 'y\n');
    git(server, 'add', '.');
    git(server, 'commit', '-qm', 'two');
    const tip = git(server, 'rev-parse', 'HEAD').trim();
    for (const name of ['--squash', '--no-commit', '-Xtheirs']) git(server, 'update-ref', `refs/tags/${name}`, tip);
    const parent = path.join(directory, 'tag-clones');
    await mkdir(parent);
    const { path: cwd } = await cloneRepository({ parent, name: 'c', url: server, log });
    git(cwd, 'reset', '-q', '--hard', oid);
    const gitDir = await resolveGitDir({ cwd, log });
    assert.ok((await loadRefs({ cwd, log })).some(ref => ref.name === '--squash'), 'such a tag is still listed');
    assert.throws(() => merge({ cwd, log, gitDir, revision: '--squash' }), TypeError);
    assert.equal(git(cwd, 'status', '--short'), '');
    const ref = { type: 'tag', name: '--squash', fullName: 'refs/tags/--squash', target: tip };
    const items = buildRefMenu({ ref, head: { branch: 'main', oid }, remotes: ['origin'], handlers: {} });
    assert.equal(items.find(item => item.key === 'checkout').reason, 'This name looks like a command-line option');
    assert.equal(items.find(item => item.key?.startsWith('ref-tag-delete-refs')).reason, undefined, 'it can still be deleted');
    await deleteTag({ cwd, log, name: '--squash' });
    assert.equal((await loadRefs({ cwd, log })).some(item => item.name === '--squash'), false);
  }

  // --- a quoted file name read as a path outside the repository (SEC-A6)
  {
    const top = path.join(directory, 'quoted');
    await mkdir(top);
    await writeFile(path.join(top, 'outside-secret.txt'), `${'SECRET'}-OUTSIDE\n`);
    const cwd = path.join(top, 'proj');
    await mkdir(cwd);
    git(cwd, 'init', '-q', '-b', 'main');
    await writeFile(path.join(cwd, 'a.txt'), 'x\n');
    git(cwd, 'add', '.');
    git(cwd, 'commit', '-qm', 'one');
    const name = '"\\056\\056/outside-secret.txt"';
    await mkdir(path.join(cwd, '"\\056\\056'));
    await writeFile(path.join(cwd, name), 'innocent\n');
    await writeFile(path.join(cwd, 'plain.txt'), 'plain\n');
    const result = await discardAll({ cwd, log, scope: 'untracked' });
    assert.equal(git(cwd, 'show', `${result.undo.before}:${name}`), 'innocent\n', 'the backup holds the file itself');
    assert.equal(git(cwd, 'show', `${result.undo.before}:plain.txt`), 'plain\n', 'and the others beside it');
    const [restore] = discardInverse(result.undo, 'undo');
    await runGit({ cwd, log, argv: restore.argv, stdin: restore.stdin, operation: 'Check' });
    assert.equal(await readFile(path.join(cwd, name), 'utf8'), 'innocent\n', 'Undo puts back what was there');
  }

  // --- `.claude` committed as a link out of the repository (SEC-A8)
  {
    const server = await repository();
    const victim = path.join(directory, 'victim');
    await mkdir(victim);
    await symlink(victim, path.join(server, '.claude'));
    git(server, 'add', '.');
    git(server, 'commit', '-qm', 'link');
    const parent = path.join(directory, 'link-clones');
    await mkdir(parent);
    const { path: cwd } = await cloneRepository({ parent, name: 'c', url: server, log });
    await assert.rejects(suggestWorktreePath({ main: cwd, branch: agentBranch('task'), agent: true }), /not a folder/);
    await assert.rejects(checkAgentFolder(cwd), /not a folder/);
    assert.deepEqual(await readdir(victim), []);
    const plain = await repository();
    assert.match(await suggestWorktreePath({ main: plain, branch: agentBranch('task'), agent: true }), /\.claude\/worktrees\/task$/);
    await mkdir(path.join(plain, '.claude'));
    await symlink(victim, path.join(plain, '.claude/worktrees'));
    await assert.rejects(checkAgentFolder(plain), /not a folder/);
  }

  // --- a message of megabytes in a repository of kilobytes (SEC-A9)
  {
    const cwd = await repository();
    const tree = git(cwd, 'rev-parse', 'HEAD^{tree}').trim();
    const head = git(cwd, 'rev-parse', 'HEAD').trim();
    const file = path.join(directory, 'message');
    await writeFile(file, 'a'.repeat(3 * 1024 * 1024));
    const big = git(cwd, 'commit-tree', tree, '-p', head, '-F', file).trim();
    git(cwd, 'update-ref', 'refs/heads/main', big);
    const commit = await loadCommit({ cwd, log, oid: big });
    assert.equal(commit.truncated, true);
    assert.match(commit.body, /Cut by 🌱 Twig/, 'the cut is said in words');
    assert.equal(commit.parents[0], head, 'what comes before the message is whole');
    assert.ok(commit.subject.length < 3000);
    const streams = createHistoryStreams({ log });
    const page = await streams.page({ cwd, skip: 0, limit: 10 });
    streams.close();
    assert.equal(page.commits.length, 2, 'the history opens');
    assert.match(page.commits[0].subject, /Cut by 🌱 Twig/);
    assert.ok(page.commits[0].subject.length < 2 * 1024 * 1024);

    // The reader across chunks: the commit after the long one is intact.
    const reader = createCommitReader();
    const seen = [];
    const oid = 'a'.repeat(40);
    const date = '2026-01-01T00:00:00+00:00';
    reader.push(`${oid}\0\0A\0a@b\0${date}\0${date}\0`, item => seen.push(item));
    for (let piece = 0; piece < 40; piece += 1) reader.push('x'.repeat(65536), item => seen.push(item));
    reader.push(`\0body\0${oid}\0\0B\0b@b\0${date}\0${date}\0second\0\0`, item => seen.push(item));
    reader.end();
    assert.equal(seen.length, 2);
    assert.match(seen[0].subject, /Cut by 🌱 Twig/);
    assert.equal(seen[1].subject, 'second');

    // Named limit: the part, marked. No limit named: a failure, never half a list.
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd, env, encoding: 'utf8', input: Buffer.alloc(MAX_TEXT_OUTPUT + 4096, 0x61) }).trim();
    const part = await runGit({ argv: ['cat-file', '-p', blob], cwd, log, operation: 'Check', maxBytes: 1000 });
    assert.equal(part.truncated, true);
    assert.equal(part.stdout.length, 1000);
    const whole = await runGit({ argv: ['cat-file', '-p', blob], cwd, log, operation: 'Check' });
    assert.equal(whole.code, -1, 'running over the default limit fails');
    assert.equal(whole.truncated, true);
    assert.match(whole.stderr, /Stopped by 🌱 Twig/);
    const binary = await runGit({ argv: ['cat-file', '-p', blob], cwd, log, operation: 'Check', binary: true, maxBytes: 1000 });
    assert.equal(binary.truncated, true);

    // A diff past its limit says so in a line of its own.
    const huge = await repository();
    await writeFile(path.join(huge, 'big.txt'), `${'line\n'.repeat(8 * 1024 * 1024)}`);
    git(huge, 'add', '.');
    git(huge, 'commit', '-qm', 'big');
    const diff = await loadFileDiff({ cwd: huge, log, oid: git(huge, 'rev-parse', 'HEAD').trim(), file: 'big.txt' });
    assert.equal(diff.truncated, true);
    assert.match(diff.patch.trimEnd().split('\n').at(-1), /^\\ Cut by 🌱 Twig/);
  }

  // Connected before this check existed, with a hook and a linked worktree: saving the
  // worktree's place must not turn "waiting for an answer" into "accepted" at the next launch.
  {
    const cwd = await repository();
    await writeFile(path.join(cwd, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const linked = path.join(directory, 'linked-before-the-check');
    git(cwd, 'worktree', 'add', '-q', '-b', 'linked-before-the-check', linked);
    const folder = path.join(directory, 'trust-upgrade');
    const first = new TrustStore(folder);
    await first.load();
    const trust = createRepositoryTrust({ store: first, log });
    await trust.guard(cwd);
    await trust.guard(linked);
    assert.ok((await trust.gate(cwd))?.refused, 'the first launch waits for the answer');
    const reloaded = new TrustStore(folder);
    await reloaded.load();
    const again = createRepositoryTrust({ store: reloaded, log });
    await again.guard(cwd);
    await again.guard(linked);
    assert.ok((await again.gate(cwd))?.refused, 'and so does the second, nobody answered');
    assert.ok((await again.gate(linked))?.refused);
  }
  assert.ok(INDEX_KINDS.includes('worktree:apply-untracked'), 'staging lines of a new file leaves Undo as staging any line does');

  console.log('Repository trust checks passed: lazy fetch, config scopes and subsections, submodules, nested Git folders, background fetch, rebase todo, settings changed after opening, kept answers, partial clones, forged worktree .git, option-looking refs, quoted paths, linked .claude, output limits.');
} finally {
  setGitGate(null);
  await rm(directory, { recursive: true, force: true });
}
