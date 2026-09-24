// Which kind of installation is running, and so how an update replaces it.
// Pure: the caller passes what Electron and the environment say; the Node
// check drives every branch without packaging anything.
//
//   mac       the .app bundle is swapped for the one inside the new DMG
//   win       the new NSIS installer runs silently over this per-user install
//   appimage  the new AppImage file takes the place of the running one
//   deb       the package is saved to Downloads and opened in the system installer
//             (installing it needs root, which 🌱 Twig does not ask for itself)

export const BUNDLE_ID = 'app.nodex.twig';

const FROM_SOURCE = 'You are running 🌱 Twig from source. Update it with git pull.';

/**
 * @param {{ packaged: boolean, platform: string, arch: string, execPath: string, env?: Record<string, string|undefined> }} facts
 * @returns {{ kind: 'mac', arch: string, appPath: string }
 *   | { kind: 'win', arch: string }
 *   | { kind: 'appimage', arch: string, appImage: string }
 *   | { kind: 'deb', arch: string }
 *   | { kind: 'unsupported', reason: string }}
 */
export function resolveInstallTarget({ packaged, platform, arch, execPath, env = {} }) {
  if (!packaged) return { kind: 'unsupported', reason: FROM_SOURCE };
  if (typeof execPath !== 'string') return { kind: 'unsupported', reason: 'Could not tell where 🌱 Twig is installed.' };
  if (platform === 'darwin') {
    const match = /^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath);
    if (!match) return { kind: 'unsupported', reason: 'Could not find the 🌱 Twig app bundle.' };
    // Gatekeeper runs a quarantined app from a read-only random copy; nothing
    // written there would survive, and the real copy is somewhere else.
    if (execPath.includes('/AppTranslocation/')) {
      return { kind: 'unsupported', reason: 'macOS is running 🌱 Twig from a temporary copy. Move it to Applications, open it from there and update again.' };
    }
    if (!['arm64', 'x64'].includes(arch)) return { kind: 'unsupported', reason: `No macOS build for ${arch}.` };
    return { kind: 'mac', arch, appPath: match[1] };
  }
  if (platform === 'win32') {
    if (arch !== 'x64') return { kind: 'unsupported', reason: `No Windows build for ${arch}.` };
    return { kind: 'win', arch };
  }
  if (platform === 'linux') {
    if (arch !== 'x64') return { kind: 'unsupported', reason: `No Linux build for ${arch}.` };
    // The AppImage runtime names the file it was started from.
    const appImage = env.APPIMAGE;
    if (typeof appImage === 'string' && appImage.startsWith('/') && !appImage.includes('\0')) {
      return { kind: 'appimage', arch, appImage };
    }
    if (execPath.startsWith('/opt/')) return { kind: 'deb', arch };
    return { kind: 'unsupported', reason: 'This copy of 🌱 Twig was not installed from a .deb or an AppImage.' };
  }
  return { kind: 'unsupported', reason: `No builds for ${platform}.` };
}
