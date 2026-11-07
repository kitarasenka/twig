import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { choosePush, mapRefspec, parseConfigList, pushArgv, readPushPlan } from '../../main/git/push-plan.js';
import { runSync } from '../../main/git/sync.js';

// What `.git/config` can do to a bare `git push`, and that neither the toolbar
// nor Commit & Push is at its mercy: one branch, by name, never forced.

const config = entries => new Map(Object.entries(entries).map(([key, value]) => [key, [value].flat()]));
const base = { 'remote.origin.url': 'x', 'branch.main.remote': 'origin', 'branch.main.merge': 'refs/heads/main' };

assert.deepEqual([...parseConfigList('remote.origin.url\nu\0remote.origin.mirror\0remote.origin.pushurl\na\0remote.origin.pushurl\nb\0')], [
  ['remote.origin.url', ['u']], ['remote.origin.mirror', ['true']], ['remote.origin.pushurl', ['a', 'b']]]);
assert.deepEqual(parseConfigList('').size, 0);

const source = 'refs/heads/feat/x';
for (const [refspec, destination, forced] of [
  ['refs/heads/*:refs/heads/*', source, false], ['+refs/heads/*:refs/mine/*', 'refs/mine/feat/x', true], ['HEAD:refs/for/main', 'refs/for/main', false],
  ['feat/x:other', 'refs/heads/other', false], ['refs/heads/feat/x', source, false], [':', source, false]
]) assert.deepEqual(mapRefspec(refspec, source), { destination, forced }, refspec);
for (const refspec of ['refs/tags/*:refs/tags/*', 'main:main', ':refs/heads/gone', '^refs/heads/feat/x', 'a:b:c']) assert.equal(mapRefspec(refspec, source), null, refspec);

const chosen = (entries, branch = 'main') => choosePush({ branch, config: config({ ...base, ...entries }) });
assert.deepEqual(chosen({}), { mode: 'push', remote: 'origin', source: 'refs/heads/main', destination: 'refs/heads/main', tracked: 'origin', notes: [] });
assert.equal(chosen({}, 'topic').mode, 'push-upstream', 'no upstream: origin, as the toolbar always did');
assert.match(choosePush({ branch: 'main', config: config({}) }).reason, /no remote named origin/);
assert.match(chosen({ 'branch.main.remote': '.' }).reason, /local branch/);
assert.match(chosen({ 'remote.pushdefault': '/tmp/evil.git' }).reason, /not a configured remote/, 'an address in place of a remote name is not followed');
assert.match(chosen({ 'branch.main.pushremote': 'gone' }).reason, /not a configured remote/);
assert.equal(chosen({ 'remote.fork.url': 'f', 'remote.pushdefault': 'fork' }).remote, 'fork');
assert.match(chosen({ 'remote.fork.url': 'f', 'branch.main.pushremote': 'fork', 'remote.pushdefault': 'origin' }).notes.join(), /sends this to fork, not to origin/);
assert.match(chosen({ 'push.default': 'nothing' }).reason, /nothing/);
assert.equal(chosen({ 'push.default': 'upstream', 'branch.main.merge': 'refs/heads/trunk' }).destination, 'refs/heads/trunk');
assert.match(chosen({ 'branch.main.merge': 'refs/heads/trunk' }).reason, /another name/, 'simple refuses, as Git does');
assert.equal(chosen({ 'branch.main.merge': 'refs/heads/trunk', 'push.default': 'current' }).destination, 'refs/heads/main');
assert.equal(chosen({ 'push.default': 'matching' }).destination, 'refs/heads/main', 'one branch, whatever else matches');
assert.match(chosen({ 'remote.origin.push': 'refs/tags/*:refs/tags/*' }).reason, /does not cover main/);
assert.equal(chosen({ 'remote.origin.push': 'HEAD:refs/for/main' }).destination, 'refs/for/main', 'a review remote keeps working');
assert.match(chosen({ 'remote.origin.push': '+refs/heads/main:refs/heads/main' }).notes.join(), /force/);

const plain = { mode: 'push', remote: 'origin', source: 'refs/heads/main', destination: 'refs/heads/main', mirror: false, followTags: true, recursive: true };
assert.deepEqual(pushArgv(plain), ['push', 'origin', 'refs/heads/main:refs/heads/main']);
assert.deepEqual(pushArgv({ ...plain, mode: 'push-upstream' }), ['push', '--set-upstream', 'origin', 'refs/heads/main:refs/heads/main']);
assert.deepEqual(pushArgv(plain, { force: true }), ['push', '--force-with-lease', 'origin', 'refs/heads/main:refs/heads/main']);
assert.deepEqual(pushArgv({ ...plain, mirror: true }), ['-c', 'remote.origin.mirror=false', 'push', 'origin', 'refs/heads/main:refs/heads/main']);
assert.deepEqual(pushArgv(plain, { exact: true }), ['push', '--no-follow-tags', '--recurse-submodules=no', 'origin', 'refs/heads/main:refs/heads/main']);

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-push-plan-'));
try {
  const log = new CommandLog(root); await log.load();
  const sh = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let count = 0;
  async function repository() {
    const folder = path.join(root, `case-${++count}`);
    const cwd = path.join(folder, 'repo');
    const remote = path.join(folder, 'remote.git');
    await mkdir(cwd, { recursive: true });
    sh(folder, 'init', '-q', '--bare', '-b', 'main', remote);
    sh(cwd, 'init', '-q', '-b', 'main');
    sh(cwd, 'config', 'user.name', 'A'); sh(cwd, 'config', 'user.email', 'a@example.com'); sh(cwd, 'config', 'commit.gpgSign', 'false');
    const commit = async name => { await writeFile(path.join(cwd, 'file'), `${name}\n`); sh(cwd, 'add', '-A'); sh(cwd, 'commit', '-qm', name); };
    await commit('one');
    sh(cwd, 'remote', 'add', 'origin', remote);
    sh(cwd, 'push', '-q', '-u', 'origin', 'main');
    return { folder, cwd, remote, commit, push: (mode = 'push', branch = 'main', extra = {}) => runSync({ cwd, log, mode, branch, ...extra }) };
  }
  const refs = cwd => sh(cwd, 'for-each-ref', '--format=%(refname)').split('\n');

  // The ordinary push: same outcome, and the remote-tracking ref moves with it — a URL would leave the badge at "1 to push".
  {
    const r = await repository();
    await r.commit('two');
    assert.deepEqual(await r.push(), { ok: true, cancelled: false, message: null });
    assert.equal(sh(r.cwd, 'status', '-sb'), '## main...origin/main');
    assert.equal(sh(r.remote, 'log', '-1', '--format=%s', 'main'), 'two');
    sh(r.cwd, 'switch', '-q', '-c', 'feat/new');
    await r.commit('three');
    assert.equal((await r.push('push-upstream', 'feat/new')).ok, true);
    assert.equal(sh(r.cwd, 'rev-parse', '--abbrev-ref', 'feat/new@{upstream}'), 'origin/feat/new', 'the new branch tracks');
    const entry = log.list().filter(item => item.operation === 'Push and set upstream').at(-1);
    assert.deepEqual(entry.argv.slice(-4), ['push', '--set-upstream', 'origin', 'refs/heads/feat/new:refs/heads/feat/new']);
  }

  // Mirror mode: only the branch goes, and what only the remote has stays.
  {
    const r = await repository();
    sh(r.cwd, 'branch', 'colleague'); sh(r.cwd, 'push', '-q', 'origin', 'colleague'); sh(r.cwd, 'branch', '-qD', 'colleague');
    sh(r.cwd, 'config', 'remote.origin.mirror', 'true');
    await r.commit('two');
    assert.equal((await r.push()).ok, true);
    assert.deepEqual(refs(r.remote), ['refs/heads/colleague', 'refs/heads/main']);
    assert.equal(sh(r.cwd, 'status', '-sb'), '## main...origin/main');
  }

  // A + in the configuration does not overwrite a colleague's commit.
  {
    const r = await repository();
    const other = path.join(r.folder, 'other');
    sh(r.folder, 'clone', '-q', '-b', 'main', r.remote, other);
    sh(other, 'config', 'user.name', 'B'); sh(other, 'config', 'user.email', 'b@example.com');
    await writeFile(path.join(other, 'theirs'), 'x\n'); sh(other, 'add', '-A'); sh(other, 'commit', '-qm', 'colleague'); sh(other, 'push', '-q');
    sh(r.cwd, 'config', 'remote.origin.push', '+refs/heads/main:refs/heads/main');
    await r.commit('two');
    assert.equal((await r.push()).ok, false, 'refused like any non-fast-forward');
    assert.equal(sh(r.remote, 'log', '-1', '--format=%s', 'main'), 'colleague');
    // With a lease, a person's explicit force still means what it says.
    sh(r.cwd, 'fetch', '-q', 'origin');
    assert.equal((await r.push('push-force')).ok, true);
    assert.equal(sh(r.remote, 'log', '-1', '--format=%s', 'main'), 'two');
  }

  // Several addresses: each gets the push, and the plan names each.
  {
    const r = await repository();
    const second = path.join(r.folder, 'second.git');
    sh(r.folder, 'init', '-q', '--bare', '-b', 'main', second);
    sh(r.cwd, 'config', '--add', 'remote.origin.pushurl', r.remote);
    sh(r.cwd, 'config', '--add', 'remote.origin.pushurl', second);
    await r.commit('two');
    assert.deepEqual((await readPushPlan({ cwd: r.cwd, log, branch: 'main' })).urls, [r.remote, second]);
    assert.equal((await r.push()).ok, true);
    assert.equal(sh(second, 'rev-parse', 'main'), sh(r.cwd, 'rev-parse', 'HEAD'));
    assert.equal(sh(r.remote, 'rev-parse', 'main'), sh(r.cwd, 'rev-parse', 'HEAD'));
  }

  // Triangular work: the branch tracks one remote and pushes to another.
  {
    const r = await repository();
    const fork = path.join(r.folder, 'fork.git');
    sh(r.folder, 'init', '-q', '--bare', '-b', 'main', fork);
    sh(r.cwd, 'remote', 'add', 'fork', fork);
    sh(r.cwd, 'config', 'remote.pushDefault', 'fork');
    await r.commit('two');
    const plan = await readPushPlan({ cwd: r.cwd, log, branch: 'main' });
    assert.equal(plan.to, 'fork/main');
    assert.deepEqual(plan.urls, [fork]);
    assert.equal((await r.push()).ok, true);
    assert.equal(sh(fork, 'log', '-1', '--format=%s', 'main'), 'two');
    assert.equal(sh(r.remote, 'log', '-1', '--format=%s', 'main'), 'one', 'not the one it tracks');
  }

  // An upstream of another name goes where push.default says, or is refused with the reason.
  {
    const r = await repository();
    sh(r.cwd, 'switch', '-q', '-c', 'local-name', '--track', 'origin/main');
    await r.commit('two');
    const refused = await r.push('push', 'local-name');
    assert.equal(refused.ok, false);
    assert.equal(refused.notStarted, true, 'Git was not run, and the Undo chain lives');
    assert.match(refused.message, /another name/);
    sh(r.cwd, 'config', 'push.default', 'upstream');
    assert.equal((await r.push('push', 'local-name')).ok, true);
    assert.equal(sh(r.remote, 'log', '-1', '--format=%s', 'main'), 'two');
  }

  // Whatever decides the push is in the digest, even what changes no word on screen.
  {
    const r = await repository();
    const digest = async () => (await readPushPlan({ cwd: r.cwd, log, branch: 'main' })).digest;
    const first = await digest();
    assert.equal(await digest(), first, 'stable');
    const elsewhere = path.join(r.folder, 'elsewhere.git');
    for (const [key, value] of [['remote.origin.pushurl', elsewhere], [`url.${elsewhere}.pushInsteadOf`, r.remote], ['remote.origin.mirror', 'true'],
      ['remote.origin.push', 'refs/heads/main:refs/heads/main'], ['push.followTags', 'true'], ['push.default', 'current'], ['branch.main.pushRemote', 'origin'], ['remote.pushDefault', 'origin']]) {
      sh(r.cwd, 'config', key, value);
      assert.notEqual(await digest(), first, key);
      sh(r.cwd, 'config', '--unset', key);
      assert.equal(await digest(), first, `${key} put back`);
    }
    sh(r.cwd, 'config', `url.${elsewhere}.pushInsteadOf`, r.remote);
    assert.deepEqual((await readPushPlan({ cwd: r.cwd, log, branch: 'main' })).urls, [elsewhere], 'a rewritten address is the one shown');
  }

  // A confirmed push is exact: tags and submodules ride along only on the person's own Push.
  {
    const r = await repository();
    sh(r.cwd, 'config', 'push.followTags', 'true');
    sh(r.cwd, 'tag', '-a', 'v1', '-m', 'v1');
    await r.commit('two');
    const plan = await readPushPlan({ cwd: r.cwd, log, branch: 'main', exact: true });
    assert.equal((await r.push('push', 'main', { plan })).ok, true);
    assert.equal(sh(r.remote, 'tag'), '', 'no tag went along');
    await r.commit('three');
    assert.equal((await r.push()).ok, true);
    assert.equal(sh(r.remote, 'tag'), 'v1', 'the toolbar keeps the person\'s push.followTags');
  }

  // Nowhere to go.
  {
    const r = await repository();
    assert.match((await readPushPlan({ cwd: r.cwd, log, branch: null })).reason, /not on a branch/);
    sh(r.cwd, 'remote', 'rename', 'origin', 'upstream');
    sh(r.cwd, 'switch', '-q', '-c', 'lonely');
    assert.equal((await readPushPlan({ cwd: r.cwd, log, branch: 'lonely' })).remote, 'upstream', 'the only remote is where a branch goes');
    sh(r.cwd, 'remote', 'add', 'second', r.cwd);
    assert.match((await r.push('push-upstream', 'lonely')).message, /no remote named origin/);
    assert.equal((await readPushPlan({ cwd: r.cwd, log, branch: 'lonely', publish: 'second' })).remote, 'second', 'with several, the one the person picked');
  }
  await log.settled();
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log('push-plan: refspec mapping, push.default, remotes by name, mirror, force, several addresses, triangular work, tracking, digest, exact pushes');
