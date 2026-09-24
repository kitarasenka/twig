/**
 * Background fetch — the one piece of network work 🌱 Twig may do on its own,
 * and only after the person turns it on in Settings (it starts Off).
 *
 * It fetches the repository in the active tab, and nothing else, every
 * `interval` minutes, so the Pull and Push badges say what the server has
 * instead of what the last manual fetch knew. There is no timer at all while
 * it is off or no repository is open: one `setTimeout` is armed for the next
 * due fetch and re-armed after it.
 *
 * It gets out of the way of the person: a fetch is not started while one of
 * their actions runs on that repository, and one already running is cancelled
 * the moment an action starts (a pull or push racing it would contend for the
 * same ref locks). A failed fetch (offline, credentials) waits for the next
 * interval instead of retrying in a loop.
 *
 * No imports from Electron, so the Node check drives it with a fake clock.
 */

/** Minutes between fetches; 0 is Off. */
export const FETCH_INTERVALS = Object.freeze([0, 5, 15, 30, 60]);
/** A repository never fetched in this session is fetched this soon after it becomes active. */
export const FIRST_FETCH_DELAY = 10_000;
/** A fetch that had to wait for, or was cancelled by, the person's action tries again this soon. */
export const RETRY_DELAY = 60_000;

/**
 * `--all` so every remote's branches are current, `--no-tags` so new tags are
 * only ever brought in by a fetch the person ran, and no submodule recursion.
 * Only remote-tracking refs move; the branches, HEAD, index and files do not.
 */
export const BACKGROUND_FETCH_ARGV = Object.freeze(['fetch', '--all', '--no-tags', '--no-recurse-submodules']);

export function normalizeFetchSettings(value) {
  const interval = value && typeof value === 'object' ? value.interval : 0;
  return { interval: FETCH_INTERVALS.includes(interval) ? interval : 0 };
}

/**
 * @param {{
 *   run: (cwd: string, signal: AbortSignal) => Promise<{ ok: boolean, cancelled?: boolean, message?: ?string }>,
 *   isBusy?: (cwd: string) => boolean,
 *   onUpdate?: (cwd: string) => void,
 *   now?: () => number, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout
 * }} options
 */
export function createFetchScheduler({ run, isBusy = () => false, onUpdate = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let interval = 0;
  let target = null;
  let timer = null;
  let dueAt = null;
  const states = new Map();
  const controllers = new Map();

  const state = cwd => {
    if (!states.has(cwd)) states.set(cwd, { lastAttempt: null, lastSuccess: null, error: null, running: false, retryAt: null });
    return states.get(cwd);
  };

  function disarm() {
    if (timer !== null) clearTimer(timer);
    timer = null; dueAt = null;
  }

  function arm() {
    disarm();
    if (!interval || !target) return;
    const current = state(target);
    if (current.running) return;
    const due = current.retryAt ?? (current.lastAttempt === null ? now() + FIRST_FETCH_DELAY : current.lastAttempt + interval * 60_000);
    dueAt = due;
    timer = setTimer(() => { timer = null; dueAt = null; void tick(); }, Math.max(0, due - now()));
  }

  async function tick() {
    const cwd = target;
    if (!interval || !cwd) return;
    const current = state(cwd);
    if (isBusy(cwd)) { current.retryAt = now() + RETRY_DELAY; arm(); return; }
    const controller = new AbortController();
    controllers.set(cwd, controller);
    current.running = true; current.retryAt = null;
    onUpdate(cwd);
    let result;
    try { result = await run(cwd, controller.signal); } catch (error) { result = { ok: false, message: error.message }; }
    controllers.delete(cwd);
    current.running = false;
    if (result.cancelled) current.retryAt = now() + RETRY_DELAY;
    else {
      current.lastAttempt = now();
      if (result.ok) { current.lastSuccess = current.lastAttempt; current.error = null; }
      else current.error = result.message || 'The background fetch failed.';
    }
    onUpdate(cwd);
    arm();
  }

  return {
    /** @param {number} minutes one of FETCH_INTERVALS */
    configure(minutes) {
      interval = normalizeFetchSettings({ interval: minutes }).interval;
      if (!interval) for (const controller of controllers.values()) controller.abort();
      arm();
    },
    /** The repository in the active tab, or null. */
    follow(cwd) {
      if (cwd === target) return;
      target = cwd || null;
      arm();
    },
    /** A person's action is starting on `cwd`: a background fetch there gives way. */
    cancel(cwd) { controllers.get(cwd)?.abort(); },
    status(cwd) {
      const current = cwd ? state(cwd) : null;
      return {
        interval,
        lastSuccess: current?.lastSuccess ?? null, lastAttempt: current?.lastAttempt ?? null,
        error: current?.error ?? null, running: Boolean(current?.running),
        nextAt: cwd && cwd === target ? dueAt : null
      };
    },
    stop() { disarm(); for (const controller of controllers.values()) controller.abort(); target = null; }
  };
}
