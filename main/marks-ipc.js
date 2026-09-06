import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { validateMark, validateOid } from './marks.js';

/** Local commit marks. No Git runs here: marks are userData metadata, not repository objects. */
export function registerMarksIpc(getWindow, entryUrl, { repositories, marks }) {
  function handler(channel, count, read) {
    ipcMain.handle(channel, async (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count
        || typeof args[0] !== 'string') throw new TypeError('Invalid mark request');
      const repo = repositories.snapshot().repositories.find(item => item.id === args[0]);
      if (!repo) throw new TypeError('Unknown repository');
      return read(repo.id, ...args.slice(1));
    });
  }
  handler('marks:list', 1, repoId => marks.list(repoId));
  handler('marks:set', 4, (repoId, oid, color, note) => {
    const mark = validateMark(oid, color, note);
    return marks.set(repoId, mark.oid, { color: mark.color, note: mark.note });
  });
  handler('marks:clear', 2, (repoId, oid) => marks.clear(repoId, validateOid(oid)));
}
