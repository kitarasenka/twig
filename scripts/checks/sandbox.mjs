import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { ensureSandbox, resetSandbox, runSeed, sandboxPlan, SEED_VERSION } from '../../main/git/sandbox.js';

// The plan is pure data: assert its shape without touching Git.
const plan = sandboxPlan();
assert.deepEqual(sandboxPlan(), plan, 'sandboxPlan must be deterministic');
assert.equal(plan.branch, 'main');
assert.ok(plan.commits.length >= 10);
assert.ok(plan.commits[0].daysAgo > 200, 'the root commit must be well backdated for the age ramp');
assert.ok(plan.commits.at(-1).daysAgo <= 3, 'the tip must be recent');
const keys = new Set();
for (const commit of plan.commits) {
  assert.equal(typeof commit.message, 'string');
  assert.ok(commit.message && !/[\n]/.test(commit.message));
  assert.ok(['maya', 'alex', 'sam'].includes(commit.author));
  if (commit.from) assert.ok(keys.has(commit.from), `${commit.key} branches from an earlier commit`);
  for (const relative of Object.keys(commit.write || {})) {
    assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'), `${relative} stays inside the tree`);
  }
  keys.add(commit.key);
}
assert.ok(plan.commits.some(c => c.merge), 'the history has a merge commit');
assert.deepEqual(plan.commits.filter(c => c.tag).map(c => c.tag), ['v0.0.1', 'v0.0.2']);
assert.ok(plan.commits.some(c => c.branch === 'feature/command-log'));
assert.ok(plan.commits.some(c => c.branch === 'feature/repository-tabs'));

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-sandbox-'));
try {
  const log = new CommandLog(root); await log.load();
  const dir = path.join(root, 'demo-sandbox');
  const remoteDir = path.join(root, 'demo-sandbox-remote.git');
  const git = async (argv) => {
    const result = await runGit({ argv, cwd: dir, log });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trimEnd();
  };

  await runSeed({ dir, remoteDir, log });

  assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n');
  assert.deepEqual(branches.sort(), ['feature/command-log', 'feature/repository-tabs', 'main']);
  for (const tag of ['v0.0.1', 'v0.0.2']) await git(['rev-parse', '--verify', `refs/tags/${tag}`]);
  const parents = await git(['rev-list', '--merges', '--count', 'HEAD']);
  assert.ok(Number(parents) >= 1, 'a merge commit is reachable from HEAD');

  assert.equal(await git(['rev-parse', '--verify', 'refs/remotes/origin/main']) !== '', true);
  const ahead = await git(['rev-list', '--count', 'origin/main..main']);
  assert.equal(ahead, '1', 'local main is one commit ahead of the demo remote');

  assert.equal((await git(['stash', 'list'])).split('\n').filter(Boolean).length, 1);
  const status = await git(['status', '--porcelain']);
  assert.match(status, /^ M README\.md$/m, 'README.md is left with an unstaged edit');
  assert.match(status, /^\?\? notes\.todo$/m, 'notes.todo is left untracked');

  const rootDate = await git(['log', '--reverse', '--format=%at', '--max-parents=0']);
  assert.ok(Date.now() / 1000 - Number(rootDate.split('\n')[0]) > 200 * 86400, 'root commit is backdated');

  const subjectsBefore = await git(['log', '--format=%s', 'main']);
  await resetSandbox({ dir, remoteDir, log });
  assert.equal(await git(['log', '--format=%s', 'main']), subjectsBefore, 'reset reproduces the same history');
  assert.equal(await git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.equal((await git(['stash', 'list'])).split('\n').filter(Boolean).length, 1);

  // ensureSandbox only re-seeds when the marker is missing or stale.
  const markerFile = path.join(root, 'demo-sandbox.json');
  await ensureSandbox({ dir, remoteDir, markerFile, log });
  const seededAt = (await stat(path.join(dir, '.git'))).mtimeMs;
  await ensureSandbox({ dir, remoteDir, markerFile, log });
  assert.equal((await stat(path.join(dir, '.git'))).mtimeMs, seededAt, 'a current marker skips re-seeding');
  assert.ok(SEED_VERSION >= 1);
  assert.ok((await readdir(dir)).includes('workspace.js'));

  console.log('Sandbox checks passed: plan shape, seed history, branches, tags, demo remote, stash, dirty tree, deterministic reset, marker fast-path.');
} finally {
  await rm(root, { recursive: true, force: true });
}
