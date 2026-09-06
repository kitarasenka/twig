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
      actions.push({ key: 'merge', text: `Merge ${from} into ${to}`, hint: `Update ${to}; keep ${from}` });
      actions.push({ key: 'merge-no-ff', text: `Merge ${from} into ${to} with a merge commit`, hint: 'Always create a merge commit' });
    }
    if (source.kind === 'local') actions.push({ key: 'rebase', text: `Rebase ${from} onto ${to}`, hint: `Replay and rewrite ${from}`, danger: true });
    if (source.kind === 'commit' && target.kind !== 'remote') {
      actions.push({ key: 'cherry-pick', text: `Cherry-pick ${from} onto ${to}`, hint: 'Copy this commit’s changes' });
    }
  }
  if (source.kind === 'commit' && target.kind !== 'remote') actions.push({ key: 'revert', text: `Revert ${from} on ${to}`, hint: 'Create a commit with the inverse changes' });
  if (source.kind === 'remote' && target.kind === 'local' && remoteEndpoint(source, remoteNames)) {
    actions.push({ key: 'pull', text: `Pull ${from} into ${to}`, hint: 'Fetch, then fast-forward only' });
    actions.push({ key: 'pull-merge', text: `Pull and merge ${from} into ${to}`, hint: 'Fetch, then merge divergent history' });
    actions.push({ key: 'pull-rebase', text: `Pull and rebase ${to} onto ${from}`, hint: `Fetch, then rewrite ${to}`, danger: true });
  }
  if (source.kind === 'local' && target.kind === 'remote' && remoteEndpoint(target, remoteNames)) {
    actions.push({ key: 'push', text: `Push ${from} to ${to}`, hint: 'Publish this branch; no force push' });
  }
  actions.push({ key: 'compare', text: `Compare ${from} with ${to}`, hint: 'View the diff; leave Git unchanged' });
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
  return {
    commands, network,
    consequence: [
      action === 'push' ? `Publish ${endpointLabel(source)} to ${endpointLabel(target)}.` : `The result stays on ${detached ? `detached HEAD at ${endpointLabel(destination)}` : endpointLabel(destination)}.`,
      commands.length > 1 ? 'Switch there first; stay there if the operation stops on a conflict.' : '',
      detached ? 'Create a branch afterwards to keep the new commits.' : '',
      rewrite ? 'Replayed commits get new object ids. Published history may then require a force push.' : '',
      mainline ? `Use parent ${mainline} as the mainline of the merge commit.` : ''
    ].filter(Boolean).join(' ')
  };
}
