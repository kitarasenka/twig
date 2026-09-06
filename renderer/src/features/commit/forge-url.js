/**
 * Web links for a commit and for an author's commits on the hosting forge,
 * derived from a Git remote address.
 *
 * Only the three public hosts are recognised (GitHub, GitLab, Bitbucket): a
 * self-hosted forge has no guessable URL shape. A remote whose URL carries
 * credentials or an unknown transport yields no link at all — the panel then
 * shows plain text, never a broken or secret-bearing address.
 *
 * No imports: Vite loads this for the commit panel and Node loads it in the
 * self-check, and both read the same file.
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function detectForge(host) {
  const lower = host.toLowerCase();
  if (lower === 'github.com' || lower.endsWith('.github.com')) return 'github';
  if (lower === 'bitbucket.org' || lower.endsWith('.bitbucket.org')) return 'bitbucket';
  if (lower === 'gitlab.com' || lower.endsWith('.gitlab.com') || lower.startsWith('gitlab.')) return 'gitlab';
  return null;
}

/**
 * `{ forge, host, repo }` for a remote URL, or null. Accepts the scp-like
 * `git@host:owner/repo.git`, `ssh://`, `https://`, `http://` and `git://`.
 * Local paths, `file://` and credential-bearing URLs return null.
 */
export function parseRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string') return null;
  const value = remoteUrl.trim();
  if (!value) return null;
  let host;
  let repo;
  const scp = value.match(/^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):(.+)$/);
  if (scp && !value.includes('://')) {
    if (scp[1] !== 'git') return null;
    host = scp[2];
    repo = scp[3];
  } else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    if (url.password || (url.username && url.username !== 'git')) return null;
    host = url.hostname;
    repo = url.pathname.replace(/^\/+/, '');
  }
  repo = repo.replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !repo || !repo.includes('/') || repo.includes('..')) return null;
  const forge = detectForge(host);
  if (!forge) return null;
  return { forge, host, repo };
}

function base(parsed) {
  return `https://${parsed.host}/${parsed.repo}`;
}

/** Web page for a single commit, or null. */
export function commitUrl(remoteUrl, oid) {
  const parsed = parseRemote(remoteUrl);
  if (!parsed || typeof oid !== 'string' || !/^[0-9a-f]{7,64}$/i.test(oid)) return null;
  if (parsed.forge === 'gitlab') return `${base(parsed)}/-/commit/${oid}`;
  if (parsed.forge === 'bitbucket') return `${base(parsed)}/commits/${oid}`;
  return `${base(parsed)}/commit/${oid}`;
}

/**
 * The forge's commit list filtered to one author's email, or null. Bitbucket
 * has no email-based filter, so it returns null; GitLab's `?author=` matches by
 * name rather than email and is a best effort only.
 */
export function authorCommitsUrl(remoteUrl, email) {
  const parsed = parseRemote(remoteUrl);
  if (!parsed || typeof email !== 'string' || !EMAIL.test(email.trim())) return null;
  const query = encodeURIComponent(email.trim());
  if (parsed.forge === 'github') return `${base(parsed)}/commits?author=${query}`;
  if (parsed.forge === 'gitlab') return `${base(parsed)}/-/commits?author=${query}`;
  return null;
}

/** First configured remote URL that maps to a known forge, or null. */
export function pickRemoteUrl(remotes) {
  if (!Array.isArray(remotes)) return null;
  const preferred = [];
  for (const name of ['origin', 'upstream']) {
    const remote = remotes.find(item => item && item.name === name);
    if (remote && Array.isArray(remote.urls)) preferred.push(...remote.urls);
  }
  for (const remote of remotes) if (remote && Array.isArray(remote.urls)) preferred.push(...remote.urls);
  for (const url of preferred) if (parseRemote(url)) return url;
  return null;
}

/**
 * `{ forge, host, repo, commit, authorCommits }` for the commit panel, or null
 * when no configured remote points at a recognised forge.
 */
export function forgeLinks(remotes, { oid = null, email = null } = {}) {
  const remoteUrl = pickRemoteUrl(remotes);
  if (!remoteUrl) return null;
  const parsed = parseRemote(remoteUrl);
  return {
    forge: parsed.forge,
    host: parsed.host,
    repo: parsed.repo,
    commit: oid ? commitUrl(remoteUrl, oid) : null,
    authorCommits: email ? authorCommitsUrl(remoteUrl, email) : null
  };
}

const LABELS = { github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket' };

/** Human name of a forge id. */
export function forgeLabel(forge) {
  return LABELS[forge] || 'the remote';
}
