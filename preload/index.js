import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('twig', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  getWorkspace: () => ipcRenderer.invoke('workspace:startup'),
  openRepository: () => ipcRenderer.invoke('repositories:open'),
  selectRepository: (id) => ipcRenderer.invoke('repositories:select', id),
  getHistoryPage: (id, skip = 0, limit = 250) => ipcRenderer.invoke('history:page', id, skip, limit),
  getRefs: (id) => ipcRenderer.invoke('history:refs', id),
  getCommit: (id, oid) => ipcRenderer.invoke('history:commit', id, oid),
  getCommitFiles: (id, oid) => ipcRenderer.invoke('history:files', id, oid),
  getFileDiff: (id, oid, file, base = null) => ipcRenderer.invoke('history:diff', id, oid, file, base),
  compareCommits: (id, base, oid) => ipcRenderer.invoke('history:compare', id, base, oid),
  getConsoleEntries: () => ipcRenderer.invoke('console:entries'),
  onConsoleUpdate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Console listener must be a function');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('console:update', callback);
    return () => ipcRenderer.removeListener('console:update', callback);
  }
}));
