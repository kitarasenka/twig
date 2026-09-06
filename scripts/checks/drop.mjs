import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { runDrop, validateDropRequest } from '../../main/git/drop.js';
import { dropActions, buildDropPlan, remoteEndpoint } from '../../main/git/drop-plan.js';
import { rowEndpoint } from '../../renderer/src/features/graph/useGitDrag.js';

const local = (name, oid) => ({ kind: 'local', ref: `refs/heads/${name}`, oid });
const commit = oid => ({ kind: 'commit', ref: null, oid });
const remote = (name, oid) => ({ kind: 'remote', ref: `refs/remotes/${name}`, oid });
const a = 'a'.repeat(40), b = 'b'.repeat(40);
const keys = (source, target) => dropActions(source, target, ['origin', 'team/upstream']).map(item => item.key);
assert.deepEqual(keys(local('a', a), local('b', b)), ['merge', 'merge-no-ff', 'rebase', 'compare']);
assert.deepEqual(keys(commit(a), local('b', b)), ['cherry-pick', 'revert', 'compare']);
assert.deepEqual(keys(commit(a), commit(b)), ['cherry-pick', 'revert', 'compare']);
assert.deepEqual(keys(commit(a), remote('origin/b', b)), ['compare']);
assert.ok(keys(local('a', a), remote('origin/b', a)).includes('push'), 'same OID can still publish a branch');
assert.ok(keys(remote('origin/a', a), local('a', a)).includes('pull'), 'same cached OID can still fetch new work');
assert.deepEqual(keys(local('a', a), local('a', a)), []);
assert.deepEqual(remoteEndpoint(remote('team/upstream/topic/x', a), ['team', 'team/upstream']), { remote: 'team/upstream', branch: 'topic/x' });
assert.equal(rowEndpoint({ oid: a }, [{ type: 'local', name: 'a', fullName: 'refs/heads/a', target: a },
  { type: 'local', name: 'b', fullName: 'refs/heads/b', target: a }], 'elsewhere').kind, 'commit', 'ambiguous tips never silently pick a branch');
const valid = { action: 'merge', source: local('a', a), target: local('b', b), head: { branch: 'b', oid: b }, mainline: null };
for (const source of [local('--detach', a), local('../bad', a), local('bad\0name', a), { ...commit(a), ref: '--all' }, commit('--help')]) {
  assert.throws(() => validateDropRequest({ ...valid, source }), TypeError);
}
assert.throws(() => buildDropPlan({ ...valid, action: '--force' }), TypeError);

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-drop-'));
try {
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, at = cwd) => {
    const result = await runGit({ cwd: at, log, argv });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trimEnd();
  };
  const add = async (file, text) => { await writeFile(path.join(cwd, file), text); await git(['add', '--', file]); await git(['commit', '-m', text]); return git(['rev-parse', 'HEAD']); };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const base = await add('base.txt', 'base');
  await git(['switch', '-c', 'feature']);
  const feature = await add('feature.txt', 'feature');
  await git(['switch', '-c', 'target', base]);
  const target = await add('target.txt', 'target');
  await git(['switch', 'main']);
  const request = async (action, source, destination, mainline = null) => ({ action, source, target: destination, mainline,
    head: { oid: await git(['rev-parse', 'HEAD']), branch: await git(['branch', '--show-current']) || null } });
  const execute = async req => runDrop({ cwd, log, request: req });
  const merged = await execute(await request('merge', local('feature', feature), local('target', target)));
  assert.equal(merged.ok, true, merged.message);
  assert.equal(await git(['branch', '--show-current']), 'target');
  assert.equal(await git(['rev-parse', 'main']), base, 'non-current target updated without changing main');
  assert.equal(await git(['rev-parse', 'feature']), feature);
  assert.equal(await readFile(path.join(cwd, 'feature.txt'), 'utf8'), 'feature');
  const mergeOid = await git(['rev-parse', 'HEAD']);

  await git(['switch', 'main']);
  const stale = await request('cherry-pick', commit(feature), local('target', target));
  assert.equal((await execute(stale)).notStarted, true, 'stale target rejected before checkout');
  assert.equal(await git(['branch', '--show-current']), 'main');
  const staleHead = await request('cherry-pick', commit(feature), local('main', base));
  await git(['switch', 'feature']);
  assert.equal((await execute(staleHead)).notStarted, true);
  await git(['switch', 'main']);
  await writeFile(path.join(cwd, 'dirty.txt'), 'keep');
  assert.equal((await execute(await request('cherry-pick', commit(feature), local('main', base)))).notStarted, true);
  await rm(path.join(cwd, 'dirty.txt'));
  const picked = await execute(await request('cherry-pick', commit(feature), local('main', base)));
  assert.equal(picked.ok, true, picked.message);
  const pickedOid = await git(['rev-parse', 'HEAD']);
  assert.equal((await execute(await request('revert', commit(feature), local('main', pickedOid)))).ok, true);
  assert.equal(await git(['ls-tree', '--name-only', 'HEAD']), 'base.txt');

  // A bare commit destination is explicitly detached, never an arbitrary branch.
  assert.equal((await execute(await request('cherry-pick', commit(feature), commit(target)))).ok, true);
  assert.equal(await git(['branch', '--show-current']), '');
  assert.equal(await git(['rev-parse', 'target']), mergeOid);
  await git(['switch', '-c', 'merge-pick', base]);
  await assert.rejects(() => execute({ action: 'cherry-pick', source: commit(mergeOid), target: local('merge-pick', base), head: { branch: 'merge-pick', oid: base }, mainline: null }), /mainline/);
  assert.equal((await execute(await request('cherry-pick', commit(mergeOid), local('merge-pick', base), 1))).ok, true);

  await git(['switch', '-c', 'replay', base]);
  const replay = await add('replay.txt', 'replay');
  await git(['switch', 'main']);
  assert.equal((await execute(await request('rebase', local('replay', replay), commit(target)))).ok, true);
  assert.equal(await git(['branch', '--show-current']), 'replay');
  assert.equal(await git(['rev-parse', 'HEAD^']), target);

  const bare = path.join(root, 'remote.git');
  await git(['init', '--bare', bare]); await git(['remote', 'add', 'team/upstream', bare]);
  await git(['push', 'team/upstream', 'main:refs/heads/published']);
  const published = await git(['rev-parse', 'refs/remotes/team/upstream/published']);
  const replayed = await git(['rev-parse', 'replay']);
  // Push main to its remote target succeeds even when cached tips agree.
  assert.equal((await execute(await request('push', local('main', published), remote('team/upstream/published', published)))).ok, true);
  await git(['branch', 'receiver', base]);
  const pull = await execute(await request('pull', remote('team/upstream/published', published), local('receiver', base)));
  assert.equal(pull.ok, true, pull.message);
  assert.equal(await git(['rev-parse', 'receiver']), published);
  assert.equal(await git(['branch', '--show-current']), 'receiver');
  const cancel = new AbortController(); cancel.abort();
  const cancelled = await runDrop({ cwd, log, signal: cancel.signal, request: await request('rebase', local('replay', replayed), commit(base)) });
  assert.equal(cancelled.cancelled, true);
  assert.equal(await git(['branch', '--show-current']), 'receiver', 'cancellation prevents checkout');

  await git(['switch', '-c', 'conflict-a', base]);
  const conflictA = await add('base.txt', 'side a');
  await git(['switch', '-c', 'conflict-b', base]);
  const conflictB = await add('base.txt', 'side b');
  const conflictRequest = await request('merge-no-ff', local('conflict-a', conflictA), local('conflict-b', conflictB));
  const conflict = await execute(conflictRequest);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.state.kind, 'merge');
  assert.deepEqual(conflict.state.conflicts, ['base.txt']);
  assert.equal((await execute(conflictRequest)).notStarted, true, 'ongoing merge blocks another drop action');
  await git(['merge', '--abort']);
  assert.equal(await git(['rev-parse', 'HEAD']), conflictB);
  console.log('drop: action matrix, validation, merge, cherry-pick, revert, mainline, rebase, pull/push and cancellation passed');
} finally { await rm(root, { recursive: true, force: true }); }
