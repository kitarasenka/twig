import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { runStep } from '../../main/automation/exec.js';
import { runAction } from '../../main/automation/actions.js';
import { triggerPipeline, collectAddedLines, stepReason } from '../../main/automation/engine.js';
import { fileWords, readRepoConfig } from '../../main/automation/discovery.js';
import { commandsIn, validatePipeline } from '../../renderer/src/features/automations/schema.js';
import { AutomationsStore } from '../../main/automations-store.js';
import { AutomationRunsStore } from '../../main/automation-runs-store.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-automation-'));
const node = process.execPath;
try {
  const log = new CommandLog(root);
  await log.load();
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);

  // --- runStep: exit codes, output, timeout, cancel ----------------------
  let step = await runStep({ argv: [node, '-e', 'console.log("hi"); process.exit(0)'], cwd, log });
  assert.equal(step.code, 0);
  assert.match(step.stdout, /hi/);

  step = await runStep({ argv: [node, '-e', 'console.error("boom"); process.exit(3)'], cwd, log });
  assert.equal(step.code, 3);
  assert.match(step.stderr, /boom/);

  step = await runStep({ argv: [node, '-e', 'setTimeout(() => {}, 10000)'], cwd, log, timeoutMs: 400 });
  assert.ok(step.timedOut, 'a long step is killed by the timeout');

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  step = await runStep({ argv: [node, '-e', 'setTimeout(() => {}, 10000)'], cwd, log, signal: controller.signal });
  assert.ok(step.cancelled, 'an aborted step reports cancelled');

  step = await runStep({ argv: ['definitely-not-a-real-binary-xyz'], cwd, log });
  assert.notEqual(step.code, 0, 'a missing executable fails, not throws');
  assert.match(step.stderr, /ENOENT/);

  // --- runAction: script path guard ------------------------------------
  await writeFile(path.join(cwd, 'ok.sh'), '#!/bin/sh\necho ran\n');
  await chmod(path.join(cwd, 'ok.sh'), 0o755);
  let result = await runAction({ action: { type: 'script', path: 'ok.sh', args: '' }, context: {}, cwd, log, env: {}, timeoutMs: 5000 });
  assert.equal(result.status, process.platform === 'win32' ? 'failed' : 'passed');
  result = await runAction({ action: { type: 'script', path: '../escape.sh', args: '' }, context: {}, cwd, log, env: {}, timeoutMs: 5000 });
  assert.equal(result.status, 'failed');
  assert.match(result.detail, /outside the repository/);

  // --- runAction: pure checks ---------------------------------------
  assert.equal((await runAction({ action: { type: 'checkBranch', block: ['main'] }, context: { branch: 'main' }, cwd, log })).status, 'failed');
  assert.equal((await runAction({ action: { type: 'checkBranch', block: ['main'] }, context: { branch: 'feature/x' }, cwd, log })).status, 'passed');
  const scan = await runAction({ action: { type: 'secretScan' }, context: { addedLines: [{ file: 'a.js', text: 'const k = "AKIAIOSFODNN7EXAMPLE"' }] }, cwd, log });
  assert.equal(scan.status, 'failed');
  assert.equal(scan.findings.length, 1);

  assert.deepEqual(collectAddedLines('--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+added line\n'), [{ file: 'x', text: 'added line' }]);
  // Hunks are counted: an added line that reads like a header is still an added line.
  assert.deepEqual(collectAddedLines('--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+++ b/fake\n+++token=abc\n'), [{ file: 'x', text: '++ b/fake\n++token=abc' }]);
  assert.deepEqual(collectAddedLines('--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n'), [], 'a deleted file adds nothing');
  assert.deepEqual(collectAddedLines('+++ "b/a\\tb \\"q\\" \\320\\266.env"\n@@ -0,0 +1 @@\n+x\n'), [{ file: 'a\tb "q" ж.env', text: 'x' }], 'a quoted name is read back');
  assert.deepEqual(collectAddedLines('+++ b/with space.txt\t\n@@ -0,0 +1 @@\n+x\n'), [{ file: 'with space.txt', text: 'x' }]);

  // --- engine: a real repo, a real staged file, a blocking pipeline -----
  const env = { GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = async argv => {
    const r = await runGit({ argv, cwd, log, env });
    assert.equal(r.code, 0, `${argv.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'a@b.c']);
  await git(['config', 'user.name', 'Test']);
  await writeFile(path.join(cwd, 'a.ts'), 'export const x = 1;\n');
  await git(['add', 'a.ts']);

  const automations = new AutomationsStore(root);
  const runs = new AutomationRunsStore(root);
  await Promise.all([automations.load(), runs.load()]);
  await automations.saveConfig(cwd, {
    pipelines: [{
      event: 'pre-commit', name: 'gate', onFailure: 'block',
      conditions: [{ type: 'changedFiles', glob: '**/*.ts' }],
      actions: [
        { type: 'command', name: 'pass', command: 'node -e process.exit(0)' },
        { type: 'command', name: 'fail', command: 'node -e process.exit(1)' },
        { type: 'command', name: 'never', command: 'node -e process.exit(0)' }
      ]
    }]
  });

  const outcome = await triggerPipeline({ event: 'pre-commit', repoId: cwd, cwd, log, automations, runs });
  assert.equal(outcome.blocked, true, 'a failed blocking step blocks the commit');
  assert.deepEqual(outcome.steps.map(s => s.status), ['passed', 'failed'], 'stops on the first failure');

  const history = runs.list(cwd);
  assert.equal(history.length, 1);
  assert.equal(history[0].result, 'blocked');

  // A condition that does not match is skipped entirely.
  await automations.saveConfig(cwd, {
    pipelines: [{ event: 'pre-commit', name: 'skipme', conditions: [{ type: 'branch', pattern: 'release/*' }], actions: [{ type: 'command', command: 'node -e process.exit(1)' }] }]
  });
  const skipped = await triggerPipeline({ event: 'pre-commit', repoId: cwd, cwd, log, automations, runs });
  assert.equal(skipped.ran, false, 'a pipeline whose conditions fail does not run');

  // --- Scan for secrets: a person's Git settings, odd names and failures ---
  const TOKEN = ['ghp', '_', 'a1B2c3D4e5'.repeat(4)].join('');
  const sh = (folder, ...argv) => execFileSync('git', argv, { cwd: folder, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let cases = 0;
  async function scanRepository(event = 'pre-commit') {
    const folder = path.join(root, `scan-${++cases}`);
    await mkdir(folder);
    sh(folder, 'init', '-q', '-b', 'main');
    sh(folder, 'config', 'user.name', 'A'); sh(folder, 'config', 'user.email', 'a@example.com'); sh(folder, 'config', 'commit.gpgSign', 'false');
    await writeFile(path.join(folder, 'README.md'), 'one\ntwo\n');
    sh(folder, 'add', '-A'); sh(folder, 'commit', '-qm', 'init');
    const store = new AutomationsStore(path.join(folder, '.git', 'twig'));
    const history = new AutomationRunsStore(path.join(folder, '.git', 'twig'));
    await Promise.all([store.load(), history.load()]);
    await store.saveConfig(folder, { pipelines: [{ event, name: 'scan', onFailure: 'block', actions: [{ type: 'secretScan' }] }] });
    return { folder, fire: () => triggerPipeline({ event, repoId: folder, cwd: folder, log, automations: store, runs: history }) };
  }
  const leaks = [
    ['the plain case', async folder => { await writeFile(path.join(folder, 'a.txt'), `t=${TOKEN}\n`); }],
    ['diff.noprefix', async folder => { sh(folder, 'config', 'diff.noprefix', 'true'); await writeFile(path.join(folder, 'a.txt'), `t=${TOKEN}\n`); }],
    ['diff.mnemonicPrefix', async folder => { sh(folder, 'config', 'diff.mnemonicPrefix', 'true'); await writeFile(path.join(folder, 'a.txt'), `t=${TOKEN}\n`); }],
    ['a non-ASCII name', async folder => { await writeFile(path.join(folder, 'секрет.env'), `t=${TOKEN}\n`); }],
    ['a name with a tab', async folder => { await writeFile(path.join(folder, 'a\tb.env'), `t=${TOKEN}\n`); }],
    ['a name with a quote', async folder => { await writeFile(path.join(folder, 'a"b.env'), `t=${TOKEN}\n`); }],
    ['a name with a space', async folder => { await writeFile(path.join(folder, 'a b.env'), `t=${TOKEN}\n`); }],
    ['-diff in .gitattributes', async folder => { await writeFile(path.join(folder, '.gitattributes'), '*.env -diff\n'); await writeFile(path.join(folder, 'a.env'), `t=${TOKEN}\n`); }],
    ['a NUL before the token', async folder => { await writeFile(path.join(folder, 'a.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(`\nt=${TOKEN}\n`)])); }],
    ['a line that reads like a diff header', async folder => { await writeFile(path.join(folder, 'a.txt'), `++t=${TOKEN}\n`); }]
  ];
  for (const [name, plant] of leaks) {
    const scan = await scanRepository();
    await plant(scan.folder);
    sh(scan.folder, 'add', '-A');
    const verdict = await scan.fire();
    assert.equal(verdict.blocked, true, `${name}: ${verdict.steps.map(item => item.detail)}`);
    assert.equal(verdict.steps[0].findings.length, 1, name);
  }
  {
    const scan = await scanRepository();
    const mark = path.join(root, 'external-ran');
    await writeFile(path.join(root, 'external.sh'), `#!/bin/sh\ntouch "${mark}"\n`); await chmod(path.join(root, 'external.sh'), 0o755);
    sh(scan.folder, 'config', 'diff.external', path.join(root, 'external.sh'));
    await writeFile(path.join(scan.folder, 'a.txt'), `t=${TOKEN}\n`);
    sh(scan.folder, 'add', '-A');
    assert.equal((await scan.fire()).blocked, true);
    await assert.rejects(stat(mark), 'the scan runs no external diff tool');
  }

  // Nothing to find is a pass, not a failure: no added text, a binary file, a rename, a mode, an empty file.
  for (const [name, change] of [
    ['a deletion', async folder => { sh(folder, 'rm', '-q', 'README.md'); }],
    ['a deleted line', async folder => { await writeFile(path.join(folder, 'README.md'), 'one\n'); }],
    ['a binary file', async folder => { await writeFile(path.join(folder, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 13, 0xff, 0xfe, 0])); }],
    ['a rename', async folder => { sh(folder, 'mv', 'README.md', 'READ.md'); }],
    ['a mode change', async folder => { await chmod(path.join(folder, 'README.md'), 0o755); }],
    ['an empty file', async folder => { await writeFile(path.join(folder, 'empty'), ''); }],
    ['a submodule shown as a log', async folder => {
      sh(folder, 'config', 'diff.submodule', 'log');
      sh(folder, 'update-index', '--add', '--cacheinfo', `160000,${sh(folder, 'rev-parse', 'HEAD')},lib`);
    }]
  ]) {
    const scan = await scanRepository();
    await change(scan.folder);
    sh(scan.folder, 'add', '-A');
    const verdict = await scan.fire();
    assert.deepEqual(verdict.steps.map(item => item.status), ['passed'], `${name}: ${verdict.steps.map(item => item.detail)}`);
  }

  // What could not be read fails the step: a passed scan means it was read.
  {
    const scan = await scanRepository();
    await writeFile(path.join(scan.folder, 'a.txt'), `t=${TOKEN}\n`);
    sh(scan.folder, 'add', '-A');
    const blob = sh(scan.folder, 'rev-parse', ':a.txt');
    await unlink(path.join(scan.folder, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
    await unlink(path.join(scan.folder, 'a.txt'));
    const verdict = await scan.fire();
    assert.equal(verdict.blocked, true);
    assert.match(verdict.steps[0].detail, /nothing was scanned/);
  }
  {
    const scan = await scanRepository();
    await writeFile(path.join(scan.folder, 'huge.txt'), 'x\n'.repeat(36 * 1024 * 1024));
    sh(scan.folder, 'add', '-A');
    const verdict = await scan.fire();
    assert.equal(verdict.blocked, true);
    assert.match(verdict.steps[0].detail, /too large to scan/);
  }

  // A push of a branch nothing tracks yet: measured from where it left the main line.
  {
    const scan = await scanRepository('pre-push');
    const remote = path.join(root, `scan-remote-${cases}.git`);
    sh(root, 'init', '-q', '--bare', '-b', 'main', remote);
    sh(scan.folder, 'remote', 'add', 'origin', remote);
    sh(scan.folder, 'push', '-q', '-u', 'origin', 'main');
    sh(scan.folder, 'switch', '-q', '-c', 'new-branch');
    await writeFile(path.join(scan.folder, 'a.txt'), `t=${TOKEN}\n`);
    sh(scan.folder, 'add', '-A'); sh(scan.folder, 'commit', '-qm', 'x');
    assert.equal((await scan.fire()).blocked, true, 'a new branch is scanned');
    sh(scan.folder, 'switch', '-q', 'main');
    sh(scan.folder, 'branch', '-qD', 'new-branch');
    sh(scan.folder, 'switch', '-q', '-c', 'clean-branch');
    await writeFile(path.join(scan.folder, 'b.txt'), 'plain\n');
    sh(scan.folder, 'add', '-A'); sh(scan.folder, 'commit', '-qm', 'y');
    assert.deepEqual((await scan.fire()).steps.map(item => item.status), ['passed']);
  }
  {
    const scan = await scanRepository('pre-push');
    await writeFile(path.join(scan.folder, 'README.md'), `t=${TOKEN}\n`);
    sh(scan.folder, 'add', '-A'); sh(scan.folder, 'commit', '-qm', 'x');
    assert.equal((await scan.fire()).blocked, true, 'no remote at all: all of it is new');
  }

  // --- .twig/hooks.json: what runs is what was hashed and shown --------------
  const pipeline = actions => ({ id: 'p1', name: 'check', event: 'pre-commit', enabled: true, onFailure: 'block', conditions: [], actions });
  async function trustedRepository(actions) {
    const folder = path.join(root, `trust-${++cases}`);
    await mkdir(path.join(folder, '.twig'), { recursive: true });
    sh(folder, 'init', '-q', '-b', 'main');
    await writeFile(path.join(folder, '.twig/hooks.json'), JSON.stringify({ pipelines: [pipeline(actions)] }));
    const store = new AutomationsStore(path.join(folder, '.git', 'twig'));
    const history = new AutomationRunsStore(path.join(folder, '.git', 'twig'));
    await Promise.all([store.load(), history.load()]);
    return {
      folder,
      trust: async () => {
        const repo = await readRepoConfig(folder);
        await store.setTrust(folder, { digest: repo.digest, approvedCommands: commandsIn(repo.config), enabledRepoPipelineIds: repo.config.pipelines.map(item => item.id) });
        return repo;
      },
      fire: () => triggerPipeline({ event: 'pre-commit', repoId: folder, cwd: folder, log, automations: store, runs: history })
    };
  }
  // A path with a space at its end names another file than the one shown: the whole file is refused.
  {
    const repo = await trustedRepository([{ id: 'a', type: 'script', path: 'check.sh ', args: '' }]);
    await writeFile(path.join(repo.folder, 'check.sh'), '#!/bin/sh\n');
    await writeFile(path.join(repo.folder, 'check.sh '), '#!/bin/sh\n');
    const read = await readRepoConfig(repo.folder);
    assert.equal(read.config, null);
    assert.match(read.error, /starts or ends with a space/);
    assert.equal((await repo.fire()).ran, false);
    assert.equal(validatePipeline({ name: 'x', actions: [{ type: 'script', path: ' a.sh', args: '' }] }).valid, false, 'nor can a pipeline be saved so');
  }
  // Pipelines that could not be saved in 🌱 Twig do not run from the file either.
  for (const actions of [[{ type: 'script', path: '../outside.sh' }], [{ type: 'command', command: 'a; b' }], []]) {
    assert.equal((await readRepoConfig((await trustedRepository(actions)).folder)).config, null, JSON.stringify(actions));
  }
  // A script past 4 MiB is hashed whole.
  {
    const repo = await trustedRepository([{ id: 'a', type: 'script', path: 'big.sh', args: '' }]);
    const pad = '#'.repeat(5 * 1024 * 1024);
    await writeFile(path.join(repo.folder, 'big.sh'), `#!/bin/sh\nexit 0\n${pad}\n`); await chmod(path.join(repo.folder, 'big.sh'), 0o755);
    const { digest } = await repo.trust();
    assert.deepEqual((await repo.fire()).steps.map(item => item.status), ['passed'], 'an approved script runs');
    await writeFile(path.join(repo.folder, 'big.sh'), `#!/bin/sh\nexit 1\n${pad}\n`);
    assert.notEqual((await readRepoConfig(repo.folder)).digest, digest, 'same length, other bytes');
    assert.equal((await repo.fire()).ran, false, 'and it no longer runs');
  }
  // A file a command names is pinned like a script.
  {
    assert.deepEqual(fileWords({ type: 'command', command: 'node --require=./a.js b.js --flag -x' }), ['./a.js', 'b.js']);
    assert.deepEqual(fileWords({ type: 'script', path: 'x.sh', args: 'c.txt' }), ['c.txt']);
    assert.deepEqual(fileWords({ type: 'custom', command: 'a; b' }), [], 'what does not parse is refused elsewhere');
    const repo = await trustedRepository([{ id: 'a', type: 'command', command: 'sh tools/lint.sh' }]);
    await mkdir(path.join(repo.folder, 'tools'));
    await writeFile(path.join(repo.folder, 'tools/lint.sh'), 'exit 0\n');
    const { digest } = await repo.trust();
    assert.deepEqual((await repo.fire()).steps.map(item => item.status), ['passed']);
    await writeFile(path.join(repo.folder, 'tools/lint.sh'), 'exit 1\n');
    assert.notEqual((await readRepoConfig(repo.folder)).digest, digest);
    assert.equal((await repo.fire()).ran, false);
  }
  // A command that names no file keeps the digest of the JSON alone: approvals of `npm test` stay valid.
  {
    const repo = await trustedRepository([{ id: 'a', type: 'command', command: 'npm test' }]);
    const read = await readRepoConfig(repo.folder);
    assert.equal(read.digest, createHash('sha256').update(read.text, 'utf8').digest('hex'));
    await writeFile(path.join(repo.folder, 'test'), 'a file named like the word\n');
    assert.notEqual((await readRepoConfig(repo.folder)).digest, read.digest, 'and a file appearing under that word is seen');
  }

  // --- what a step printed is stored and quoted without credentials ----------
  {
    const dir = path.join(root, 'runs');
    await mkdir(dir);
    const url = `https://u:${TOKEN}@example.invalid/x.git`;
    await writeFile(path.join(dir, 'automation-runs.json'), JSON.stringify({ repo: [{ id: 'old', steps: [{ name: 'old', stdout: url, stderr: '', detail: null }] }] }), { mode: 0o644 });
    const store = new AutomationRunsStore(dir);
    await store.load();
    assert.ok(!(await readFile(path.join(dir, 'automation-runs.json'), 'utf8')).includes(TOKEN), 'a token stored by an older version is gone after a load');
    assert.equal(store.get('repo', 'old').steps[0].stdout, 'https://***@example.invalid/x.git');
    await store.append('repo', { id: 'new', steps: [{ name: 'step', stdout: `token ${TOKEN}`, stderr: url, detail: url }] });
    const file = await readFile(path.join(dir, 'automation-runs.json'), 'utf8');
    assert.ok(!file.includes(TOKEN));
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'automation-runs.json'))).mode & 0o777, 0o600);
    const printed = await runAction({ action: { type: 'command', command: `node -e console.log(process.argv[1]) ${url}` }, context: {}, cwd, log, env: {}, timeoutMs: 5000 });
    assert.ok(!printed.stdout.includes(TOKEN), 'the step result itself is clean');
    assert.ok(!stepReason([{ name: 'x', status: 'failed', stderr: url, stdout: '' }]).includes(TOKEN), 'and so is what an agent is told');
    await store.clear();
    assert.deepEqual(store.list('repo'), []);
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'automation-runs.json'), 'utf8')), {});
    assert.ok((await readdir(dir)).every(name => !name.endsWith('.tmp')));
  }

  console.log('Automation run checks passed: step exit/output/timeout/cancel, script path guard, pure checks, engine sequencing on a real repo, secret scan against Git settings and odd names, failure to read fails, trust digest over everything that runs, clean stored output.');
} finally { await rm(root, { recursive: true, force: true }); }
