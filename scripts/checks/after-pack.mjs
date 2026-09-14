import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import afterPack, { launcherScript } from '../after-pack.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'twig-after-pack-'));
const context = (platform, dir) => ({
  electronPlatformName: platform, appOutDir: dir, packager: { executableName: 'twig' }
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

// Other platforms are packed exactly as before.
for (const platform of ['darwin', 'win32']) {
  const dir = await stagePack(platform);
  await afterPack(context(platform, dir));
  assert.equal(await readFile(path.join(dir, 'twig'), 'utf8'), 'ELF-not-really');
  await assert.rejects(stat(path.join(dir, 'twig.bin')));
  await assert.rejects(stat(path.join(dir, 'etc/fonts/fonts.conf')));
}

// The executable name is not hardcoded: it comes from the packager.
assert.match(launcherScript('other-name'), /exec "\$here\/other-name\.bin" "\$@"/);

await rm(tmp, { recursive: true, force: true });
console.log('after-pack check passed');
