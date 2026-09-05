import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadProfile, saveProfileValue, parseProfile } from '../../main/git/profile.js';

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-profile-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const env = { GIT_CONFIG_GLOBAL: path.join(root, 'global'), GIT_CONFIG_NOSYSTEM: '1' };
  const log = new CommandLog(root); await log.load();
  const options = { cwd, log, env, scope: 'local' };
  const git = async argv => {
    const result = await runGit({ cwd, log, env, argv });
    assert.equal(result.code, 0, result.stderr); return result.stdout;
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', '--global', 'user.name', 'Global Twig']);
  await git(['config', 'credential.example.password', 'not-for-profile']);
  let profile = await loadProfile(options);
  assert.equal(profile.values['user.name'], null);
  assert.equal(profile.effective['user.name'], 'Global Twig');
  const literal = 'Twig 🌱; $(echo forbidden)';
  profile = await saveProfileValue({ ...options, key: 'user.name', value: literal, expected: null });
  assert.equal(profile.values['user.name'], literal);
  assert.equal(profile.effective['user.name'], literal);
  await assert.rejects(saveProfileValue({ ...options, key: 'user.name', value: 'Overwrite', expected: null }), /changed outside/);
  assert.equal((await loadProfile(options)).values['user.name'], literal);
  profile = await saveProfileValue({ ...options, key: 'user.name', value: null, expected: literal });
  assert.equal(profile.values['user.name'], null);
  assert.equal(profile.effective['user.name'], 'Global Twig');
  for (const [key, value] of [['user.email', 'twig@example.invalid'], ['core.editor', 'code --wait'], ['pull.rebase', 'merges'], ['init.defaultBranch', 'feature/new']]) {
    profile = await saveProfileValue({ ...options, key, value, expected: null });
    assert.equal(profile.values[key], value);
  }
  for (const [key, value] of [['credential.helper', 'bad'], ['user.name', 'bad\nvalue'], ['user.name', 'bad\0value'], ['pull.rebase', 'bad'], ['init.defaultBranch', '-bad'], ['init.defaultBranch', 'bad..branch']]) {
    await assert.rejects(saveProfileValue({ ...options, key, value, expected: null }), TypeError);
  }
  await assert.rejects(loadProfile({ ...options, scope: '../../config' }), TypeError);
  await saveProfileValue({ ...options, scope: 'global', key: 'user.name', value: 'Updated Global', expected: 'Global Twig' });
  assert.match(await readFile(env.GIT_CONFIG_GLOBAL, 'utf8'), /Updated Global/);
  const reads = log.list().filter(entry => entry.argv.includes('--get-regexp'));
  assert.ok(reads.length > 0);
  assert.ok(reads.every(entry => !entry.stdout.includes('not-for-profile') && !entry.stdout.includes('credential.')));
  assert.equal(parseProfile('user.name\nfirst\0user.name\nlast\0')['user.name'], 'last');
  assert.throws(() => parseProfile('user.name\ntruncated'));
  console.log('Profile checks passed: isolated global/local config, inheritance, literal argv, stale edits, validation, allowlisted reads.');
} finally { await rm(root, { recursive: true, force: true }); }
