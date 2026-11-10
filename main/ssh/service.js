import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { runSsh } from './exec.js';
import { createTokenRegistry } from '../token-registry.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

const digest = content => createHash('sha256').update(content).digest('hex');
const leaf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(value)) throw new TypeError(ui`Invalid SSH key filename.`);
  return value;
};
const text = value => typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value);

export function publicKeyInfo(content) {
  const [type, encoded] = content.trim().split(/\s+/);
  if (!encoded || !/^(ssh-|ecdsa-|sk-)/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error(ui`Not an SSH public key.`);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) > bytes.length - 4 || bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString() !== type) throw new Error(ui`Invalid public key encoding.`);
  return { type, fingerprint: `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}` };
}

/**
 * The first word of a config line as OpenSSH's own reader takes it: a quote
 * anywhere in it is removed (`"Match"` and `Ma"tch"` are both Match), and it
 * ends at a space, a tab or `=`. Read any other way, a line slips past the
 * checks below and into `ssh -G`.
 */
export function configKeyword(line) {
  let at = line.search(/[^ \t\r]/);
  if (at < 0) return { word: '', rest: '' };
  let word = '';
  for (; at < line.length; at++) {
    const character = line[at];
    if (' \t\r='.includes(character)) break;
    if (character !== '"') { word += character; continue; }
    const end = line.indexOf('"', at + 1);
    if (end < 0) return { word: `${word}${line.slice(at + 1)}`.toLowerCase(), rest: '' };
    word += line.slice(at + 1, end);
    at = end + 1;
    break;
  }
  return { word: word.toLowerCase(), rest: line.slice(at).replace(/^[ \t\r]*=?[ \t\r]*/, '') };
}

export function validationCopy(content) {
  // ssh -G can run Match exec. Check its syntax but never execute user commands to validate a file.
  return content.split(/\r?\n/).map((line, index) => {
    const { word, rest } = configKeyword(line);
    if (word === 'include') {
      if (!rest.trim()) throw new Error(ui`Include needs a path on line ${index + 1}.`);
      return '# Include paths are validated when SSH opens the connection.';
    }
    if (word === 'match') {
      const tokens = []; let token = ''; let quote = ''; let escaped = false;
      for (const character of rest) {
        if (escaped) { token += character; escaped = false; }
        else if (character === '\\') escaped = true;
        else if (quote) { if (character === quote) quote = ''; else token += character; }
        else if (character === '"' || character === "'") quote = character;
        else if (/\s/.test(character)) { if (token) { tokens.push(token); token = ''; } }
        else if (character === '#' && !token) break;
        else token += character;
      }
      if (quote || escaped) throw new Error(ui`Unclosed Match argument on line ${index + 1}.`);
      if (token) tokens.push(token);
      for (let at = 0; at < tokens.length; at++) {
        const criterion = tokens[at].replace(/^!/, '').toLowerCase();
        if (['all', 'canonical', 'final'].includes(criterion)) continue;
        // OpenSSH 9.9 also takes `exec=command` as one word.
        if (criterion.startsWith('exec=')) { tokens[at] = `${tokens[at].startsWith('!') ? '!' : ''}host=twig-validation.invalid`; continue; }
        if (criterion.includes('=')) continue;
        if (!tokens[at + 1]) throw new Error(ui`Missing Match argument on line ${index + 1}.`);
        if (criterion === 'exec') { tokens[at] = tokens[at].startsWith('!') ? '!host' : 'host'; tokens[at + 1] = 'twig-validation.invalid'; }
        at++;
      }
      return `Match ${tokens.map(token => JSON.stringify(token)).join(' ')}`;
    }
    return line;
  }).join('\n');
}

/** A host name as it can go into a Host line, ssh-keyscan or known_hosts: no patterns, no spaces. */
const HOST_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;
export function validHostName(value) {
  return typeof value === 'string' && value.length <= 253 && HOST_NAME.test(value);
}

const configWords = rest => {
  const words = []; let word = ''; let quote = false;
  for (const character of rest) {
    if (character === '"') { quote = !quote; continue; }
    if (!quote && /[ \t]/.test(character)) { if (word) { words.push(word); word = ''; } continue; }
    if (!quote && character === '#' && !word) break;
    word += character;
  }
  if (word) words.push(word);
  return words;
};

/**
 * Where a Host block for `host` that uses `identity` (`~/.ssh/<file>`) goes in
 * an SSH config, or that one is there already. OpenSSH takes the first value
 * it reads for most options, so the block goes before the first Host or Match
 * line — ahead of a catch-all `Host *` — and after the global lines at the top,
 * which would otherwise end up inside it. `IdentitiesOnly` keeps ssh to this
 * key; `AddKeysToAgent` (and with Apple's ssh `UseKeychain`) asks for the
 * passphrase once, not on every push.
 * @returns {{ already: boolean, content: string, block: string }}
 */
export function sshHostPlan(content, host, identity, { keychain = false } = {}) {
  if (!validHostName(host)) throw new TypeError(ui`Enter a host name such as github.com.`);
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const lines = content.length ? content.split(/\r?\n/) : [];
  let patterns = null; let first = -1;
  const home = identity.replace(/^~\//, '');
  for (const [index, line] of lines.entries()) {
    const { word, rest } = configKeyword(line);
    if (word === 'host' || word === 'match') {
      if (first < 0) first = index;
      patterns = word === 'host' ? configWords(rest).map(pattern => pattern.toLowerCase()) : null;
      continue;
    }
    if (word === 'identityfile' && patterns?.includes(host.toLowerCase())) {
      const [value = ''] = configWords(rest);
      if (value === identity || value === `%d/${home}` || value.endsWith(`/${home}`)) return { already: true, content, block: '' };
    }
  }
  const body = [`Host ${host}`, `  IdentityFile ${identity}`, '  IdentitiesOnly yes', '  AddKeysToAgent yes'];
  if (keychain) body.push('  UseKeychain yes');
  const block = body.join(eol);
  if (first < 0) {
    const before = lines.length && lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    const head = before.length ? `${before.join(eol)}${eol}${eol}` : '';
    return { already: false, content: `${head}${block}${eol}`, block };
  }
  const next = [...lines.slice(0, first), ...body, '', ...lines.slice(first)];
  return { already: false, content: next.join(eol), block };
}

/**
 * What ssh-keyscan printed: one `host type key` line per key, `#` comments.
 * Each key's fingerprint is computed here, the way ssh prints it.
 */
export function parseKeyscan(output) {
  const keys = [];
  for (const line of String(output).split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0].startsWith('#')) continue;
    try {
      const info = publicKeyInfo(`${fields[1]} ${fields[2]}`);
      if (!keys.some(key => key.key === fields[2])) keys.push({ type: fields[1], key: fields[2], fingerprint: info.fingerprint });
    } catch { /* a line that is not a key is not trusted */ }
  }
  return keys;
}

/** The name known_hosts gives a host: bare on port 22, `[host]:port` otherwise. */
export const knownHostsName = (host, port) => (port === 22 ? host : `[${host}]:${port}`);

export function createSshService({ home, log }) {
  const directory = path.join(home, '.ssh'); const configFile = path.join(directory, 'config');
  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(ui`SSH settings must use a regular .ssh directory.`);
    await chmod(directory, 0o700);
  }
  async function regular(file, optional = false) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(ui`SSH file is not a regular file or is too large.`);
      return info;
    } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  }
  async function readConfig() {
    const info = await regular(configFile, true);
    const content = info ? await readFile(configFile, 'utf8') : '';
    return { content, digest: digest(content), exists: Boolean(info), path: configFile };
  }
  async function keys() {
    let names;
    try { names = await readdir(directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const name of names.filter(name => name.endsWith('.pub'))) {
      try {
        leaf(name); await regular(path.join(directory, name));
        const content = await readFile(path.join(directory, name), 'utf8');
        const info = publicKeyInfo(content);
        const privateInfo = await regular(path.join(directory, name.slice(0, -4)), true);
        result.push({ name, ...info, publicKey: content.trim(), hasPrivateKey: Boolean(privateInfo), securePermissions: !privateInfo || (privateInfo.mode & 0o077) === 0 });
      } catch { result.push({ name, error: ui`Could not read a valid public key.` }); }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function generate({ name, comment, passphrase }) {
    leaf(name);
    if (name.endsWith('.pub') || ['config', 'known_hosts', 'authorized_keys'].includes(name)) throw new TypeError(ui`Choose a new key filename.`);
    if (!text(comment) || !text(passphrase) || !passphrase) throw new TypeError(ui`Enter a single-line comment and a non-empty passphrase.`);
    await ensureDirectory();
    const destination = path.join(directory, name);
    if (await regular(destination, true) || await regular(`${destination}.pub`, true)) throw new Error(ui`This key filename already exists.`);
    const temporary = await mkdtemp(path.join(directory, '.twig-key-'));
    try {
      const key = path.join(temporary, 'key');
      const result = await runSsh({ executable: 'ssh-keygen', argv: ['-q', '-t', 'ed25519', '-f', key, '-C', comment], cwd: directory, log, stdin: `${passphrase}\n${passphrase}\n` });
      if (result.code !== 0) throw new Error(ui`ssh-keygen did not create the key. Show output in the console.`);
      await copyFile(key, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600);
      await copyFile(`${key}.pub`, `${destination}.pub`, constants.COPYFILE_EXCL); await chmod(`${destination}.pub`, 0o644);
      return keys();
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function secureKey(name) {
    leaf(name);
    if (!name.endsWith('.pub')) throw new TypeError(ui`Choose a listed public key.`);
    await ensureDirectory();
    const file = path.join(directory, name.slice(0, -4));
    await regular(path.join(directory, name)); await regular(file);
    await chmod(file, 0o600);
    return keys();
  }
  async function saveConfig(content, expected) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || content.includes('\0') || typeof expected !== 'string') throw new TypeError(ui`Invalid SSH configuration.`);
    await ensureDirectory();
    const before = await readConfig();
    if (before.digest !== expected) throw new Error(ui`SSH config changed outside 🌱 Twig. Reload before saving.`);
    const temporary = await mkdtemp(path.join(directory, '.twig-config-'));
    try {
      const check = path.join(temporary, 'check'); await writeFile(check, validationCopy(content), { mode: 0o600 });
      const result = await runSsh({ executable: 'ssh', argv: ['-G', '-F', check, '-o', 'CanonicalizeHostname=no', 'twig-validation.invalid'], cwd: directory, log, quiet: true });
      if (result.code !== 0) throw new Error(ui`SSH rejected the configuration: ${result.stderr.slice(0, 1000)}`);
      if ((await readConfig()).digest !== expected) throw new Error(ui`SSH config changed during validation. Reload before saving.`);
      const backup = before.exists ? `${configFile}.twig-backup-${randomUUID()}` : null;
      if (backup) await writeFile(backup, before.content, { flag: 'wx', mode: 0o600 });
      const next = path.join(temporary, 'config'); await writeFile(next, content, { mode: 0o600 });
      await rename(next, configFile); await chmod(configFile, 0o600);
      return { ...await readConfig(), backup };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function testConnection(target, signal) {
    if (typeof target !== 'string' || target.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(target)) throw new TypeError(ui`Enter an SSH host alias or user@host.`);
    const config = await readConfig();
    return runSsh({ executable: 'ssh', argv: ['-T', '-F', config.exists ? configFile : process.platform === 'win32' ? 'NUL' : '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', target], cwd: home, log, signal });
  }
  /** One journal entry for a file 🌱 Twig writes itself, shaped like a command. */
  async function journaled({ argv, operation, output = '', run }) {
    const id = randomUUID(); const startedAt = new Date().toISOString(); const started = performance.now();
    await log.start({ id, executable: '🌱 Twig', argv, cwd: directory, startedAt, operation });
    try {
      const value = await run();
      if (output) await log.output(id, 'stdout', output);
      await log.finish(id, { code: 0, stdout: output, stderr: '', cancelled: false, ms: Math.round(performance.now() - started), startedAt });
      return value;
    } catch (error) {
      await log.output(id, 'stderr', `${error.message}\n`);
      await log.finish(id, { code: 1, stdout: '', stderr: error.message, cancelled: false, ms: Math.round(performance.now() - started), startedAt });
      throw error;
    }
  }
  /**
   * A Host block that makes ssh use a key 🌱 Twig listed for one host. ssh
   * tries id_ed25519 and a few other names by itself, never a key called
   * anything else, and a key it does not try never reaches the Git host.
   */
  async function addHost(key, host, expected) {
    leaf(key);
    if (!key.endsWith('.pub') || typeof expected !== 'string') throw new TypeError(ui`Choose a listed public key.`);
    if (!validHostName(host)) throw new TypeError(ui`Enter a host name such as github.com.`);
    await regular(path.join(directory, key)); await regular(path.join(directory, key.slice(0, -4)));
    const identity = `~/.ssh/${key.slice(0, -4)}`;
    const config = await readConfig();
    if (config.digest !== expected) throw new Error(ui`SSH config changed outside 🌱 Twig. Reload before saving.`);
    let plan = sshHostPlan(config.content, host, identity, { keychain: process.platform === 'darwin' });
    if (plan.already) return { ...config, already: true, backup: null };
    // UseKeychain is Apple's: an ssh from elsewhere on PATH (Homebrew) refuses
    // the whole file over it, and Git would run that same ssh.
    const save = () => journaled({ argv: ['add', 'Host', host, 'to', configFile], operation: 'Add a Host to the SSH config', output: `${plan.block}\n`,
      run: () => saveConfig(plan.content, expected) });
    let saved;
    try { saved = await save(); } catch (error) {
      if (!/usekeychain/i.test(error.message)) throw error;
      plan = sshHostPlan(config.content, host, identity);
      saved = await save();
    }
    return { ...saved, already: false };
  }
  const scans = createTokenRegistry();
  const knownHosts = path.join(directory, 'known_hosts');
  /**
   * Which host and port `target` reaches, as `ssh -G` resolves it from the
   * config (a copy where Match exec cannot run), then the keys that host
   * offers right now and whether known_hosts already has them. Trusting comes
   * after the person compared the fingerprints, by the token this returns.
   */
  async function scanHost(target, signal) {
    if (typeof target !== 'string' || target.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(target)) throw new TypeError(ui`Enter an SSH host alias or user@host.`);
    const config = await readConfig();
    let host = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target; let port = 22;
    const temporary = await mkdtemp(path.join(os.tmpdir(), 'twig-ssh-scan-'));
    try {
      const check = path.join(temporary, 'config'); await writeFile(check, validationCopy(config.content), { mode: 0o600 });
      const resolved = await runSsh({ executable: 'ssh', argv: ['-G', '-F', check, target], cwd: home, log, quiet: true, signal, operation: 'Read where an SSH host points' });
      if (resolved.code === 0) {
        const named = resolved.stdout.match(/^hostname (\S+)$/m)?.[1]; const number = Number(resolved.stdout.match(/^port (\d+)$/m)?.[1]);
        if (named) host = named;
        if (Number.isInteger(number) && number > 0 && number < 65536) port = number;
      }
    } finally { await rm(temporary, { recursive: true, force: true }); }
    if (!validHostName(host)) throw new Error(ui`This host name cannot be checked here.`);
    const scanned = await runSsh({ executable: 'ssh-keyscan', argv: ['-T', '10', '-p', String(port), host], cwd: home, log, signal });
    if (scanned.cancelled) return { host, port, keys: [], state: 'cancelled' };
    const keys = parseKeyscan(scanned.stdout);
    if (!keys.length) return { host, port, keys, state: 'unreachable' };
    const name = knownHostsName(host, port);
    let known = [];
    if (await regular(knownHosts, true)) {
      const found = await runSsh({ executable: 'ssh-keygen', argv: ['-F', name, '-f', knownHosts], cwd: home, log, signal, operation: 'Read known SSH hosts' });
      known = found.code === 0 ? parseKeyscan(found.stdout) : [];
    }
    const state = !known.length ? 'unknown' : keys.some(key => known.some(item => item.key === key.key)) ? 'known' : 'changed';
    const view = keys.map(({ type, fingerprint }) => ({ type, fingerprint }));
    if (state !== 'unknown') return { host, port, keys: view, state };
    return { host, port, keys: view, state, token: scans.add(home, { host, port, keys }) };
  }
  /** Append the keys the person saw to known_hosts, once, without touching what is there. */
  async function trustHost(token) {
    let entry;
    try { entry = scans.take(home, token); } catch { throw new TypeError(ui`Check the host again.`); }
    const { host, port, keys } = entry;
    await ensureDirectory();
    const info = await regular(knownHosts, true);
    const before = info ? await readFile(knownHosts, 'utf8') : '';
    const name = knownHostsName(host, port);
    const fresh = keys.filter(key => !before.includes(` ${key.key}`));
    if (!fresh.length) return { host, port, added: 0 };
    const next = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${fresh.map(key => `${name} ${key.type} ${key.key}`).join('\n')}\n`;
    await journaled({ argv: ['append', knownHosts, name], operation: 'Trust an SSH host key',
      output: `${fresh.map(key => `${name} ${key.type} ${key.fingerprint}`).join('\n')}\n`, run: async () => {
        const temporary = await mkdtemp(path.join(directory, '.twig-known-'));
        try {
          const file = path.join(temporary, 'known_hosts'); await writeFile(file, next, { mode: 0o600 });
          const now = await regular(knownHosts, true);
          if ((now ? await readFile(knownHosts, 'utf8') : '') !== before) throw new Error(ui`known_hosts changed outside 🌱 Twig. Check the host again.`);
          await rename(file, knownHosts); await chmod(knownHosts, 0o600);
        } finally { await rm(temporary, { recursive: true, force: true }); }
      } });
    return { host, port, added: fresh.length };
  }
  return { keys, generate, secureKey, readConfig, saveConfig, testConnection, addHost, scanHost, trustHost };
}
