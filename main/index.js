import { app, BrowserWindow, Menu, session, shell } from 'electron';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registerIpc } from './ipc.js';
import { isExternalLink, isLocalAsset, isTrustedPage } from './security.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const development = !app.isPackaged && process.env.GIT_DESK_DEV === '1';
const entryUrl = development ? 'http://127.0.0.1:5188/'
  : pathToFileURL(path.join(root, 'dist/renderer/index.html')).href;
let window;

function openExternal(url) {
  if (isExternalLink(url)) void shell.openExternal(url).catch(() => {});
}

async function createWindow() {
  window = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1000, minHeight: 640,
    title: 'Git Desk', show: false,
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
  registerIpc(() => window, entryUrl);
  await createWindow();
}).catch((error) => { console.error('Git Desk failed to start:', error.message); app.exit(1); });
app.on('activate', () => { if (!window) void createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
