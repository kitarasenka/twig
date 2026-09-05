import { app, dialog, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';

function validSender(event, getWindow, entryUrl, args, count) {
  const window = getWindow();
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
}

export function registerIpc(getWindow, entryUrl, { journal, repositories, git }) {
  ipcMain.handle('app:info', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid app information request');
    return { name: '🌱Twig', version: app.getVersion(), platform: process.platform };
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
  ipcMain.handle('console:entries', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid console request');
    return journal.list();
  });
}
