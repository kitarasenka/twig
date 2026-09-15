import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import afterPack, { launcherScript } from '../after-pack.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'twig-after-pack-'));
const context = (platform, dir) => ({
  electronPlatformName: platform, appOutDir: dir,
  packager: { executableName: 'twig', appInfo: { productFilename: '🌱 Twig' } }
});

async function stagePack(name) {
  const dir = path.join(tmp, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'twig'), 'ELF-not-really', { mode: 0o755 });
  await writeFile(path.join(dir, 'chrome-sandbox'), 'ELF-not-really', { mode: 0o755 });
  return dir;
}

// Linux: the real binary steps aside and the launcher takes its name, because
// AppRun and the .desktop entry exec the file by name and nothing else.
const linux = await stagePack('linux');
await afterPack(context('linux', linux));
assert.equal(await readFile(path.join(linux, 'twig.bin'), 'utf8'), 'ELF-not-really');
const launcher = await readFile(path.join(linux, 'twig'), 'utf8');
assert.match(launcher, /^#!\/bin\/bash\n/);
assert.match(launcher, /^exec "\$here\/twig\.bin" "\$@"$/m);
assert.match(launcher, /^unset NODE_OPTIONS$/m);
assert.equal((await stat(path.join(linux, 'twig'))).mode & 0o111, 0o111);

// The fontconfig the launcher points at travels with the application, and it is
// the file from the repository, not a copy that can drift.
const packed = await readFile(path.join(linux, 'etc/fonts/fonts.conf'), 'utf8');
const source = await readFile(new URL('../../build/fontconfig/fonts.conf', import.meta.url), 'utf8');
assert.equal(packed, source);
assert.match(launcher, /FONTCONFIG_FILE="\$here\/etc\/fonts\/fonts\.conf"/);
assert.match(launcher, /FONTCONFIG_PATH="\$here\/etc\/fonts"/);
assert.match(launcher, /unset FONTCONFIG_SYSROOT/);

// A private cache directory is the whole point: caches written by a newer host
// fontconfig are what leave the bundled one with no fonts at all.
assert.match(source, /<cachedir prefix="xdg">twig\/fontconfig<\/cachedir>/);
assert.equal((source.match(/<cachedir/g) || []).length, 1);
// Host font directories and host rendering preferences are kept.
assert.match(source, /<dir>\/usr\/share\/fonts<\/dir>/);
assert.match(source, /<include ignore_missing="yes">\/etc\/fonts\/conf\.d<\/include>/);

// The launcher is a shell script, so it has to be one that bash accepts.
execFileSync('bash', ['-n', path.join(linux, 'twig')]);

// Running twice over the same directory must not wrap the launcher in itself.
await afterPack(context('linux', linux));
assert.equal(await readFile(path.join(linux, 'twig.bin'), 'utf8'), 'ELF-not-really');
assert.equal(await readFile(path.join(linux, 'twig'), 'utf8'), launcher);

// Windows is packed exactly as before — no launcher swap, no signing.
{
  const dir = await stagePack('win32');
  await afterPack(context('win32', dir));
  assert.equal(await readFile(path.join(dir, 'twig'), 'utf8'), 'ELF-not-really');
  await assert.rejects(stat(path.join(dir, 'twig.bin')));
  await assert.rejects(stat(path.join(dir, 'etc/fonts/fonts.conf')));
}

// macOS: the .app gets an ad-hoc signature (no identity, just enough for the
// kernel to accept it) — that's the difference between a normal Gatekeeper
// warning and arm64's hard "app is damaged" refusal for wholly unsigned code.
// build.mac.identity is null, so electron-builder's own afterSign hook never
// fires (see the comment on adHocSignMac); this only proves our afterPack
// step reaches a real `codesign` and it accepts the result.
if (process.platform === 'darwin') {
  const dir = await stagePack('darwin');
  const contentsDir = path.join(dir, '🌱 Twig.app', 'Contents');
  await mkdir(path.join(contentsDir, 'MacOS'), { recursive: true });
  await copyFile('/usr/bin/true', path.join(contentsDir, 'MacOS', 'twig'));
  await writeFile(path.join(contentsDir, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>twig</string>
<key>CFBundleIdentifier</key><string>app.nodex.twig</string>
</dict></plist>
`, 'utf8');
  await afterPack(context('darwin', dir));
  execFileSync('codesign', ['--verify', '--deep', path.join(dir, '🌱 Twig.app')]);
} else {
  console.log('after-pack check: skipping macOS ad-hoc signing (codesign unavailable on this platform)');
}

// The executable name is not hardcoded: it comes from the packager.
assert.match(launcherScript('other-name'), /exec "\$here\/other-name\.bin" "\$@"/);

await rm(tmp, { recursive: true, force: true });
console.log('after-pack check passed');
