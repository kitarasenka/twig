import { dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { isTrustedPage } from './security.js';
import { cloneRepository, validateCloneName } from './git/clone.js';
import { changeRemote, loadRemotes, validateRepositoryUrl } from './git/remotes.js';

export function registerRepositoryIpc(getWindow, entryUrl, { journal, repositories, undo }) {
  let destination = null;
  let clone = null;
  const remoteJobs = new Map();
  const register = (channel, count, action) => ipcMain.handle(channel, (event, ...args) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new TypeError('Invalid repository management request');
    return action(...args);
  });
  function repository(id, requireAvailable = true) {
    if (typeof id !== 'string' || id.length > 4096) throw new TypeError('Invalid repository id');
    const item = repositories.snapshot().repositories.find(item => item.id === id);
    if (!item || (requireAvailable && !item.available)) throw new TypeError('Repository is unavailable');
    return item;
  }
  register('sandbox:reset', 0, () => repositories.resetSandbox());
  // Closing the demo tab is a stored preference, not a repository mutation: it
  // deletes nothing, and the same sandbox comes back when it is shown again.
  register('sandbox:visible', 1, visible => {
    if (typeof visible !== 'boolean') throw new TypeError('Invalid demo workspace visibility');
    return repositories.setSandboxVisible(visible);
  });
  register('repositories:remove', 1, id => {
    repository(id, false);
    if (remoteJobs.has(id)) throw new Error('Wait for the remote action before removing this repository.');
    return repositories.remove(id);
  });
  register('remotes:read', 1, id => loadRemotes({ cwd: repository(id).path, log: journal }));
  register('remotes:change', 5, async (id, action, name, url, expected) => {
    const item = repository(id);
    if (remoteJobs.has(id)) throw new Error('A remote action is already running.');
    const controller = new AbortController(); remoteJobs.set(id, controller);
    try { return await undo.perform(item.path, `remotes:${action}`, [], () => changeRemote({ cwd: item.path, log: journal, action, name, url, expected, signal: controller.signal })); }
    finally { remoteJobs.delete(id); }
  });
  register('remotes:cancel', 1, id => { repository(id); remoteJobs.get(id)?.abort(); return true; });
  register('clone:destination', 0, async () => {
    const choice = await dialog.showOpenDialog(getWindow(), { title: 'Choose parent folder for clone', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    destination = { token: randomUUID(), path: choice.filePaths[0], expires: Date.now() + 15 * 60 * 1000 };
    return { token: destination.token, path: destination.path };
  });
  register('clone:start', 3, async (token, name, url) => {
    if (typeof token !== 'string' || token !== destination?.token || destination.expires < Date.now()) throw new TypeError('Choose the destination folder again.');
    validateCloneName(name); validateRepositoryUrl(url);
    if (clone) throw new Error('A clone is already running.');
    const controller = new AbortController(); clone = controller;
    try {
      const result = await cloneRepository({ parent: destination.path, name, url, log: journal, signal: controller.signal });
      if (!result.ok) return result;
      return { ...result, workspace: await repositories.add(result.path) };
    } finally { clone = null; }
  });
  register('clone:cancel', 0, () => { clone?.abort(); return true; });
}
