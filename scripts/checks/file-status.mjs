import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FILE_STATUS, fileStatus } from '../../renderer/src/features/diff/file-status.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');

// Normalisation: leading letter wins, similarity scores and casing are stripped,
// `?` is untracked, a bare tree-listing space and anything unknown is neutral.
assert.deepEqual(fileStatus('A'), { letter: 'A', label: 'Added', className: 'file-status-add' });
assert.deepEqual(fileStatus('m'), { letter: 'M', label: 'Modified', className: 'file-status-mod' });
assert.equal(fileStatus('R100').className, 'file-status-ren');
assert.equal(fileStatus('R100').letter, 'R');
assert.equal(fileStatus('?').label, 'Untracked');
assert.equal(fileStatus(' ').className, 'file-status-other');
assert.equal(fileStatus(' ').letter, '·');
assert.equal(fileStatus('').letter, '·');
assert.equal(fileStatus(null).className, 'file-status-other');
assert.equal(fileStatus('Z').className, 'file-status-other');
assert.equal(fileStatus('U').className, 'file-status-conflict');

// Every class the module can emit has a matching rule in history.css.
const css = await read('renderer/src/ui/history.css');
const classes = new Set([...Object.values(FILE_STATUS).map(m => m.className), 'file-status-other']);
for (const name of classes) {
  assert.match(css, new RegExp(`\\.${name}\\b`), `history.css styles .${name}`);
  const rule = css.match(new RegExp(`[^}]*\\.${name}\\b[^{]*\\{([^}]*)\\}`))[1];
  assert.match(rule, /background: var\(--mark-\w+\)/, `.${name} fills with a mark token`);
}
assert.match(css, /\.file-status \{[^}]*color: var\(--bg\)/, 'the badge letter is drawn in --bg');

// The letter sits in --bg on a --mark-* fill. It is a bold single-glyph badge
// with a redundant text label (title + aria-label), so it needs the 3:1 a UI
// component needs, the same bar foundation.mjs holds the marks to.
const tokens = await read('renderer/src/ui/tokens.css');
function luminance(hex) {
  const channels = hex.match(/\w\w/g).map(c => parseInt(c, 16) / 255)
    .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(a, b) { const v = [luminance(a), luminance(b)].sort((x, y) => y - x); return (v[0] + 0.05) / (v[1] + 0.05); }
const marks = ['mark-red', 'mark-amber', 'mark-green', 'mark-blue', 'mark-violet', 'mark-slate'];
for (const theme of ['dark', 'light']) {
  const block = tokens.split(`:root[data-theme='${theme}'] {`)[1].split('}')[0];
  const palette = Object.fromEntries([...block.matchAll(/--([\w-]+): (#\w{6});/g)].map(m => [m[1], m[2].slice(1)]));
  for (const mark of marks) {
    assert.ok(contrast(palette.bg, palette[mark]) >= 3, `${theme}: --bg on --${mark} for the file badge`);
  }
}

console.log('File-status badge checks passed: normalisation, CSS parity, badge contrast.');
