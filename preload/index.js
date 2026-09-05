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
  readWorktree: (id) => ipcRenderer.invoke('worktree:read', id),
  getWorktreeDiff: (id, path, staged = false) => ipcRenderer.invoke('worktree:diff', id, path, staged),
  stageFile: (id, path) => ipcRenderer.invoke('worktree:stage', id, path),
  unstageFile: (id, path, unborn = false) => ipcRenderer.invoke('worktree:unstage', id, path, unborn),
  trackFile: (id, path) => ipcRenderer.invoke('worktree:track', id, path),
  applySelection: (id, path, staged, digest, selection) => ipcRenderer.invoke('worktree:apply', id, path, staged, digest, selection),
  createCommit: (id, message, amend = false) => ipcRenderer.invoke('worktree:commit', id, message, amend),
  stashPush: (id, includeUntracked = false, message = '') => ipcRenderer.invoke('stash:push', id, includeUntracked, message),
  stashPop: (id) => ipcRenderer.invoke('stash:pop', id),
  stashList: (id) => ipcRenderer.invoke('stash:list', id),
  getDivergence: (id, branch = null) => ipcRenderer.invoke('sync:divergence', id, branch),
  runSync: (id, mode, branch = null) => ipcRenderer.invoke('sync:run', id, mode, branch),
  cancelSync: (id) => ipcRenderer.invoke('sync:cancel', id),
  getConsoleEntries: () => ipcRenderer.invoke('console:entries'),
  onConsoleUpdate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Console listener must be a function');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('console:update', callback);
    return () => ipcRenderer.removeListener('console:update', callback);
  }
}));
