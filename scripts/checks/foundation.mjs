import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isExternalLink, isLocalAsset, isTrustedPage } from '../../main/security.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');
const assetRoot = path.join(root, 'dist/renderer');
const assetUrl = pathToFileURL(path.join(assetRoot, 'index.html')).href;
assert.ok(isLocalAsset(assetUrl, assetRoot));
for (const url of [pathToFileURL(path.join(root, 'main/index.js')).href,
  assetUrl.replace('index.html', '%2e%2e/preload/index.cjs'),
  assetUrl.replace('index.html', '..%2f..%2fmain/index.js'), 'https://example.com']) {
  assert.equal(isLocalAsset(url, assetRoot), false, url);
}
const entry = 'file:///Applications/Git%20Desk/dist/renderer/index.html';
assert.ok(isTrustedPage(entry + '#history', entry));
for (const url of ['file:///etc/passwd', entry + '?other=1', 'https://example.com', 'file://host/Applications/Git%20Desk/dist/renderer/index.html', 'invalid']) {
  assert.equal(isTrustedPage(url, entry), false, url);
}
assert.ok(isTrustedPage('http://127.0.0.1:5188/', 'http://127.0.0.1:5188/'));
assert.equal(isTrustedPage('http://127.0.0.1:5188/elsewhere', 'http://127.0.0.1:5188/'), false);
assert.ok(isExternalLink('https://example.com/docs'));
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://host', 'https://user:secret@example.com', 'invalid']) {
  assert.equal(isExternalLink(url), false, url);
}

const tokens = await read('renderer/src/ui/tokens.css');
assert.equal((await read('design/TOKENS.md')).split('```css\n')[1].split('```')[0], tokens);
function luminance(hex) {
  const channels = hex.match(/\w\w/g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
function contrast(a, b) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); }
for (const theme of ['dark', 'light']) {
  const block = tokens.split(`:root[data-theme='${theme}'] {`)[1].split('}')[0];
  const palette = Object.fromEntries([...block.matchAll(/--([\w-]+): (#\w{6});/g)].map(m => [m[1], m[2].slice(1)]));
  for (const foreground of ['text', 'muted', 'accent', 'lane-mint', 'lane-cream', 'lane-leaf', 'danger',
    'age-fresh', 'age-young', 'age-mature', 'age-old', 'age-root']) {
    for (const background of ['bg', 'surface', 'surface-raised', 'surface-hover', 'accent-bg']) {
      assert.ok(contrast(palette[foreground], palette[background]) >= 4.5, `${theme}: ${foreground} on ${background}`);
    }
  }
}

const temp = await mkdtemp(path.join(tmpdir(), 'twig-install-check-'));
try {
  await mkdir(path.join(temp, 'modules/desktop'), { recursive: true });
  await mkdir(path.join(temp, 'modules/docs'), { recursive: true });
  await mkdir(path.join(temp, 'bin'));
  const installer = path.join(temp, 'install.mjs');
  await copyFile(path.join(root, '../../tools/install-modules.js'), installer);
  await writeFile(path.join(temp, 'modules/desktop/package.json'), JSON.stringify({ nodexInstall: false }));
  const marker = path.join(temp, 'called');
  const fakeNpm = path.join(temp, 'bin', process.platform === 'win32' ? 'npm.cmd' : 'npm');
  await writeFile(fakeNpm, process.platform === 'win32'
    ? '@echo off\r\necho called>>"%TWIG_INSTALL_MARKER%"\r\n'
    : '#!/bin/sh\nprintf "called\\n" >> "$TWIG_INSTALL_MARKER"\n', { mode: 0o755 });
  const run = () => spawnSync(process.execPath, [installer], {
    cwd: temp, encoding: 'utf8', shell: false,
    env: { ...process.env, PATH: `${path.join(temp, 'bin')}${path.delimiter}${process.env.PATH}`, TWIG_INSTALL_MARKER: marker }
  });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Skipping desktop: nodexInstall is false/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await mkdir(path.join(temp, 'modules/service'));
  await writeFile(path.join(temp, 'modules/service/package.json'), '{}');
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await readFile(marker, 'utf8')).trim(), 'called');
  await writeFile(path.join(temp, 'modules/desktop/package.json'), '{broken');
  result = run();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot read package.json for desktop/);
} finally { await rm(temp, { recursive: true, force: true }); }
console.log('Foundation checks passed: navigation policy, token parity, contrast, installer opt-out/default/error.');
