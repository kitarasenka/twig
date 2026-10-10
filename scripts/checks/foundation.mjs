import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
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
// A commit author's plain email opens in the system mail client; nothing more.
assert.ok(isExternalLink('mailto:dev@example.com'));
for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'ssh://host', 'https://user:secret@example.com',
  'mailto:', 'mailto:not-an-email', 'mailto:dev@example.com?subject=Hi&body=x', 'invalid']) {
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
  // Commit marks are drawn as strokes, dots and swatches, not text, so they only
  // need the 3:1 that a UI component needs against the surfaces they sit on.
  for (const mark of ['mark-red', 'mark-amber', 'mark-green', 'mark-blue', 'mark-violet', 'mark-slate']) {
    for (const background of ['bg', 'surface', 'surface-raised']) {
      assert.ok(contrast(palette[mark], palette[background]) >= 3, `${theme}: ${mark} on ${background}`);
    }
  }
}

// The monorepo installer this file once also checked (`tools/install-modules.js`,
// `nodexInstall`) does not exist in the standalone repository: it stopped
// `npm test` here, and every check after this one never ran.
console.log('Foundation checks passed: navigation policy, token parity, contrast.');
