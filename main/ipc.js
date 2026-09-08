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
import { createRepositoryWatcher } from './repo-watch.js';

function validSender(event, getWindow, entryUrl, args, count) {
  const window = getWindow();
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
}

export function registerIpc(getWindow, entryUrl, { journal, repositories, git, undo, marks, automations, automationRuns, automationPath }) {
  registerUndoIpc(getWindow, entryUrl, { repositories, undo });
  registerMarksIpc(getWindow, entryUrl, { repositories, marks });
  registerAutomationsIpc(getWindow, entryUrl, { repositories, journal, automations, runs: automationRuns, loginPath: automationPath });
  registerSshIpc(getWindow, entryUrl, { journal });
  registerRepositoryIpc(getWindow, entryUrl, { journal, repositories, undo });
  registerProfileIpc(getWindow, entryUrl, { journal, repositories, stateDir: app.getPath('userData') });
  registerHistoryIpc(getWindow, entryUrl, { journal, repositories });
  registerBlameIpc(getWindow, entryUrl, { journal, repositories });
  registerWorktreeIpc(getWindow, entryUrl, { journal, repositories, undo });
  registerHistoryOpsIpc(getWindow, entryUrl, { journal, repositories, undo, stateDir: app.getPath('userData') });
  registerConsoleIpc(getWindow, entryUrl, { repositories, journal });
  const watcher = createRepositoryWatcher(getWindow);
  ipcMain.handle('repo:watch', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || (args[0] !== null && typeof args[0] !== 'string')) {
      throw new Error('Invalid watch request');
    }
    if (args[0] === null) { void watcher.watch(null); return true; }
    const repo = repositories.snapshot().repositories.find(item => item.id === args[0] && item.available);
    if (!repo) throw new Error('Repository is unavailable');
    void watcher.watch(repo.path);
    return true;
  });
  ipcMain.handle('app:info', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid app information request');
    return { name: '🌱 Twig', version: app.getVersion(), platform: process.platform };
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
