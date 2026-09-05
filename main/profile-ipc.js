import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { loadProfile, saveProfileValue } from './git/profile.js';

export function registerProfileIpc(getWindow, entryUrl, { journal, repositories, stateDir }) {
  const register = (channel, count, action) => ipcMain.handle(channel, (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new TypeError('Invalid profile request');
    const [id, scope, ...rest] = args;
    if (scope !== 'local' && scope !== 'global') throw new TypeError('Invalid profile scope');
    if (id !== null && (typeof id !== 'string' || id.length > 4096)) throw new TypeError('Invalid repository');
    const repository = id === null ? null : repositories.snapshot().repositories.find(item => item.id === id && item.available);
    if ((id !== null && !repository) || (scope === 'local' && !repository)) throw new TypeError('Open an available repository first');
    return action({ cwd: repository?.path || stateDir, log: journal, scope }, ...rest);
  });
  register('profile:read', 2, loadProfile);
  register('profile:save', 5, (options, key, value, expected) => saveProfileValue({ ...options, key, value, expected }));
}
