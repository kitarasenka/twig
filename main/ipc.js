import { app, clipboard, dialog, ipcMain } from 'electron';
import { nt } from './language.js';
import { ui } from '../renderer/src/i18n/i18n.js';
import { createBumper } from './automation/bump.js';
import { isTrustedPage } from './security.js';
import { registerHistoryIpc } from './history-ipc.js';
import { registerBlameIpc } from './blame-ipc.js';
import { registerHistoryOpsIpc } from './history-ops-ipc.js';
import { registerWorktreeIpc } from './worktree-ipc.js';
import { registerProfileIpc } from './profile-ipc.js';
import { registerRepositoryIpc } from './repository-ipc.js';
import { registerUndoIpc } from './undo-ipc.js';
import { registerSshIpc } from './ssh-ipc.js';
import { registerMarksIpc } from './marks-ipc.js';
import { registerAutomationsIpc } from './automations-ipc.js';
import { registerConsoleIpc } from './console-ipc.js';
import { registerFilesIpc } from './files-ipc.js';
import { registerFetchIpc } from './fetch-ipc.js';
import { registerRepoToolsIpc } from './repo-tools-ipc.js';
import { createTokenRegistry } from './token-registry.js';
import { inspectRepository } from './git/config-risk.js';
import { initRepository, buildInitArgv, loadDefaultBranch } from './git/init.js';
import { createRepositoryWatcher } from './repo-watch.js';
import { registerUpdateIpc } from './update-ipc.js';
import { registerMcpIpc } from './mcp-ipc.js';

function validSender(event, getWindow, entryUrl, args, count) {
  const window = getWindow();
  return window && event.sender === window.webContents
    && event.senderFrame === window.webContents.mainFrame
    && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
}

const SHOWN_FINDINGS = 12;

function findingLines(findings) {
  const lines = findings.slice(0, SHOWN_FINDINGS).map(({ key, value }) => `${key} = ${value.length > 200 ? `${value.slice(0, 200)}…` : value}`);
  if (findings.length > SHOWN_FINDINGS) lines.push(nt`and ${findings.length - SHOWN_FINDINGS} more`);
  return lines.join('\n');
}

export function registerIpc(getWindow, entryUrl, { journal, repositories, trust, git, undo, marks, automations, automationRuns, automationPath, editor, fetchSettings, updateSettings, mcpSettings, language }) {
  /**
   * Before the first `git status` of a folder: one that holds programs Git
   * would run, or a push going elsewhere, opens only after the person says so.
   * The answer is kept, so it is asked once and not at every launch.
   */
  async function confirmRepository(directory) {
    const inspection = await inspectRepository(directory, journal);
    if (!inspection) return true;
    const fresh = trust.unapproved(inspection);
    if (fresh.length) {
      const answer = await dialog.showMessageBox(getWindow(), {
        type: 'warning', buttons: [nt('Cancel'), nt('Open anyway')], defaultId: 0, cancelId: 0, noLink: true,
        message: nt('This repository can run programs or send your work elsewhere'),
        detail: `${findingLines(fresh)}\n\n`
          + nt('Git runs these while 🌱 Twig only reads the repository or on your own commit, merge and push. Open it only if you trust where this folder came from.')
      });
      if (answer.response !== 1) return false;
    }
    await trust.approve(inspection);
    return true;
  }
  /** A connected repository that stopped: its settings changed, or it was connected before these checks. Answered once per change. */
  async function reviewRepository(folder) {
    const pending = trust.pending(folder);
    if (!pending) return false;
    const answer = await dialog.showMessageBox(getWindow(), {
      type: 'warning', buttons: [nt('Keep stopped'), nt('Allow')], defaultId: 0, cancelId: 0, noLink: true,
      message: nt`🌱 Twig stopped reading ${pending.name}`,
      detail: `${findingLines(pending.findings)}\n\n`
        + nt('These Git settings or hooks are new to 🌱 Twig. It stopped using this repository so they cannot run. Allow them only if you know where they came from. Open repository asks again.')
    });
    await trust.answer(folder, answer.response === 1);
    return answer.response === 1;
  }
  // The "Bump version" action: planned for the commit panel and agent proposals, applied by their commit.
  const bumper = createBumper({ log: journal, automations });
  registerUpdateIpc(getWindow, entryUrl, { journal, store: updateSettings });
  registerUndoIpc(getWindow, entryUrl, { repositories, undo });
  registerMarksIpc(getWindow, entryUrl, { repositories, marks });
  registerAutomationsIpc(getWindow, entryUrl, { repositories, journal, automations, runs: automationRuns, loginPath: automationPath, bumper });
  registerSshIpc(getWindow, entryUrl, { journal });
  registerRepositoryIpc(getWindow, entryUrl, { journal, repositories, undo });
  registerProfileIpc(getWindow, entryUrl, { journal, repositories, stateDir: app.getPath('userData') });
  registerHistoryIpc(getWindow, entryUrl, { journal, repositories });
  registerBlameIpc(getWindow, entryUrl, { journal, repositories });
  registerWorktreeIpc(getWindow, entryUrl, { journal, repositories, undo, bumper });
  const patchFiles = createTokenRegistry();
  registerHistoryOpsIpc(getWindow, entryUrl, { journal, repositories, undo, stateDir: app.getPath('userData'), patchFiles });
  registerConsoleIpc(getWindow, entryUrl, { repositories, journal });
  registerFilesIpc(getWindow, entryUrl, { repositories, journal, editor, loginPath: automationPath });
  // Proposals live with the MCP service registered below; the board asks for them when it reads.
  registerRepoToolsIpc(getWindow, entryUrl, { repositories, journal, undo, patchFiles, folders: createTokenRegistry(), automations, automationRuns, automationPath, confirmRepository,
    pendingProposals: () => mcp.pendingPaths(), connectedAgents: () => mcp.agents() });
  const fetcher = registerFetchIpc(getWindow, entryUrl, { repositories, journal, undo, store: fetchSettings });
  const mcp = registerMcpIpc(getWindow, entryUrl, { repositories, journal, store: mcpSettings, undo, automations, automationRuns, automationPath, bumper });
  // The window learns of a config or hook change only when it stopped the repository or was allowed.
  const watcher = createRepositoryWatcher(getWindow, undefined, async (cwd) => {
    await trust.check(cwd);
    if (!trust.blocked(cwd)) return;
    await reviewRepository(cwd);
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('repo:external-change', { cwd, changedAt: Date.now() });
  });
  // With the window gone (macOS keeps the app running) nothing is on screen
  // to be kept current, so the background fetch stops until a window asks again.
  const hooked = new WeakSet();
  ipcMain.handle('repo:watch', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || (args[0] !== null && typeof args[0] !== 'string')) {
      throw new Error('Invalid watch request');
    }
    // The background fetch, when it is on, follows the same active repository.
    // So does the MCP server's idea of "the repository open in 🌱 Twig".
    if (args[0] === null) { void watcher.watch(null); fetcher.follow(null); mcp.follow(null); return true; }
    const repo = repositories.snapshot().repositories.find(item => item.id === args[0] && item.available);
    if (!repo) throw new Error(ui`Repository is unavailable`);
    void watcher.watch(repo.path);
    fetcher.follow(repo.path);
    mcp.follow(repo.id);
    const window = getWindow();
    if (window && !hooked.has(window)) { hooked.add(window); window.once('closed', () => { fetcher.follow(null); mcp.follow(null); }); }
    return true;
  });
  // The interface language. The renderer asks before its first paint and
  // loads its own catalog; main switches the menu bar and native dialogs.
  ipcMain.handle('language:get', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid language request');
    return language.get();
  });
  ipcMain.handle('language:set', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 16) throw new Error('Invalid language request');
    return language.set(args[0]);
  });
  ipcMain.handle('app:info', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid app information request');
    return { name: '🌱 Twig', version: app.getVersion(), platform: process.platform };
  });
  // Waits for the repository the window opens on, not for every connected one:
  // the others arrive through `workspace:update`.
  const startupView = async () => { await git.ready(); return { git: git.state(), ...repositories.snapshot() }; };
  ipcMain.handle('workspace:startup', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid workspace request');
    return startupView();
  });
  ipcMain.handle('git:check', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid workspace request');
    await git.recheck();
    return startupView();
  });
  repositories.onUpdate(snapshot => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('workspace:update', snapshot);
  });
  // Folders picked in a native dialog, held until the person confirms what to do with them.
  const folders = createTokenRegistry();
  ipcMain.handle('repositories:open', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid repository request');
    const window = getWindow();
    const choice = await dialog.showOpenDialog(window, { title: nt('Open Git repository'), properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return repositories.snapshot();
    const directory = choice.filePaths[0];
    if (await repositories.inspect(directory) === 'none') {
      const branch = await loadDefaultBranch({ cwd: directory, log: journal });
      return { ...repositories.snapshot(), init: { token: folders.add('init', { directory, branch }), path: directory, command: buildInitArgv(branch) } };
    }
    if (!await confirmRepository(directory)) return repositories.snapshot();
    return repositories.add(directory);
  });
  // A folder with no repository, once the person agreed to start one there.
  ipcMain.handle('repositories:init', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1)) throw new Error('Invalid repository request');
    const { directory, branch } = folders.take('init', args[0]);
    const fresh = await repositories.inspect(directory) === 'none';
    if (fresh) await initRepository({ cwd: directory, log: journal, branch });
    else if (!await confirmRepository(directory)) return repositories.snapshot();
    return repositories.add(directory, { made: fresh });
  });
  // A connected repository that moved: the new folder is picked here and held
  // by a token, so the path never comes from the renderer.
  ipcMain.handle('repositories:choose-location', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 4096) throw new Error('Invalid repository request');
    const repository = repositories.snapshot().repositories.find(item => item.id === args[0] && !item.sandbox);
    if (!repository) throw new Error(ui`Unknown repository.`);
    const window = getWindow();
    const choice = await dialog.showOpenDialog(window, { title: nt`Locate ${repository.name}`, properties: ['openDirectory'] });
    if (choice.canceled || !choice.filePaths[0]) return null;
    const directory = choice.filePaths[0];
    if (!await confirmRepository(directory)) return null;
    return { token: folders.add(repository.id, { directory }), path: directory };
  });
  ipcMain.handle('repositories:locate', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 2) || typeof args[0] !== 'string' || args[0].length > 4096) throw new Error('Invalid repository request');
    const { directory } = folders.take(args[0], args[1]);
    return repositories.relocate(args[0], directory);
  });
  ipcMain.handle('repositories:select', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 4096) throw new Error('Invalid repository request');
    const snapshot = await repositories.select(args[0]);
    const repository = snapshot.repositories.find(item => item.id === args[0]);
    return repository?.blocked && await reviewRepository(repository.path) ? repositories.select(args[0]) : snapshot;
  });
  // The renderer is sandboxed on a file:// origin, where the async Clipboard
  // API is unreliable and would need a permission this app grants to nothing.
  // Copy is a one-way write of a string the renderer already had on screen.
  ipcMain.handle('app:copy', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 1_000_000) {
      throw new Error('Invalid copy request');
    }
    clipboard.writeText(args[0]);
    return true;
  });
  // Settings → Command journal: what 🌱 Twig keeps of the commands it ran and of automation runs.
  ipcMain.handle('console:clear', async (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid console request');
    await Promise.all([journal.clear(), automationRuns.clear()]);
    return true;
  });
  ipcMain.handle('console:entries', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 0)) throw new Error('Invalid console request');
    return journal.list();
  });
  // The output of an automatic read reaches the window only when its entry is
  // opened (the list and the live events leave it out).
  ipcMain.handle('console:output', (event, ...args) => {
    if (!validSender(event, getWindow, entryUrl, args, 1) || typeof args[0] !== 'string' || args[0].length > 100) throw new Error('Invalid console request');
    return journal.outputOf(args[0]);
  });
}
