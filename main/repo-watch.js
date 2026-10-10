import fs from 'node:fs';
import { lstat, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tell the renderer when a repository changed on disk from outside 🌱 Twig — a
 * commit, checkout, fetch, branch edit or stash run from a terminal — so the
 * history can reload without the user pressing Refresh.
 *
 * This is event-driven, not a poll: a single `fs.watch` on the git directory,
 * debounced. No timer wakes up on its own. The git directory layout it leans on
 * (`HEAD`, `refs/`, `packed-refs`, the operation markers) is Git's documented
 * on-disk contract, the same one `operation-state.js` reads.
 *
 * No imports from `electron`: the window is passed in, so a Node check can drive
 * the watcher directly.
 */

// Ref tips, HEAD and the operation markers — the things a reload of the graph
// would show differently. `index` is deliberately absent: `git status` rewrites
// it opportunistically, which a reload of ours runs, and watching it invites a
// feedback loop. External `git add` is instead picked up on window focus.
// `FETCH_HEAD` is absent too: every fetch rewrites it, even the background one
// that brought nothing, while a fetch that did bring something moves refs.
const WATCHED = /(^|[/\\])(HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|packed-refs)$|(^|[/\\])(refs|logs|rebase-merge|rebase-apply|sequencer)([/\\]|$)/;
const DEBOUNCE_MS = 300;

/** Resolve the real git directory without spawning Git: `.git` is a directory, or a file pointing at one. */
export async function resolveGitDir(cwd) {
  const dot = path.join(cwd, '.git');
  let info;
  try { info = await stat(dot); } catch { return null; }
  if (info.isDirectory()) return dot;
  if (!info.isFile()) return null;
  const match = (await readFile(dot, 'utf8').catch(() => '')).match(/^gitdir:\s*(.+?)\s*$/m);
  if (!match) return null;
  const resolved = path.resolve(cwd, match[1]);
  return stat(resolved).then(entry => (entry.isDirectory() ? resolved : null)).catch(() => null);
}

// 🌱 Twig's own bookkeeping (the backups a discard or a .gitignore edit
// records): never drawn in the graph, so its writes are not a change to show.
const OWN_REFS = /(^|[/\\])refs[/\\]twig([/\\]|$)/;

export function isWatchedPath(filename) {
  if (!filename) return true; // some platforms omit the name; assume it mattered
  const name = String(filename);
  return !name.endsWith('.lock') && !OWN_REFS.test(name) && WATCHED.test(name);
}

/**
 * The folder to watch for `gitDir`. A linked worktree's git directory holds
 * only its own HEAD and index; its branches, tags and `packed-refs` live in
 * the repository's common directory, which a `commondir` file names. Watching
 * that one covers both (the worktree's own folder is inside it).
 */
export async function resolveWatchedDir(gitDir) {
  const file = path.join(gitDir, 'commondir');
  // A small regular file only: a FIFO here would hold a thread of the fs pool.
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size > 4096) return gitDir;
  const pointer = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!pointer) return gitDir;
  const common = path.resolve(gitDir, pointer);
  // Only the layout Git itself makes for a linked worktree: this directory is
  // <common>/worktrees/<name>, and the common directory has refs and objects.
  // A folder that did not come from `git clone` (an unpacked archive) can
  // carry any `commondir`; pointed at `/` or the home folder, the recursive
  // watch would cover all of it.
  const relative = path.relative(common, gitDir).split(path.sep);
  if (relative.length !== 2 || relative[0] !== 'worktrees') return gitDir;
  const [refs, objects] = await Promise.all(['refs', 'objects'].map(name => stat(path.join(common, name)).catch(() => null)));
  return refs?.isDirectory() && objects?.isDirectory() ? common : gitDir;
}

/**
 * @param {() => (import('electron').BrowserWindow | null)} getWindow
 * @param {number} [debounceMs]
 */
export function createRepositoryWatcher(getWindow, debounceMs = DEBOUNCE_MS) {
  let token = 0;
  let active = null; // { cwd, handle: fs.FSWatcher, timer: NodeJS.Timeout | null }

  function stop() {
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    try { active.handle?.close(); } catch { /* already gone */ }
    active = null;
  }

  async function watch(cwd) {
    if (active && active.cwd === cwd) return;
    stop();
    const mine = ++token; // bump before any await so a later watch() call wins the race
    if (!cwd) return;
    const ownDir = await resolveGitDir(cwd);
    const gitDir = ownDir && await resolveWatchedDir(ownDir);
    if (mine !== token || !gitDir) return;

    const state = { cwd, handle: null, timer: null, changedAt: 0 };
    // `changedAt`: when the last change of this burst reached the watch. The
    // window compares it with when it last read the refs, so it can tell a
    // change it has not seen from the echo of its own action — instead of
    // dropping every change that lands just after one of its reloads.
    const fire = () => {
      state.timer = null;
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('repo:external-change', { cwd, changedAt: state.changedAt });
    };
    const onEvent = (_type, filename) => {
      if (!isWatchedPath(filename)) return;
      state.changedAt = Date.now();
      if (state.timer) clearTimeout(state.timer);
      state.timer = setTimeout(fire, debounceMs);
    };
    try {
      state.handle = fs.watch(gitDir, { recursive: true, persistent: false }, onEvent);
    } catch {
      try { state.handle = fs.watch(gitDir, { persistent: false }, onEvent); }
      catch { return; } // no watch support here; the window-focus refresh still covers it
    }
    state.handle.on('error', () => {});
    if (mine !== token) { try { state.handle.close(); } catch { /* raced */ } return; }
    active = state;
  }

  return { watch, stop, get watching() { return active?.cwd ?? null; } };
}
