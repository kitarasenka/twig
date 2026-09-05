import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { parseStatusV2 } from '../../main/git/status-parser.js';
import { RepositoryStore } from '../../main/store.js';
import { createRepositoryService } from '../../main/git/repository.js';

const directory = await mkdtemp(path.join(tmpdir(), 'twig-git-check-'));
try {
  const log = new CommandLog(directory);
  await log.load();
  const version = await runGit({ argv: ['--version'], cwd: directory, log, operation: 'Test Git availability' });
  assert.equal(version.code, 0);
  assert.deepEqual(version.argv.slice(0, 3), ['--no-pager', '-c', 'color.ui=false']);
  assert.match(version.stdout, /^git version /);
  assert.equal(version.cwd, directory);
  assert.match(version.startedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(version.ms >= 0);

  const init = await runGit({ argv: ['init', '--initial-branch=main'], cwd: directory, log, operation: 'Test repository setup' });
  assert.equal(init.code, 0);
  const status = await runGit({ argv: ['status', '--porcelain=v2', '--branch', '-z'], cwd: directory, log, operation: 'Test repository status' });
  assert.equal(status.code, 0);
  const parsed = parseStatusV2(status.stdout);
  assert.equal(parsed.branch.name, 'main');
  assert.equal(parsed.branch.unborn, true);

  const repositories = createRepositoryService({ log, store: new RepositoryStore(directory) });
  await repositories.load();
  const workspace = await repositories.add(directory);
  assert.equal(workspace.repositories.length, 1);
  assert.equal(workspace.activeId, workspace.repositories[0].id);
  assert.equal(workspace.repositories[0].available, true);
  assert.equal(workspace.repositories[0].status.branch.name, 'main');

  const failure = await runGit({ argv: ['rev-parse', '--verify', 'not-a-real-revision'], cwd: directory, log, operation: 'Test command failure' });
  assert.notEqual(failure.code, 0);
  assert.ok(failure.stderr || failure.stdout);

  const restored = new CommandLog(directory);
  await restored.load();
  const entries = restored.list();
  assert.equal(entries.length, 6);
  assert.equal(entries[0].state, 'finished');
  assert.equal(entries[0].argv[0], '--no-pager');
  assert.equal(entries.at(-1).code, failure.code);
  await assert.rejects(runGit({ argv: ['status', 1], cwd: directory, log }), /Invalid Git command/);
  console.log('Git executor checks passed: argv, output, errors, journal persistence, validation.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
