/**
 * When the Worktrees board reads Git. Twenty agents committing at once moved a
 * branch every half second, each move read every worktree, and a superseded
 * read ran to its end anyway: 1043 processes in twelve seconds. So one read runs
 * at a time, what arrives meanwhile becomes one read after it, and reads nobody
 * asked for keep `gap` apart. `urgent` (Refresh, the screen opening) skips the
 * wait; `fresh` reads every worktree, and asks of the merged read what any of
 * the requests asked. No imports: Vite and the Node check both load this module.
 */

export const BOARD_GAP = 2500;

export function createBoardRefresh({ read, gap = BOARD_GAP, now = Date.now, later = setTimeout, cancel = clearTimeout }) {
  let running = false;
  let wanted = null;
  let timer = null;
  let finished = -Infinity;
  let stopped = false;

  function pump() {
    if (running || stopped || !wanted) return;
    const wait = wanted.urgent ? 0 : Math.max(0, finished + gap - now());
    if (wait > 0) { timer ??= later(() => { timer = null; pump(); }, wait); return; }
    if (timer !== null) { cancel(timer); timer = null; }
    const { fresh } = wanted;
    wanted = null; running = true;
    Promise.resolve().then(() => read(fresh)).catch(() => {}).finally(() => { running = false; finished = now(); pump(); });
  }

  return {
    request({ fresh = false, urgent = false } = {}) {
      wanted = { fresh: fresh || Boolean(wanted?.fresh), urgent: urgent || Boolean(wanted?.urgent) };
      pump();
    },
    stop() { stopped = true; wanted = null; if (timer !== null) { cancel(timer); timer = null; } }
  };
}
