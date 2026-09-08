import path from 'node:path';

/**
 * Portable mode: keep every bit of app state (settings, connected repositories,
 * the command journal, marks, automations, the demo sandbox and Chromium's
 * cache) in a `twig-data` folder next to the runnable artifact instead of the
 * per-user OS directory, so a `.zip` / portable `.exe` / `.AppImage` copied to a
 * USB stick carries its state with it.
 *
 * Pure decision function — `main/index.js` injects `exists`, the OS checks come
 * from `process`; a Node check drives it directly.
 */

export const PORTABLE_DIRNAME = 'twig-data';
export const PORTABLE_MARKER = '.twig-portable';

const truthy = (value) => value === '1' || value === 'true' || value === 'yes';

/**
 * The directory that holds the thing the user launched: the folder next to a
 * Windows portable `.exe`, next to a Linux `.AppImage`, or the folder that
 * contains `Twig.app` on macOS. `null` when it cannot be located.
 */
export function portableHostDir({ env = {}, platform, execPath }) {
  if (platform === 'win32' && env.PORTABLE_EXECUTABLE_DIR) return env.PORTABLE_EXECUTABLE_DIR;
  if (env.APPIMAGE) return path.dirname(env.APPIMAGE);
  if (!execPath) return null;
  if (platform === 'darwin') {
    const marker = `${path.sep}Contents${path.sep}MacOS${path.sep}`;
    const at = execPath.indexOf('.app' + marker);
    if (at !== -1) return path.dirname(execPath.slice(0, at + 4));
  }
  return path.dirname(execPath);
}

/**
 * Absolute path to use for `userData`, or `null` to keep Electron's default.
 *
 * - `TWIG_DATA_DIR` (absolute) wins on every platform and needs no packaging.
 * - Otherwise, only a packaged build goes portable, and only when asked:
 *   `TWIG_PORTABLE=1`, a Windows portable launch, or a `twig-data` folder /
 *   `.twig-portable` marker already sitting next to the artifact.
 */
export function resolvePortableDataDir({ env = {}, platform, packaged, execPath, exists }) {
  const explicit = (env.TWIG_DATA_DIR || '').trim();
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('TWIG_DATA_DIR must be an absolute path');
    return explicit;
  }
  if (!packaged) return null;

  const host = portableHostDir({ env, platform, execPath });
  if (!host) return null;

  const dataDir = path.join(host, PORTABLE_DIRNAME);
  const forced = truthy(env.TWIG_PORTABLE)
    || (platform === 'win32' && !!env.PORTABLE_EXECUTABLE_DIR);
  const opted = exists(dataDir) || exists(path.join(host, PORTABLE_MARKER));
  return forced || opted ? dataDir : null;
}
