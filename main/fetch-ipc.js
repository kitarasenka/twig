import { ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { FETCH_INTERVALS, createFetchScheduler } from './background-fetch.js';
import { backgroundFetch } from './git/sync.js';

/**
 * Background fetch channels: read and change the consent (`fetch:get`,
 * `fetch:set`) and read how the active repository's schedule stands
 * (`fetch:status`). The renderer never starts a fetch through these — main
 * runs it on its own timer, and only while Settings says so.
 *
 * @returns {{ follow: (cwd: ?string) => void }} the scheduler, which follows the watched (active) repository
 */
export function registerFetchIpc(getWindow, entryUrl, { repositories, journal, undo, store }) {
  const scheduler = createFetchScheduler({
    run: (cwd, signal) => backgroundFetch({ cwd, log: journal, signal }),
    isBusy: cwd => undo.isBusy(cwd),
    onUpdate: cwd => {
      const window = getWindow();
      if (window && !window.isDestroyed()) window.webContents.send('fetch:update', { cwd });
    }
  });
  scheduler.configure(store.get().interval);
  // The person's own action always wins: a background fetch on that repository gives way.
  undo.onChange(cwd => { if (undo.isBusy(cwd)) scheduler.cancel(cwd); });

  function handler(channel, count, action) {
    ipcMain.handle(channel, (event, ...args) => {
      const window = getWindow();
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !isTrustedPage(event.senderFrame.url, entryUrl) || args.length !== count) throw new Error('Invalid fetch request');
      return action(...args);
    });
  }
  const settings = () => ({ ...store.get(), intervals: [...FETCH_INTERVALS] });
  handler('fetch:get', 0, () => settings());
  handler('fetch:set', 1, async interval => {
    if (!FETCH_INTERVALS.includes(interval)) throw new Error('Invalid fetch interval');
    await store.save({ interval });
    scheduler.configure(interval);
    return settings();
  });
  handler('fetch:status', 1, id => {
    if (typeof id !== 'string') throw new Error('Invalid fetch request');
    const repo = repositories.snapshot().repositories.find(item => item.id === id && item.available);
    if (!repo) throw new Error('Repository is unavailable');
    return scheduler.status(repo.path);
  });
  return scheduler;
}
