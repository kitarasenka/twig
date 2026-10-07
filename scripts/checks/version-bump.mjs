import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { createCommit } from '../../main/git/commit-ops.js';
import { UndoService } from '../../main/undo.js';
import { AutomationsStore } from '../../main/automations-store.js';
import { AutomationRunsStore } from '../../main/automation-runs-store.js';
import { createBumper, commitWithBump } from '../../main/automation/bump.js';
import { createCommitProposals } from '../../main/mcp/commit-proposal.js';
import {
  BUMP_CHOICES, LOCK_PATHS, bumpLabel, bumpTargets, findStringValue, nextVersion, nextVersions, replaceStringValue, validBumpPath
} from '../../renderer/src/features/automations/version-bump.js';
import { normalizePipeline, validatePipeline } from '../../renderer/src/features/automations/schema.js';
import { TEMPLATES } from '../../renderer/src/features/automations/templates.js';

// --- the text edit ---------------------------------------------------------------------------
assert.deepEqual(BUMP_CHOICES, ['none', 'patch', 'minor', 'major']);
assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
assert.equal(nextVersion('0.9.9', 'patch'), '0.9.10');
for (const odd of ['1.2', '1.2.3-beta.1', 'v1.2.3', '', null]) assert.equal(nextVersion(odd, 'patch'), null, String(odd));
assert.equal(nextVersion('1.2.3', 'none'), null);
assert.deepEqual(nextVersions('0.15.0'), { patch: '0.15.1', minor: '0.16.0', major: '1.0.0' });

const pkg = '{\r\n\t"name": "garden",\r\n\t"version": "1.2.3",\r\n\t"dependencies": {\r\n\t\t"version": "9.9.9",\r\n\t\t"x": "^1.2.3"\r\n\t},\r\n\t"note": "\\"version\\": \\"1.2.3\\""\r\n}\r\n';
{
  const bumped = replaceStringValue(pkg, ['version'], '1.2.3', '1.3.0');
  assert.equal(bumped, pkg.replace('"version": "1.2.3"', '"version": "1.3.0"'), 'only the root version changes; tabs, CRLF and the rest stay');
  assert.equal(replaceStringValue(pkg, ['version'], '1.0.0', '1.3.0'), null, 'a version that is not the expected one is not overwritten');
  assert.equal(findStringValue(pkg, ['dependencies', 'version']).value, '9.9.9');
  assert.equal(findStringValue('{"a": [1, {"version": "x"}], "version": "2.0.0"}', ['version']).value, '2.0.0', 'arrays are skipped');
  for (const broken of ['{"version": "1.2.3"', '{"version": 1}', 'not json', '{"version": "1.2.3"} trailing', '']) assert.equal(findStringValue(broken, ['version']), null, broken);
  assert.equal(findStringValue('﻿{"version": "1.0.0"}', ['version']).value, '1.0.0', 'a byte-order mark is fine');
}
const lock = `${JSON.stringify({ name: 'garden', version: '1.2.3', lockfileVersion: 3, requires: true,
  packages: { '': { name: 'garden', version: '1.2.3', dependencies: { a: '^1.2.3' } }, 'node_modules/a': { version: '1.2.3' } } }, null, 2)}\n`;
{
  let text = lock;
  for (const keys of LOCK_PATHS) text = replaceStringValue(text, keys, '1.2.3', '1.2.4');
  assert.equal(JSON.parse(text).version, '1.2.4');
  assert.equal(JSON.parse(text).packages[''].version, '1.2.4');
  assert.equal(JSON.parse(text).packages['node_modules/a'].version, '1.2.3', 'a dependency of the same version is not touched');
  assert.equal(text.split('\n').filter((line, index) => line !== lock.split('\n')[index]).length, 2, 'exactly two lines changed');
}
assert.deepEqual(bumpTargets({ target: 'file', path: 'package.json' }, ['src/a.js']), ['package.json']);
assert.deepEqual(bumpTargets({ target: 'modules' }, ['modules/b/x.js', 'modules/a/y/z.js', 'server/x.js', 'modules/b/package.json', 'modules']), ['modules/a/package.json', 'modules/b/package.json']);
for (const ok of ['package.json', 'apps/web/package.json']) assert.ok(validBumpPath(ok), ok);
for (const bad of ['../package.json', '/package.json', 'package.jsonx', 'a//package.json', 'x\\package.json', 'apps/../package.json', '']) assert.ok(!validBumpPath(bad), bad);
assert.equal(bumpLabel({ targets: [{ path: 'package.json', current: '1.2.3', next: nextVersions('1.2.3') }] }, 'minor'), 'Minor — package.json 1.2.3 → 1.3.0');
assert.equal(bumpLabel({ targets: [] }, 'none'), 'Don’t bump the version');

// --- the automation action --------------------------------------------------------------------
{
  const action = normalizePipeline({ event: 'pre-commit', name: 'v', actions: [{ type: 'bumpVersion' }] }).actions[0];
  assert.deepEqual({ target: action.target, path: action.path, default: action.default }, { target: 'file', path: 'package.json', default: 'patch' });
  assert.equal(normalizePipeline({ actions: [{ type: 'bumpVersion', target: 'modules', default: 'minor' }] }).actions[0].target, 'modules');
  assert.ok(validatePipeline({ event: 'pre-commit', name: 'v', actions: [{ type: 'bumpVersion' }] }).valid);
  assert.match(validatePipeline({ event: 'pre-push', name: 'v', actions: [{ type: 'bumpVersion' }] }).errors.join(), /Before Commit/);
  assert.match(validatePipeline({ event: 'pre-commit', name: 'v', actions: [{ type: 'bumpVersion', path: '../package.json' }] }).errors.join(), /package\.json inside/);
  const template = TEMPLATES.find(item => item.id === 'bump-version').build();
  assert.ok(validatePipeline(template).valid);
}

// --- on real Git -------------------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-bump-'));
try {
  const log = new CommandLog(root); await log.load();
  const cwd = path.join(root, 'garden');
  await mkdir(cwd);
  const git = async (...argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  const write = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); };
  const read = file => readFile(path.join(cwd, file), 'utf8');
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.name', 'Ada Lovelace');
  await git('config', 'user.email', 'ada@example.com');
  await git('config', 'commit.gpgSign', 'false');
  await write('package.json', pkg);
  await write('package-lock.json', lock);
  await write('modules/alpha/package.json', '{\n  "name": "alpha",\n  "version": "0.4.1"\n}\n');
  await write('modules/beta/readme.md', 'no package.json here\n');
  await write('src/game.js', 'export const speed = 1;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Initial');

  const automations = new AutomationsStore(path.join(root, 'auto'));
  const runs = new AutomationRunsStore(path.join(root, 'auto'));
  await Promise.all([automations.load(), runs.load()]);
  const repo = { id: cwd, name: 'garden', path: cwd };
  const bumper = createBumper({ log, automations });

  assert.equal(await bumper.plan({ repo, files: ['src/game.js'] }), null, 'no bump action, no plan');
  // Without the automation the root package.json is still offered, bumping nothing unless chosen.
  assert.deepEqual(await bumper.packagePlan({ repo }), { choice: 'none', source: 'package',
    targets: [{ path: 'package.json', current: '1.2.3', next: { patch: '1.2.4', minor: '1.3.0', major: '2.0.0' }, lock: 'package-lock.json' }] });
  await automations.saveConfig(cwd, { pipelines: [TEMPLATES.find(item => item.id === 'bump-version').build()] });
  const plan = await bumper.plan({ repo, files: ['src/game.js'] });
  assert.deepEqual(plan, { choice: 'patch', targets: [{ path: 'package.json', current: '1.2.3', next: { patch: '1.2.4', minor: '1.3.0', major: '2.0.0' }, lock: 'package-lock.json' }], source: 'automation' });

  // Applied and reverted byte for byte.
  {
    const applied = await bumper.apply({ repo, choice: 'major', plan });
    assert.deepEqual(applied.map(entry => [entry.path, entry.from, entry.to, entry.files.map(item => item.file)]), [['package.json', '1.2.3', '2.0.0', ['package.json', 'package-lock.json']]]);
    assert.equal(await read('package.json'), pkg.replace('"version": "1.2.3"', '"version": "2.0.0"'));
    assert.deepEqual((await git('diff', '--cached', '--name-only')).split('\n'), ['package-lock.json', 'package.json'], 'the bumped files are staged');
    await bumper.revert({ repo, applied });
    assert.equal(await read('package.json'), pkg);
    assert.equal(await read('package-lock.json'), lock);
    await git('reset', '-q');
  }
  // A version that moved since the plan is refused, and nothing is left written.
  {
    await write('package.json', pkg.replace('1.2.3', '1.2.9'));
    await assert.rejects(bumper.apply({ repo, choice: 'patch', plan }), /no longer has version 1\.2\.3/);
    assert.equal(await read('package-lock.json'), lock);
    await git('checkout', '--', 'package.json');
  }
  // Modules: each changed module with a package.json, nothing else.
  {
    await automations.saveConfig(cwd, { pipelines: [{ event: 'pre-commit', name: 'Modules', actions: [{ type: 'bumpVersion', target: 'modules', default: 'minor' }] }] });
    const modules = await bumper.plan({ repo, files: ['modules/alpha/index.js', 'modules/beta/readme.md', 'src/game.js'] });
    assert.deepEqual(modules.targets.map(target => [target.path, target.current, target.lock]), [['modules/alpha/package.json', '0.4.1', null]]);
    assert.equal(modules.choice, 'minor');
    await automations.saveConfig(cwd, { pipelines: [TEMPLATES.find(item => item.id === 'bump-version').build()] });
  }

  // The commit panel's path: the bump goes into the same commit; a failed commit puts everything back.
  {
    await write('src/game.js', 'export const speed = 2;\n');
    await git('add', 'src/game.js');
    const warnings = await commitWithBump({ request: { cwd, log, message: 'feat: faster' }, repo, choice: 'minor', bumper, commit: createCommit });
    assert.ok(warnings.includes('Version of package.json: 1.2.3 → 1.3.0.'));
    assert.deepEqual((await git('show', '--name-only', '--format=', 'HEAD')).split('\n'), ['package-lock.json', 'package.json', 'src/game.js']);
    assert.equal(await git('status', '--porcelain'), '');

    const hook = path.join(cwd, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 1\n'); await chmod(hook, 0o755);
    await write('src/game.js', 'export const speed = 3;\n');
    await git('add', 'src/game.js');
    const pkgBefore = await read('package.json');
    await assert.rejects(commitWithBump({ request: { cwd, log, message: 'feat: even faster' }, repo, choice: 'patch', bumper, commit: createCommit }), /Commit failed/);
    assert.equal(await read('package.json'), pkgBefore, 'the version is back');
    assert.equal(await git('diff', '--cached', '--name-only'), 'src/game.js', 'and so is the index');
    await rm(hook);
    await git('reset', '-q', '--hard');
  }

  // An agent's proposal: the person picks the bump in the dialog; the agent hears what changed.
  {
    const undo = new UndoService({ directory: path.join(root, 'undo'), log }); await undo.load();
    const shown = [];
    const proposals = createCommitProposals({ log, undo, automations, runs, isAllowed: () => true, present: view => { shown.push(view); return true; }, bump: bumper });
    await write('src/game.js', 'export const speed = 4;\n');
    const id = await proposals.propose({ repo, message: 'feat: speed 4', push: false });
    const view = shown.at(-1);
    assert.equal(view.bump.choice, 'patch');
    assert.equal(view.bump.targets[0].current, '1.3.0');
    const done = await proposals.decide(id, { action: 'commit', message: 'feat: speed 4', bump: 'patch' });
    assert.match(done.outcome, /^committed [0-9a-f]{12} on main: feat: speed 4\nversion package\.json: 1\.3\.0 → 1\.3\.1$/);
    assert.deepEqual((await git('show', '--name-only', '--format=', 'HEAD')).split('\n'), ['package-lock.json', 'package.json', 'src/game.js']);
    assert.equal(JSON.parse(await read('package-lock.json')).packages['node_modules/a'].version, '1.2.3');

    // "Don't bump" commits without touching the version.
    await write('src/game.js', 'export const speed = 5;\n');
    const second = await proposals.propose({ repo, message: 'feat: speed 5', push: false });
    const kept = await proposals.decide(second, { action: 'commit', message: 'feat: speed 5', bump: 'none' });
    assert.doesNotMatch(kept.outcome, /version/);
    assert.equal(JSON.parse(await read('package.json')).version, '1.3.1');

    // A blocked commit never bumps: the bump comes after the checks.
    await automations.saveConfig(cwd, { pipelines: [
      TEMPLATES.find(item => item.id === 'bump-version').build(),
      { event: 'commit-msg', name: 'Rules', onFailure: 'block', actions: [{ type: 'validateMessage', rule: { mode: 'conventional' } }] }
    ] });
    await write('src/game.js', 'export const speed = 6;\n');
    const third = await proposals.propose({ repo, message: 'speed six', push: false });
    const blocked = await proposals.decide(third, { action: 'commit', message: 'speed six', bump: 'major' });
    assert.match(blocked.outcome, /^not committed: a commit-msg automation blocked it/);
    assert.equal(JSON.parse(await read('package.json')).version, '1.3.1', 'the version was not touched');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('version-bump: semver, text edit keeps formatting, lock root entries only, action schema, plan/apply/revert, modules, panel commit, agent proposal');
