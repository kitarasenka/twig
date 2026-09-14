// Manual update check: one request, and only when the person asks for it.
// The app has no updater and no telemetry — this reads the latest GitHub
// Release the same way opening the releases page in a browser would, compares
// its tag with the running version and hands back a link. Nothing is
// downloaded, installed or reported anywhere.
//
// No electron import: the Node check loads this module directly.

export const RELEASES_API = 'https://api.github.com/repos/kitarasenka/twig/releases/latest';
export const RELEASES_PAGE = 'https://github.com/kitarasenka/twig/releases';
const RELEASE_URL_PREFIX = 'https://github.com/kitarasenka/twig/releases/';
const TIMEOUT_MS = 10_000;

/** `twig-v0.8.3`, `v0.8.3` and `0.8.3` all name the same release. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = /^(?:twig-)?v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(value.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** -1, 0 or 1, by the usual numeric precedence of the three parts. */
export function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * What the release JSON means for the version that is running. The release
 * body arrives over the network, so its URL is trusted only when it points at
 * this repository's own releases; anything else falls back to the releases page.
 */
export function interpretRelease(currentVersion, release) {
  const current = parseVersion(currentVersion);
  const latestTag = release && typeof release === 'object' ? release.tag_name : null;
  const latest = parseVersion(latestTag);
  if (!current || !latest) return { status: 'unknown', current: currentVersion, latest: null, url: RELEASES_PAGE };
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_URL_PREFIX)
    ? release.html_url : RELEASES_PAGE;
  const newer = compareVersions(latest, current) > 0;
  return {
    status: newer ? 'update' : 'current',
    current: currentVersion,
    latest: latest.join('.'),
    url
  };
}

/**
 * @param {{ currentVersion: string, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ status: 'update'|'current'|'unknown'|'error', current: string, latest: string|null, url: string, message?: string }>}
 */
export async function checkForUpdate({ currentVersion, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
  const failure = message => ({ status: 'error', current: currentVersion, latest: null, url: RELEASES_PAGE, message });
  // The deadline is cleared as soon as the request settles: an AbortSignal
  // left running would hold the event loop open long after the answer arrived.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error('Update check timed out')), timeoutMs);
  let response;
  try {
    response = await fetchImpl(RELEASES_API, {
      redirect: 'error',
      signal: controller.signal,
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Twig/${currentVersion}` }
    });
  } catch {
    return failure('Could not reach GitHub. Check your connection and try again.');
  } finally {
    clearTimeout(deadline);
  }
  if (response.status === 404) return failure('No published release yet.');
  if (!response.ok) return failure(`GitHub answered ${response.status}.`);
  try {
    return interpretRelease(currentVersion, await response.json());
  } catch {
    return failure('GitHub sent an answer this version could not read.');
  }
}
