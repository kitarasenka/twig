import os from 'node:os';
import { gitReason } from './commit-ops.js';
import { findFetchRisks } from './config-risk.js';
import { runGit } from './exec.js';
import { buildRefsArgv, parseRefsV1 } from './refs.js';
import { loadOperationState } from './operation-state.js';
import { validateRefName } from './refs-ops.js';
import { loadRemotes, validateRemoteName, validateRemoteTransport, validateRepositoryUrl } from './remotes.js';
import { BACKGROUND_FETCH_ARGV } from '../background-fetch.js';
import { pushArgv, readPushPlan } from './push-plan.js';
import { redactCredentials } from './redact.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

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
  'push-upstream': (branch, remote) => ['push', '--set-upstream', remote, branch],
  'push-force': () => ['push', '--force-with-lease']
};

/** `--force` is never offered: only `--force-with-lease`, per the brief. */
export function buildSyncArgv(mode, branch = null, remote = 'origin') {
  const build = Object.hasOwn(MODES, mode) ? MODES[mode] : null;
  if (!build) throw new TypeError('Unknown sync operation');
  if (mode === 'push-upstream') {
    if (typeof branch !== 'string' || branch.length === 0 || branch.startsWith('-') || /[\s\0~^:?*[\\]/.test(branch)) {
      throw new TypeError('Invalid branch name');
    }
    validateRemoteName(remote);
  }
  return build(branch, remote);
}

export const DESTRUCTIVE = new Set(['push-force']);
// These never run as written above: `.git/config` could make a bare push go
// elsewhere, delete or force, so the argv comes from the push plan.
const PLANNED = new Set(['push', 'push-upstream', 'push-force']);

const LABELS = {
  fetch: 'Fetch', 'fetch-prune': 'Fetch and prune', pull: 'Pull', 'pull-rebase': 'Pull with rebase',
  'pull-merge': 'Pull and merge', push: 'Push', 'push-upstream': 'Push and set upstream', 'push-force': 'Push with lease'
};

// What the window says when a sync stops, one whole sentence per mode.
const CANCELLED = {
  fetch: ui`Fetch was cancelled.`, 'fetch-prune': ui`Fetch and prune was cancelled.`, pull: ui`Pull was cancelled.`,
  'pull-rebase': ui`Pull with rebase was cancelled.`, 'pull-merge': ui`Pull and merge was cancelled.`, push: ui`Push was cancelled.`,
  'push-upstream': ui`Push and set upstream was cancelled.`, 'push-force': ui`Push with lease was cancelled.`
};
const FAILED = {
  fetch: ui`Fetch failed. Show output in the console.`, 'fetch-prune': ui`Fetch and prune failed. Show output in the console.`,
  pull: ui`Pull failed. Show output in the console.`, 'pull-rebase': ui`Pull with rebase failed. Show output in the console.`,
  'pull-merge': ui`Pull and merge failed. Show output in the console.`, push: ui`Push failed. Show output in the console.`,
  'push-upstream': ui`Push and set upstream failed. Show output in the console.`, 'push-force': ui`Push with lease failed. Show output in the console.`
};

/** Why no network command runs here, or null: a remote whose address is a command. */
async function refusedRemote({ cwd, log }) {
  try {
    for (const remote of await loadRemotes({ cwd, log })) {
      for (const address of [...remote.urls, ...remote.pushUrls]) validateRemoteTransport(address);
    }
    return null;
  } catch (error) { return error.message; }
}

/**
 * Why a push was refused, from the status Git prints for the ref. `[rejected]`
 * and the words in brackets are the same in every language Git speaks; only the
 * hints around them are translated, so nothing else of the output is read.
 * @returns {?'behind'|'non-fast-forward'|'stale'|'remote'}
 */
export function pushRefusal(stderr) {
  const line = String(stderr).split('\n').find(text => /^\s*!\s+\[/.test(text));
  if (!line) return null;
  if (line.includes('[remote rejected]')) return 'remote';
  if (!line.includes('[rejected]')) return null;
  if (line.includes('(fetch first)')) return 'behind';
  if (line.includes('(stale info)')) return 'stale';
  return line.includes('(non-fast-forward)') ? 'non-fast-forward' : null;
}

/**
 * Whether this branch was once at its upstream's tip and moved off it — an
 * amend, a rebase, a reset — rather than being behind work somebody else
 * pushed. Only then is replacing the remote's history what the person did.
 */
async function wasRewritten({ cwd, log, branch, upstream }) {
  if (!branch || !upstream) return false;
  const tip = await runGit({ argv: ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`], cwd, log, operation: 'Read upstream tip' });
  if (tip.code !== 0) return false;
  const reflog = await runGit({ argv: ['log', '--walk-reflogs', '--format=%H', '--max-count=2000', `refs/heads/${branch}`, '--'], cwd, log, operation: 'Read branch reflog' });
  return reflog.code === 0 && reflog.stdout.split('\n').includes(tip.stdout.trim());
}

/**
 * What stopped a pull or a push, for the window to offer the way out. Nothing
 * here is shown as it stands: `kind` picks the sentence and the buttons.
 * `lease` is the exact command Push with lease would run.
 */
async function readRefusal({ cwd, log, mode, branch, stderr }) {
  if (mode === 'pull') {
    const { ahead, behind } = await loadDivergence({ cwd, log, branch });
    return ahead > 0 && behind > 0 ? { kind: 'diverged' } : null;
  }
  if (mode === 'pull-rebase' || mode === 'pull-merge') {
    const state = await loadOperationState({ cwd, log });
    return state.kind === 'none' ? null : { kind: 'stopped', operation: state.kind };
  }
  if (!mode.startsWith('push')) return null;
  const refused = pushRefusal(stderr);
  if (refused === 'remote') return { kind: 'remote' };
  if (refused === 'stale') return { kind: 'stale' };
  if (refused === 'behind') return { kind: 'behind' };
  if (refused !== 'non-fast-forward') return null;
  const { upstream } = await loadDivergence({ cwd, log, branch });
  if (!await wasRewritten({ cwd, log, branch, upstream })) return { kind: 'behind' };
  const plan = await readPushPlan({ cwd, log, branch });
  return plan.mode ? { kind: 'rewritten', lease: pushArgv(plan, { force: true }) } : { kind: 'behind' };
}

/**
 * `remote` is where Publish sends a branch with no upstream: it has to be one
 * of the configured remotes.
 * `plan`: the push a person confirmed (`readPushPlan`); without one it is read here.
 * @param {{ cwd: string, log: object, mode: string, branch?: ?string, remote?: ?string, signal?: ?AbortSignal, plan?: ?object }} options
 * @returns {Promise<{ ok: boolean, cancelled: boolean, message: ?string, reason?: string, refusal?: ?object }>}
 */
export async function runSync({ cwd, log, mode, branch = null, remote = null, signal = null, plan = null }) {
  let argv = buildSyncArgv(mode, branch, remote ?? 'origin');
  if (remote !== null && !(await loadRemotes({ cwd, log })).some(item => item.name === remote)) {
    throw new Error(ui`This remote is not configured any more. Reload the list.`);
  }
  if (PLANNED.has(mode)) {
    const push = plan ?? await readPushPlan({ cwd, log, branch, publish: remote });
    if (!push.mode) return { ok: false, cancelled: false, notStarted: true, message: push.reason, reason: push.reason };
    argv = mode === 'push-force' ? pushArgv(push, { force: true }) : push.argv;
  }
  const refused = await refusedRemote({ cwd, log });
  if (refused) return { ok: false, cancelled: false, message: refused, reason: refused };
  const result = await runGit({ argv, cwd, log, operation: LABELS[mode], signal, prompt: true });
  if (result.cancelled) return { ok: false, cancelled: true, message: CANCELLED[mode] };
  if (result.code !== 0) {
    const refusal = await readRefusal({ cwd, log, mode, branch, stderr: result.stderr }).catch(() => null);
    return { ok: false, cancelled: false, message: FAILED[mode], reason: gitReason(result), refusal };
  }
  return { ok: true, cancelled: false, message: null };
}

/**
 * Divergence for the badges on Pull and Push. Counts come from
 * `git for-each-ref`, never from a network call, so this stays cheap and
 * works offline; it reports what the last fetch knows.
 * @param {{ cwd: string, log: object, branch: ?string }} options
 * @returns {Promise<{ ahead: number, behind: number, upstream: ?string }>}
 */
/**
 * Ahead/behind of one branch, for the Pull and Push badges. It asks about that
 * branch alone: `%(upstream:track)` makes Git walk the history of every branch
 * it is asked about, and this used to read every ref to keep one of them.
 * A pattern also matches refs under it (`feat` → `feat/x`), hence the exact
 * name check after.
 */
export async function loadDivergence({ cwd, log, branch }) {
  if (!branch) return { ahead: 0, behind: 0, upstream: null };
  validateRefName(branch);
  const result = await runGit({ argv: buildRefsArgv([`refs/heads/${branch}`]), cwd, log, operation: 'Read branch divergence' });
  if (result.code !== 0) throw new Error(ui`Git could not read this branch.`);
  const current = parseRefsV1(result.stdout).find(ref => ref.type === 'local' && ref.name === branch);
  if (!current) return { ahead: 0, behind: 0, upstream: null };
  return { ahead: current.ahead, behind: current.behind, upstream: current.upstream };
}

/**
 * Publishing or removing one ref on a remote — the half of `git push` the
 * toolbar has no place for: sending a tag that would otherwise stay local
 * forever, and deleting a branch or tag that only exists on the server.
 *
 * The ref is spelled in full on both sides (`refs/tags/x:refs/tags/x`) so the
 * remote side is never guessed from a short name or mapped by
 * `remote.<r>.push`, and it sits behind `--` so a ref that looks like an option
 * stays a ref.
 */
export function buildPushRefArgv({ remote, ref, remove = false }) {
  validateRemoteName(remote);
  const match = /^refs\/(heads|tags)\/(.+)$/.exec(typeof ref === 'string' ? ref : '');
  if (!match) throw new TypeError('A ref to push must be refs/heads/… or refs/tags/…');
  validateRefName(match[2]);
  return ['push', '--progress', ...(remove ? ['--delete'] : []), remote, '--', remove ? ref : `${ref}:${ref}`];
}

/**
 * @param {{ cwd: string, log: object, remote: string, ref: string, remove?: boolean, signal?: ?AbortSignal }} options
 * @returns {Promise<{ ok: boolean, cancelled: boolean, message: ?string }>}
 */
export async function pushRef({ cwd, log, remote, ref, remove = false, signal = null }) {
  const argv = buildPushRefArgv({ remote, ref, remove });
  const configured = (await loadRemotes({ cwd, log })).find(item => item.name === remote);
  if (!configured) throw new Error(ui`This remote is not configured any more. Reload the list.`);
  for (const address of [...configured.urls, ...configured.pushUrls]) validateRepositoryUrl(address);
  const operation = `${remove ? 'Delete on' : 'Push to'} ${remote}: ${ref}`;
  const result = await runGit({ cwd, log, argv, signal, operation, prompt: true });
  if (result.cancelled) {
    return { ok: false, cancelled: true, message: remove ? ui`Delete on ${remote}: ${ref} was cancelled.` : ui`Push to ${remote}: ${ref} was cancelled.` };
  }
  if (result.code !== 0) {
    return { ok: false, cancelled: false, message: remove ? ui`Delete on ${remote}: ${ref} failed. Show output in the console.` : ui`Push to ${remote}: ${ref} failed. Show output in the console.` };
  }
  return { ok: true, cancelled: false, message: null };
}

/**
 * The fetch the background schedule runs (see main/background-fetch.js). It is
 * journaled like any other command, under a `Background:` label, so it shows
 * in the console's Full History and not among the person's own actions.
 *
 * Nobody pressed anything, so it runs nothing a repository can name: no hook
 * (a fetch fires `reference-transaction`), no `core.alternateRefsCommand`, and
 * no fetch at all where the settings put a program in the way. Those settings
 * may have been accepted on opening; a manual Fetch still works there.
 * @param {{ cwd: string, log: object, signal?: ?AbortSignal }} options
 * @returns {Promise<{ ok: boolean, cancelled: boolean, message: ?string }>}
 */
export async function backgroundFetch({ cwd, log, signal = null }) {
  const refused = await refusedRemote({ cwd, log });
  if (refused) return { ok: false, cancelled: false, message: refused };
  const [risk] = await findFetchRisks(cwd, log);
  if (risk) return { ok: false, cancelled: false, message: ui`Background fetch is off here: ${risk.key} names a program. Fetch by hand if you trust it.` };
  const argv = ['-c', `core.hooksPath=${os.devNull}`, '-c', 'core.alternateRefsCommand=', ...BACKGROUND_FETCH_ARGV];
  const result = await runGit({ cwd, log, argv, signal, operation: 'Background: fetch all remotes' });
  if (result.cancelled) return { ok: false, cancelled: true, message: null };
  if (result.code !== 0) {
    // The reason is shown in Settings, so a credential inside a URL is cut out of it.
    const reason = redactCredentials(result.stderr).split('\n').map(line => line.replace(/^(fatal|error): /, '').trim()).find(Boolean);
    return { ok: false, cancelled: false, message: reason ? ui`Fetch failed: ${reason}` : ui`Fetch failed. Show output in the console.` };
  }
  return { ok: true, cancelled: false, message: null };
}
