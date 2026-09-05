import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('twig', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getWorkspace: () => ipcRenderer.invoke('workspace:startup'),
  openRepository: () => ipcRenderer.invoke('repositories:open'),
  selectRepository: (id) => ipcRenderer.invoke('repositories:select', id),
  getConsoleEntries: () => ipcRenderer.invoke('console:entries'),
  onConsoleUpdate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Console listener must be a function');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('console:update', callback);
    return () => ipcRenderer.removeListener('console:update', callback);
  }
}));
