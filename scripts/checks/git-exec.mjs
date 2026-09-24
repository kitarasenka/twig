import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(version.argv.slice(0, 5), ['--no-pager', '-c', 'color.ui=false', '-c', 'log.showSignature=false']);
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

  // The journal is bounded on both axes. A single command cannot pour megabytes
  // into it (a history page or a blame easily would), and the file is rewritten
  // from the entries still kept, so it cannot grow without end — an 882 MB one
  // grew past V8's string limit and stopped the app from starting at all.
  const journalFile = path.join(directory, 'command-log.jsonl');
  const huge = 'x'.repeat(2 * 1024 * 1024);
  await log.start({ id: 'flood', argv: ['log'], cwd: directory, operation: 'Test output cap', startedAt: new Date().toISOString() });
  for (let index = 0; index < 4; index++) await log.output('flood', 'stdout', huge);
  await log.finish('flood', { code: 0, ms: 1 });
  const flooded = log.list().at(-1);
  assert.ok(flooded.stdout.length < 300 * 1024, `the kept output is capped: ${flooded.stdout.length}`);
  assert.match(flooded.stdout, /output truncated by 🌱 Twig/);
  assert.ok((await stat(journalFile)).size < 2 * 1024 * 1024, 'the dropped chunks never reached the file');

  const bounded = new CommandLog(directory);
  await bounded.load();
  assert.deepEqual(bounded.list().map(entry => entry.id), log.list().map(entry => entry.id), 'a compacted journal replays into the same entries');
  assert.equal(bounded.list().at(-1).stdout, flooded.stdout);
  assert.equal(bounded.list().at(-1).code, 0);

  // A journal whose lines outnumber what the console keeps loads and shrinks.
  const overflow = [];
  for (let index = 0; index < 2400; index++) {
    overflow.push(JSON.stringify({ type: 'start', entry: { id: `old-${index}`, argv: ['status'], cwd: directory, operation: 'Old', startedAt: new Date().toISOString() } }));
    overflow.push(JSON.stringify({ type: 'finish', id: `old-${index}`, result: { code: 0, ms: 1 } }));
  }
  await writeFile(journalFile, `${overflow.join('\n')}\n`, 'utf8');
  const before = (await stat(journalFile)).size;
  const trimmed = new CommandLog(directory);
  await trimmed.load();
  assert.equal(trimmed.list().length, 2000);
  assert.equal(trimmed.list()[0].id, 'old-400');
  assert.ok((await stat(journalFile)).size < before, 'loading compacts the file down to what it kept');

  console.log('Git executor checks passed: argv, output, errors, journal persistence, output cap, compaction, validation.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
