import { app, ipcMain } from 'electron';
import { isTrustedPage } from './security.js';
import { createMcpService } from './mcp/service.js';
import { createCommitProposals, MESSAGE_LIMIT } from './mcp/commit-proposal.js';

const DECISIONS = ['commit', 'commit-push', 'cancel'];
const BUMPS = [null, 'none', 'patch', 'minor', 'major'];

/**
 * Settings → AI agents (MCP): read and change whether 🌱 Twig listens
 * (`mcp:get`, `mcp:set`) and whether agents may propose commits
 * (`mcp:allow-commits`), the window's one-way report of what is selected
 * (`mcp:ui-context`), and the commit-proposal dialog: main pushes a proposal
 * (`mcp:proposal`, null closes it), the window answers with the person's
 * decision (`mcp:proposal-decide`). Agents never reach these channels — they
 * talk to the socket the service opens.
 *
 * @returns {{ follow: (id: ?string) => void }} for `repo:watch`, which knows the active repository
 */
export function registerMcpIpc(getWindow, entryUrl, { repositories, journal, store, undo, automations, automationRuns, automationPath }) {
  const send = (channel, payload) => {
    const window = getWindow();
    if (!window || window.isDestroyed()) return false;
    window.webContents.send(channel, payload);
    return true;
  };
  const proposals = createCommitProposals({
    log: journal, undo, automations, runs: automationRuns, loginPath: automationPath,
    isAllowed: () => store.get().allowCommits,
    // A proposal brings the window forward: the person has to see it to answer it.
    present: view => {
      const window = getWindow();
      if (!window || window.isDestroyed()) return false;
      if (view) {
        if (window.isMinimized()) window.restore();
        window.show();
        if (process.platform === 'darwin') app.focus({ steal: true });
        window.focus();
      }
      window.webContents.send('mcp:proposal', view);
      return true;
    },
    onStep: step => send('mcp:proposal-step', { pipeline: step.pipeline ?? null, name: step.name, status: step.status })
  });
  const service = createMcpService({
    userData: app.getPath('userData'), execPath: process.execPath, appImage: process.env.APPIMAGE || null,
    version: app.getVersion(), repositories, journal, proposals
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
    await store.save({ ...store.get(), enabled: args[0] });
    await service.configure(args[0]);
    return settings();
  });
  ipcMain.handle('mcp:allow-commits', async (event, ...args) => {
    if (!valid(event, args, 1) || typeof args[0] !== 'boolean') throw new Error('Invalid MCP request');
    await store.save({ ...store.get(), allowCommits: args[0] });
    if (!args[0]) proposals.revokeAll();
    return settings();
  });
  ipcMain.handle('mcp:proposal-current', (event, ...args) => {
    if (!valid(event, args, 0)) throw new Error('Invalid MCP request');
    return proposals.current();
  });
  ipcMain.handle('mcp:proposal-decide', (event, ...args) => {
    const [id, decision] = args;
    if (!valid(event, args, 2) || typeof id !== 'string' || id.length > 64 || !decision || typeof decision !== 'object'
      || !DECISIONS.includes(decision.action) || typeof decision.message !== 'string' || decision.message.length > MESSAGE_LIMIT
      || !BUMPS.includes(decision.bump ?? null)) throw new Error('Invalid MCP request');
    return proposals.decide(id, { action: decision.action, message: decision.message, bump: decision.bump ?? null });
  });
  // One-way and frequent (every selection change), so a malformed report is
  // dropped rather than thrown back at the window.
  ipcMain.on('mcp:ui-context', (event, ...args) => {
    if (valid(event, args, 1)) service.setUiContext(args[0]);
  });
  return { follow: id => service.follow(id) };
}
