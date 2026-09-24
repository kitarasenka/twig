import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { buildSubmoduleUpdateArgv, displayUrl, loadSubmodules, parseGitlinks, parseGitmodules, submoduleDirectory, updateSubmodules } from '../../main/git/submodules.js';
import { inverseReason } from '../../main/git/undo-plan.js';
import { submoduleAction, submoduleConsequence, submoduleState, submoduleUpdateCommand } from '../../renderer/src/features/tools/tools-view.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

const A = 'a'.repeat(40); const B = 'b'.repeat(40);

// --- parsing and words --------------------------------------------------------------------------
assert.deepEqual(parseGitlinks(`100644 ${A} 0\t.gitmodules\x00160000 ${B} 0\tvendor/my lib\0`), [{ path: 'vendor/my lib', pinned: B }]);
assert.deepEqual(parseGitlinks(`160000 ${A} 1\tx\x00160000 ${B} 2\tx\x00160000 ${A} 3\tx\0`), [{ path: 'x', pinned: B }], 'a conflicted gitlink counts once, as checked out');
assert.throws(() => parseGitlinks('garbage\0'), /Invalid ls-files/);
assert.deepEqual(parseGitmodules('submodule.lib.v2.path\nvendor/lib\0submodule.lib.v2.url\nhttps://example.com/lib.git\0submodule.lib.v2.branch\nmain\0'),
  [{ name: 'lib.v2', path: 'vendor/lib', url: 'https://example.com/lib.git', branch: 'main' }], 'a name with dots keeps them');
assert.equal(displayUrl('https://user:token@example.com/lib.git'), 'https://example.com/lib.git', 'credentials never reach the screen');
assert.equal(displayUrl('git@github.com:me/lib.git'), 'git@github.com:me/lib.git');
assert.deepEqual(buildSubmoduleUpdateArgv(), ['submodule', 'update', '--init', '--']);
assert.deepEqual(buildSubmoduleUpdateArgv(['vendor/my lib']), submoduleUpdateCommand(['vendor/my lib']), 'the dialog shows what main runs');
assert.deepEqual(buildSubmoduleUpdateArgv(null), submoduleUpdateCommand(null));
assert.throws(() => buildSubmoduleUpdateArgv(['../outside']), TypeError);
assert.throws(() => buildSubmoduleUpdateArgv([]), TypeError);
assert.match(submoduleState({ state: 'uninitialized' }), /Not initialized/);
assert.equal(submoduleState({ state: 'moved', head: B, pinned: A }), `Checked out at ${B.slice(0, 7)}, not at the pinned ${A.slice(0, 7)}.`);
assert.equal(submoduleAction({ state: 'pinned' }), null);
assert.equal(submoduleAction({ state: 'moved' }), 'Check out pinned commit');
assert.match(submoduleConsequence([{ state: 'uninitialized', path: 'lib' }]), /lib is cloned from its URL, which reaches the network/);
assert.match(submoduleConsequence([{ state: 'moved', path: 'lib' }]), /checked out at the pinned commit, detached/);
assert.match(submoduleConsequence([{ state: 'pinned', path: 'lib' }]), /already at its pinned commit/);
assert.equal(isUserCommand('Read submodules'), false);
assert.equal(isUserCommand('Read submodule commit'), false);
assert.equal(isUserCommand('Update submodules'), true);
assert.match(inverseReason('submodules:update', { operation: 'none' }, { operation: 'none' }, []), /Undo does not move them back/);

// --- real Git -------------------------------------------------------------------------------------
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-submodules-')));
// Git refuses local-path submodule URLs by default since 2.38.1; the fixture needs them.
const saved = { COUNT: process.env.GIT_CONFIG_COUNT, KEY: process.env.GIT_CONFIG_KEY_0, VALUE: process.env.GIT_CONFIG_VALUE_0 };
Object.assign(process.env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always' });
try {
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const git = async (cwd, argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`); return result.stdout.trim(); };
  const init = async cwd => {
    await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
    for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(cwd, ['config', key, value]);
  };
  const lib = path.join(root, 'lib'); const app = path.join(root, 'app');
  await init(lib); await init(app);
  await writeFile(path.join(lib, 'lib.txt'), 'v1\n'); await git(lib, ['add', '.']); await git(lib, ['commit', '-m', 'lib v1']);
  const v1 = await git(lib, ['rev-parse', 'HEAD']);
  await writeFile(path.join(app, 'app.txt'), 'app\n'); await git(app, ['add', '.']); await git(app, ['commit', '-m', 'app']);
  assert.deepEqual(await loadSubmodules({ cwd: app, log }), [], 'no gitlinks, nothing more is read');
  await git(app, ['submodule', 'add', lib, 'vendor/my lib']); await git(app, ['commit', '-m', 'add lib']);

  let list = await loadSubmodules({ cwd: app, log });
  assert.deepEqual(list, [{ path: 'vendor/my lib', name: 'vendor/my lib', url: lib, branch: null, pinned: v1, head: v1, state: 'pinned' }]);

  // Move the checkout inside the submodule: the pin in the index stays.
  await writeFile(path.join(lib, 'lib.txt'), 'v2\n'); await git(lib, ['commit', '-am', 'lib v2']);
  const v2 = await git(lib, ['rev-parse', 'HEAD']);
  await git(path.join(app, 'vendor/my lib'), ['pull', '--ff-only', '-q']);
  list = await loadSubmodules({ cwd: app, log });
  assert.equal(list[0].state, 'moved'); assert.equal(list[0].head, v2); assert.equal(list[0].pinned, v1);
  assert.equal(await submoduleDirectory({ cwd: app, log, path: 'vendor/my lib' }), path.join(app, 'vendor/my lib'), 'an initialized submodule opens as a tab from its own folder');
  await assert.rejects(submoduleDirectory({ cwd: app, log, path: 'app.txt' }), TypeError, 'only a gitlink the index names');

  assert.deepEqual(await updateSubmodules({ cwd: app, log, paths: ['vendor/my lib'] }), { ok: true, cancelled: false, message: null });
  list = await loadSubmodules({ cwd: app, log });
  assert.equal(list[0].state, 'pinned', 'update checks out the pinned commit');
  assert.equal(await readFile(path.join(app, 'vendor/my lib', 'lib.txt'), 'utf8'), 'v1\n');

  // A fresh clone has the submodule uninitialized until Update.
  const clone = path.join(root, 'clone');
  await git(root, ['clone', '-q', app, clone]);
  list = await loadSubmodules({ cwd: clone, log });
  assert.equal(list[0].state, 'uninitialized'); assert.equal(list[0].head, null);
  await assert.rejects(submoduleDirectory({ cwd: clone, log, path: 'vendor/my lib' }), /not initialized/);
  assert.equal((await updateSubmodules({ cwd: clone, log })).ok, true, 'update --init with no paths does them all');
  assert.equal((await loadSubmodules({ cwd: clone, log }))[0].state, 'pinned');

  // Uncommitted work inside a submodule is never overwritten.
  await git(path.join(app, 'vendor/my lib'), ['checkout', '-q', 'main']);
  await writeFile(path.join(app, 'vendor/my lib', 'lib.txt'), 'edited here\n');
  const refused = await updateSubmodules({ cwd: app, log, paths: ['vendor/my lib'] });
  assert.equal(refused.ok, false);
  assert.equal(await readFile(path.join(app, 'vendor/my lib', 'lib.txt'), 'utf8'), 'edited here\n');
} finally {
  for (const [name, value] of Object.entries(saved)) {
    const key = name === 'COUNT' ? 'GIT_CONFIG_COUNT' : name === 'KEY' ? 'GIT_CONFIG_KEY_0' : 'GIT_CONFIG_VALUE_0';
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}

console.log('Submodule checks passed: gitlinks and .gitmodules parsing, credentials hidden, words and shown commands, pinned / moved / uninitialized, update to the pin, update --init in a fresh clone, local edits never overwritten.');
