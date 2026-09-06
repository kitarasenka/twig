import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { loadCommit, loadCommitFiles, loadFileDiff, loadRangeFiles } from './git/commit.js';

/** Only registered repository IDs cross IPC; revisions and files are validated by each reader. */
export function registerHistoryIpc(getWindow, entryUrl, { repositories, journal }) {
  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new Error('Invalid history request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo || !repo.available) throw new Error('Repository is unavailable');
      return read({ cwd: repo.path, log: journal }, ...args.slice(1));
    });
  }
  handler('history:page', 3, async (options, skip, limit) => {
    if (!Number.isSafeInteger(skip) || skip < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid history page');
    const { loadHistoryPage } = await import('./git/history.js');
    return loadHistoryPage({ ...options, skip, limit });
  });
  handler('history:file-log', 2, async (options, file) => {
    const { loadFileHistory } = await import('./git/history.js');
    return loadFileHistory({ ...options, file });
  });
  handler('history:rebase-todo', 2, async (options, oid) => {
    const { loadRebaseCandidates } = await import('./git/history.js');
    return loadRebaseCandidates({ ...options, oid });
  });
  handler('history:refs', 1, async options => {
    const { loadRefs } = await import('./git/refs.js');
    return loadRefs(options);
  });
  handler('history:commit', 2, (options, oid) => loadCommit({ ...options, oid }));
  handler('history:files', 2, (options, oid) => loadCommitFiles({ ...options, oid }));
  handler('history:diff', 4, (options, oid, file, base) => loadFileDiff({ ...options, oid, file, base }));
  handler('history:compare', 3, (options, base, oid) => loadRangeFiles({ ...options, base, oid }));
}
