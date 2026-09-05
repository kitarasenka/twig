import { mkdir, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { hasControlCharacters, validateRepositoryUrl } from './remotes.js';

export function validateCloneName(name) {
  if (typeof name !== 'string' || !name || name.length > 180 || /[<>:"/\\|?*]/.test(name) || hasControlCharacters(name)
    || /^[. -]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])([.]|$)/i.test(name)) {
    throw new TypeError('Choose a new folder name without path separators or reserved characters.');
  }
  return name;
}

export async function cloneRepository({ parent, name, url, log, signal }) {
  validateCloneName(name); validateRepositoryUrl(url);
  if (signal?.aborted) return { ok: false, cancelled: true, path: null };
  const cwd = await realpath(parent);
  const target = path.join(cwd, name);
  try { await mkdir(target); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('That folder already exists. Choose a new folder name.');
    throw new Error('Could not create the destination folder. Check its location and permissions.');
  }
  try {
    if (signal?.aborted) return { ok: false, cancelled: true, path: target };
    const result = await runGit({ cwd, log, argv: ['clone', '--progress', '--', url, target], signal, operation: 'Clone repository' });
    if (result.cancelled) return { ok: false, cancelled: true, path: target };
    if (result.code !== 0) throw new Error('Clone did not finish. Show output in the console. Any remaining files are kept at the chosen destination.');
    return { ok: true, cancelled: false, path: target };
  } finally {
    // Only an empty directory is removable; never recursively clean up a failed clone.
    await rmdir(target).catch(() => {});
  }
}
