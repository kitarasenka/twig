import path from 'node:path';
import { validateFile } from './git/commit.js';

/**
 * "Open in editor" and "Reveal in Finder" for a file of an open repository.
 * Pure: no Electron, no process — main/files-ipc.js runs what this decides,
 * and the Node check drives it directly.
 *
 * The editor is a setting main keeps, never a path the renderer sends: the
 * renderer only names a preset from the list below, and the one free-form
 * choice — "Other application…" — is picked in a native dialog main opens
 * itself. Nothing here can be talked into running an arbitrary program.
 */

export const EDITOR_PRESETS = Object.freeze([
  { id: 'system', label: 'System default' },
  { id: 'vscode', label: 'Visual Studio Code', macApp: 'Visual Studio Code', cli: 'code', winExe: 'Code.exe' },
  { id: 'cursor', label: 'Cursor', macApp: 'Cursor', cli: 'cursor', winExe: 'Cursor.exe' },
  { id: 'zed', label: 'Zed', macApp: 'Zed', cli: 'zed', winExe: 'Zed.exe' },
  { id: 'sublime', label: 'Sublime Text', macApp: 'Sublime Text', cli: 'subl', winExe: 'sublime_text.exe' },
  { id: 'custom', label: 'Other application…' }
]);

const PRESET_IDS = new Set(EDITOR_PRESETS.map(preset => preset.id));
export const DEFAULT_EDITOR = Object.freeze({ preset: 'system', customPath: null });

/**
 * File types the operating system would run rather than show when asked to
 * "open" them. They only matter for the System default choice on Windows and
 * Linux, where that means `shell.openPath` — a repository someone else wrote
 * could otherwise turn a right-click into running their program. macOS uses
 * `open -t`, which always means "the default text editor".
 */
const LAUNCHABLE = new Set([
  // Windows
  'exe', 'com', 'bat', 'cmd', 'msi', 'msp', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'scr',
  'lnk', 'url', 'hta', 'cpl', 'msc', 'jar', 'reg', 'pif', 'appref-ms', 'application', 'gadget', 'scf', 'inf',
  // Linux and friends
  'desktop', 'appimage', 'sh', 'bash', 'zsh', 'run', 'bin', 'deb', 'rpm', 'flatpakref', 'snap',
  // macOS bundles, in case one is opened from another platform's checkout
  'app', 'command', 'tool', 'pkg', 'dmg', 'terminal', 'workflow'
]);

export function editorLabel(settings) {
  const value = normalizeEditorSettings(settings);
  if (value.preset === 'custom') return value.customPath ? applicationName(value.customPath) : 'Other application';
  return EDITOR_PRESETS.find(preset => preset.id === value.preset).label;
}

/** `Visual Studio Code.app` → `Visual Studio Code`, `C:\…\notepad++.exe` → `notepad++`. */
export function applicationName(file) {
  const base = String(file).split(/[\\/]/).filter(Boolean).at(-1) || String(file);
  return base.replace(/\.(app|exe)$/i, '');
}

/** Whatever was on disk becomes a valid setting; anything odd falls back to System default. */
export function normalizeEditorSettings(value) {
  if (!value || typeof value !== 'object') return { ...DEFAULT_EDITOR };
  const preset = PRESET_IDS.has(value.preset) ? value.preset : 'system';
  const customPath = validCustomPath(value.customPath) ? value.customPath : null;
  if (preset === 'custom' && !customPath) return { ...DEFAULT_EDITOR };
  return { preset, customPath };
}

export function validCustomPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
    && (path.posix.isAbsolute(value) || path.win32.isAbsolute(value));
}

export function validPreset(value) {
  return typeof value === 'string' && PRESET_IDS.has(value);
}

/**
 * The absolute path of a repository file, refused if the relative path climbs
 * out of the working tree. `validateFile` already rejects `..` and a leading
 * `/`; the `path.relative` check is the second lock, and it is the one that
 * also catches a Windows drive letter.
 */
export function resolveRepositoryFile(root, file, pathApi = path) {
  validateFile(file);
  const absolute = pathApi.resolve(root, ...file.split('/'));
  const relative = pathApi.relative(pathApi.resolve(root), absolute);
  if (!relative || relative.startsWith('..') || pathApi.isAbsolute(relative)) throw new TypeError('Invalid file path');
  return absolute;
}

export function isLaunchable(file) {
  const name = String(file).split(/[\\/]/).at(-1).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 && LAUNCHABLE.has(name.slice(dot + 1));
}

/**
 * Where on `PATH` an editor's command-line launcher lives. On Windows a CLI
 * shim is usually a `.cmd`, which cannot run without a shell — so the shim's
 * directory only tells us where the real `.exe` is (VS Code keeps `bin\code.cmd`
 * next to `..\Code.exe`).
 */
export function findEditorExecutable(preset, { pathString = '', platform = process.platform, exists }) {
  if (!preset?.cli) return null;
  const api = platform === 'win32' ? path.win32 : path.posix;
  const directories = pathString.split(platform === 'win32' ? ';' : ':').map(item => item.trim()).filter(Boolean);
  for (const directory of directories) {
    if (platform !== 'win32') {
      const candidate = api.join(directory, preset.cli);
      if (exists(candidate)) return candidate;
      continue;
    }
    const direct = api.join(directory, `${preset.cli}.exe`);
    if (exists(direct)) return direct;
    if (preset.winExe && exists(api.join(directory, `${preset.cli}.cmd`))) {
      for (const candidate of [api.join(directory, '..', preset.winExe), api.join(directory, preset.winExe)]) {
        if (exists(candidate)) return api.normalize(candidate);
      }
    }
  }
  return null;
}

/**
 * How to open `file` with the chosen editor:
 * - `{ kind: 'spawn', executable, args, wait }` — one process, never a shell;
 *   `wait` is true for macOS `open`, which returns at once and says on stderr
 *   when the application is missing.
 * - `{ kind: 'shell' }` — hand the file to the OS (`shell.openPath`).
 * - `{ kind: 'refused', reason, message }` — nothing runs.
 */
export function planOpen({ settings, file, platform = process.platform, pathString = '', exists = () => false, executableBit = false }) {
  const value = normalizeEditorSettings(settings);
  if (value.preset === 'system') {
    if (platform === 'darwin') return { kind: 'spawn', executable: 'open', args: ['-t', file], wait: true };
    // An executable bit is the Linux way of saying "run me", extension or not.
    if (isLaunchable(file) || (platform !== 'win32' && executableBit)) {
      return { kind: 'refused', reason: 'launchable',
        message: 'This file type would run as a program. Choose an editor in Settings to open it as text.' };
    }
    return { kind: 'shell' };
  }
  if (value.preset === 'custom') {
    if (platform === 'darwin' && /\.app\/?$/i.test(value.customPath)) {
      return { kind: 'spawn', executable: 'open', args: ['-a', value.customPath, file], wait: true };
    }
    return { kind: 'spawn', executable: value.customPath, args: [file], wait: false };
  }
  const preset = EDITOR_PRESETS.find(item => item.id === value.preset);
  if (platform === 'darwin') return { kind: 'spawn', executable: 'open', args: ['-a', preset.macApp, file], wait: true };
  const executable = findEditorExecutable(preset, { pathString, platform, exists });
  if (!executable) {
    return { kind: 'refused', reason: 'not-found',
      message: `${preset.label} was not found on PATH (${preset.cli}). Install its command-line launcher or pick the application in Settings.` };
  }
  return { kind: 'spawn', executable, args: [file], wait: false };
}

