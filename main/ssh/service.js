import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { runSsh } from './exec.js';

const digest = content => createHash('sha256').update(content).digest('hex');
const leaf = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(value)) throw new TypeError('Invalid SSH key filename.');
  return value;
};
const text = value => typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value);

export function publicKeyInfo(content) {
  const [type, encoded] = content.trim().split(/\s+/);
  if (!encoded || !/^(ssh-|ecdsa-|sk-)/.test(type) || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Not an SSH public key.');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 8 || bytes.readUInt32BE(0) > bytes.length - 4 || bytes.subarray(4, 4 + bytes.readUInt32BE(0)).toString() !== type) throw new Error('Invalid public key encoding.');
  return { type, fingerprint: `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}` };
}

export function validationCopy(content) {
  // ssh -G can run Match exec. Check its syntax but never execute user commands to validate a file.
  return content.split(/\r?\n/).map((line, index) => {
    if (/^\s*include(?:\s|=)/i.test(line)) {
      if (!line.replace(/^\s*include(?:\s+|\s*=\s*)/i, '').trim()) throw new Error(`Include needs a path on line ${index + 1}.`);
      return '# Include paths are validated when SSH opens the connection.';
    }
    if (/^\s*match(?:\s|=)/i.test(line)) {
      const value = line.replace(/^\s*match(?:\s*=\s*|\s+)/i, '');
      const tokens = []; let token = ''; let quote = ''; let escaped = false;
      for (const character of value) {
        if (escaped) { token += character; escaped = false; }
        else if (character === '\\') escaped = true;
        else if (quote) { if (character === quote) quote = ''; else token += character; }
        else if (character === '"' || character === "'") quote = character;
        else if (/\s/.test(character)) { if (token) { tokens.push(token); token = ''; } }
        else if (character === '#' && !token) break;
        else token += character;
      }
      if (quote || escaped) throw new Error(`Unclosed Match argument on line ${index + 1}.`);
      if (token) tokens.push(token);
      for (let at = 0; at < tokens.length; at++) {
        const criterion = tokens[at].replace(/^!/, '').toLowerCase();
        if (['all', 'canonical', 'final'].includes(criterion)) continue;
        if (!tokens[at + 1]) throw new Error(`Missing Match argument on line ${index + 1}.`);
        if (criterion === 'exec') { tokens[at] = tokens[at].startsWith('!') ? '!host' : 'host'; tokens[at + 1] = 'twig-validation.invalid'; }
        at++;
      }
      return `Match ${tokens.map(token => JSON.stringify(token)).join(' ')}`;
    }
    return line;
  }).join('\n');
}

export function createSshService({ home, log }) {
  const directory = path.join(home, '.ssh'); const configFile = path.join(directory, 'config');
  async function ensureDirectory() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('SSH settings must use a regular .ssh directory.');
    await chmod(directory, 0o700);
  }
  async function regular(file, optional = false) {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error('SSH file is not a regular file or is too large.');
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
      } catch { result.push({ name, error: 'Could not read a valid public key.' }); }
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }
  async function generate({ name, comment, passphrase }) {
    leaf(name);
    if (name.endsWith('.pub') || ['config', 'known_hosts', 'authorized_keys'].includes(name)) throw new TypeError('Choose a new key filename.');
    if (!text(comment) || !text(passphrase) || !passphrase) throw new TypeError('Enter a single-line comment and a non-empty passphrase.');
    await ensureDirectory();
    const destination = path.join(directory, name);
    if (await regular(destination, true) || await regular(`${destination}.pub`, true)) throw new Error('This key filename already exists.');
    const temporary = await mkdtemp(path.join(directory, '.twig-key-'));
    try {
      const key = path.join(temporary, 'key');
      const result = await runSsh({ executable: 'ssh-keygen', argv: ['-q', '-t', 'ed25519', '-f', key, '-C', comment], cwd: directory, log, stdin: `${passphrase}\n${passphrase}\n` });
      if (result.code !== 0) throw new Error('ssh-keygen did not create the key. Show output in the console.');
      await copyFile(key, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600);
      await copyFile(`${key}.pub`, `${destination}.pub`, constants.COPYFILE_EXCL); await chmod(`${destination}.pub`, 0o644);
      return keys();
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function secureKey(name) {
    leaf(name);
    if (!name.endsWith('.pub')) throw new TypeError('Choose a listed public key.');
    await ensureDirectory();
    const file = path.join(directory, name.slice(0, -4));
    await regular(path.join(directory, name)); await regular(file);
    await chmod(file, 0o600);
    return keys();
  }
  async function saveConfig(content, expected) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024 || content.includes('\0') || typeof expected !== 'string') throw new TypeError('Invalid SSH configuration.');
    await ensureDirectory();
    const before = await readConfig();
    if (before.digest !== expected) throw new Error('SSH config changed outside 🌱 Twig. Reload before saving.');
    const temporary = await mkdtemp(path.join(directory, '.twig-config-'));
    try {
      const check = path.join(temporary, 'check'); await writeFile(check, validationCopy(content), { mode: 0o600 });
      const result = await runSsh({ executable: 'ssh', argv: ['-G', '-F', check, '-o', 'CanonicalizeHostname=no', 'twig-validation.invalid'], cwd: directory, log, quiet: true });
      if (result.code !== 0) throw new Error(`SSH rejected the configuration: ${result.stderr.slice(0, 1000)}`);
      if ((await readConfig()).digest !== expected) throw new Error('SSH config changed during validation. Reload before saving.');
      const backup = before.exists ? `${configFile}.twig-backup-${randomUUID()}` : null;
      if (backup) await writeFile(backup, before.content, { flag: 'wx', mode: 0o600 });
      const next = path.join(temporary, 'config'); await writeFile(next, content, { mode: 0o600 });
      await rename(next, configFile); await chmod(configFile, 0o600);
      return { ...await readConfig(), backup };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }
  async function testConnection(target, signal) {
    if (typeof target !== 'string' || target.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9_.@-]*$/.test(target)) throw new TypeError('Enter an SSH host alias or user@host.');
    const config = await readConfig();
    return runSsh({ executable: 'ssh', argv: ['-T', '-F', config.exists ? configFile : process.platform === 'win32' ? 'NUL' : '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', target], cwd: home, log, signal });
  }
  return { keys, generate, secureKey, readConfig, saveConfig, testConnection };
}
