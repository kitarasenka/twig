import path from 'node:path';
import { runGit } from './exec.js';

export const hasControlCharacters = value => [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

export function validateRemoteName(name) {
  if (typeof name !== 'string' || name.length > 255 || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)
    || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) throw new TypeError('Invalid remote name.');
  return name;
}

export function validateRepositoryUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || hasControlCharacters(value) || value.includes(' ') || value.startsWith('-')) {
    // Spaces are valid in absolute local paths, but never in transport URLs.
    if (typeof value === 'string' && value.length <= 4096 && path.isAbsolute(value) && !hasControlCharacters(value)) return value;
    throw new TypeError('Enter an HTTPS, SSH, Git or local repository address.');
  }
  if (path.isAbsolute(value)) return value;
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[^:]/.test(value)) return value;
  let url;
  try { url = new URL(value); } catch { throw new TypeError('Enter a full repository URL or an absolute local path.'); }
  if (!['https:', 'http:', 'ssh:', 'git:', 'file:'].includes(url.protocol)) throw new TypeError('Unsupported repository transport.');
  if (url.password || url.search || url.hash || (['http:', 'https:'].includes(url.protocol) && url.username)) {
    throw new TypeError('Use a credential helper instead of credentials or tokens in the URL.');
  }
  return value;
}

export function parseRemotes(output) {
  const remotes = new Map();
  if (!output) return [];
  if (!output.endsWith('\0')) throw new Error('Incomplete remote configuration.');
  for (const record of output.slice(0, -1).split('\0')) {
    const separator = record.indexOf('\n');
    const match = record.slice(0, separator).match(/^remote[.](.+)[.](url|pushurl)$/);
    if (separator < 0 || !match) throw new Error('Unexpected remote configuration.');
    const [, name, kind] = match;
    if (!remotes.has(name)) remotes.set(name, { name, urls: [], pushUrls: [] });
    remotes.get(name)[kind === 'url' ? 'urls' : 'pushUrls'].push(record.slice(separator + 1));
  }
  return [...remotes.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function loadRemotes({ cwd, log }) {
  // Existing configs can contain tokens even though Twig refuses to create such URLs.
  // Buffer this short config read so credentials split across chunks never reach disk.
  const safeLog = {
    start: entry => log.start(entry),
    output: async () => {},
    finish: async (id, result) => {
      const stdout = result.stdout.split('\0').map(record => {
        if (!record) return '';
        const split = record.indexOf('\n');
        if (split < 0) return '[unrecognized remote record hidden]';
        try { validateRepositoryUrl(record.slice(split + 1)); return record; }
        catch { return `${record.slice(0, split)}\n[address hidden: unsupported or credential-bearing URL]`; }
      }).join('\0');
      const stderr = result.stderr ? '[Git reported a remote configuration error; output hidden to protect stored credentials.]\n' : '';
      if (stdout) await log.output(id, 'stdout', stdout);
      if (stderr) await log.output(id, 'stderr', stderr);
      await log.finish(id, { ...result, stdout, stderr });
    }
  };
  const result = await runGit({ cwd, log: safeLog, argv: ['config', '--null', '--get-regexp', '^remote[.].*[.](url|pushurl)$'], operation: 'Read remotes' });
  if (result.code !== 0 && result.code !== 1) throw new Error('Could not read remotes. Show output in the console.');
  return parseRemotes(result.stdout);
}

export async function changeRemote({ cwd, log, action, name, url = null, expected = null, signal = null }) {
  validateRemoteName(name);
  if (!['add', 'set-url', 'remove', 'fetch'].includes(action)) throw new TypeError('Invalid remote action.');
  if (action === 'add' || action === 'set-url') validateRepositoryUrl(url);
  else if (url !== null) throw new TypeError('Unexpected remote URL.');
  if (expected !== null && (typeof expected !== 'string' || expected.length > 32768)) throw new TypeError('Invalid remote snapshot.');
  const remotes = await loadRemotes({ cwd, log });
  const previous = remotes.find(remote => remote.name === name);
  if (action === 'add' ? Boolean(previous) : !previous) throw new Error(action === 'add' ? 'A remote with this name already exists.' : 'This remote no longer exists. Reload the list.');
  if (action !== 'add' && JSON.stringify(previous) !== expected) throw new Error('This remote changed outside 🌱 Twig. Reload the list before continuing.');
  if (action === 'fetch') for (const address of previous.urls) validateRepositoryUrl(address);
  if (signal?.aborted) return { ok: false, cancelled: true };
  const argv = action === 'fetch' ? ['fetch', '--progress', '--prune', '--', name]
    : ['remote', action, '--', name, ...(['add', 'set-url'].includes(action) ? [url] : [])];
  const result = await runGit({ cwd, log, argv, signal, operation: `${action === 'fetch' ? 'Fetch and prune' : `Remote ${action}`}: ${name}` });
  if (result.cancelled) return { ok: false, cancelled: true };
  if (result.code !== 0) throw new Error('Git could not finish the remote action. Show output in the console.');
  return { ok: true, cancelled: false };
}
