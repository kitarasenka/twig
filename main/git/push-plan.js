import { createHash } from 'node:crypto';
import { runGit } from './exec.js';
import { redactCredentials } from './redact.js';
import { validateRemoteName } from './remotes.js';
import { validateRefName } from './refs-ops.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * What a push will really do. A bare `git push` takes its remote, its refs and
 * even a force from `.git/config` (`remote.<r>.mirror`, `remote.<r>.push` with
 * a `+`, `remote.pushDefault`, `branch.<b>.pushRemote`, `push.default`), so
 * what the window promises and what Git does can part ways. Here that
 * configuration is read and the push is written out in full: the remote by its
 * name and one refspec, `refs/heads/<b>:<destination>`. With a refspec on the
 * command line Git ignores `remote.<r>.push`, and a `+` never reaches it. The
 * name stays — a URL would leave `refs/remotes/<r>/<b>` behind and the Push
 * badge counting commits that are already there — and with several `pushurl`s
 * Git sends to each, as a bare push does. Mirror mode refuses any refspec, so
 * it is switched off for the one command.
 *
 * Everything that decides the outcome joins `digest`: a change between showing
 * a plan and running it is seen, even one that keeps the words the same.
 */

const TRUE = /^(?:true|yes|on|[1-9]\d*)$/i;
const yes = value => value !== null && TRUE.test(value);

/** `git config -z --get-regexp`: `key\nvalue\0`, a key alone when it has no value. Section and variable names come lowercased. */
export function parseConfigList(output) {
  const config = new Map();
  for (const record of output.split('\0')) {
    if (!record) continue;
    const split = record.indexOf('\n');
    const key = split < 0 ? record : record.slice(0, split);
    config.set(key, [...(config.get(key) ?? []), split < 0 ? 'true' : record.slice(split + 1)]);
  }
  return config;
}

/** Where one `remote.<r>.push` refspec sends `source`, as `{ destination, forced }`, or null when it says nothing about it. */
export function mapRefspec(refspec, source) {
  const forced = refspec.startsWith('+');
  const [from, to = null, ...rest] = (forced ? refspec.slice(1) : refspec).split(':');
  if (rest.length || refspec.startsWith('^') || (from === '' && to !== '')) return null;
  const full = name => (name.startsWith('refs/') ? name : `refs/heads/${name}`);
  if (from === '') return { destination: source, forced };
  if (from === 'HEAD') return { destination: to ? full(to) : source, forced };
  const star = from.indexOf('*');
  if (star < 0) return full(from) === source ? { destination: to ? full(to) : source, forced } : null;
  const [head, tail] = [full(from.slice(0, star)), from.slice(star + 1)];
  if (!source.startsWith(head) || !source.endsWith(tail) || source.length < head.length + tail.length) return null;
  const match = source.slice(head.length, source.length - tail.length);
  return { destination: to ? full(to).replace('*', match) : source, forced };
}

/**
 * The remote and the destination ref a push of `branch` means under this
 * configuration, by the rules of a bare `git push`, or why there is none.
 * What Git itself would refuse (`push.default` of nothing, a `simple` push to
 * an upstream of another name) is refused here in words.
 * @param {{ branch: string, config: Map<string, string[]> }} options
 */
export function choosePush({ branch, config, publish = null }) {
  const get = key => config.get(key)?.at(-1) ?? null;
  const remotes = new Set([...config.keys()].map(key => /^remote\.(.+)\.(?:url|pushurl)$/.exec(key)?.[1]).filter(Boolean));
  const source = `refs/heads/${branch}`;
  const tracked = get(`branch.${branch}.remote`);
  const merge = get(`branch.${branch}.merge`);
  if (tracked === '.') return { reason: ui`${branch} follows a local branch, so there is no remote to push to.` };
  if (!tracked || !merge) {
    // The remote the person picked to publish to; with one remote there is nothing to pick.
    const target = publish ?? (remotes.size === 1 ? [...remotes][0] : 'origin');
    if (!remotes.has(target)) return { reason: ui`${branch} has no upstream and there is no remote named origin.` };
    return { mode: 'push-upstream', remote: target, source, destination: source, tracked: null, notes: [] };
  }
  const remote = get(`branch.${branch}.pushremote`) ?? get('remote.pushdefault') ?? tracked;
  if (!remotes.has(remote)) return { reason: ui`${remote} is not a configured remote, so 🌱 Twig will not push there.` };
  const notes = remote === tracked ? [] : [ui`The configuration sends this to ${remote}, not to ${tracked}, where ${branch} is tracked.`];

  const refspecs = config.get(`remote.${remote}.push`) ?? [];
  if (refspecs.length) {
    const mapped = refspecs.map(refspec => mapRefspec(refspec, source)).find(Boolean);
    if (!mapped) return { reason: ui`remote.${remote}.push does not cover ${branch}, so a push would not send it.` };
    if (mapped.destination !== source) notes.push(ui`remote.${remote}.push sends this to ${mapped.destination}.`);
    if (mapped.forced) notes.push(ui`remote.${remote}.push asks to force this. 🌱 Twig does not: Git refuses the push if it would overwrite anything.`);
    return { mode: 'push', remote, source, destination: mapped.destination, tracked, notes };
  }
  const strategy = (get('push.default') ?? 'simple').toLowerCase();
  if (strategy === 'nothing') return { reason: ui`push.default is nothing, so a push without a name sends nothing.` };
  const triangular = remote !== tracked;
  if (strategy === 'upstream' || strategy === 'tracking') {
    if (triangular) return { reason: ui`push.default is upstream, and ${remote} is not where ${branch} is tracked.` };
    return { mode: 'push', remote, source, destination: merge, tracked, notes };
  }
  if (strategy === 'simple' && !triangular && merge !== source) {
    return { reason: ui`${branch} tracks ${merge}, another name, and push.default is simple. Git refuses this push.` };
  }
  return { mode: 'push', remote, source, destination: source, tracked, notes };
}

/** `origin/main`, or `origin refs/for/main` for a ref that is not a branch. */
const place = (remote, destination) => (destination.startsWith('refs/heads/') ? `${remote}/${destination.slice('refs/heads/'.length)}` : `${remote} ${destination}`);

/**
 * The push as argv. `exact` is for a push a person confirmed in a dialog: only
 * the ref it names goes, whatever `push.followTags` or
 * `push.recurseSubmodules` would add.
 * @param {object} plan from `readPushPlan`
 * @param {{ force?: boolean, exact?: boolean }} [options]
 */
export function pushArgv(plan, { force = false, exact = false } = {}) {
  return [
    ...(plan.mirror ? ['-c', `remote.${plan.remote}.mirror=false`] : []),
    'push',
    ...(exact && plan.followTags ? ['--no-follow-tags'] : []),
    ...(exact && plan.recursive ? ['--recurse-submodules=no'] : []),
    ...(force ? ['--force-with-lease'] : []),
    ...(plan.mode === 'push-upstream' ? ['--set-upstream'] : []),
    plan.remote, `${plan.source}:${plan.destination}`
  ];
}

const digestOf = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Reads the configuration a push of `branch` depends on and the addresses it
 * would really go to (`pushInsteadOf` and friends applied).
 * @param {{ cwd: string, log: object, branch: ?string, exact?: boolean, publish?: ?string }} options
 * @returns {Promise<{ mode: ?string, label: ?string, to: ?string, remote: ?string, source?: string, destination?: string,
 *   urls: string[], notes: string[], argv: ?string[], reason?: string, digest: string }>}
 */
export async function readPushPlan({ cwd, log, branch, exact = false, publish = null }) {
  const nowhere = reason => ({ mode: null, label: null, to: null, remote: null, argv: null, urls: [], notes: [], reason, digest: digestOf([reason]) });
  if (!branch) return nowhere(ui`HEAD is not on a branch.`);
  validateRefName(branch);
  const listed = await runGit({ cwd, log, argv: ['config', '-z', '--get-regexp', '^(push|url|remote|branch)\\.'], operation: 'Read the push configuration' });
  if (listed.code > 1) throw new Error(ui`Git could not read the push configuration.`);
  const config = parseConfigList(listed.stdout);
  const choice = choosePush({ branch, config, publish });
  if (choice.reason) return nowhere(choice.reason);
  try { validateRemoteName(choice.remote); }
  catch { return nowhere(ui`${choice.remote} is not a remote name 🌱 Twig pushes to.`); }
  const addresses = await runGit({ cwd, log, argv: ['remote', 'get-url', '--push', '--all', '--', choice.remote], operation: 'Read the push address' });
  if (addresses.code !== 0) return nowhere(ui`${choice.remote} has no address to push to.`);
  const urls = addresses.stdout.split('\n').filter(Boolean);
  const first = key => config.get(key)?.at(-1) ?? null;
  const mirror = yes(first(`remote.${choice.remote}.mirror`));
  const followTags = yes(first('push.followtags'));
  const recursive = !['no', 'false', null].includes(first('push.recursesubmodules'));
  const notes = [...choice.notes, ...(mirror ? [ui`remote.${choice.remote}.mirror is set. 🌱 Twig pushes this one branch, not a mirror.`] : [])];
  const to = place(choice.remote, choice.destination);
  const plan = {
    ...choice, notes, mirror, followTags, recursive, to, urls: urls.map(redactCredentials),
    label: choice.mode === 'push-upstream' ? `${to} (new upstream)` : to
  };
  const relevant = [...config].filter(([key]) => key.startsWith('push.') || key.startsWith('url.') || key === 'remote.pushdefault'
    || key.startsWith(`remote.${choice.remote}.`) || key.startsWith(`branch.${branch}.`)).sort(([a], [b]) => (a < b ? -1 : 1));
  return { ...plan, argv: pushArgv(plan, { exact }), digest: digestOf([plan.mode, plan.remote, plan.source, plan.destination, urls, relevant]) };
}
