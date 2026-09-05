import { app, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { createSshService } from './ssh/service.js';

export function registerSshIpc(getWindow, entryUrl, { journal }) {
  const ssh = createSshService({ home: app.getPath('home'), log: journal });
  let busy = false; let connection = null;
  const register = (channel, count, action, writes = false) => ipcMain.handle(channel, async (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new TypeError('Invalid SSH request');
    if (!writes) return action(...args);
    if (busy) throw new Error('Another SSH action is running.');
    busy = true;
    try { return await action(...args); } finally { busy = false; }
  });
  register('ssh:keys', 0, ssh.keys);
  register('ssh:config', 0, ssh.readConfig);
  register('ssh:generate', 3, (name, comment, passphrase) => ssh.generate({ name, comment, passphrase }), true);
  register('ssh:secure-key', 1, ssh.secureKey, true);
  register('ssh:save-config', 2, ssh.saveConfig, true);
  register('ssh:test', 1, async target => {
    connection = new AbortController();
    try { return await ssh.testConnection(target, connection.signal); } finally { connection = null; }
  }, true);
  register('ssh:cancel', 0, () => { connection?.abort(); return true; });
}
