// The update check: one request to the latest GitHub Release — when the person
// presses the button, or at launch and daily if they chose that in Settings.
// It compares the tag with the running version and names the one installer
// asset that fits this installation (see update-target.js); downloading and
// installing it is updater.js, and only on a further press. No telemetry:
// nothing but the User-Agent version leaves the machine.
//
// No electron import: the Node check loads this module directly.

export const RELEASES_API = 'https://api.github.com/repos/kitarasenka/twig/releases/latest';
export const RELEASES_PAGE = 'https://github.com/kitarasenka/twig/releases';
const RELEASE_URL_PREFIX = 'https://github.com/kitarasenka/twig/releases/';
const DOWNLOAD_URL_PREFIX = 'https://github.com/kitarasenka/twig/releases/download/';
const TIMEOUT_MS = 10_000;
const NOTES_LIMIT = 6000;
// The installers are 90–140 MB; anything far outside that is not ours.
const MAX_ASSET_BYTES = 600 * 1024 * 1024;

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
 * The file name electron-builder gives this installation's installer, from the
 * `artifactName` patterns in package.json. electron-builder rewrites `${arch}`
 * per target: deb says `amd64`, AppImage `x86_64`, DMG and NSIS keep `x64`.
 */
export function assetName(version, target) {
  if (!target || typeof version !== 'string') return null;
  if (target.kind === 'mac' && ['arm64', 'x64'].includes(target.arch)) return `Twig-${version}-macos-${target.arch}.dmg`;
  if (target.kind === 'win' && target.arch === 'x64') return `Twig-${version}-windows-x64.exe`;
  if (target.kind === 'appimage' && target.arch === 'x64') return `Twig-${version}-linux-x86_64.AppImage`;
  if (target.kind === 'deb' && target.arch === 'x64') return `Twig-${version}-linux-amd64.deb`;
  return null;
}

/**
 * The one asset of the release that installs over this copy, or null. Every
 * field comes off the network, so the name must be exactly the expected one,
 * the URL must be this repository's download URL for that very tag and file,
 * and the SHA-256 GitHub computed on upload must be there — without it the
 * download could not be checked, and an unchecked download is not installed.
 */
export function pickAsset(release, version, target) {
  const name = assetName(version, target);
  if (!name || !release || !Array.isArray(release.assets)) return null;
  const asset = release.assets.find(item => item && item.name === name);
  if (!asset) return null;
  const url = `${DOWNLOAD_URL_PREFIX}twig-v${version}/${name}`;
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/.exec(asset.digest) : null;
  if (asset.browser_download_url !== url || !digest) return null;
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) return null;
  return { name, url, size: asset.size, sha256: digest[1] };
}

/** Release notes are shown as plain text; the page escapes them like any string. */
function releaseNotes(release) {
  if (typeof release.body !== 'string') return '';
  // Markdown heading marks (`### Что нового`) would show as literal hashes.
  const text = release.body.replace(/\r\n/g, '\n').replace(/^#{1,6}[ \t]+/gm, '').trim();
  return text.length > NOTES_LIMIT ? `${text.slice(0, NOTES_LIMIT)}…` : text;
}

/**
 * What the release JSON means for the version that is running. The release
 * body arrives over the network, so its URL is trusted only when it points at
 * this repository's own releases; anything else falls back to the releases page.
 * With a `target`, the installer asset for this installation is picked too.
 */
export function interpretRelease(currentVersion, release, target = null) {
  const current = parseVersion(currentVersion);
  const latestTag = release && typeof release === 'object' ? release.tag_name : null;
  const latest = parseVersion(latestTag);
  if (!current || !latest) return { status: 'unknown', current: currentVersion, latest: null, url: RELEASES_PAGE };
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_URL_PREFIX)
    ? release.html_url : RELEASES_PAGE;
  const newer = compareVersions(latest, current) > 0;
  const version = latest.join('.');
  return {
    status: newer ? 'update' : 'current',
    current: currentVersion,
    latest: version,
    url,
    ...(newer ? { notes: releaseNotes(release), asset: pickAsset(release, version, target) } : {})
  };
}

/**
 * @param {{ currentVersion: string, target?: object|null, fetchImpl?: typeof fetch, timeoutMs?: number }} options
 * @returns {Promise<{ status: 'update'|'current'|'unknown'|'error', current: string, latest: string|null, url: string, message?: string }>}
 */
export async function checkForUpdate({ currentVersion, target = null, fetchImpl = globalThis.fetch, timeoutMs = TIMEOUT_MS }) {
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
    return interpretRelease(currentVersion, await response.json(), target);
  } catch {
    return failure('GitHub sent an answer this version could not read.');
  }
}
