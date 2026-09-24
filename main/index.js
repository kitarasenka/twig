import { app, BrowserWindow, Menu, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerIpc } from './ipc.js';
import { isExternalLink, isLocalAsset, isTrustedPage } from './security.js';
import { CommandLog } from './command-log.js';
import { RepositoryStore } from './store.js';
import { MarksStore } from './marks-store.js';
import { AutomationsStore } from './automations-store.js';
import { AutomationRunsStore } from './automation-runs-store.js';
import { resolveLoginPath } from './automation/path.js';
import { EditorStore } from './editor-store.js';
import { FetchStore } from './fetch-store.js';
import { UpdateStore } from './update-store.js';
import { runGit } from './git/exec.js';
import { createRepositoryService } from './git/repository.js';
import { SANDBOX_DIRNAME, SANDBOX_MARKER_FILE, SANDBOX_REMOTE_DIRNAME } from './git/sandbox.js';
import { UndoService } from './undo.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const iconPath = path.join(root, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const development = !app.isPackaged && process.env.TWIG_DEV === '1';

const entryUrl = development ? 'http://127.0.0.1:5188/'
  : pathToFileURL(path.join(root, 'dist/renderer/index.html')).href;
let window;

async function detectGit(log) {
  const result = await runGit({ argv: ['--version'], cwd: app.getPath('home'), log, operation: 'Background: check Git installation' });
  if (result.code !== 0) return { available: false, version: null, instruction: 'Install Git, then restart 🌱 Twig.' };
  return { available: true, version: result.stdout.trim(), instruction: null };
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
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { window = null; });
  await window.loadURL(entryUrl);
}

app.whenReady().then(async () => {
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' }
  ]));
  const userData = app.getPath('userData');
  const journal = new CommandLog(userData);
  const undo = new UndoService({ directory: userData, log: journal });
  const marks = new MarksStore(userData);
  // These three read their own files and don't touch git, so nothing here depends
  // on the others finishing first — sequencing them only added up their wait times.
  await Promise.all([journal.load(), undo.load(), marks.load()]);
  const git = await detectGit(journal);
  journal.onChange((event) => {
    if (window && !window.isDestroyed()) window.webContents.send('console:update', event);
  });
  const sandbox = {
    dir: path.join(userData, SANDBOX_DIRNAME),
    remoteDir: path.join(userData, SANDBOX_REMOTE_DIRNAME),
    markerFile: path.join(userData, SANDBOX_MARKER_FILE)
  };
  const repositories = createRepositoryService({ log: journal, store: new RepositoryStore(userData), sandbox, undo, marks });
  await repositories.load();
  const automations = new AutomationsStore(app.getPath('userData'));
  const automationRuns = new AutomationRunsStore(app.getPath('userData'));
  const editor = new EditorStore(app.getPath('userData'));
  const fetchSettings = new FetchStore(app.getPath('userData'));
  const updateSettings = new UpdateStore(app.getPath('userData'));
  const [, , automationPath] = await Promise.all([automations.load(), automationRuns.load(), resolveLoginPath(), editor.load(), fetchSettings.load(), updateSettings.load()]);
  registerIpc(() => window, entryUrl, { journal, repositories, git, undo, marks, automations, automationRuns, automationPath, editor, fetchSettings, updateSettings });
  await createWindow();
}).catch((error) => { console.error('🌱 Twig failed to start:', error.message); app.exit(1); });
app.on('activate', () => { if (!window) void createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
