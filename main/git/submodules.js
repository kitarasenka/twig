import { stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateFile } from './commit.js';

/**
 * Submodules: other repositories pinned at one commit inside this one.
 *
 * The pinned commit is the gitlink in the index (`ls-files --stage`, mode
 * 160000), the name and URL come from `.gitmodules`, and what is actually
 * checked out is read from the submodule's own HEAD. The human output of
 * `git submodule status` is not parsed: its paths are neither quoted nor
 * NUL-separated.
 */

/** `git ls-files --stage -z` → the gitlinks: `[{ path, pinned }]`. */
export function parseGitlinks(output) {
  const links = [];
  for (const record of output.split('\0')) {
    if (!record) continue;
    const match = /^(\d{6}) ([0-9a-f]{40,64}) (\d)\t(.+)$/s.exec(record);
    if (!match) throw new Error('Invalid ls-files output');
    // Stage 2/3 gitlinks of a conflict repeat the path; the ours-side (2) is what is checked out.
    if (match[1] === '160000' && (match[3] === '0' || match[3] === '2')) links.push({ path: match[4], pinned: match[2] });
  }
  return links;
}

/**
 * `git config -f .gitmodules -z --get-regexp ^submodule\.` → by name.
 * A name may itself contain dots, so the key is the last component and the
 * name everything between the first and the last dot.
 */
export function parseGitmodules(output) {
  const modules = new Map();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const split = record.indexOf('\n');
    const key = split < 0 ? record : record.slice(0, split);
    const value = split < 0 ? '' : record.slice(split + 1);
    const last = key.lastIndexOf('.');
    if (!key.startsWith('submodule.') || last <= 'submodule.'.length) continue;
    const name = key.slice('submodule.'.length, last);
    const entry = modules.get(name) || { name, path: null, url: null, branch: null };
    const field = key.slice(last + 1);
    if (field === 'path' || field === 'url' || field === 'branch') entry[field] = value;
    modules.set(name, entry);
  }
  return [...modules.values()];
}

/** A URL as the screen shows it: credentials never leave main. */
export function displayUrl(url) {
  if (!url) return null;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@\s]*@/i, '$1');
}

async function exists(target) {
  try { await stat(target); return true; } catch { return false; }
}

/**
 * @param {{ cwd: string, log: object }} options
 * @returns {Promise<Array<{ path: string, name: ?string, url: ?string, branch: ?string, pinned: string, head: ?string, state: 'uninitialized'|'pinned'|'moved' }>>}
 */
export async function loadSubmodules({ cwd, log }) {
  const staged = await runGit({ cwd, log, argv: ['ls-files', '--stage', '-z'], operation: 'Read submodules' });
  if (staged.code !== 0) throw new Error('Git could not read the index.');
  const links = parseGitlinks(staged.stdout);
  if (!links.length) return [];
  const config = await runGit({ cwd, log, argv: ['config', '--file', '.gitmodules', '-z', '--get-regexp', '^submodule[.]'], operation: 'Read submodule settings' });
  const modules = config.code === 0 ? parseGitmodules(config.stdout) : [];
  return Promise.all(links.map(async link => {
    const module = modules.find(entry => entry.path === link.path) || null;
    const directory = path.join(cwd, link.path);
    let head = null;
    if (await exists(path.join(directory, '.git'))) {
      const result = await runGit({ cwd: directory, log, argv: ['rev-parse', '--verify', '--quiet', 'HEAD'], operation: 'Read submodule commit' });
      head = result.code === 0 ? result.stdout.trim() : null;
    }
    return {
      path: link.path, name: module?.name ?? null, url: displayUrl(module?.url ?? null), branch: module?.branch ?? null,
      pinned: link.pinned, head, state: head === null ? 'uninitialized' : head === link.pinned ? 'pinned' : 'moved'
    };
  }));
}

/**
 * `git submodule update --init` for the given paths, or for all of them:
 * clones what is missing and checks each submodule out at its pinned commit
 * (detached, as Git always does). Git refuses rather than overwrite a
 * submodule's uncommitted changes.
 */
export function buildSubmoduleUpdateArgv(paths = null, { recursive = false } = {}) {
  if (paths !== null && (!Array.isArray(paths) || paths.length === 0 || paths.length > 500)) throw new TypeError('Invalid submodule paths');
  (paths || []).forEach(validateFile);
  return ['submodule', 'update', '--init', ...(recursive ? ['--recursive'] : []), '--', ...(paths || [])];
}

/** @param {{ cwd: string, log: object, paths?: ?string[], recursive?: boolean, signal?: ?AbortSignal }} options */
export async function updateSubmodules({ cwd, log, paths = null, recursive = false, signal = null }) {
  const argv = buildSubmoduleUpdateArgv(paths, { recursive });
  const result = await runGit({ cwd, log, argv, signal, operation: paths?.length === 1 ? `Update submodule ${paths[0]}` : 'Update submodules' });
  if (signal?.aborted) return { ok: false, cancelled: true, message: 'Submodule update cancelled.' };
  if (result.code !== 0) return { ok: false, cancelled: false, message: 'git submodule update did not finish. Show output in the console.' };
  return { ok: true, cancelled: false, message: null };
}

/**
 * The folder of an initialized submodule named by the screen, checked
 * against the gitlinks just read — the renderer's path is only a key.
 */
export async function submoduleDirectory({ cwd, log, path: wanted }) {
  validateFile(wanted);
  const found = (await loadSubmodules({ cwd, log })).find(entry => entry.path === wanted);
  if (!found) throw new TypeError('There is no such submodule.');
  if (found.state === 'uninitialized') throw new Error(`${wanted} is not initialized yet. Update it first.`);
  return path.join(cwd, found.path);
}
