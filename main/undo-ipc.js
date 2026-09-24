import { dialog, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';

export function registerUndoIpc(getWindow, entryUrl, { repositories, undo }) {
  const register = (channel, count, action) => ipcMain.handle(channel, (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count || typeof args[0] !== 'string') throw new TypeError('Invalid Undo request');
    const repo = repositories.snapshot().repositories.find(item => item.id === args[0] && item.available);
    if (!repo) throw new TypeError('Repository is unavailable');
    return action(repo.path, ...args.slice(1));
  });
  register('undo:state', 1, cwd => undo.inspect(cwd));
  register('undo:move', 2, (cwd, direction) => undo.move(cwd, direction, async (plan, direction) => {
    const command = plan.commands.map(argv => ['git', '--no-pager', '-c', 'color.ui=false', '-c', 'log.showSignature=false', ...argv].map(value => JSON.stringify(value)).join(' ')).join('\n');
    const result = await dialog.showMessageBox(getWindow(), { type: 'warning', title: `${direction === 'undo' ? 'Undo' : 'Redo'} Git action`,
      message: plan.explanation, detail: `${command}\n\nRepository: ${cwd}`, buttons: ['Cancel', 'Run these commands'], defaultId: 0, cancelId: 0 });
    return result.response === 1;
  }));
  undo.onChange(cwd => { const window = getWindow(); if (window && !window.isDestroyed()) window.webContents.send('undo:update', { cwd }); });
}
