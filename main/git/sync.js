import { runGit } from './exec.js';
import { loadRefs } from './refs.js';

/**
 * Network operations. Each one takes an AbortSignal because the brief
 * requires pull and push to be cancellable; credentials never block them
 * silently, because exec.js already pins GIT_TERMINAL_PROMPT=0 and its own
 * askpass, so a missing credential fails fast instead of hanging invisibly.
 */

const MODES = {
  fetch: () => ['fetch'],
  'fetch-prune': () => ['fetch', '--prune'],
  pull: () => ['pull', '--ff-only'],
  'pull-rebase': () => ['pull', '--rebase'],
  'pull-merge': () => ['pull', '--no-rebase'],
  push: () => ['push'],
  'push-upstream': branch => ['push', '--set-upstream', 'origin', branch],
  'push-force': () => ['push', '--force-with-lease']
};

/** `--force` is never offered: only `--force-with-lease`, per the brief. */
export function buildSyncArgv(mode, branch = null) {
  const build = Object.hasOwn(MODES, mode) ? MODES[mode] : null;
  if (!build) throw new TypeError('Unknown sync operation');
  if (mode === 'push-upstream') {
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-') || /[\s\0~^:?*[\\]/.test(branch)) {
      throw new TypeError('Invalid branch name');
    }
  }
  return build(branch);
}

export const DESTRUCTIVE = new Set(['push-force']);

const LABELS = {
  fetch: 'Fetch', 'fetch-prune': 'Fetch and prune', pull: 'Pull', 'pull-rebase': 'Pull with rebase',
  'pull-merge': 'Pull and merge', push: 'Push', 'push-upstream': 'Push and set upstream', 'push-force': 'Push with lease'
};

/**
 * @param {{ cwd: string, log: object, mode: string, branch?: ?string, signal?: ?AbortSignal }} options
 * @returns {Promise<{ ok: boolean, cancelled: boolean, message: ?string }>}
 */
export async function runSync({ cwd, log, mode, branch = null, signal = null }) {
  const argv = buildSyncArgv(mode, branch);
  const result = await runGit({ argv, cwd, log, operation: LABELS[mode], signal });
  if (result.cancelled) return { ok: false, cancelled: true, message: `${LABELS[mode]} was cancelled.` };
  if (result.code !== 0) return { ok: false, cancelled: false, message: `${LABELS[mode]} failed. Show output in the console.` };
  return { ok: true, cancelled: false, message: null };
}

/**
 * Divergence for the badges on Pull and Push. Counts come from
 * `git for-each-ref`, never from a network call, so this stays cheap and
 * works offline; it reports what the last fetch knows.
 * @param {{ cwd: string, log: object, branch: ?string }} options
 * @returns {Promise<{ ahead: number, behind: number, upstream: ?string }>}
 */
export async function loadDivergence({ cwd, log, branch }) {
  if (!branch) return { ahead: 0, behind: 0, upstream: null };
  const refs = await loadRefs({ cwd, log });
  const current = refs.find(ref => ref.type === 'local' && ref.name === branch);
  if (!current) return { ahead: 0, behind: 0, upstream: null };
  return { ahead: current.ahead, behind: current.behind, upstream: current.upstream };
}
