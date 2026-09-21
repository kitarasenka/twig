import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('twig', Object.freeze({
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  checkForUpdate: () => ipcRenderer.invoke('app:check-update'),
  getSshKeys: () => ipcRenderer.invoke('ssh:keys'),
  secureSshKey: name => ipcRenderer.invoke('ssh:secure-key', name),
  getSshConfig: () => ipcRenderer.invoke('ssh:config'),
  generateSshKey: (name, comment, passphrase) => ipcRenderer.invoke('ssh:generate', name, comment, passphrase),
  saveSshConfig: (content, digest) => ipcRenderer.invoke('ssh:save-config', content, digest),
  testSshConnection: target => ipcRenderer.invoke('ssh:test', target),
  cancelSshConnection: () => ipcRenderer.invoke('ssh:cancel'),
  getUndoState: id => ipcRenderer.invoke('undo:state', id),
  moveUndo: (id, direction) => ipcRenderer.invoke('undo:move', id, direction),
  onUndoUpdate: listener => {
    if (typeof listener !== 'function') throw new TypeError('Invalid Undo listener');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('undo:update', callback);
    return () => ipcRenderer.removeListener('undo:update', callback);
  },
  watchRepository: id => ipcRenderer.invoke('repo:watch', id),
  onRepositoryChange: listener => {
    if (typeof listener !== 'function') throw new TypeError('Invalid repository-change listener');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('repo:external-change', callback);
    return () => ipcRenderer.removeListener('repo:external-change', callback);
  },
  getWorkspace: () => ipcRenderer.invoke('workspace:startup'),
  openRepository: () => ipcRenderer.invoke('repositories:open'),
  selectRepository: (id) => ipcRenderer.invoke('repositories:select', id),
  removeRepository: (id) => ipcRenderer.invoke('repositories:remove', id),
  resetDemoWorkspace: () => ipcRenderer.invoke('sandbox:reset'),
  setDemoWorkspaceVisible: (visible) => ipcRenderer.invoke('sandbox:visible', visible),
  getRemotes: (id) => ipcRenderer.invoke('remotes:read', id),
  changeRemote: (id, action, name, url = null, expected = null) => ipcRenderer.invoke('remotes:change', id, action, name, url, expected),
  cancelRemote: (id) => ipcRenderer.invoke('remotes:cancel', id),
  chooseCloneDestination: () => ipcRenderer.invoke('clone:destination'),
  cloneRepository: (token, name, url) => ipcRenderer.invoke('clone:start', token, name, url),
  cancelClone: () => ipcRenderer.invoke('clone:cancel'),
  getGitProfile: (id, scope) => ipcRenderer.invoke('profile:read', id, scope),
  saveGitProfileValue: (id, scope, key, value, expected) => ipcRenderer.invoke('profile:save', id, scope, key, value, expected),
  getHistoryPage: (id, skip = 0, limit = 250) => ipcRenderer.invoke('history:page', id, skip, limit),
  getRefs: (id) => ipcRenderer.invoke('history:refs', id),
  getCommit: (id, oid) => ipcRenderer.invoke('history:commit', id, oid),
  getCommitFiles: (id, oid) => ipcRenderer.invoke('history:files', id, oid),
  getFileDiff: (id, oid, file, base = null) => ipcRenderer.invoke('history:diff', id, oid, file, base),
  compareCommits: (id, base, oid) => ipcRenderer.invoke('history:compare', id, base, oid),
  getRebaseCandidates: (id, oid) => ipcRenderer.invoke('history:rebase-todo', id, oid),
  listMarks: (id) => ipcRenderer.invoke('marks:list', id),
  setMark: (id, oid, color, note) => ipcRenderer.invoke('marks:set', id, oid, color, note),
  clearMark: (id, oid) => ipcRenderer.invoke('marks:clear', id, oid),
  getFileHistory: (id, file) => ipcRenderer.invoke('history:file-log', id, file),
  getBlame: (id, oid, path) => ipcRenderer.invoke('blame:file', id, oid, path),
  getReverseBlame: (id, startOid, endRef, path) => ipcRenderer.invoke('blame:reverse', id, startOid, endRef, path),
  getBlameBefore: (id, oid, path, line, parentIndex = null) => ipcRenderer.invoke('blame:before', id, oid, path, line, parentIndex),
  cancelBlame: (id) => ipcRenderer.invoke('blame:cancel', id),
  searchHistory: (id, query) => ipcRenderer.invoke('history:search', id, query),
  copyText: (text) => ipcRenderer.invoke('app:copy', text),
  readWorktree: (id) => ipcRenderer.invoke('worktree:read', id),
  getWorktreeDiff: (id, path, staged = false) => ipcRenderer.invoke('worktree:diff', id, path, staged),
  stageFile: (id, path) => ipcRenderer.invoke('worktree:stage', id, path),
  unstageFile: (id, path, unborn = false) => ipcRenderer.invoke('worktree:unstage', id, path, unborn),
  trackFile: (id, path) => ipcRenderer.invoke('worktree:track', id, path),
  stageAll: (id, scope) => ipcRenderer.invoke('worktree:stage-all', id, scope),
  unstageAll: (id) => ipcRenderer.invoke('worktree:unstage-all', id),
  applySelection: (id, path, staged, digest, selection) => ipcRenderer.invoke('worktree:apply', id, path, staged, digest, selection),
  createCommit: (id, message, amend = false, expectedHead = null) => ipcRenderer.invoke('worktree:commit', id, message, amend, amend ? expectedHead : null),
  stashPush: (id, includeUntracked = false, message = '') => ipcRenderer.invoke('stash:push', id, includeUntracked, message),
  stashPop: (id) => ipcRenderer.invoke('stash:pop', id),
  stashList: (id) => ipcRenderer.invoke('stash:list', id),
  stashFiles: (id, oid) => ipcRenderer.invoke('stash:files', id, oid),
  stashDiff: (id, oid, path, untracked = false) => ipcRenderer.invoke('stash:diff', id, oid, path, untracked),
  stashAction: (id, action, index, expectedOid, name = null) => ipcRenderer.invoke('stash:action', id, action, index, expectedOid, name),
  getDivergence: (id, branch = null) => ipcRenderer.invoke('sync:divergence', id, branch),
  runSync: (id, mode, branch = null) => ipcRenderer.invoke('sync:run', id, mode, branch),
  cancelSync: (id) => ipcRenderer.invoke('sync:cancel', id),
  runDrop: (id, request) => ipcRenderer.invoke('sync:drop', id, request),
  pushRef: (id, remote, ref, remove = false) => ipcRenderer.invoke('sync:push-ref', id, remote, ref, remove),
  getOperationState: (id) => ipcRenderer.invoke('ops:state', id),
  mergeRevision: (id, revision, noFf = false) => ipcRenderer.invoke('ops:merge', id, revision, noFf),
  cherryPick: (id, oid) => ipcRenderer.invoke('ops:cherry-pick', id, oid),
  revertCommit: (id, oid, mainline = null) => ipcRenderer.invoke('ops:revert', id, oid, mainline),
  resetTo: (id, mode, oid) => ipcRenderer.invoke('ops:reset', id, mode, oid),
  runSequencer: (id, kind, step) => ipcRenderer.invoke('ops:sequencer', id, kind, step),
  rebaseOnto: (id, oid, entries = null) => ipcRenderer.invoke('ops:rebase', id, oid, entries),
  rewordCommit: (id, oid, message) => ipcRenderer.invoke('ops:reword', id, oid, message),
  createBranch: (id, name, startPoint, checkout = false) => ipcRenderer.invoke('refs:create-branch', id, name, startPoint, checkout),
  createTag: (id, name, oid, message = '') => ipcRenderer.invoke('refs:create-tag', id, name, oid, message),
  checkoutRef: (id, target, detach = false) => ipcRenderer.invoke('refs:checkout', id, target, detach),
  deleteBranch: (id, name, force = false) => ipcRenderer.invoke('refs:delete-branch', id, name, force),
  renameBranch: (id, from, to) => ipcRenderer.invoke('refs:rename-branch', id, from, to),
  setUpstream: (id, branch, upstream) => ipcRenderer.invoke('refs:upstream', id, branch, upstream),
  deleteTag: (id, name) => ipcRenderer.invoke('refs:delete-tag', id, name),
  getBisectState: (id) => ipcRenderer.invoke('bisect:state', id),
  runBisect: (id, step, oid = null) => ipcRenderer.invoke('bisect:run', id, step, oid),
  readConflict: (id, path) => ipcRenderer.invoke('conflict:read', id, path),
  saveConflict: (id, path, content, mtimeMs, size) => ipcRenderer.invoke('conflict:save', id, path, content, mtimeMs, size),
  takeConflictSide: (id, path, side) => ipcRenderer.invoke('conflict:take', id, path, side),
  markConflictResolved: (id, path) => ipcRenderer.invoke('conflict:resolve', id, path),
  getAutomationConfig: (id) => ipcRenderer.invoke('automation:config', id),
  saveAutomationConfig: (id, config) => ipcRenderer.invoke('automation:save', id, config),
  trustAutomations: (id, trust) => ipcRenderer.invoke('automation:trust', id, trust),
  runAutomation: (id, event, options = null) => ipcRenderer.invoke('automation:run', id, event, options),
  cancelAutomation: (id) => ipcRenderer.invoke('automation:cancel', id),
  getAutomationRuns: (id) => ipcRenderer.invoke('automation:runs', id),
  getAutomationRun: (id, executionId) => ipcRenderer.invoke('automation:run-detail', id, executionId),
  onAutomationStep: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Automation listener must be a function');
    const callback = (_event, step) => listener(step);
    ipcRenderer.on('automation:step', callback);
    return () => ipcRenderer.removeListener('automation:step', callback);
  },
  getConsoleEntries: () => ipcRenderer.invoke('console:entries'),
  runConsoleCommand: (id, input) => ipcRenderer.invoke('console:run-command', id, input),
  onConsoleUpdate: (listener) => {
    if (typeof listener !== 'function') throw new TypeError('Console listener must be a function');
    const callback = (_event, update) => listener(update);
    ipcRenderer.on('console:update', callback);
    return () => ipcRenderer.removeListener('console:update', callback);
  }
}));
