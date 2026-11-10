import { randomUUID } from 'node:crypto';
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * What a failed Git command said, carried to the window with the failure.
 *
 * An Error thrown in main reaches the renderer as its message alone, so the
 * reason travels inside it after DETAIL_MARK, as JSON: `reason` is the tail of
 * Git's output (credentials already cut out by `gitReason`), `hooks` the
 * executable hooks that ran for it. `failureText` in the renderer cuts the mark
 * and everything after it off, so a window that does not read the reason shows
 * the sentence as before; `renderer/src/app/git-failure.js` reads it.
 * The same mark, character for character, is in both of those files.
 */
export const DETAIL_MARK = '\u0000twig:detail\u0000';

/** The message with the reason behind the mark, or the message alone when there is none. */
export function withDetail(message, { reason = '', hooks = [] } = {}) {
  if (!reason && !hooks.length) return message;
  return `${message}${DETAIL_MARK}${JSON.stringify({ reason, hooks })}`;
}

/** An error crossing IPC with its `detail` and `hooks` kept: a TypeError stays itself, it rejects the request. */
export function carryDetail(error) {
  if (!(error instanceof Error) || error instanceof TypeError || (!error.detail && !error.hooks?.length)) return error;
  if (error.message.includes(DETAIL_MARK)) return error;
  return new Error(withDetail(error.message, { reason: error.detail || '', hooks: error.hooks || [] }));
}

/**
 * The executable hooks among `names`, where Git looks for them (`core.hooksPath`
 * honoured: `rev-parse --git-path hooks` answers with it). Only read after a
 * failure, to say which hook could have stopped it.
 */
export async function presentHooks({ cwd, log, names }) {
  const result = await runGit({ argv: ['rev-parse', '--git-path', 'hooks'], cwd, log, operation: 'Read the hooks folder' });
  if (result.code !== 0) return [];
  const folder = path.resolve(cwd, result.stdout.trim());
  const found = [];
  for (const name of names) {
    const info = await stat(path.join(folder, name)).catch(() => null);
    if (info?.isFile() && (process.platform === 'win32' || (info.mode & 0o111))) found.push(name);
  }
  return found;
}

const inside = (folder, file) => {
  const relative = path.relative(folder, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * Deletes a `*.lock` file Git left behind ("Unable to create '…/index.lock':
 * File exists"). The path comes from Git's own message, so it is checked here
 * before anything is removed: absolute, a regular file (not a link, not a
 * folder) named `*.lock`, inside this repository's Git directory or its common
 * directory (a linked worktree keeps its index in the first, refs in the
 * second). `busy` says whether 🌱 Twig itself is running Git in this
 * repository right now — then the lock may well be its own, and is kept.
 * Another program holding the lock (an editor opened by `git commit` in a
 * terminal) cannot be seen from here; the window asks the person about that
 * before calling this. Journaled as `🌱 Twig remove <path>`.
 * @returns {Promise<{ ok: boolean, message: ?string }>}
 */
export async function removeLock({ cwd, log, file, busy = false }) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.lock') || file.includes('\0')) {
    throw new TypeError('Invalid lock path');
  }
  if (busy) return { ok: false, message: ui`🌱 Twig is running Git in this repository right now. Try again in a moment.` };
  const dirs = await runGit({ argv: ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], cwd, log, operation: 'Read the Git directory' });
  if (dirs.code !== 0) return { ok: false, message: ui`Git could not read this repository.` };
  const roots = await Promise.all(dirs.stdout.split('\n').filter(Boolean).map(dir => realpath(dir).catch(() => dir)));
  const parent = await realpath(path.dirname(file)).catch(() => null);
  const target = parent && path.join(parent, path.basename(file));
  if (!target || !roots.some(root => inside(root, target))) return { ok: false, message: ui`That file is not a lock of this repository.` };
  const info = await lstat(target).catch(() => null);
  if (!info) return { ok: true, message: ui`The lock is already gone.` };
  if (!info.isFile()) return { ok: false, message: ui`That lock is not a plain file, so 🌱 Twig leaves it alone.` };

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  await log.start({ id, executable: '🌱 Twig', argv: ['remove', target], cwd, startedAt, operation: 'Remove a stale Git lock' });
  try {
    await rm(target);
    await log.finish(id, { code: 0, stdout: '', stderr: '', cancelled: false, ms: Math.round(performance.now() - started), startedAt });
    return { ok: true, message: null };
  } catch (error) {
    await log.output(id, 'stderr', `${error.message}\n`);
    await log.finish(id, { code: 1, stdout: '', stderr: error.message, cancelled: false, ms: Math.round(performance.now() - started), startedAt });
    return { ok: false, message: ui`Could not remove the lock. See the command console.` };
  }
}

/**
 * How many commits only a detached HEAD holds: no branch, tag or remote
 * branch reaches them, so checking out something else leaves them to the
 * reflog. `refs/twig/*` (🌱 Twig's own backups) and the stash do not count.
 */
export async function countDetachedCommits({ cwd, log }) {
  // Exit code 0 either way (a probe that fails reads as a failure in the journal): `HEAD` means detached.
  const head = await runGit({ argv: ['rev-parse', '--symbolic-full-name', 'HEAD'], cwd, log, operation: 'Read whether HEAD is detached' });
  if (head.code !== 0 || head.stdout.trim() !== 'HEAD') return 0;
  const result = await runGit({ argv: ['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes', '--'], cwd, log, operation: 'Read commits on no branch' });
  if (result.code !== 0) return 0;
  return Number.parseInt(result.stdout.trim(), 10) || 0;
}
