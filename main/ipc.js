import { app, clipboard, dialog, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { registerHistoryIpc } from './history-ipc.js';
import { registerBlameIpc } from './blame-ipc.js';
import { registerHistoryOpsIpc } from './history-ops-ipc.js';
import { registerWorktreeIpc } from './worktree-ipc.js';
import { registerProfileIpc } from './profile-ipc.js';
import { registerRepositoryIpc } from './repository-ipc.js';
import { registerUndoIpc } from './undo-ipc.js';
import { registerSshIpc } from './ssh-ipc.js';
import { registerMarksIpc } from './marks-ipc.js';
import { registerAutomationsIpc } from './automations-ipc.js';
import { registerConsoleIpc } from './console-ipc.js';
import { registerFilesIpc } from './files-ipc.js';
import { registerFetchIpc } from './fetch-ipc.js';
import { registerRepoToolsIpc } from './repo-tools-ipc.js';
import { createTokenRegistry } from './token-registry.js';
import { createRepositoryWatcher } from './repo-watch.js';
import { checkForUpdate } from './update-check.js';

function validSender(event, getWindow, entryUrl, args, count) {
  const window = getWindow();
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
}

export function registerIpc(getWindow, entryUrl, { journal, repositories, git, undo, marks, automations, automationRuns, automationPath, editor, fetchSettings }) {
  registerUndoIpc(getWindow, entryUrl, { repositories, undo });
  registerMarksIpc(getWindow, entryUrl, { repositories, marks });
  registerAutomationsIpc(getWindow, entryUrl, { repositories, journal, automations, runs: automationRuns, loginPath: automationPath });
  registerSshIpc(getWindow, entryUrl, { journal });
  registerRepositoryIpc(getWindow, entryUrl, { journal, repositories, undo });
  registerProfileIpc(getWindow, entryUrl, { journal, repositories, stateDir: app.getPath('userData') });
  registerHistoryIpc(getWindow, entryUrl, { journal, repositories });
  registerBlameIpc(getWindow, entryUrl, { journal, repositories });
  registerWorktreeIpc(getWindow, entryUrl, { journal, repositories, undo });
  const patchFiles = createTokenRegistry();
  registerHistoryOpsIpc(getWindow, entryUrl, { journal, repositories, undo, stateDir: app.getPath('userData'), patchFiles });
  registerConsoleIpc(getWindow, entryUrl, { repositories, journal });
  registerFilesIpc(getWindow, entryUrl, { repositories, journal, editor, loginPath: automationPath });
  registerRepoToolsIpc(getWindow, entryUrl, { repositories, journal, undo, patchFiles, folders: createTokenRegistry() });
  const fetcher = registerFetchIpc(getWindow, entryUrl, { repositories, journal, undo, store: fetchSettings });
  const watcher = createRepositoryWatcher(getWindow);
  // With the window gone (macOS keeps the app running) nothing is on screen
  // to be kept current, so the background fetch stops until a window asks again.
  const hooked = new WeakSet();
  ipcMain.handle('repo:watch', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || (args[0] !== null && typeof args[0] !== 'string')) {
      throw new Error('Invalid watch request');
    }
    // The background fetch, when it is on, follows the same active repository.
    if (args[0] === null) { void watcher.watch(null); fetcher.follow(null); return true; }
    const repo = repositories.snapshot().repositories.find(item => item.id === args[0] && item.available);
    if (!repo) throw new Error('Repository is unavailable');
    void watcher.watch(repo.path);
    fetcher.follow(repo.path);
    const window = getWindow();
    if (window && !hooked.has(window)) { hooked.add(window); window.once('closed', () => fetcher.follow(null)); }
    return true;
  });
  ipcMain.handle('app:info', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid app information request');
    return { name: '🌱 Twig', version: app.getVersion(), platform: process.platform };
  });
  // The one network request this app makes on its own behalf, and only when the
  // person presses the button: read the latest release tag and compare it with
  // the running version. Nothing is downloaded, installed or sent anywhere.
  let updateCheck = null;
  ipcMain.handle('app:check-update', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid update request');
    // A second press while the first request is still open reuses it rather
    // than opening another connection.
    updateCheck ??= checkForUpdate({ currentVersion: app.getVersion() }).finally(() => { updateCheck = null; });
    return updateCheck;
  });
  ipcMain.handle('workspace:startup', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid workspace request');
    return { git, ...repositories.snapshot() };
  });
  ipcMain.handle('repositories:open', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid repository request');
    const window = getWindow();
    const choice = await dialog.showOpenDialog(window, { title: 'Open Git repository', properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return repositories.snapshot();
    return repositories.add(choice.filePaths[0]);
  });
  ipcMain.handle('repositories:select', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 4096) throw new Error('Invalid repository request');
    return repositories.select(args[0]);
  });
  // The renderer is sandboxed on a file:// origin, where the async Clipboard
  // API is unreliable and would need a permission this app grants to nothing.
  // Copy is a one-way write of a string the renderer already had on screen.
  ipcMain.handle('app:copy', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 1_000_000) {
      throw new Error('Invalid copy request');
    }
    clipboard.writeText(args[0]);
    return true;
  });
  ipcMain.handle('console:entries', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid console request');
    return journal.list();
  });
}
