import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';

/**
 * Git LFS: files kept on an LFS server, with only a small pointer committed.
 *
 * Whether a repository uses LFS is read from its committed `.gitattributes`
 * (`filter=lfs`), which needs no git-lfs at all — so a repository that uses it
 * on a machine without it is recognised, and the person is told why its large
 * files are three lines of text. With git-lfs installed, `git lfs ls-files`
 * says which of those files are still pointers in the working tree.
 */

/** How many not-yet-downloaded paths are named, beyond the count. */
const NAMED = 20;

/**
 * `git lfs ls-files --long`: `<sha256> <*|-> <path>`, where `*` is a file
 * whose content is in the working tree and `-` one that is still a pointer.
 * @param {string} output
 */
export function parseLfsFiles(output) {
  const files = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const match = /^([0-9a-f]{64}) ([*-]) (.+)$/.exec(line);
    if (!match) throw new Error('Invalid git lfs ls-files output');
    files.push({ oid: match[1], present: match[2] === '*', path: match[3] });
  }
  return files;
}

/** `git-lfs/3.4.1 (GitHub; darwin arm64; go 1.21.5)` → `3.4.1`. */
export function parseLfsVersion(output) {
  return /git-lfs\/(\d+(?:\.\d+)+)/.exec(output)?.[1] ?? null;
}

/**
 * Whether `git lfs` would find its program, looked up the way Git does (its
 * exec path, then PATH) without running a command that is bound to fail — a
 * failed entry in the journal would take "Show output" away from a real error.
 */
export async function findLfsProgram({ cwd, log, env = process.env, platform = process.platform }) {
  const execPath = await runGit({ cwd, log, argv: ['--exec-path'], operation: 'Read Git exec path' });
  const directories = [execPath.code === 0 ? execPath.stdout.trim() : null, ...(env.PATH || '').split(path.delimiter)].filter(Boolean);
  const names = platform === 'win32' ? ['git-lfs.exe', 'git-lfs.cmd', 'git-lfs.bat'] : ['git-lfs'];
  for (const directory of directories) {
    for (const name of names) {
      try { await access(path.join(directory, name), platform === 'win32' ? constants.F_OK : constants.X_OK); return path.join(directory, name); } catch { /* not here */ }
    }
  }
  return null;
}

/**
 * @param {{ cwd: string, log: object }} options
 * @returns {Promise<{ used: boolean, installed: ?boolean, version: ?string, files: number, missing: number, missingPaths: string[] }>}
 */
export async function loadLfsStatus({ cwd, log }) {
  const none = { used: false, installed: null, version: null, files: 0, missing: 0, missingPaths: [] };
  // Every read here exits 0 whatever it finds: a "no match" exit code would
  // read as a failed command in the journal, and "Show output" would point at it.
  const listed = await runGit({ cwd, log, argv: ['ls-files', '--cached', '-z', '--', ':(glob)**/.gitattributes'], operation: 'Read whether the repository uses Git LFS' });
  if (listed.code !== 0) throw new Error('Git could not list .gitattributes.');
  const files = listed.stdout.split('\0').filter(file => file && !file.includes('\n'));
  if (!files.length) return none;
  const attributes = await runGit({ cwd, log, argv: ['cat-file', '--batch'], stdin: files.map(file => `:${file}\n`).join(''), operation: 'Read .gitattributes for Git LFS' });
  if (attributes.code !== 0) throw new Error('Git could not read .gitattributes.');
  if (!/\bfilter=lfs\b/.test(attributes.stdout)) return none;
  if (!await findLfsProgram({ cwd, log })) return { ...none, used: true, installed: false };
  const version = await runGit({ cwd, log, argv: ['lfs', 'version'], operation: 'Read Git LFS version' });
  if (version.code !== 0) return { ...none, used: true, installed: false };
  const tracked = await runGit({ cwd, log, argv: ['lfs', 'ls-files', '--long'], operation: 'Read Git LFS files' });
  if (tracked.code !== 0) throw new Error('git lfs could not list the files it tracks.');
  const lfsFiles = parseLfsFiles(tracked.stdout);
  const missing = lfsFiles.filter(file => !file.present);
  return { used: true, installed: true, version: parseLfsVersion(version.stdout), files: lfsFiles.length,
    missing: missing.length, missingPaths: missing.slice(0, NAMED).map(file => file.path) };
}

/**
 * Downloads the LFS content of the checked-out files and puts it in place of
 * their pointers. Only files whose working copy is a pointer change on disk;
 * the index, HEAD and every ref stay where they are. It reaches the network
 * like a fetch does, so it can be cancelled.
 * @param {{ cwd: string, log: object, signal?: ?AbortSignal }} options
 */
export async function pullLfs({ cwd, log, signal = null }) {
  const result = await runGit({ cwd, log, signal, argv: ['lfs', 'pull'], operation: 'Download Git LFS files' });
  if (signal?.aborted) return { ok: false, cancelled: true, message: 'Git LFS download cancelled.' };
  if (result.code !== 0) return { ok: false, cancelled: false, message: 'git lfs pull did not finish. Show output in the console.' };
  return { ok: true, cancelled: false, message: null };
}
