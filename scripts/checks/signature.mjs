import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { loadSignature, parseVerification, signatureFormat } from '../../main/git/signature.js';
import { loadCommit } from '../../main/git/commit.js';
import { loadHistoryPage } from '../../main/git/history.js';
import { PROFILE_KEYS, loadProfile, saveProfileValue } from '../../main/git/profile.js';
import { FORMAT_NAMES, signatureView } from '../../renderer/src/features/commit/signature-view.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

// --- the commit object's own header decides whether it is signed ------------------------------
const header = marker => `tree ${'a'.repeat(40)}\nauthor A <a@b> 1 +0000\ncommitter A <a@b> 1 +0000\ngpgsig ${marker}\n line\n -----END-----\n\nmessage\n`;
assert.equal(signatureFormat(header('-----BEGIN SSH SIGNATURE-----')), 'ssh');
assert.equal(signatureFormat(header('-----BEGIN PGP SIGNATURE-----')), 'openpgp');
assert.equal(signatureFormat(header('-----BEGIN SIGNED MESSAGE-----')), 'x509');
assert.equal(signatureFormat(header('something else')), 'unknown');
assert.equal(signatureFormat(`tree ${'a'.repeat(40)}\n\ngpgsig -----BEGIN PGP SIGNATURE-----\n`), null, 'a message that quotes a signature is not a signature');
assert.equal(signatureFormat(`tree ${'a'.repeat(40)}\ngpgsig-sha256 -----BEGIN SSH SIGNATURE-----\n\nm\n`), 'ssh', 'SHA-256 repositories use gpgsig-sha256');
assert.deepEqual(parseVerification('G\0a@b\0SHA256:x\0SHA256:x\0fully\n'), { status: 'G', signer: 'a@b', key: 'SHA256:x', fingerprint: 'SHA256:x', trust: 'fully' });
assert.equal(parseVerification('N\0\0\0\0undefined\n').trust, null, 'Git prints "undefined" for a trust level it has none of');
assert.throws(() => parseVerification('Z\0\0\0\0'), /Invalid signature/);

// --- the words ------------------------------------------------------------------------------
assert.equal(signatureView(null).label, 'Checking signature…');
assert.equal(signatureView({ signed: false }).label, 'Not signed');
assert.equal(signatureView({ signed: true, format: 'ssh', status: 'G', signer: 'a@b', key: 'SHA256:k' }).tone, 'good');
assert.match(signatureView({ signed: true, format: 'ssh', status: 'G', signer: 'a@b', key: 'SHA256:k' }).detail, /Signed with SSH by a@b\. Key SHA256:k\./);
assert.match(signatureView({ signed: true, format: 'ssh', status: 'N' }).detail, /gpg\.ssh\.allowedSignersFile/, 'an SSH signature Git could not check says what to set');
assert.equal(signatureView({ signed: true, format: 'ssh', status: 'N' }).label, 'Signed with SSH, not verified');
assert.match(signatureView({ signed: true, format: 'openpgp', status: 'N' }).detail, /gpg is not installed/);
assert.equal(signatureView({ signed: true, format: 'openpgp', status: 'B' }).tone, 'bad');
assert.equal(signatureView({ signed: true, format: 'openpgp', status: 'R' }).tone, 'bad');
for (const status of ['U', 'X', 'Y', 'E']) assert.equal(signatureView({ signed: true, format: 'openpgp', status }).tone, 'warn', status);
assert.deepEqual(Object.keys(FORMAT_NAMES), ['ssh', 'openpgp', 'x509', 'unknown']);
assert.equal(isUserCommand('Read commit signature'), false, 'verification is a read: Full History only');
assert.equal(isUserCommand('Read commit signature verification'), false);

// --- the profile offers the signing settings -------------------------------------------------
for (const key of ['commit.gpgSign', 'tag.gpgSign', 'gpg.format', 'user.signingKey', 'gpg.ssh.allowedSignersFile']) assert.ok(PROFILE_KEYS.includes(key), key);

let sshKeygen = true;
try { execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' }); } catch (error) { sshKeygen = error.code !== 'ENOENT'; }

const root = await mkdtemp(path.join(os.tmpdir(), 'twig-signature-'));
// The person's own global config must not decide the outcome (an empty
// gpg.ssh.program there breaks SSH signing, for one).
const saved = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
process.env.GIT_CONFIG_GLOBAL = path.join(root, 'global.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
try {
  await writeFile(process.env.GIT_CONFIG_GLOBAL, '');
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const cwd = path.join(root, 'repo');
  const git = async (argv, stdin = null) => {
    const result = await runGit({ cwd, log, argv, stdin });
    assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await runGit({ cwd: root, log, argv: ['init', '--initial-branch=main', cwd] });
  for (const [key, value] of [['user.name', 'Twig Check'], ['user.email', 'check@example.invalid'], ['core.hooksPath', '']]) await git(['config', key, value]);

  // Signing settings go through the profile's validation.
  const options = { cwd, log, scope: 'local' };
  let profile = await saveProfileValue({ ...options, key: 'commit.gpgSign', value: 'false', expected: null });
  assert.equal(profile.values['commit.gpgSign'], 'false');
  await assert.rejects(saveProfileValue({ ...options, key: 'commit.gpgSign', value: 'yes', expected: 'false' }), TypeError);
  await assert.rejects(saveProfileValue({ ...options, key: 'gpg.format', value: 'pgp', expected: null }), TypeError);
  await assert.rejects(saveProfileValue({ ...options, key: 'user.signingKey', value: 'a\nb', expected: null }), TypeError);

  await writeFile(path.join(cwd, 'a.txt'), 'a\n'); await git(['add', 'a.txt']); await git(['commit', '-m', 'unsigned']);
  const unsigned = await git(['rev-parse', 'HEAD']);
  assert.deepEqual(await loadSignature({ cwd, log, oid: unsigned }), { signed: false, format: null, status: 'N', signer: null, key: null, fingerprint: null, trust: null });
  assert.equal(log.list().filter(entry => entry.argv.includes('--format=%G?%x00%GS%x00%GK%x00%GF%x00%GT')).length, 0, 'an unsigned commit never runs a verifier');
  await assert.rejects(loadSignature({ cwd, log, oid: '--help' }), TypeError);

  if (sshKeygen) {
    const key = path.join(root, 'signing');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'check', '-f', key]);
    const other = path.join(root, 'other');
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'other', '-f', other]);
    profile = await saveProfileValue({ ...options, key: 'gpg.format', value: 'ssh', expected: null });
    profile = await saveProfileValue({ ...options, key: 'user.signingKey', value: `${key}.pub`, expected: null });
    profile = await saveProfileValue({ ...options, key: 'commit.gpgSign', value: 'true', expected: 'false' });
    assert.equal(profile.effective['commit.gpgSign'], 'true');

    // The switch in the profile is all it takes: a plain commit is signed.
    await writeFile(path.join(cwd, 'b.txt'), 'b\n'); await git(['add', 'b.txt']); await git(['commit', '-m', 'signed by the switch']);
    const signed = await git(['rev-parse', 'HEAD']);
    const noSigners = await loadSignature({ cwd, log, oid: signed });
    assert.equal(noSigners.signed, true, 'signed, although Git itself answers N without an allowed signers file');
    assert.equal(noSigners.format, 'ssh');
    assert.equal(noSigners.status, 'N');
    assert.equal(signatureView(noSigners).label, 'Signed with SSH, not verified');

    const allowed = path.join(root, 'allowed_signers');
    await writeFile(allowed, `check@example.invalid ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);
    await saveProfileValue({ ...options, key: 'gpg.ssh.allowedSignersFile', value: allowed, expected: null });
    const good = await loadSignature({ cwd, log, oid: signed });
    assert.equal(good.status, 'G', 'verified against the allowed signers file');
    assert.equal(good.signer, 'check@example.invalid');
    assert.match(good.key, /^SHA256:/);
    assert.equal(signatureView(good).label, 'Verified signature');

    await writeFile(allowed, `check@example.invalid ${(await readFile(`${other}.pub`, 'utf8')).trim()}\n`);
    assert.equal((await loadSignature({ cwd, log, oid: signed })).status, 'U', 'a key the file does not list for the signer is not trusted');
    await writeFile(allowed, `check@example.invalid ${(await readFile(`${key}.pub`, 'utf8')).trim()}\n`);

    // Change the message after signing: the same signature no longer matches.
    const raw = await git(['cat-file', 'commit', signed]);
    const forged = await git(['hash-object', '-t', 'commit', '-w', '--stdin'], `${raw.replace('signed by the switch', 'changed after signing')}\n`);
    const bad = await loadSignature({ cwd, log, oid: forged });
    assert.equal(bad.status, 'B', 'a changed commit fails verification');
    assert.equal(signatureView(bad).label, 'Bad signature');

    // log.showSignature in the person's config must not leak the verifier's
    // output into the NUL records every reader parses.
    await git(['config', 'log.showSignature', 'true']);
    const page = await loadHistoryPage({ cwd, log, limit: 10 });
    assert.deepEqual(page.commits.map(commit => commit.subject), ['signed by the switch', 'unsigned']);
    assert.equal((await loadCommit({ cwd, log, oid: signed })).subject, 'signed by the switch');
    const reprofiled = await loadProfile(options);
    assert.equal(reprofiled.values['gpg.ssh.allowedSignersFile'], allowed);
    assert.equal(reprofiled.values['user.signingKey'], `${key}.pub`);
  } else console.log('ssh-keygen is not installed: SSH signing checks skipped.');
} finally {
  for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  await rm(root, { recursive: true, force: true });
}

console.log('Signature checks passed: header detection, verdict words, profile switch signs commits, unverified without allowed signers, verified, untrusted key, forged commit, showSignature does not break readers.');
