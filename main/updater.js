// In-app update: check → download → prepare → restart. Every step after the
// check happens only on a press in the window; the automatic check (opt-in,
// Settings → Updates) only reads the release and lights the toolbar button.
//
// There is no paid signing identity, so Squirrel/electron-updater cannot
// replace a macOS app here (it insists the new bundle carry the same Developer
// ID). Instead the installer GitHub already serves is used directly, checked
// against the SHA-256 GitHub computed when it was uploaded:
//
//   mac       mount the DMG read-only, copy the .app next to the running one,
//             verify its signature, bundle id and version, swap the two
//             bundles by rename and reopen after this process has exited
//   win       run the NSIS installer silently (`--updated /S --force-run`); it
//             installs over this per-user copy and starts the new version
//   appimage  put the new file next to the running one, rename it over it,
//             and start it after this process has exited
//   deb       save it to Downloads and open it in the system package installer
//
// A file this process writes carries no quarantine flag, so macOS does not ask
// again whether to open an app "downloaded from the internet": that question
// was answered when 🌱 Twig itself was installed, and the download is checked
// byte for byte against the release.
//
// No electron import: everything the platform provides is injected, and the
// Node check drives the whole flow with a fake network and fake bundles.

import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate } from './update-check.js';
import { BUNDLE_ID } from './update-target.js';

const MAX_REDIRECTS = 5;
const IDLE_TIMEOUT_MS = 60_000;
const FIRST_AUTO_CHECK_MS = 20_000;
const AUTO_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const MAC_STAGED = '.twig-update.app';
const MAC_PREVIOUS = '.twig-previous.app';
const APPIMAGE_STAGED = '.twig-update.AppImage';

// Waits for the old process to exit, then starts the new one. The script is a
// constant; the pid and the command arrive as positional arguments, never as
// script text. /bin/sh lives outside the app bundle and outside the AppImage
// mount, so it outlives both.
export const RELAUNCH_SCRIPT = [
  'pid="$1"; shift',
  'i=0',
  'while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done',
  'exec "$@"'
].join('\n');

class UpdateError extends Error {}

/** Only GitHub itself and its asset storage may serve the file. */
export function allowedDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  return url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com');
}

/**
 * Streams `asset` into `file`, following at most five redirects and only to
 * GitHub hosts, and accepts the result only when its size and SHA-256 are the
 * ones the release announced. A partial or mismatching file is deleted.
 */
export async function downloadAsset({ asset, file, fetchImpl, signal, userAgent, onProgress = () => {} }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let idle = null;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => controller.abort(new UpdateError('The download stalled. Try again.')), IDLE_TIMEOUT_MS);
  };
  let handle = null;
  let iterator = null;
  try {
    let url = asset.url;
    let response = null;
    for (let hop = 0; ; hop++) {
      if (!allowedDownloadUrl(url)) throw new UpdateError('The download was redirected somewhere other than GitHub.');
      touch();
      response = await fetchImpl(url, {
        redirect: 'manual', signal: controller.signal,
        headers: { accept: 'application/octet-stream', 'user-agent': userAgent }
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      if (hop >= MAX_REDIRECTS) throw new UpdateError('The download was redirected too many times.');
      const location = response.headers.get('location');
      if (!location) throw new UpdateError('GitHub sent a redirect without a location.');
      url = new URL(location, url).href;
    }
    if (!response.ok || !response.body) throw new UpdateError(`GitHub answered ${response.status} for the download.`);
    const hash = createHash('sha256');
    let received = 0;
    handle = await open(file, 'w');
    // Cancel and the stall deadline must end the loop even if the body stream
    // itself never notices the abort: each read races the abort.
    const stopped = new Promise((_resolve, reject) => {
      const fail = () => reject(controller.signal.reason);
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener('abort', fail, { once: true });
    });
    stopped.catch(() => {});
    iterator = response.body[Symbol.asyncIterator]();
    for (;;) {
      const { value: chunk, done } = await Promise.race([iterator.next(), stopped]);
      if (done) break;
      touch();
      received += chunk.byteLength;
      if (received > asset.size) throw new UpdateError('The download is larger than the release says. It was discarded.');
      hash.update(chunk);
      await handle.write(chunk);
      onProgress(received, asset.size);
    }
    await handle.close();
    handle = null;
    if (received !== asset.size) throw new UpdateError('The download ended early. Try again.');
    if (hash.digest('hex') !== asset.sha256) throw new UpdateError('The download does not match the checksum of the release. It was discarded.');
  } catch (error) {
    void iterator?.return?.()?.catch?.(() => {});
    await handle?.close().catch(() => {});
    await rm(file, { force: true });
    if (signal?.aborted) throw new UpdateError('Download cancelled.');
    if (error instanceof UpdateError) throw error;
    if (controller.signal.reason instanceof UpdateError) throw controller.signal.reason;
    throw new UpdateError('The download failed. Check your connection and try again.');
  } finally {
    clearTimeout(idle);
    signal?.removeEventListener('abort', abort);
  }
}

async function startsWith(file, bytes, offset = 0) {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes.length);
    await handle.read(buffer, 0, bytes.length, offset);
    return buffer.equals(Buffer.from(bytes));
  } finally { await handle.close(); }
}

/**
 * @param {{
 *   currentVersion: string,
 *   target: object,                 resolveInstallTarget(...)
 *   directory: string,              scratch folder for downloads (userData/updates)
 *   downloadsDir: string,           where a .deb is saved for the person
 *   store: { get(): {auto:boolean}, save(value): Promise<{auto:boolean}> },
 *   log: object,                    command journal
 *   runTool: (argv: string[], operation: string) => Promise<{ code: number, stdout: string, stderr: string }>,
 *   spawnDetached: (executable: string, args: string[], env?: object) => void,
 *   quit: () => void,
 *   openPath: (file: string) => Promise<string>,
 *   onState?: (state: object) => void,
 *   fetchImpl?: typeof fetch,
 *   pid?: number
 * }} options
 */
export function createUpdater({
  currentVersion, target, directory, downloadsDir, store, log, runTool, spawnDetached, quit, openPath,
  onState = () => {}, fetchImpl = globalThis.fetch, pid = process.pid
}) {
  const userAgent = `Twig/${currentVersion}`;
  const installable = target.kind !== 'unsupported';
  let state = {
    status: 'idle', current: currentVersion, latest: null, url: null, notes: '',
    kind: target.kind, installable, installReason: installable ? null : target.reason,
    progress: null, error: null, savedTo: null, checkedAt: null, auto: store.get().auto
  };
  let asset = null;
  let prepared = null;
  let checking = null;
  let download = null;
  let timer = null;

  function set(patch) {
    state = { ...state, ...patch };
    onState(snapshot());
  }
  function snapshot() { return { ...state, progress: state.progress && { ...state.progress } }; }

  async function tool(argv, operation) {
    const result = await runTool(argv, operation);
    if (result.code !== 0) throw new UpdateError(`${operation.replace(/^Update: /, '')} failed: ${(result.stderr || result.stdout).trim().split('\n').pop() || `exit ${result.code}`}`);
    return result.stdout;
  }

  function launch(executable, args, operation, extraEnv) {
    const id = `update-${Date.now()}`;
    const startedAt = new Date().toISOString();
    void log.start({ id, executable, argv: [executable, ...args], cwd: directory, startedAt, operation });
    spawnDetached(executable, args, extraEnv);
    void log.finish(id, { code: 0, stdout: '', stderr: '', cancelled: false, ms: 0, startedAt });
  }

  async function check() {
    if (['downloading', 'preparing', 'ready', 'installing'].includes(state.status)) return snapshot();
    checking ??= (async () => {
      set({ status: 'checking', error: null });
      const result = await checkForUpdate({ currentVersion, target: installable ? target : null, fetchImpl });
      const checkedAt = new Date().toISOString();
      if (result.status === 'update') {
        asset = result.asset || null;
        set({
          status: 'available', latest: result.latest, url: result.url, notes: result.notes || '', checkedAt,
          installReason: !installable ? target.reason
            : asset ? null : 'This release has no installer for this system that 🌱 Twig can verify.'
        });
      } else if (result.status === 'current') {
        asset = null;
        set({ status: 'current', latest: result.latest, url: result.url, notes: '', checkedAt });
      } else {
        asset = null;
        set({ status: 'error', url: result.url, checkedAt,
          error: result.status === 'unknown' ? 'Could not tell which release is the latest.' : result.message });
      }
      return snapshot();
    })().finally(() => { checking = null; });
    return checking;
  }

  async function prepareMac(file) {
    const parent = path.dirname(target.appPath);
    const staged = path.join(parent, MAC_STAGED);
    const mount = await mkdtemp(path.join(os.tmpdir(), 'twig-update-'));
    try {
      await tool(['hdiutil', 'attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mount, file], 'Update: mount the new version');
      try {
        const apps = [];
        for (const name of await readdir(mount)) {
          if (name.endsWith('.app') && (await lstat(path.join(mount, name))).isDirectory()) apps.push(name);
        }
        if (apps.length !== 1) throw new UpdateError('The disk image does not hold exactly one app.');
        await rm(staged, { recursive: true, force: true });
        try {
          await tool(['ditto', path.join(mount, apps[0]), staged], 'Update: copy the new version');
        } catch (error) {
          throw new UpdateError(`Could not write next to ${path.basename(target.appPath)} in ${parent}. ${error.message}`);
        }
      } finally {
        await runTool(['hdiutil', 'detach', mount, '-force'], 'Update: unmount the disk image').catch(() => {});
      }
      const plist = path.join(staged, 'Contents/Info.plist');
      const id = (await tool(['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist], 'Update: read the bundle id')).trim();
      const version = (await tool(['plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], 'Update: read the bundle version')).trim();
      if (id !== BUNDLE_ID) throw new UpdateError(`The disk image holds ${id || 'an unknown app'}, not 🌱 Twig.`);
      if (version !== state.latest) throw new UpdateError(`The disk image holds version ${version}, not ${state.latest}.`);
      await tool(['codesign', '--verify', '--deep', '--strict', staged], 'Update: verify the new version’s signature');
      // Nothing should carry the flag (this process wrote the files), but an
      // app that did would stop at the "downloaded from the internet" question.
      await runTool(['xattr', '-dr', 'com.apple.quarantine', staged], 'Update: clear the download flag');
      return { staged };
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(mount, { recursive: true, force: true }).catch(() => {});
      await rm(file, { force: true });
    }
  }

  async function prepareAppImage(file) {
    if (!await startsWith(file, [0x7f, 0x45, 0x4c, 0x46]) || !await startsWith(file, [0x41, 0x49, 0x02], 8)) {
      throw new UpdateError('The download is not an AppImage.');
    }
    const staged = path.join(path.dirname(target.appImage), APPIMAGE_STAGED);
    try {
      await copyFile(file, staged);
      await chmod(staged, 0o755);
    } catch (error) {
      await rm(staged, { force: true }).catch(() => {});
      throw new UpdateError(`Could not write next to the AppImage in ${path.dirname(target.appImage)} (${error.code || error.message}).`);
    } finally { await rm(file, { force: true }); }
    return { staged };
  }

  async function prepareWin(file) {
    if (!await startsWith(file, [0x4d, 0x5a])) throw new UpdateError('The download is not a Windows installer.');
    return { installer: file };
  }

  async function prepareDeb(file) {
    if (!await startsWith(file, [...Buffer.from('!<arch>\n')])) throw new UpdateError('The download is not a .deb package.');
    await mkdir(downloadsDir, { recursive: true });
    const saved = path.join(downloadsDir, asset.name);
    try { await copyFile(file, saved); } finally { await rm(file, { force: true }); }
    return { deb: saved };
  }

  async function startDownload() {
    if (state.status !== 'available' || !installable || !asset) return snapshot();
    if (download) return snapshot();
    const controller = new AbortController();
    download = controller;
    let percent = -1;
    set({ status: 'downloading', error: null, progress: { received: 0, total: asset.size } });
    try {
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, asset.name);
      await downloadAsset({
        asset, file, fetchImpl, signal: controller.signal, userAgent,
        onProgress(received, total) {
          const next = Math.floor(received * 100 / total);
          if (next !== percent) { percent = next; set({ progress: { received, total } }); }
        }
      });
      if (controller.signal.aborted) throw new UpdateError('Download cancelled.');
      set({ status: 'preparing', progress: null });
      prepared = target.kind === 'mac' ? await prepareMac(file)
        : target.kind === 'appimage' ? await prepareAppImage(file)
          : target.kind === 'win' ? await prepareWin(file)
            : await prepareDeb(file);
      set({ status: 'ready', savedTo: prepared.deb || null });
    } catch (error) {
      prepared = null;
      const cancelled = controller.signal.aborted;
      set({ status: 'available', progress: null, error: cancelled ? null : error instanceof UpdateError ? error.message : `The update could not be prepared: ${error.message}` });
    } finally {
      download = null;
    }
    return snapshot();
  }

  function cancel() {
    download?.abort(new UpdateError('Download cancelled.'));
    return snapshot();
  }

  async function install() {
    if (state.status !== 'ready' || !prepared) return snapshot();
    try {
      if (target.kind === 'deb') {
        const failure = await openPath(prepared.deb);
        if (failure) throw new UpdateError(`Could not open the package: ${failure}. It is saved in ${prepared.deb}.`);
        set({ status: 'handed-off' });
        return snapshot();
      }
      set({ status: 'installing', error: null });
      if (target.kind === 'mac') {
        const previous = path.join(path.dirname(target.appPath), MAC_PREVIOUS);
        await rm(previous, { recursive: true, force: true });
        try {
          await rename(target.appPath, previous);
        } catch (error) {
          throw new UpdateError(error.code === 'EPERM'
            ? 'macOS did not let 🌱 Twig replace itself. Allow it in System Settings → Privacy & Security → App Management, then try again.'
            : `Could not move the current version aside (${error.code || error.message}).`);
        }
        try { await rename(prepared.staged, target.appPath); }
        catch (error) {
          await rename(previous, target.appPath).catch(() => {});
          throw new UpdateError(`Could not put the new version in place (${error.code || error.message}). The current version was kept.`);
        }
        launch('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'twig-relaunch', String(pid), '/usr/bin/open', target.appPath], 'Update: restart into the new version');
      } else if (target.kind === 'appimage') {
        await rename(prepared.staged, target.appImage);
        // The new AppImage sets these for itself; the old mount's values would mislead it.
        const clean = { APPDIR: undefined, APPIMAGE: undefined, ARGV0: undefined, OWD: undefined, FONTCONFIG_FILE: undefined, FONTCONFIG_PATH: undefined };
        launch('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'twig-relaunch', String(pid), target.appImage], 'Update: restart into the new version', clean);
      } else {
        launch(prepared.installer, ['--updated', '/S', '--force-run'], 'Update: run the installer');
      }
      quit();
    } catch (error) {
      set({ status: 'ready', error: error instanceof UpdateError ? error.message : `The update could not be installed: ${error.message}` });
    }
    return snapshot();
  }

  function schedule() {
    clearTimeout(timer);
    timer = null;
    if (!state.auto) return;
    const run = delay => {
      timer = setTimeout(() => { void check().catch(() => {}).finally(() => run(AUTO_CHECK_EVERY_MS)); }, delay);
      timer.unref?.();
    };
    run(FIRST_AUTO_CHECK_MS);
  }

  async function setAuto(value) {
    const saved = await store.save({ auto: value === true });
    set({ auto: saved.auto });
    schedule();
    return snapshot();
  }

  /** Clears what an earlier update left behind, then starts the opt-in schedule. */
  async function start() {
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (target.kind === 'mac') {
      const parent = path.dirname(target.appPath);
      await rm(path.join(parent, MAC_PREVIOUS), { recursive: true, force: true }).catch(() => {});
      await rm(path.join(parent, MAC_STAGED), { recursive: true, force: true }).catch(() => {});
    }
    if (target.kind === 'appimage') await rm(path.join(path.dirname(target.appImage), APPIMAGE_STAGED), { force: true }).catch(() => {});
    schedule();
  }

  function stop() { clearTimeout(timer); timer = null; download?.abort(); }

  return { state: snapshot, check, download: startDownload, cancel, install, setAuto, start, stop };
}

export { UpdateError };
