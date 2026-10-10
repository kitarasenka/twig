import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
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
  assert.deepEqual(version.argv.slice(0, 7), ['--no-pager', '-c', 'color.ui=false', '-c', 'log.showSignature=false', '-c', 'core.fsmonitor=false']);
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
  await restored.settled(); // its compaction runs behind the load
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
  await bounded.settled();
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
  await trimmed.settled();
  assert.ok((await stat(journalFile)).size < before, 'loading compacts the file down to what it kept');

  // 🌱 Twig's own reads keep a shorter output, leave it out of the list and the
  // live events (it is read when the entry is opened); a person's commands
  // stream whole, and their finish does not send the output a second time.
  const quietDir = path.join(directory, 'quiet');
  const quiet = new CommandLog(quietDir);
  await quiet.load();
  const events = [];
  quiet.onChange(event => events.push(event));
  const now = new Date().toISOString();
  const page = 'y'.repeat(100 * 1024);
  await quiet.start({ id: 'read', argv: ['log'], cwd: directory, operation: 'Read commit history', startedAt: now });
  await quiet.output('read', 'stdout', page);
  await quiet.finish('read', { code: 0, ms: 2, stdout: page, stderr: '' });
  const read = quiet.list().at(-1);
  assert.equal(read.background, true);
  assert.equal(read.stdout, '', 'the list leaves an automatic read\'s output out');
  assert.equal(read.lazy, true, 'and says there is some');
  const readOutput = quiet.outputOf('read').stdout;
  assert.ok(readOutput.startsWith('y'.repeat(32 * 1024)) && readOutput.endsWith('… output truncated by 🌱 Twig at 32 KB.\n'), 'kept to 32 KB, with the notice');
  assert.deepEqual(events.map(event => event.type), ['start', 'finish'], 'no output events for an automatic read');
  assert.equal(events.at(-1).result.lazy, true);
  assert.ok(!('stdout' in events.at(-1).result));
  events.length = 0;
  await quiet.start({ id: 'typed', argv: ['log', '-1'], cwd: directory, operation: 'Console command', startedAt: now });
  await quiet.output('typed', 'stdout', 'hello\n');
  await quiet.finish('typed', { code: 0, ms: 1, stdout: 'hello\n', stderr: '' });
  assert.deepEqual(events.map(event => event.type), ['start', 'output', 'finish'], 'a typed command streams');
  assert.ok(!('stdout' in events.at(-1).result), 'its finish does not repeat what was streamed');
  assert.equal(quiet.list().at(-1).stdout, 'hello\n');
  // The truncation notice survives the finish (the whole output used to replace
  // the clipped stream and lose it) and a restart.
  const long = 'z'.repeat(300 * 1024);
  await quiet.start({ id: 'long', argv: ['log'], cwd: directory, operation: 'Console command', startedAt: now });
  await quiet.output('long', 'stdout', long);
  await quiet.finish('long', { code: 0, ms: 1, stdout: long, stderr: '' });
  assert.ok(quiet.list().at(-1).stdout.endsWith('… output truncated by 🌱 Twig at 256 KB.\n'), 'the notice is kept after the finish');
  // A credential split across two chunks escapes the per-chunk redaction; the
  // finish redacts the whole and rewrites the file, so no piece stays in it.
  await quiet.start({ id: 'cred', argv: ['fetch'], cwd: directory, operation: 'Console command', startedAt: now });
  await quiet.output('cred', 'stderr', "fatal: unable to access 'https://ghp_secr");
  await quiet.output('cred', 'stderr', "et@github.com/a/b/'\n");
  await quiet.finish('cred', { code: 128, ms: 1, stdout: '', stderr: "fatal: unable to access 'https://ghp_secret@github.com/a/b/'\n" });
  assert.ok(!quiet.list().at(-1).stderr.includes('ghp_'), 'the kept stderr is the redacted whole');
  await quiet.settled();
  assert.ok(!(await readFile(path.join(quietDir, 'command-log.jsonl'), 'utf8')).includes('ghp_secr'), 'and the file holds no piece of it');
  const reread = new CommandLog(quietDir);
  await reread.load();
  assert.ok(reread.list().find(entry => entry.id === 'long').stdout.endsWith('at 256 KB.\n'), 'the notice after a restart too');
  assert.equal(reread.outputOf('read').stdout, readOutput);

  // The journal on disk is best effort: a write that fails (here the file is a
  // folder) does not stop the journal in memory, nor the git commands after it.
  const brokenDir = path.join(directory, 'broken');
  const broken = new CommandLog(brokenDir);
  await broken.load();
  await broken.settled();
  await rm(path.join(brokenDir, 'command-log.jsonl'), { force: true });
  await mkdir(path.join(brokenDir, 'command-log.jsonl'));
  const errorLog = console.error;
  console.error = () => {};
  try {
    for (let index = 0; index < 2; index++) {
      assert.equal((await runGit({ argv: ['--version'], cwd: directory, log: broken, operation: 'Test after a failed write' })).code, 0, `command ${index + 1} runs`);
    }
  } finally { console.error = errorLog; }
  assert.equal(broken.list().length, 2, 'both are in the journal in memory');

  // No optional locks: a status read of a repository whose files were touched
  // must not rewrite the index (that takes index.lock, and a person's own
  // `git add` in a terminal fails meanwhile). Plain Git does rewrite it here,
  // which is what makes the first half meaningful.
  const locked = path.join(directory, 'optional-locks');
  await mkdir(locked);
  const plainEnv = { ...process.env };
  delete plainEnv.GIT_OPTIONAL_LOCKS; // an empty value would read as "off" too
  const plain = args => spawnSync('git', args, { cwd: locked, encoding: 'utf8', env: plainEnv });
  plain(['init', '-q', '--initial-branch=main']);
  await writeFile(path.join(locked, 'tracked.txt'), 'content\n');
  plain(['add', 'tracked.txt']);
  plain(['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'one']);
  const touch = () => utimes(path.join(locked, 'tracked.txt'), new Date(Date.now() + 120000), new Date(Date.now() + 120000));
  const index = () => readFile(path.join(locked, '.git', 'index'));
  await touch();
  const indexBefore = await index();
  assert.equal((await runGit({ argv: ['status', '--porcelain=v2', '--branch', '-z'], cwd: locked, log, operation: 'Test status without optional locks' })).code, 0);
  assert.deepEqual(await index(), indexBefore, '🌱 Twig\'s status read leaves the index alone');
  plain(['status', '--porcelain']);
  assert.notDeepEqual(await index(), indexBefore, 'plain git status refreshes the index here, so the read above really skipped it');

  console.log('Git executor checks passed: argv, output, errors, journal persistence, output cap, compaction, validation, no optional locks, quiet automatic reads, kept notices, split credentials, failed writes.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
