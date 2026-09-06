import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { runStep } from '../../main/automation/exec.js';
import { runAction } from '../../main/automation/actions.js';
import { triggerPipeline, collectAddedLines } from '../../main/automation/engine.js';
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

  console.log('Automation run checks passed: step exit/output/timeout/cancel, script path guard, pure checks, engine sequencing on a real repo.');
} finally { await rm(root, { recursive: true, force: true }); }
