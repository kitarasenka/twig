import { ui } from '../../renderer/src/i18n/i18n.js';
// Shared by the renderer preview and the validated executor. No Node imports.
export const endpointLabel = item => item.ref
  ? item.ref.replace(/^refs\/(heads|remotes)\//, '') : item.oid.slice(0, 7);
export const sameEndpoint = (a, b) => Boolean(a && b && a.oid === b.oid && a.ref === b.ref && a.kind === b.kind);

export function remoteEndpoint(item, names) {
  if (item.kind !== 'remote') return null;
  const rest = item.ref.slice('refs/remotes/'.length);
  const remote = names.filter(name => rest.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0];
  return remote ? { remote, branch: rest.slice(remote.length + 1) } : null;
}

export function dropActions(source, target, remoteNames = []) {
  if (!source || !target || sameEndpoint(source, target)) return [];
  const from = endpointLabel(source), to = endpointLabel(target);
  const actions = [];
  if (source.oid !== target.oid) {
    if (source.kind !== 'commit' && target.kind === 'local') {
      actions.push({ key: 'merge', text: ui`Merge ${from} into ${to}`, hint: ui`Update ${to}; keep ${from}` });
      actions.push({ key: 'merge-no-ff', text: ui`Merge ${from} into ${to} with a merge commit`, hint: ui`Always create a merge commit` });
    }
    if (source.kind === 'local') actions.push({ key: 'rebase', text: ui`Rebase ${from} onto ${to}`, hint: ui`Replay and rewrite ${from}`, danger: true });
    if (source.kind === 'commit' && target.kind !== 'remote') {
      actions.push({ key: 'cherry-pick', text: ui`Cherry-pick ${from} onto ${to}`, hint: ui`Copy this commit’s changes` });
    }
  }
  if (source.kind === 'commit' && target.kind !== 'remote') actions.push({ key: 'revert', text: ui`Revert ${from} on ${to}`, hint: ui`Create a commit with the inverse changes` });
  if (source.kind === 'remote' && target.kind === 'local' && remoteEndpoint(source, remoteNames)) {
    actions.push({ key: 'pull', text: ui`Pull ${from} into ${to}`, hint: ui`Fetch, then fast-forward only` });
    actions.push({ key: 'pull-merge', text: ui`Pull and merge ${from} into ${to}`, hint: ui`Fetch, then merge divergent history` });
    actions.push({ key: 'pull-rebase', text: ui`Pull and rebase ${to} onto ${from}`, hint: ui`Fetch, then rewrite ${to}`, danger: true });
  }
  if (source.kind === 'local' && target.kind === 'remote' && remoteEndpoint(target, remoteNames)) {
    actions.push({ key: 'push', text: ui`Push ${from} to ${to}`, hint: ui`Publish this branch; no force push` });
  }
  actions.push({ key: 'compare', text: ui`Compare ${from} with ${to}`, hint: ui`View the diff; leave Git unchanged` });
  return actions;
}

export function buildDropPlan({ action, source, target, head, remoteNames = [], mainline = null }) {
  if (!dropActions(source, target, remoteNames).some(item => item.key === action) || action === 'compare') {
    throw new TypeError('This action is not available for these endpoints');
  }
  const destination = action === 'rebase' ? source : target;
  const commands = [];
  const network = action.startsWith('pull') || action === 'push';
  if (action !== 'push') {
    if (destination.kind === 'local') {
      const name = endpointLabel(destination);
      if (head.branch !== name) commands.push(['switch', '--no-guess', '--', name]);
    } else if (head.branch || head.oid !== destination.oid) commands.push(['switch', '--detach', '--', destination.oid]);
  }
  if (action.startsWith('merge')) commands.push(['merge', '--no-edit', ...(action === 'merge-no-ff' ? ['--no-ff'] : []), source.oid]);
  else if (action === 'rebase') commands.push(['rebase', '--no-autostash', '--no-update-refs', target.oid]);
  else if (action === 'cherry-pick' || action === 'revert') {
    commands.push([action, ...(action === 'revert' ? ['--no-edit'] : []), ...(mainline ? ['--mainline', String(mainline)] : []), source.oid]);
  } else if (action.startsWith('pull')) {
    const { remote, branch } = remoteEndpoint(source, remoteNames);
    const mode = action === 'pull' ? ['--ff-only', '--no-rebase'] : action === 'pull-merge' ? ['--no-rebase', '--no-edit', '--ff'] : ['--rebase'];
    commands.push(['-c', 'rebase.updateRefs=false', 'pull', '--progress', '--no-autostash', ...mode, '--', remote, `refs/heads/${branch}`]);
  } else if (action === 'push') {
    const { remote, branch } = remoteEndpoint(target, remoteNames);
    commands.push(['-c', 'push.followTags=false', 'push', '--progress', '--', remote, `${source.oid}:refs/heads/${branch}`]);
  }
  const detached = action !== 'push' && destination.kind === 'commit';
  const rewrite = action === 'rebase' || action === 'pull-rebase';
  // Each sentence on its own as well, so the window can translate them one by one.
  const consequences = [
    action === 'push' ? ui`Publish ${endpointLabel(source)} to ${endpointLabel(target)}.`
      : detached ? ui`The result stays on detached HEAD at ${endpointLabel(destination)}.` : ui`The result stays on ${endpointLabel(destination)}.`,
    commands.length > 1 ? ui`Switch there first; stay there if the operation stops on a conflict.` : '',
    detached ? ui`Create a branch afterwards to keep the new commits.` : '',
    rewrite ? ui`Replayed commits get new object ids. Published history may then require a force push.` : '',
    mainline ? ui`Use parent ${mainline} as the mainline of the merge commit.` : ''
  ].filter(Boolean);
  return { commands, network, consequence: consequences.join(' '), consequences };
}
