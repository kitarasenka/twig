import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runGit } from '../../main/git/exec.js';
import { CommandLog } from '../../main/command-log.js';
import { RepositoryStore } from '../../main/store.js';
import { createRepositoryService } from '../../main/git/repository.js';
import { changeRemote, loadRemotes, parseRemotes, validateRepositoryUrl } from '../../main/git/remotes.js';
import { cloneRepository, validateCloneName } from '../../main/git/clone.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-repositories-'));
try {
  const cwd = path.join(root, 'source with spaces'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, directory = cwd) => {
    const result = await runGit({ cwd: directory, log, argv });
    assert.equal(result.code, 0, result.stderr); return result.stdout.trim();
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']); await git(['config', 'user.email', 'twig@example.invalid']);
  await writeFile(path.join(cwd, 'readme.txt'), 'Twig fixture\r\n');
  await git(['add', '--', 'readme.txt']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '-m', 'Root']);
  const oid = await git(['rev-parse', 'HEAD']);
  const bare = path.join(root, 'remote.git'); await git(['clone', '--bare', '--', cwd, bare]);
  const options = { cwd, log };
  assert.deepEqual(await loadRemotes(options), []);
  await changeRemote({ ...options, action: 'add', name: 'upstream', url: bare });
  let remote = (await loadRemotes(options))[0];
  assert.deepEqual(remote, { name: 'upstream', urls: [bare], pushUrls: [] });
  await changeRemote({ ...options, action: 'fetch', name: 'upstream', expected: JSON.stringify(remote) });
  assert.equal(await git(['rev-parse', 'refs/remotes/upstream/main']), oid);
  await git(['config', 'remote.upstream.url', cwd]);
  await assert.rejects(changeRemote({ ...options, action: 'remove', name: 'upstream', expected: JSON.stringify(remote) }), /changed outside/);
  remote = (await loadRemotes(options))[0];
  await changeRemote({ ...options, action: 'set-url', name: 'upstream', url: bare, expected: JSON.stringify(remote) });
  remote = (await loadRemotes(options))[0];
  await changeRemote({ ...options, action: 'remove', name: 'upstream', expected: JSON.stringify(remote) });
  assert.deepEqual(await loadRemotes(options), []);
  assert.equal(await git(['rev-parse', 'HEAD']), oid);
  await git(['config', 'remote.private.url', 'https://user:fixture-secret@host/repo']);
  assert.equal((await loadRemotes(options))[0].name, 'private');
  const privateRead = log.list().findLast(entry => entry.operation === 'Read remotes');
  assert.ok(!JSON.stringify(privateRead).includes('fixture-secret'));
  assert.match(privateRead.stdout, /address hidden/);
  await git(['config', '--remove-section', 'remote.private']);
  for (const url of ['--upload-pack=bad', 'ext::sh bad', 'https://user:secret@host/repo', 'https://host/repo?token=secret', 'ssh://host/repo\ninvalid']) assert.throws(() => validateRepositoryUrl(url), TypeError);
  for (const url of ['git@github.com:team/repo.git', 'ssh://git@host/team/repo', 'https://host/team/repo', cwd]) assert.equal(validateRepositoryUrl(url), url);
  for (const name of ['../escape', '/absolute', 'C:\\escape', 'CON.txt', 'aux', 'repo.', 'repo/child']) assert.throws(() => validateCloneName(name), TypeError);
  const before = log.list().length;
  await assert.rejects(changeRemote({ ...options, action: 'add', name: '--upload-pack', url: bare }), TypeError);
  assert.equal(log.list().length, before, 'invalid input must never reach Git');
  const result = await cloneRepository({ parent: root, name: 'cloned 🌱 repo', url: bare, log });
  assert.equal(result.ok, true); assert.equal(await git(['rev-parse', 'HEAD'], result.path), oid);
  await assert.rejects(cloneRepository({ parent: root, name: 'cloned 🌱 repo', url: bare, log }), /already exists/);
  assert.equal(await readFile(path.join(result.path, 'readme.txt'), 'utf8'), 'Twig fixture\r\n');
  const cancelled = await cloneRepository({ parent: root, name: 'cancelled', url: bare, log, signal: AbortSignal.abort() });
  assert.equal(cancelled.cancelled, true);
  await assert.rejects(access(path.join(root, 'cancelled')));
  const controller = new AbortController();
  const cancellingLog = { start: async entry => { await log.start(entry); controller.abort(); }, output: (...args) => log.output(...args), finish: (...args) => log.finish(...args) };
  assert.equal((await cloneRepository({ parent: root, name: 'cancel-at-start', url: bare, log: cancellingLog, signal: controller.signal })).cancelled, true);
  const stateDir = path.join(root, 'state');
  const service = createRepositoryService({ log, store: new RepositoryStore(stateDir) }); await service.load();
  await Promise.all([service.add(cwd), service.add(result.path)]);
  assert.equal(service.snapshot().repositories.length, 2);
  const sourceId = service.snapshot().repositories.find(item => item.name === 'source with spaces').id;
  await Promise.all([service.select(sourceId), service.remove(sourceId)]);
  assert.deepEqual(service.snapshot().repositories.map(item => item.id), [result.path]);
  await access(path.join(cwd, '.git'));
  const restored = createRepositoryService({ log, store: new RepositoryStore(stateDir) }); await restored.load();
  assert.equal(restored.snapshot().activeId, result.path);
  await restored.remove(result.path); assert.equal(restored.snapshot().activeId, null);
  await access(path.join(result.path, '.git'));
  assert.throws(() => parseRemotes('remote.origin.url\ntruncated'));

  // --- closing and reopening the demo workspace ------------------------------
  // The demo tab is derived, so closing it is one stored flag. It must survive a
  // restart, cost no git at startup while closed, and give back the same
  // sandbox — not a fresh seed — when it is shown again.
  const demoDir = path.join(root, 'state', 'demo-sandbox');
  const demo = { dir: demoDir, remoteDir: path.join(root, 'state', 'demo-sandbox-remote.git'), markerFile: path.join(root, 'state', 'demo-sandbox.json') };
  const withDemo = () => createRepositoryService({ log, store: new RepositoryStore(stateDir), sandbox: demo });
  const seeded = withDemo(); await seeded.load();
  assert.equal(seeded.snapshot().repositories[0]?.sandbox, true, 'the demo is the first tab');
  assert.equal(seeded.snapshot().repositories[0].available, true, 'the demo is seeded and readable');
  const demoHead = await git(['rev-parse', 'HEAD'], demoDir);
  await assert.rejects(seeded.remove(demoDir), /cannot be removed/);

  await seeded.setSandboxVisible(false);
  assert.deepEqual(seeded.snapshot().repositories.filter(item => item.sandbox), [], 'closing hides the demo tab');
  await access(path.join(demoDir, '.git')); // closing deletes nothing

  const spawnsBefore = log.list().length;
  const restarted = withDemo(); await restarted.load();
  assert.deepEqual(restarted.snapshot().repositories.filter(item => item.sandbox), [], 'the demo stays closed across a restart');
  assert.equal(log.list().length, spawnsBefore, 'a closed demo runs no git at startup');
  await assert.rejects(restarted.resetSandbox(), /closed/);

  await restarted.setSandboxVisible(true);
  const reopened = restarted.snapshot().repositories[0];
  assert.equal(reopened?.sandbox, true, 'showing it again puts the demo back first');
  assert.equal(reopened.available, true);
  assert.equal(await git(['rev-parse', 'HEAD'], demoDir), demoHead, 'the same sandbox comes back, not a new seed');
  const shown = withDemo(); await shown.load();
  assert.equal(shown.snapshot().repositories[0]?.sandbox, true, 'and an open demo survives a restart too');

  console.log('Repository checks passed: remotes, stale state, fetch, clone, cancellation, existing-directory refusal, persistence, concurrent list mutations, no disk deletion, demo close/show.');
} finally { await rm(root, { recursive: true, force: true }); }
