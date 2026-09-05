/**
 * Which remote a remote-tracking ref belongs to.
 *
 * `refs/remotes/origin/feature` is not a `<remote>/<branch>` pair by
 * construction: a remote name may itself contain a slash, so the split is
 * decided by the remotes the repository actually has and the longest match
 * wins — never by the first slash in the name.
 *
 * No imports: Vite loads this for the screen and Node loads it in the
 * self-check, and both read the same file.
 */
export function splitRemoteRef(fullName, remoteNames) {
  if (typeof fullName !== 'string' || !fullName.startsWith('refs/remotes/')) return null;
  const rest = fullName.slice('refs/remotes/'.length);
  const remote = (Array.isArray(remoteNames) ? remoteNames : [])
    .filter(name => typeof name === 'string' && rest.startsWith(`${name}/`) && rest.length > name.length + 1)
    .sort((a, b) => b.length - a.length)[0];
  if (!remote) return null;
  const branch = rest.slice(remote.length + 1);
  return { remote, branch, ref: `refs/heads/${branch}` };
}

/**
 * The command `sync:push-ref` will run, for the confirmation dialog §6.5 asks
 * for. The self-check asserts this against the argv builder in main, so the
 * text in the dialog cannot drift away from the command that actually runs.
 */
export function pushRefCommand({ remote, ref, remove = false }) {
  return ['push', '--progress', ...(remove ? ['--delete'] : []), remote, '--', ref];
}
