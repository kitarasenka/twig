import { app, BrowserWindow, dialog, Menu, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerIpc } from './ipc.js';
import { isExternalLink, isLocalAsset, isReloadKey, isTrustedPage } from './security.js';
import { CommandLog } from './command-log.js';
import { RepositoryStore } from './store.js';
import { MarksStore } from './marks-store.js';
import { AutomationsStore } from './automations-store.js';
import { AutomationRunsStore } from './automation-runs-store.js';
import { resolveLoginPath } from './automation/path.js';
import { EditorStore } from './editor-store.js';
import { FetchStore } from './fetch-store.js';
import { UpdateStore } from './update-store.js';
import { McpStore } from './mcp-store.js';
import { runGit, setGitGate } from './git/exec.js';
import { createRepositoryService } from './git/repository.js';
import { createRepositoryTrust, TrustStore } from './repository-trust.js';
import { SANDBOX_DIRNAME, SANDBOX_MARKER_FILE, SANDBOX_REMOTE_DIRNAME } from './git/sandbox.js';
import { movePlan } from './git/rebase.js';
import { UndoService } from './undo.js';
import { hardenProcessEnv } from './process-env.js';
import { effectiveLocale, LanguageStore, native, nt, readCatalog } from './language.js';
import { resolveLocale, ui } from '../renderer/src/i18n/i18n.js';
import { MESSAGE_KEYS } from '../renderer/src/i18n/messages.js';

// Before anything is spawned: no program or library lookup in the working
// directory, which is always someone's repository.
hardenProcessEnv(process.env, process.platform);

// Run from source (`npm run dev`, `npm start`), 🌱 Twig would share the
// installed copy's userData — its repositories, marks, Undo chains, journal and
// MCP socket — and both would rewrite the same files. A run from source keeps
// its own folder unless one is given on the command line (the smoke runs do).
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), 'twig-dev'));
}
// One process per userData folder: a second launch brings the open window
// forward instead of starting a second writer of the same files.
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();

const root = fileURLToPath(new URL('../', import.meta.url));
const iconPath = path.join(root, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const development = !app.isPackaged && process.env.TWIG_DEV === '1';

const entryUrl = development ? 'http://127.0.0.1:5188/'
  : pathToFileURL(path.join(root, 'dist/renderer/index.html')).href;
let window;

async function detectGit(log) {
  const result = await runGit({ argv: ['--version'], cwd: app.getPath('home'), log, operation: 'Background: check Git installation' });
  if (result.code !== 0) return { available: false, version: null, instruction: ui`🌱 Twig works through the Git installed on this computer, and it did not answer. Install Git, then check again.` };
  return { available: true, version: result.stdout.trim(), instruction: null };
}

/** Asks the window to re-read the open repository, the way its Refresh button does. */
function sendRefresh() {
  if (window && !window.isDestroyed()) window.webContents.send('app:refresh');
}

/**
 * The menu bar in the interface language. Roles keep their behaviour and
 * shortcuts; only the words are ours. Reloading the page is for development:
 * everywhere else the same keys refresh the repository, because a reload would
 * drop whatever is being written or resolved in the window.
 */
function buildMenu() {
  const mac = process.platform === 'darwin';
  const name = '🌱 Twig';
  const separator = { type: 'separator' };
  return Menu.buildFromTemplate([
    ...(mac ? [{ label: name, submenu: [
      { role: 'about', label: nt`About ${name}` }, separator,
      { role: 'services', label: nt('Services') }, separator,
      { role: 'hide', label: nt`Hide ${name}` }, { role: 'hideOthers', label: nt('Hide Others') },
      { role: 'unhide', label: nt('Show All') }, separator,
      { role: 'quit', label: nt`Quit ${name}` }
    ] }] : []),
    { label: nt('File'), submenu: [mac ? { role: 'close', label: nt('Close Window') } : { role: 'quit', label: nt('Quit') }] },
    { label: nt('Edit'), submenu: [
      { role: 'undo', label: nt('Undo') }, { role: 'redo', label: nt('Redo') }, separator,
      { role: 'cut', label: nt('Cut') }, { role: 'copy', label: nt('Copy') }, { role: 'paste', label: nt('Paste') },
      ...(mac ? [{ role: 'pasteAndMatchStyle', label: nt('Paste and Match Style') }] : []),
      { role: 'delete', label: nt('Delete') }, { role: 'selectAll', label: nt('Select All') }
    ] },
    // Developer tools only when running from source, never in an installed copy.
    { label: nt('View'), submenu: [development ? { role: 'reload', label: nt('Reload') }
      : { label: nt('Refresh'), accelerator: 'CmdOrCtrl+R', registerAccelerator: false, click: sendRefresh },
      ...(app.isPackaged ? [] : [{ role: 'toggleDevTools', label: nt('Toggle Developer Tools') }]),
      { role: 'resetZoom', label: nt('Actual Size') }, { role: 'zoomIn', label: nt('Zoom In') }, { role: 'zoomOut', label: nt('Zoom Out') },
      separator, { role: 'togglefullscreen', label: nt('Toggle Full Screen') }] },
    { label: nt('Window'), submenu: [{ role: 'minimize', label: nt('Minimize') }, { role: 'zoom', label: nt('Zoom') },
      ...(mac ? [separator, { role: 'front', label: nt('Bring All to Front') }] : [{ role: 'close', label: nt('Close') }])] }
  ]);
}

/** Main's own words follow the chosen language; the renderer loads its catalog itself. */
async function applyLanguage(choice) {
  const locale = effectiveLocale(choice, app.getPreferredSystemLanguages());
  native.setLocale(locale, await readCatalog(locale), MESSAGE_KEYS);
  Menu.setApplicationMenu(buildMenu());
  return { choice, locale };
}

function openExternal(url) {
  if (isExternalLink(url)) void shell.openExternal(url).catch(() => {});
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1000, minHeight: 640,
    title: '🌱 Twig', show: false, icon: iconPath,
    webPreferences: {
      preload: path.join(root, 'dist/preload/index.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, spellcheck: false
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedPage(url, entryUrl)) { event.preventDefault(); openExternal(url); }
  });
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  if (!development) {
    window.webContents.on('before-input-event', (event, input) => {
      if (isReloadKey(input, process.platform)) { event.preventDefault(); sendRefresh(); }
    });
  }
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  await window.loadURL(entryUrl);
}

app.whenReady().then(async () => {
  if (!primary) return;
  if (process.platform === 'darwin') app.dock.setIcon(iconPath);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const localAsset = isLocalAsset(details.url, path.join(root, 'dist/renderer'));
    const localDev = development && ['http:', 'ws:'].includes(url.protocol)
      && url.host === '127.0.0.1:5188';
    callback({ cancel: !localAsset && !localDev });
  });
  const language = new LanguageStore(app.getPath('userData'));
  await applyLanguage(await language.load());
  const userData = app.getPath('userData');
  const journal = new CommandLog(userData);
  const undo = new UndoService({ directory: userData, log: journal });
  const marks = new MarksStore(userData);
  const automations = new AutomationsStore(userData);
  const automationRuns = new AutomationRunsStore(userData);
  const editor = new EditorStore(userData);
  const fetchSettings = new FetchStore(userData);
  const updateSettings = new UpdateStore(userData, { defaultAuto: app.isPackaged });
  const mcpSettings = new McpStore(userData);
  // These read their own files and don't touch git, so nothing here depends on
  // the others finishing first — sequencing them only added up their wait times.
  await Promise.all([journal.load(), undo.load(), marks.load(), automations.load(), automationRuns.load(), editor.load(), fetchSettings.load(), updateSettings.load(), mcpSettings.load()]);
  journal.onChange((event) => {
    if (window && !window.isDestroyed()) window.webContents.send('console:update', event);
  });
  const sandbox = {
    dir: path.join(userData, SANDBOX_DIRNAME),
    remoteDir: path.join(userData, SANDBOX_REMOTE_DIRNAME),
    markerFile: path.join(userData, SANDBOX_MARKER_FILE)
  };
  const trustStore = new TrustStore(userData);
  await trustStore.load();
  const trust = createRepositoryTrust({ store: trustStore, log: journal });
  setGitGate(trust.gate);
  // Everything stored under a repository's id moves with it when it is located elsewhere.
  const movers = [marks, automations, automationRuns, undo, { rekey: (from, to) => movePlan({ stateDir: userData, from, to }) }];
  const repositories = createRepositoryService({ log: journal, store: new RepositoryStore(userData), sandbox, undo, marks, trust, movers });
  await repositories.loadStored();
  // The window does not wait for Git: it is created below and asks for the
  // workspace when it is ready, which waits for the one repository it opens on.
  // Without Git nothing is seeded or read; the window says so and checks again.
  let gitState = null;
  const readGit = async () => {
    gitState = await detectGit(journal);
    if (gitState.available) await repositories.start().first.catch(() => {});
  };
  let reading = readGit();
  const git = {
    state: () => gitState,
    ready: () => reading,
    recheck: () => { if (!gitState?.available) reading = readGit(); return reading; }
  };
  // The login shell's PATH (for automations and the external editor) took
  // ~0.6 s to answer and the window waited for it. It is asked now and awaited
  // where it is used; it never rejects.
  const automationPath = resolveLoginPath();
  registerIpc(() => window, entryUrl, { journal, repositories, trust, git, undo, marks, automations, automationRuns, automationPath, editor, fetchSettings, updateSettings, mcpSettings,
    language: { get: () => ({ choice: language.get(), locale: native.getLocale(), system: resolveLocale(app.getPreferredSystemLanguages()) }),
      set: async value => ({ ...await applyLanguage(await language.save(value)), system: resolveLocale(app.getPreferredSystemLanguages()) }) } });
  await createWindow();
}).catch((error) => {
  console.error('🌱 Twig failed to start:', error.message);
  // A launch from the Dock or the Start menu has no terminal: say it in a window.
  dialog.showErrorBox(nt('🌱 Twig could not start'), `${error.message}\n\n${nt`Settings folder: ${app.getPath('userData')}`}`);
  app.exit(1);
});
app.on('second-instance', () => {
  if (!window) { if (app.isReady()) void createWindow(); return; }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
app.on('activate', () => { if (!window) void createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
