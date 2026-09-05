import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, access, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CommandLog } from '../../main/command-log.js';
import { createSshService, validationCopy } from '../../main/ssh/service.js';
import { runSsh } from '../../main/ssh/exec.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-ssh-'));
try {
  const log = new CommandLog(root); await log.load();
  const ssh = createSshService({ home: root, log });
  assert.deepEqual(await ssh.keys(), []);
  let config = await ssh.readConfig(); assert.equal(config.exists, false);
  const secret = 'fixture-encrypted-key-passphrase';
  const keys = await ssh.generate({ name: 'id_twig', comment: 'Twig Fixture', passphrase: secret });
  assert.equal(keys.length, 1); assert.equal(keys[0].type, 'ssh-ed25519'); assert.equal(keys[0].hasPrivateKey, true);
  const key = path.join(root, '.ssh', 'id_twig');
  const fingerprint = await runSsh({ executable: 'ssh-keygen', argv: ['-lf', `${key}.pub`], cwd: root, log });
  assert.ok(fingerprint.stdout.includes(keys[0].fingerprint));
  const wrong = await runSsh({ executable: 'ssh-keygen', argv: ['-y', '-f', key], cwd: root, log, stdin: 'wrong-passphrase\n' });
  assert.notEqual(wrong.code, 0, 'the generated private key must be encrypted');
  const right = await runSsh({ executable: 'ssh-keygen', argv: ['-y', '-f', key], cwd: root, log, stdin: `${secret}\n` });
  assert.equal(right.code, 0); assert.ok(keys[0].publicKey.startsWith(right.stdout.trim().split(' ').slice(0, 2).join(' ')));
  assert.equal(JSON.stringify(log.list()).includes(secret), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(key)).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, '.ssh'))).mode & 0o777, 0o700);
  }
  await assert.rejects(ssh.generate({ name: 'id_twig', comment: '', passphrase: secret }), /already exists/);
  await assert.rejects(ssh.generate({ name: '../escape', comment: '', passphrase: secret }), TypeError);
  const content = 'Host twig\r\n  HostName github.com\r\n  User git\r\n';
  config = await ssh.saveConfig(content, config.digest);
  assert.equal(await readFile(config.path, 'utf8'), content);
  await assert.rejects(ssh.saveConfig('DefinitelyNotAnSSHOption yes\n', config.digest), /rejected/);
  assert.equal(await readFile(config.path, 'utf8'), content);
  const updated = await ssh.saveConfig(`${content}  Port 22\r\n`, config.digest);
  assert.equal(await readFile(updated.backup, 'utf8'), content);
  if (process.platform !== 'win32') {
    assert.equal((await stat(updated.path)).mode & 0o777, 0o600);
    assert.equal((await stat(updated.backup)).mode & 0o777, 0o600);
  }
  await assert.rejects(ssh.saveConfig(content, config.digest), /changed outside/);
  const marker = path.join(root, 'must-not-run');
  const dangerous = `Match=!exec "touch ${marker}"\n  User git\nInclude missing-files/*\n`;
  assert.doesNotMatch(validationCopy(dangerous), /touch/);
  await ssh.saveConfig(dangerous, updated.digest);
  await assert.rejects(access(marker));
  await assert.rejects(ssh.testConnection('--ProxyCommand=bad'), TypeError);
  await writeFile(path.join(root, 'outside'), 'unchanged');
  await rm(config.path); await symlink(path.join(root, 'outside'), config.path);
  await assert.rejects(ssh.saveConfig(content, updated.digest), /regular/);
  assert.equal(await readFile(path.join(root, 'outside'), 'utf8'), 'unchanged');
  console.log('SSH checks passed: encrypted Ed25519, fingerprints, secret-free journal, permissions, native config validation, backups, stale files, Match exec isolation and symlink refusal.');
} finally { await rm(root, { recursive: true, force: true }); }
