import { app, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';

export function registerIpc(getWindow, entryUrl) {
  ipcMain.handle('app:info', (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== 0) {
      throw new Error('Invalid app information request');
    }
    return { name: 'Git Desk', version: app.getVersion(), platform: process.platform };
  });
}
