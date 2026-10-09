import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';

// A repository's own `.git/config` can name programs Git runs while it only
// *reads*: `git status` runs `core.fsmonitor` and clean filters, a fetch runs
// `core.sshCommand` and credential helpers, a signature check runs
// `gpg.program`. 🌱 Twig reads on its own (status on open and on every refresh,
// background fetch, signatures), so a folder whose `.git` came from someone
// else — an archive, a shared drive — would run their program before the
// person did anything. `git clone` never copies config, so this is about
// opening a folder that already has one.
//
// Hooks and `core.hooksPath` are not listed: they run on the person's own
// commit, checkout or merge, exactly as in a terminal.
const RISKY = [
  /^core\.fsmonitor$/, /^core\.sshcommand$/, /^core\.gitproxy$/, /^core\.pager$/,
  /^diff\.external$/, /^diff\..+\.(textconv|command)$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^credential\.(.+\.)?helper$/,
  /^gpg\.(.+\.)?program$/,
  /^include\.path$/, /^includeif\..+\.path$/,
  /^uploadpack\.packobjectshook$/
];

// Signing programs people really configure. A bare name is looked up in PATH
// (never in the repository: see main/process-env.js); an absolute path must
// point outside the repository, or a planted `./tools/gpg` would pass.
const SIGNERS = new Set(['gpg', 'gpg2', 'gpgsm', 'ssh-keygen', 'op-ssh-sign']);
// Credential helpers that ship with Git or with the common installers, named
// the way Git resolves them (`git-credential-<name>` in PATH).
const HELPERS = new Set(['osxkeychain', 'manager', 'manager-core', 'store', 'cache', 'libsecret', 'gnome-keyring', 'wincred', 'oauth']);
// `ssh` with a key, a config file, a port or a harmless -o. Anything else —
// ProxyCommand, LocalCommand, a pipe — still asks.
const SAFE_SSH_OPTIONS = /^(IdentitiesOnly|IdentityFile|IdentityAgent|StrictHostKeyChecking|UserKnownHostsFile|Port|User|AddKeysToAgent|UseKeychain|ServerAliveInterval|ConnectTimeout|BatchMode)=[^\s;&|`$<>()]+$/i;

// `roots`: the repository as Git prints it and as the person picked it — on
// macOS one is `/private/var/…` and the other `/var/…` for the same folder.
function insideRepository(file, roots) {
  return roots.some(root => {
    const relative = path.relative(root, path.resolve(root, file));
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

function safeSshCommand(value) {
  const words = value.trim().split(/\s+/);
  if (words.shift() !== 'ssh') return false;
  while (words.length) {
    const word = words.shift();
    if (['-i', '-F', '-p', '-l'].includes(word)) {
      const argument = words.shift();
      if (!argument || /[;&|`$<>()]/.test(argument)) return false;
    } else if (word === '-o') {
      if (!SAFE_SSH_OPTIONS.test(words.shift() || '')) return false;
    } else if (!/^-[46ACTqvx]+$/.test(word)) return false;
  }
  return true;
}

/** Values that only name Git's own machinery or a well-known tool — not a program someone planted. */
function harmless(key, value, roots) {
  const text = value.trim();
  if (key === 'core.fsmonitor') return /^(true|false|yes|no|on|off|1|0|)$/i.test(text);
  if (/^filter\.lfs\.(clean|smudge|process)$/.test(key)) return /^git-lfs (clean|smudge|filter-process)\b/.test(text);
  if (/^gpg\.(.+\.)?program$/.test(key)) {
    if (!SIGNERS.has(path.basename(text))) return false;
    return !text.includes('/') || (path.isAbsolute(text) && !insideRepository(text, roots));
  }
  if (/^credential\.(.+\.)?helper$/.test(key)) return text === '' || HELPERS.has(text);
  if (key === 'core.sshcommand') return safeSshCommand(text);
  return false;
}

export const isRiskyConfigKey = key => RISKY.some(pattern => pattern.test(key.toLowerCase()));

/**
 * Settings in the repository's local config that would run a program while
 * 🌱 Twig reads it, as `{ key, value }`. Only names are listed first (the
 * journal never sees unrelated values, credentials included); the values of
 * the risky keys are read one by one. A folder outside any repository → [].
 */
export async function findRiskyConfig(directory, log) {
  const top = await runGit({ argv: ['rev-parse', '--show-toplevel'], cwd: directory, log, operation: 'Verify repository' });
  if (top.code !== 0) return [];
  const root = top.stdout.trimEnd();
  const roots = [...new Set([root, path.resolve(directory), await realpath(root).catch(() => root)])];
  const names = await runGit({
    argv: ['config', '--local', '--null', '--name-only', '--list'], cwd: directory, log,
    operation: 'Read repository config names'
  });
  if (names.code !== 0) return [];
  const keys = [...new Set(names.stdout.split('\0').filter(Boolean).map(key => key.toLowerCase()))].filter(isRiskyConfigKey);
  const found = [];
  for (const key of keys) {
    const values = await runGit({
      argv: ['config', '--local', '--null', '--get-all', '--', key], cwd: directory, log,
      operation: 'Read repository config value'
    });
    for (const value of values.stdout.split('\0').filter(Boolean)) {
      if (!harmless(key, value, roots)) found.push({ key, value });
    }
  }
  return found;
}
