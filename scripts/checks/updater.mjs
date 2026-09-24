// The in-app updater without the network: every request goes through an
// injected fetch that serves bytes from memory. On macOS the whole bundle swap
// runs for real — a fake ad-hoc-signed 🌱 Twig.app is packed into a DMG with
// hdiutil, "downloaded", mounted, copied, verified and renamed into place.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assetName, interpretRelease, pickAsset } from '../../main/update-check.js';
import { resolveInstallTarget } from '../../main/update-target.js';
import { RELAUNCH_SCRIPT, allowedDownloadUrl, createUpdater, downloadAsset } from '../../main/updater.js';
import { runStep } from '../../main/automation/exec.js';
import { autoCheckExplanation, formatBytes, percent, toolbarUpdate, updateStatusLine } from '../../renderer/src/app/update-view.js';

const exists = file => access(file).then(() => true, () => false);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const tmp = await mkdtemp(path.join(os.tmpdir(), 'twig-updater-check-'));
const log = { start() {}, output() {}, finish() {} };

// ── Asset names and picking ────────────────────────────────────────────────
assert.equal(assetName('1.2.3', { kind: 'mac', arch: 'arm64' }), 'Twig-1.2.3-macos-arm64.dmg');
assert.equal(assetName('1.2.3', { kind: 'mac', arch: 'x64' }), 'Twig-1.2.3-macos-x64.dmg');
assert.equal(assetName('1.2.3', { kind: 'win', arch: 'x64' }), 'Twig-1.2.3-windows-x64.exe');
assert.equal(assetName('1.2.3', { kind: 'appimage', arch: 'x64' }), 'Twig-1.2.3-linux-x86_64.AppImage');
assert.equal(assetName('1.2.3', { kind: 'deb', arch: 'x64' }), 'Twig-1.2.3-linux-amd64.deb');
assert.equal(assetName('1.2.3', { kind: 'win', arch: 'arm64' }), null);
assert.equal(assetName('1.2.3', { kind: 'unsupported' }), null);

// The names above must be the ones package.json makes electron-builder produce.
const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
assert.equal(pkg.build.mac.artifactName, 'Twig-${version}-macos-${arch}.${ext}');
assert.equal(pkg.build.win.artifactName, 'Twig-${version}-windows-${arch}.${ext}');
assert.equal(pkg.build.linux.artifactName, 'Twig-${version}-linux-${arch}.${ext}');
assert.equal(pkg.build.appId, 'app.nodex.twig', 'the macOS swap checks the new bundle against this id');

const macTarget = { kind: 'mac', arch: 'arm64' };
const digest = 'a'.repeat(64);
const goodAsset = {
  name: 'Twig-0.14.0-macos-arm64.dmg', size: 1000, digest: `sha256:${digest}`,
  browser_download_url: 'https://github.com/kitarasenka/twig/releases/download/twig-v0.14.0/Twig-0.14.0-macos-arm64.dmg'
};
const release = assets => ({ tag_name: 'twig-v0.14.0', html_url: 'https://github.com/kitarasenka/twig/releases/tag/twig-v0.14.0', body: '## 0.14.0\r\n- New thing', assets });
assert.deepEqual(pickAsset(release([goodAsset]), '0.14.0', macTarget),
  { name: goodAsset.name, url: goodAsset.browser_download_url, size: 1000, sha256: digest });
for (const [label, bad] of [
  ['another repository', { ...goodAsset, browser_download_url: 'https://github.com/evil/twig/releases/download/twig-v0.14.0/Twig-0.14.0-macos-arm64.dmg' }],
  ['another tag', { ...goodAsset, browser_download_url: 'https://github.com/kitarasenka/twig/releases/download/twig-v0.13.0/Twig-0.14.0-macos-arm64.dmg' }],
  ['no digest', { ...goodAsset, digest: undefined }],
  ['sha1 digest', { ...goodAsset, digest: `sha1:${'a'.repeat(40)}` }],
  ['zero size', { ...goodAsset, size: 0 }],
  ['huge size', { ...goodAsset, size: 5e9 }],
  ['other arch', { ...goodAsset, name: 'Twig-0.14.0-macos-x64.dmg' }]
]) assert.equal(pickAsset(release([bad]), '0.14.0', macTarget), null, label);
assert.equal(pickAsset(release('nope'), '0.14.0', macTarget), null);

const interpreted = interpretRelease('0.13.0', release([goodAsset]), macTarget);
assert.equal(interpreted.status, 'update');
assert.equal(interpreted.notes, '0.14.0\n- New thing', 'heading marks are dropped, line endings normalised');
assert.equal(interpreted.asset.name, goodAsset.name);
assert.equal(interpretRelease('0.14.0', release([goodAsset]), macTarget).asset, undefined, 'no asset for the running version');
assert.equal(interpretRelease('0.13.0', release([goodAsset])).asset, null, 'no target, no asset');

// ── Which installation is running ──────────────────────────────────────────
const target = facts => resolveInstallTarget({ packaged: true, arch: 'x64', env: {}, ...facts });
assert.equal(resolveInstallTarget({ packaged: false, platform: 'darwin', arch: 'arm64', execPath: '/x' }).kind, 'unsupported');
assert.deepEqual(target({ platform: 'darwin', arch: 'arm64', execPath: '/Applications/🌱 Twig.app/Contents/MacOS/🌱 Twig' }),
  { kind: 'mac', arch: 'arm64', appPath: '/Applications/🌱 Twig.app' });
assert.equal(target({ platform: 'darwin', execPath: '/private/var/folders/x/AppTranslocation/ABC/d/🌱 Twig.app/Contents/MacOS/🌱 Twig' }).kind, 'unsupported');
assert.match(target({ platform: 'darwin', execPath: '/private/var/folders/x/AppTranslocation/ABC/d/🌱 Twig.app/Contents/MacOS/🌱 Twig' }).reason, /Applications/);
assert.equal(target({ platform: 'darwin', execPath: '/usr/local/bin/twig' }).kind, 'unsupported');
assert.deepEqual(target({ platform: 'win32', execPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\twig\\🌱 Twig.exe' }), { kind: 'win', arch: 'x64' });
assert.equal(target({ platform: 'win32', arch: 'arm64', execPath: 'C:\\x.exe' }).kind, 'unsupported');
assert.deepEqual(target({ platform: 'linux', execPath: '/tmp/.mount_TwigXYZ/twig.bin', env: { APPIMAGE: '/home/a/Apps/Twig.AppImage' } }),
  { kind: 'appimage', arch: 'x64', appImage: '/home/a/Apps/Twig.AppImage' });
assert.equal(target({ platform: 'linux', execPath: '/tmp/.mount/twig.bin', env: { APPIMAGE: 'relative/Twig.AppImage' } }).kind, 'unsupported');
assert.deepEqual(target({ platform: 'linux', execPath: '/opt/🌱 Twig/twig.bin' }), { kind: 'deb', arch: 'x64' });
assert.equal(target({ platform: 'linux', execPath: '/home/a/twig/twig.bin' }).kind, 'unsupported');
assert.equal(target({ platform: 'freebsd', execPath: '/x' }).kind, 'unsupported');

// ── Where a download may come from ─────────────────────────────────────────
assert.ok(allowedDownloadUrl('https://github.com/kitarasenka/twig/releases/download/x/y'));
assert.ok(allowedDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/1/2?sig=x'));
for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://githubusercontent.com.evil.example/x',
  'https://user:pw@github.com/x', 'https://github.com:444/x', 'file:///etc/passwd', 'not a url']) {
  assert.equal(allowedDownloadUrl(bad), false, bad);
}

// ── A fake network ─────────────────────────────────────────────────────────
function body(bytes, chunk = 64 * 1024) {
  return (async function* () { for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk); })();
}
function network(routes) {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    const route = routes[url];
    if (!route) return { ok: false, status: 404, headers: new Headers(), body: null };
    if (route.redirect) return { ok: false, status: 302, headers: new Headers({ location: route.redirect }), body: null };
    if (route.json) return { ok: true, status: 200, json: async () => route.json };
    return { ok: true, status: 200, headers: new Headers(), body: body(route.bytes) };
  };
  return { fetchImpl, seen };
}
const ASSET_URL = 'https://github.com/kitarasenka/twig/releases/download/twig-v0.14.0/Twig-0.14.0-linux-x86_64.AppImage';
const STORAGE_URL = 'https://release-assets.githubusercontent.com/asset/1?token=x';

// ── downloadAsset ──────────────────────────────────────────────────────────
const payload = Buffer.alloc(300_000, 7);
const asset = { name: 'x', url: ASSET_URL, size: payload.length, sha256: sha256(payload) };
{
  const { fetchImpl, seen } = network({ [ASSET_URL]: { redirect: STORAGE_URL }, [STORAGE_URL]: { bytes: payload } });
  const file = path.join(tmp, 'ok.bin');
  const progress = [];
  await downloadAsset({ asset, file, fetchImpl, userAgent: 'Twig/0.13.0', onProgress: received => progress.push(received) });
  assert.deepEqual(await readFile(file), payload);
  assert.equal(seen.length, 2, 'the redirect to GitHub asset storage is followed');
  assert.equal(seen[0].options.redirect, 'manual', 'redirects are followed by hand, one checked hop at a time');
  assert.deepEqual(Object.keys(seen[0].options.headers).sort(), ['accept', 'user-agent']);
  assert.equal(progress.at(-1), payload.length);
}
for (const [label, routes, size, hash, message] of [
  ['redirect off GitHub', { [ASSET_URL]: { redirect: 'https://evil.example/x' } }, payload.length, asset.sha256, /other than GitHub/],
  ['redirect loop', { [ASSET_URL]: { redirect: ASSET_URL } }, payload.length, asset.sha256, /too many times/],
  ['checksum mismatch', { [ASSET_URL]: { bytes: payload } }, payload.length, 'b'.repeat(64), /checksum/],
  ['larger than announced', { [ASSET_URL]: { bytes: payload } }, payload.length - 1, asset.sha256, /larger/],
  ['shorter than announced', { [ASSET_URL]: { bytes: payload } }, payload.length + 1, asset.sha256, /ended early/],
  ['404', {}, payload.length, asset.sha256, /404/]
]) {
  const file = path.join(tmp, 'bad.bin');
  await assert.rejects(downloadAsset({ asset: { ...asset, size, sha256: hash }, file, fetchImpl: network(routes).fetchImpl, userAgent: 'x' }), message, label);
  assert.equal(await exists(file), false, `${label}: nothing is left behind`);
}
{
  const controller = new AbortController();
  const slow = async (url, options) => ({ ok: true, status: 200, headers: new Headers(), body: (async function* () {
    yield Buffer.alloc(10);
    controller.abort();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason)));
  })() });
  const file = path.join(tmp, 'cancel.bin');
  await assert.rejects(downloadAsset({ asset, file, fetchImpl: slow, signal: controller.signal, userAgent: 'x' }), /cancelled/);
  assert.equal(await exists(file), false);
}

// ── The restart helper really waits for the old process ────────────────────
{
  const marker = path.join(tmp, 'relaunched');
  const old = spawn('sleep', ['0.6']);
  const started = Date.now();
  const helper = spawn('/bin/sh', ['-c', RELAUNCH_SCRIPT, 'twig-relaunch', String(old.pid), '/bin/sh', '-c', 'date > "$0"', marker]);
  await new Promise(resolve => helper.on('close', resolve));
  assert.ok(Date.now() - started >= 500, 'the new version starts only after the old process exited');
  assert.ok(await exists(marker), 'the command after the pid runs as given');
}

// ── The whole flow, per kind of installation ───────────────────────────────
function storeStub() {
  let value = { auto: false };
  return { get: () => ({ ...value }), save: async next => { value = { auto: next.auto === true }; return { ...value }; } };
}
async function flow({ kind, bytes, targetExtra = {}, version = '0.14.0', runTool }) {
  const name = assetName(version, { kind, arch: kind === 'mac' ? 'arm64' : 'x64' });
  const url = `https://github.com/kitarasenka/twig/releases/download/twig-v${version}/${name}`;
  const { fetchImpl } = network({
    'https://api.github.com/repos/kitarasenka/twig/releases/latest': { json: {
      tag_name: `twig-v${version}`, html_url: `https://github.com/kitarasenka/twig/releases/tag/twig-v${version}`, body: 'Notes',
      assets: [{ name, size: bytes.length, digest: `sha256:${sha256(bytes)}`, browser_download_url: url }]
    } },
    [url]: { redirect: STORAGE_URL }, [STORAGE_URL]: { bytes }
  });
  const calls = { spawned: [], quit: 0, opened: [], states: [] };
  const updater = createUpdater({
    currentVersion: '0.13.0', target: { kind, arch: kind === 'mac' ? 'arm64' : 'x64', ...targetExtra },
    directory: path.join(tmp, `${kind}-scratch`), downloadsDir: path.join(tmp, `${kind}-downloads`),
    store: storeStub(), log, fetchImpl, pid: 4242,
    runTool: runTool || (async () => { throw new Error('no tools expected'); }),
    spawnDetached: (executable, args, env) => calls.spawned.push({ executable, args, env }),
    quit: () => { calls.quit++; },
    openPath: async file => { calls.opened.push(file); return ''; },
    onState: state => calls.states.push(state.status)
  });
  return { updater, calls };
}

// AppImage: the new file is put next to the old one and renamed over it.
{
  const dir = path.join(tmp, 'apps');
  await mkdir(dir, { recursive: true });
  const appImage = path.join(dir, 'Twig.AppImage');
  await writeFile(appImage, 'old version');
  const bytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0, 0x41, 0x49, 0x02]), Buffer.alloc(5000, 1)]);
  const { updater, calls } = await flow({ kind: 'appimage', bytes, targetExtra: { appImage } });
  assert.equal(updater.state().status, 'idle');
  assert.equal((await updater.check()).status, 'available');
  assert.equal(updater.state().installReason, null);
  assert.equal(updater.state().notes, 'Notes');
  assert.equal((await updater.download()).status, 'ready');
  assert.ok(calls.states.includes('downloading') && calls.states.includes('preparing'), 'progress is broadcast');
  assert.equal(await exists(path.join(dir, '.twig-update.AppImage')), true);
  assert.equal(await readFile(appImage, 'utf8'), 'old version', 'nothing replaced before the restart press');
  assert.equal((await updater.check()).status, 'ready', 'a later check does not forget a prepared update');
  await updater.install();
  assert.deepEqual(await readFile(appImage), bytes);
  assert.equal((await stat(appImage)).mode & 0o777, 0o755);
  assert.equal(calls.quit, 1);
  assert.equal(calls.spawned.length, 1);
  const [helper] = calls.spawned;
  assert.equal(helper.executable, '/bin/sh');
  assert.deepEqual(helper.args, ['-c', RELAUNCH_SCRIPT, 'twig-relaunch', '4242', appImage]);
  assert.ok('APPDIR' in helper.env && helper.env.APPDIR === undefined, 'the old mount’s APPDIR is not passed on');
  await updater.start();
  assert.equal(await exists(path.join(dir, '.twig-update.AppImage')), false);
}
// A download that is not an AppImage is refused and cleaned up.
{
  const dir = path.join(tmp, 'apps-bad');
  await mkdir(dir, { recursive: true });
  const appImage = path.join(dir, 'Twig.AppImage');
  await writeFile(appImage, 'old version');
  const { updater } = await flow({ kind: 'appimage', bytes: Buffer.from('#!/bin/sh\necho hi\n'), targetExtra: { appImage } });
  await updater.check();
  const state = await updater.download();
  assert.equal(state.status, 'available');
  assert.match(state.error, /not an AppImage/);
  assert.equal(await exists(path.join(dir, '.twig-update.AppImage')), false);
  assert.equal(await readFile(appImage, 'utf8'), 'old version');
}
// Windows: the NSIS installer runs silently and starts the new version itself.
{
  const bytes = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4000)]);
  const { updater, calls } = await flow({ kind: 'win', bytes });
  await updater.check();
  assert.equal((await updater.download()).status, 'ready');
  await updater.install();
  assert.equal(calls.spawned[0].executable, path.join(tmp, 'win-scratch', 'Twig-0.14.0-windows-x64.exe'));
  assert.deepEqual(calls.spawned[0].args, ['--updated', '/S', '--force-run']);
  assert.equal(calls.quit, 1);
}
// deb: saved to Downloads and handed to the system installer; nothing quits.
{
  const bytes = Buffer.concat([Buffer.from('!<arch>\n'), Buffer.alloc(4000)]);
  const { updater, calls } = await flow({ kind: 'deb', bytes });
  await updater.check();
  const ready = await updater.download();
  assert.equal(ready.savedTo, path.join(tmp, 'deb-downloads', 'Twig-0.14.0-linux-amd64.deb'));
  assert.equal((await updater.install()).status, 'handed-off');
  assert.deepEqual(calls.opened, [ready.savedTo]);
  assert.equal(calls.quit, 0);
  assert.equal(calls.spawned.length, 0);
}
// An unsupported installation still learns about the release, but gets no download.
{
  const { updater } = await flow({ kind: 'unsupported', bytes: Buffer.alloc(10), targetExtra: { reason: 'From source.' } });
  const state = await updater.check();
  assert.equal(state.status, 'available');
  assert.equal(state.installable, false);
  assert.equal(state.installReason, 'From source.');
  assert.equal((await updater.download()).status, 'available', 'download is refused');
}
// The opt-in automatic check is saved and scheduled, and stops cleanly.
{
  const { updater } = await flow({ kind: 'win', bytes: Buffer.from('MZ') });
  assert.equal((await updater.setAuto(true)).auto, true);
  assert.equal((await updater.setAuto(false)).auto, false);
  updater.stop();
}

// macOS: a real DMG, a real mount, a real signature check and a real swap.
if (process.platform === 'darwin') {
  async function fakeBundle(dir, { id = 'app.nodex.twig', version }) {
    const contents = path.join(dir, '🌱 Twig.app', 'Contents');
    await mkdir(path.join(contents, 'MacOS'), { recursive: true });
    await copyFile('/usr/bin/true', path.join(contents, 'MacOS', 'twig'));
    await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>twig</string>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
</dict></plist>
`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(dir, '🌱 Twig.app')], { stdio: 'ignore' });
    return path.join(dir, '🌱 Twig.app');
  }
  async function dmgOf(version, options = {}) {
    const source = await mkdtemp(path.join(tmp, 'dmg-src-'));
    await fakeBundle(source, { version, ...options });
    const dmg = path.join(tmp, `${path.basename(source)}.dmg`);
    execFileSync('hdiutil', ['create', '-quiet', '-volname', 'Twig', '-srcfolder', source, '-format', 'UDZO', dmg]);
    return readFile(dmg);
  }
  const runTool = (argv, operation) => runStep({ argv, cwd: tmp, log, operation, timeoutMs: 120_000 });
  const applications = path.join(tmp, 'Applications');
  await mkdir(applications, { recursive: true });
  const appPath = await fakeBundle(applications, { version: '0.13.0' });
  const plistVersion = () => execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(appPath, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();

  // Wrong app inside the image: refused, the running copy untouched, nothing staged.
  {
    const { updater } = await flow({ kind: 'mac', bytes: await dmgOf('0.14.0', { id: 'com.example.other' }), targetExtra: { appPath }, runTool });
    await updater.check();
    const state = await updater.download();
    assert.equal(state.status, 'available');
    assert.match(state.error, /com\.example\.other, not 🌱 Twig/);
    assert.equal(await exists(path.join(applications, '.twig-update.app')), false);
    assert.equal(plistVersion(), '0.13.0');
  }
  const image = await dmgOf('0.14.0');
  // Right app, but not the version the release names: refused too.
  {
    const { updater } = await flow({ kind: 'mac', version: '0.14.1', bytes: image, targetExtra: { appPath }, runTool });
    await updater.check();
    assert.match((await updater.download()).error, /version 0\.14\.0, not 0\.14\.1/);
    assert.equal(await exists(path.join(applications, '.twig-update.app')), false);
  }
  // The real thing.
  {
    const { updater, calls } = await flow({ kind: 'mac', bytes: image, targetExtra: { appPath }, runTool });
    await updater.check();
    const ready = await updater.download();
    assert.equal(ready.status, 'ready', ready.error);
    assert.equal(await exists(path.join(applications, '.twig-update.app')), true);
    assert.equal(plistVersion(), '0.13.0', 'the running copy is untouched until restart');
    assert.equal(await exists(path.join(tmp, 'mac-scratch', 'Twig-0.14.0-macos-arm64.dmg')), false, 'the DMG is deleted once copied');
    assert.equal(execFileSync('hdiutil', ['info'], { encoding: 'utf8' }).includes('twig-update-'), false, 'the image is unmounted');
    await updater.install();
    assert.equal(plistVersion(), '0.14.0', 'the new bundle sits where the old one was');
    assert.equal(await exists(path.join(applications, '.twig-previous.app')), true);
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
    assert.equal(calls.quit, 1);
    assert.deepEqual(calls.spawned[0].args, ['-c', RELAUNCH_SCRIPT, 'twig-relaunch', '4242', '/usr/bin/open', appPath]);
    await updater.start();
    assert.equal(await exists(path.join(applications, '.twig-previous.app')), false, 'the next launch clears the old bundle');
  }
} else {
  console.log('updater check: skipping the macOS bundle swap (hdiutil and codesign exist only on macOS)');
}

// ── Words ──────────────────────────────────────────────────────────────────
assert.equal(formatBytes(512), '1 KB');
assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
assert.equal(formatBytes(127_450_728), '122 MB');
assert.equal(percent({ received: 50, total: 200 }), 25);
assert.equal(percent(null), 0);
const base = { current: '0.13.0', latest: '0.14.0', installable: true, installReason: null, error: null, kind: 'mac' };
assert.equal(toolbarUpdate(null), null);
for (const status of ['idle', 'checking', 'current', 'error', 'handed-off']) assert.equal(toolbarUpdate({ ...base, status }), null, status);
assert.deepEqual(toolbarUpdate({ ...base, status: 'available' }).action, 'download');
assert.equal(toolbarUpdate({ ...base, status: 'available' }).label, 'Update to 0.14.0');
assert.equal(toolbarUpdate({ ...base, status: 'available', installable: false, installReason: 'x' }).action, 'settings');
assert.equal(toolbarUpdate({ ...base, status: 'downloading', progress: { received: 1, total: 4 } }).label, 'Downloading 25%');
assert.equal(toolbarUpdate({ ...base, status: 'ready' }).label, 'Restart to update');
assert.equal(toolbarUpdate({ ...base, status: 'ready', kind: 'deb' }).label, 'Install 0.14.0');
assert.equal(toolbarUpdate({ ...base, status: 'installing' }).action, null);
assert.match(updateStatusLine({ ...base, status: 'available' }), /0\.14\.0 is available\. You have 0\.13\.0/);
assert.match(updateStatusLine({ ...base, status: 'current' }), /latest release/);
assert.match(updateStatusLine({ ...base, status: 'ready', kind: 'win' }), /installer/);
assert.match(autoCheckExplanation(false), /only when you press/);
assert.match(autoCheckExplanation(true), /nothing is downloaded until you press/);

await rm(tmp, { recursive: true, force: true });
console.log('Updater check passed: asset picking, install targets, download hosts/size/checksum/cancel, restart helper, AppImage/Windows/deb flows' +
  (process.platform === 'darwin' ? ', real DMG mount and bundle swap' : '') + ', toolbar words.');
