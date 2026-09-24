import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { dialog, ipcMain, shell } from 'electron';
import { isTrustedPage } from './security.js';
import { EDITOR_PRESETS, editorLabel, planOpen, resolveRepositoryFile, validPreset } from './editor.js';

const OPEN_TIMEOUT_MS = 15_000;
const STDERR_CAP = 8192;

function exists(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/**
 * Runs the editor as one process, never through a shell, and journals it like
 * an automation step so the console shows exactly what ran. macOS `open`
 * returns at once and is waited for — it is the one that knows whether the
 * application exists. A real editor binary is left running on its own: 🌱 Twig
 * records that it started and does not wait for it to close.
 */
function launch({ executable, args, wait, cwd, log, pathString }) {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  void log.start({ id, executable, argv: args, cwd, startedAt, operation: 'Open in editor' });
  return new Promise(resolve => {
    let settled = false;
    let stderr = '';
    const done = (code, message, out = '') => {
      if (settled) return;
      settled = true;
      if (out) void log.output(id, 'stdout', out);
      if (code !== 0 && message && !stderr) void log.output(id, 'stderr', `${message}\n`);
      void log.finish(id, { code, stdout: out, stderr: stderr || (code === 0 ? '' : message), cancelled: false, ms: elapsed(), startedAt });
      resolve(code === 0 ? { ok: true } : { ok: false, reason: 'failed', message });
    };
    let child;
    try {
      child = spawn(executable, args, {
        cwd, shell: false, windowsHide: false, detached: !wait,
        stdio: wait ? ['ignore', 'ignore', 'pipe'] : 'ignore',
        env: { ...process.env, PATH: pathString || process.env.PATH || '' }
      });
    } catch (error) { done(-1, error.message); return; }
    child.on('error', error => done(-1, error.code === 'ENOENT' ? `${executable} was not found.` : error.message));
    if (!wait) {
      child.on('spawn', () => { child.unref(); done(0, null, 'Started. 🌱 Twig does not wait for the editor to close.\n'); });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } done(-1, 'The editor did not answer in time.'); }, OPEN_TIMEOUT_MS);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      if (stderr.length >= STDERR_CAP) return;
      stderr += chunk;
      void log.output(id, 'stderr', chunk);
    });
    child.on('close', code => {
      clearTimeout(timer);
      done(code ?? -1, code === 0 ? null : (stderr.trim().split('\n').at(-1) || `The editor exited with code ${code}.`).slice(0, 300));
    });
  });
}

/**
 * Opening a repository file outside 🌱 Twig: in the chosen editor, or selected
 * in Finder / Explorer / the file manager. The renderer names a repository by
 * id and a file by its path inside the working tree; main resolves both and
 * refuses a path that would leave the tree. The editor comes from main's own
 * setting — the renderer can choose a preset, never a program.
 */
export function registerFilesIpc(getWindow, entryUrl, { repositories, journal, editor, loginPath = '' }) {
  function valid(event, args, count) {
    const window = getWindow();
    return window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame
      && isTrustedPage(event.senderFrame.url, entryUrl) && args.length === count;
  }
  function describe() {
    const value = editor.get();
    return { ...value, label: editorLabel(value), presets: EDITOR_PRESETS.map(({ id, label }) => ({ id, label })) };
  }
  function repositoryFile(id, file) {
    if (typeof id !== 'string' || typeof file !== 'string') throw new TypeError('Invalid file request');
    const repo = repositories.snapshot().repositories.find(item => item.id === id && item.available);
    if (!repo) throw new TypeError('Unknown repository');
    return { root: repo.path, absolute: resolveRepositoryFile(repo.path, file) };
  }
  async function statOrNull(file) {
    try { return await stat(file); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  }

  ipcMain.handle('editor:get', (event, ...args) => {
    if (!valid(event, args, 0)) throw new TypeError('Invalid editor request');
    return describe();
  });
  ipcMain.handle('editor:set', async (event, ...args) => {
    if (!valid(event, args, 1) || !validPreset(args[0])) throw new TypeError('Invalid editor request');
    if (args[0] !== 'custom') { await editor.save({ preset: args[0], customPath: null }); return describe(); }
    const mac = process.platform === 'darwin';
    const choice = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose the application that opens files',
      defaultPath: mac ? '/Applications' : undefined,
      properties: ['openFile'],
      filters: mac ? [{ name: 'Applications', extensions: ['app'] }]
        : process.platform === 'win32' ? [{ name: 'Programs', extensions: ['exe'] }] : []
    });
    if (choice.canceled || !choice.filePaths[0]) return describe();
    await editor.save({ preset: 'custom', customPath: choice.filePaths[0] });
    return describe();
  });

  ipcMain.handle('file:open', async (event, ...args) => {
    if (!valid(event, args, 2)) throw new TypeError('Invalid file request');
    const [id, file] = args;
    const { root, absolute } = repositoryFile(id, file);
    const info = await statOrNull(absolute);
    if (!info) return { ok: false, reason: 'missing', message: `${file} is not in the working tree — it was deleted or renamed since.` };
    if (!info.isFile()) return { ok: false, reason: 'not-file', message: `${file} is not a regular file.` };
    const plan = planOpen({ settings: editor.get(), file: absolute, platform: process.platform,
      pathString: loginPath, exists, executableBit: (info.mode & 0o111) !== 0 });
    if (plan.kind === 'refused') return { ok: false, reason: plan.reason, message: plan.message };
    if (plan.kind === 'shell') {
      const failure = await shell.openPath(absolute);
      return failure ? { ok: false, reason: 'failed', message: failure } : { ok: true, editor: editorLabel(editor.get()) };
    }
    const result = await launch({ ...plan, cwd: root, log: journal, pathString: loginPath });
    return { ...result, editor: editorLabel(editor.get()) };
  });

  /**
   * Selects the file in the file manager. A file that is gone from the working
   * tree has its nearest surviving folder selected instead — never opened:
   * `shell.openPath` on a folder named `x.app` would launch it.
   */
  ipcMain.handle('file:reveal', async (event, ...args) => {
    if (!valid(event, args, 2)) throw new TypeError('Invalid file request');
    const [id, file] = args;
    const { root, absolute } = repositoryFile(id, file);
    let target = absolute;
    while (target !== root && !await statOrNull(target)) target = path.dirname(target);
    shell.showItemInFolder(target);
    return target === absolute ? { ok: true, missing: false }
      : { ok: true, missing: true, shown: path.relative(root, target).split(path.sep).join('/') || '.' };
  });
}
