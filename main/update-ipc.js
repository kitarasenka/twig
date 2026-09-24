import { app, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { isTrustedPage } from './security.js';
import { runStep } from './automation/exec.js';
import { createUpdater } from './updater.js';
import { resolveInstallTarget } from './update-target.js';

/**
 * In-app update channels. The renderer only presses buttons: `update:check`,
 * `update:download`, `update:cancel`, `update:install` and the opt-in
 * `update:auto`. What is downloaded, from where, and how it is installed is
 * decided here from the release and this installation — never from arguments.
 * Progress and every state change arrive as `update:state`.
 */
export function registerUpdateIpc(getWindow, entryUrl, { journal, store }) {
  const userData = app.getPath('userData');
  const updater = createUpdater({
    currentVersion: app.getVersion(),
    target: resolveInstallTarget({
      packaged: app.isPackaged, platform: process.platform, arch: process.arch,
      execPath: process.execPath, env: process.env
    }),
    directory: path.join(userData, 'updates'),
    downloadsDir: app.getPath('downloads'),
    store,
    log: journal,
    // The macOS helpers (hdiutil, ditto, plutil, codesign, xattr) run like any
    // other non-Git process: no shell, journalled, with a deadline.
    runTool: (argv, operation) => runStep({ argv, cwd: app.getPath('temp'), log: journal, operation, timeoutMs: 300_000 }),
    // The restart helper and the Windows installer must outlive this process.
    spawnDetached(executable, args, patch = {}) {
      const env = { ...process.env };
      for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete env[key]; else env[key] = value; }
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false, env });
      child.on('error', () => {});
      child.unref();
    },
    quit: () => setImmediate(() => app.quit()),
    openPath: file => shell.openPath(file),
    onState(state) {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('update:state', state);
    }
  });

  function handler(channel, count, action) {
    ipcMain.handle(channel, (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new Error('Invalid update request');
      return action(...args);
    });
  }
  handler('update:state', 0, () => updater.state());
  handler('update:check', 0, () => updater.check());
  // The download takes minutes: answer at once, progress follows as events.
  handler('update:download', 0, () => { void updater.download(); return updater.state(); });
  handler('update:cancel', 0, () => updater.cancel());
  handler('update:install', 0, () => updater.install());
  handler('update:auto', 1, value => {
    if (typeof value !== 'boolean') throw new Error('Invalid update request');
    return updater.setAuto(value);
  });
  void updater.start();
  app.on('before-quit', () => updater.stop());
  return updater;
}
