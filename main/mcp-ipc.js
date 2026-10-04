import { app, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { createMcpService } from './mcp/service.js';

/**
 * Settings → AI agents (MCP): read and change whether 🌱 Twig listens
 * (`mcp:get`, `mcp:set`), and the window's one-way report of what is selected
 * (`mcp:ui-context`), which only ever lands in main's memory. Agents never
 * reach these channels — they talk to the socket the service opens.
 *
 * @returns {{ follow: (id: ?string) => void }} for `repo:watch`, which knows the active repository
 */
export function registerMcpIpc(getWindow, entryUrl, { repositories, journal, store }) {
  const service = createMcpService({
    userData: app.getPath('userData'), execPath: process.execPath, appImage: process.env.APPIMAGE || null,
    version: app.getVersion(), repositories, journal
  });
  void service.configure(store.get().enabled);
  app.on('will-quit', () => { void service.configure(false); });

  const valid = (event, args, count) => {
    const window = getWindow();
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
  };
  const settings = () => ({ ...store.get(), status: service.status(), config: service.config() });
  ipcMain.handle('mcp:get', (event, ...args) => {
    if (!valid(event, args, 0)) throw new Error('Invalid MCP request');
    return settings();
  });
  ipcMain.handle('mcp:set', async (event, ...args) => {
    if (!valid(event, args, 1) || typeof args[0] !== 'boolean') throw new Error('Invalid MCP request');
    await store.save({ enabled: args[0] });
    await service.configure(args[0]);
    return settings();
  });
  // One-way and frequent (every selection change), so a malformed report is
  // dropped rather than thrown back at the window.
  ipcMain.on('mcp:ui-context', (event, ...args) => {
    if (valid(event, args, 1)) service.setUiContext(args[0]);
  });
  return { follow: id => service.follow(id) };
}
