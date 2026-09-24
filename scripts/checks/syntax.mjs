import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LANGUAGES, languageFor, languageLabel } from '../../renderer/src/features/diff/languages.js';
import { MAX_LINE_CHARS, SYNTAX_CLASSES, highlightLines } from '../../renderer/src/features/diff/syntax.js';
import { displayRows, lineSpans, patchSourceLines, sideSyntax, splitByRanges } from '../../renderer/src/features/diff/diff-view.js';
import { annotatePatch, segmentPair } from '../../renderer/src/features/diff/intraline.js';
import { readDiffPrefs, writeDiffPrefs } from '../../renderer/src/features/diff/diff-prefs.js';
import Prism from 'prismjs';

const read = file => readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
const text = pieces => pieces.map(piece => piece.text).join('');
const classesOf = (pieces, fragment) => pieces.filter(piece => piece.text.includes(fragment)).map(piece => piece.cls);

// --- which grammar a file gets ----------------------------------------------------
for (const [path, language] of [
  ['src/app.js', 'javascript'], ['a/b/c.MJS', 'javascript'], ['App.jsx', 'jsx'], ['x.ts', 'typescript'], ['x.tsx', 'tsx'],
  ['main.py', 'python'], ['go.mod', null], ['lib.rs', 'rust'], ['Main.kt', 'kotlin'], ['x.hpp', 'cpp'], ['x.h', 'c'],
  ['style.scss', 'scss'], ['index.html', 'markup'], ['icon.svg', 'markup'], ['README.md', 'markdown'],
  ['config.yml', 'yaml'], ['Cargo.toml', 'toml'], ['setup.cfg', 'ini'], ['query.sql', 'sql'], ['build.sh', 'bash'],
  ['Dockerfile', 'docker'], ['docker/Dockerfile.dev', 'docker'], ['Makefile', 'makefile'], ['Gemfile', 'ruby'],
  ['.gitignore', 'git'], ['.zshrc', 'bash'], ['main.tf', 'hcl'], ['api.proto', 'protobuf'], ['fix.patch', 'diff'],
  ['app-portage.ebuild', 'bash'], ['notes.txt', null], ['LICENSE', null], ['yarn.lock', null], ['', null], [null, null]
]) assert.equal(languageFor(path), language, String(path));
assert.equal(languageLabel('cpp'), 'C++');
assert.equal(languageLabel(null), 'Plain text');
// Every name the map can answer has a grammar loaded by syntax.js — a language
// named here but not imported would silently render plain.
for (const language of Object.keys(LANGUAGES)) assert.ok(Prism.languages[language], `Prism grammar ${language} is loaded`);
const syntaxSource = await read('renderer/src/features/diff/syntax.js');
for (const language of Object.keys(LANGUAGES)) {
  if (['markup', 'css', 'javascript'].includes(language)) continue;
  assert.match(syntaxSource, new RegExp(`prismjs/components/prism-${language}\\.js`), `${language} is imported`);
}

// --- tokens become per-line ranges ------------------------------------------------------
{
  const [first, second, third] = highlightLines(['const a = `x', 'still template ${b}`; /* c', 'omment */ run(1)'], 'javascript');
  assert.deepEqual(first[0], { start: 0, end: 5, cls: 'syn-keyword' });
  assert.ok(second.some(range => range.cls === 'syn-string' && range.start === 0), 'a template string keeps its colour on the next line');
  assert.ok(third.some(range => range.cls === 'syn-comment' && range.start === 0), 'a block comment keeps its colour on the next line');
  assert.ok(third.some(range => range.cls === 'syn-function'), 'a call is a function');
  assert.ok(third.some(range => range.cls === 'syn-number'), 'a literal is a number');
  for (const ranges of [first, second, third]) {
    for (let i = 1; i < ranges.length; i++) assert.ok(ranges[i].start >= ranges[i - 1].end, 'ranges are ordered and do not overlap');
  }
}
{
  const [def, body, end] = highlightLines(['def f(x):', '    """doc', 'more""" + 2'], 'python');
  assert.equal(def[0].cls, 'syn-keyword');
  assert.ok(body.some(range => range.cls === 'syn-string'));
  assert.equal(end[0].cls, 'syn-string');
}
assert.deepEqual(highlightLines(['a', 'b'], null), [null, null], 'no language, no colours');
assert.deepEqual(highlightLines(['a'], 'no-such-grammar'), [null]);
assert.deepEqual(highlightLines(['x'.repeat(MAX_LINE_CHARS + 1), 'const y = 1'], 'javascript'), [null, null],
  'a minified line is never tokenized — the whole block shows plain');
for (const cls of highlightLines(['<div class="a">x</div>'], 'markup')[0].map(range => range.cls)) assert.ok(SYNTAX_CLASSES.includes(cls));
{
  const lines = Array.from({ length: 4000 }, (_, i) => `export function f${i}(a, b) { return a + b * ${i}; } // ${i}`);
  const chars = lines.reduce((total, line) => total + line.length + 1, 0);
  const started = performance.now();
  const ranges = highlightLines(lines, 'javascript');
  const ms = performance.now() - started;
  assert.ok(ranges.every(Boolean), `a ${chars}-character block under the limit is highlighted`);
  assert.ok(ms < 2000, `4000 lines highlight in ${ms.toFixed(0)} ms`);
  console.log(`  4000 JavaScript lines (${Math.round(chars / 1024)} KB) highlighted in ${ms.toFixed(0)} ms`);
  assert.deepEqual(highlightLines(Array.from({ length: 6000 }, () => 'x'.repeat(60)), 'javascript').filter(Boolean), [],
    'past the block limit nothing is tokenized');
}

// --- each side of a hunk is highlighted as one block ----------------------------------------
{
  const calls = [];
  const fake = lines => { calls.push(lines); return lines.map(line => [{ start: 0, end: line.length, cls: `from:${lines.join('|')}` }]); };
  const lines = [
    { kind: 'hunk', text: '@@' }, { kind: 'context', text: 'a' }, { kind: 'delete', text: 'old' }, { kind: 'add', text: 'new' },
    { kind: 'meta', text: '\\ No newline at end of file' }, { kind: 'hunk', text: '@@' }, { kind: 'add', text: 'z' }
  ];
  const out = sideSyntax(lines, fake);
  assert.deepEqual(calls, [['a', 'old'], ['a', 'new'], ['z']], 'old side, new side, then the next hunk alone');
  assert.equal(out[1][0].cls, 'from:a|new', 'context takes the new side');
  assert.equal(out[2][0].cls, 'from:a|old', 'a removed line takes the old side');
  assert.equal(out[3][0].cls, 'from:a|new');
  assert.equal(out[4], null, 'meta lines belong to neither side');
  assert.equal(out[0], null);
  assert.equal(out[6][0].cls, 'from:z');
}

// --- ranges and change segments merge into pieces --------------------------------------------
assert.deepEqual(splitByRanges('const x', 0, [{ start: 0, end: 5, cls: 'syn-keyword' }]), [{ text: 'const', cls: 'syn-keyword' }, { text: ' x', cls: '' }]);
assert.deepEqual(splitByRanges('nst x', 2, [{ start: 0, end: 5, cls: 'k' }], 'diff-seg-add'), [{ text: 'nst', cls: 'k diff-seg-add' }, { text: ' x', cls: 'diff-seg-add' }],
  'a piece starting mid-token keeps the token class');
assert.deepEqual(splitByRanges('abc', 0, null), [{ text: 'abc', cls: '' }]);
assert.deepEqual(splitByRanges('', 0, null), []);
{
  const seg = segmentPair('return total + 1;', 'return total + 2;');
  const ranges = [{ start: 0, end: 6, cls: 'syn-keyword' }, { start: 15, end: 16, cls: 'syn-number' }];
  const pieces = lineSpans('return total + 2;', ranges, seg.new);
  assert.equal(text(pieces), 'return total + 2;', 'nothing is lost or duplicated');
  assert.deepEqual(classesOf(pieces, '2'), ['syn-number diff-seg-add'], 'the changed digit is both a number and an addition');
  assert.deepEqual(classesOf(pieces, 'return'), ['syn-keyword']);
}

// --- word mode ---------------------------------------------------------------------------------
const patch = [
  'diff --git a/a.js b/a.js', '--- a/a.js', '+++ b/a.js',
  '@@ -1,5 +1,5 @@',
  ' const keep = 1;',
  '-const total = count + 1;',
  '+const total = count + 2;',
  '-completely different old line here',
  '+zzz',
  ' done();',
  '-remove_this_line_entirely',
  '+q = 42 * 7',
  '+extra();', ''
].join('\n');
const rows = annotatePatch(patch);
{
  const shown = displayRows(rows);
  assert.equal(shown.length, rows.length, 'line mode shows every row');
  assert.deepEqual(shown.map(row => row.marker), ['', ' ', '-', '+', '-', '+', ' ', '-', '+', '+']);
}
{
  const shown = displayRows(rows, { words: true });
  const changed = shown.filter(row => row.cls === 'diff-changed');
  assert.equal(changed.length, 1, 'only the similar pair folds into one line');
  assert.equal(changed[0].marker, '~');
  assert.equal(changed[0].oldLine, 2);
  assert.equal(changed[0].newLine, 2);
  assert.equal(text(changed[0].pieces), 'const total = count + 12;', 'shared text once, removed then added');
  assert.ok(changed[0].pieces.some(piece => piece.text === '1' && piece.cls.includes('diff-seg-del')));
  assert.ok(changed[0].pieces.some(piece => piece.text === '2' && piece.cls.includes('diff-seg-add')));
  // A rewrite is not interleaved: its lines stay whole and separate, in order.
  const markers = shown.map(row => `${row.marker}${text(row.pieces)}`);
  assert.deepEqual(markers.slice(3, 5), ['-completely different old line here', '+zzz']);
  assert.equal(shown.length, rows.length - 1, 'one pair became one row, nothing else changed');
  assert.deepEqual(shown.filter(row => row.cls === 'diff-hunk').length, 1);
}
{
  // Each piece of a merged line keeps the syntax of its own side.
  const syntax = sideSyntax(patchSourceLines(rows), lines => highlightLines(lines, 'javascript'));
  const shown = displayRows(rows, { syntax, words: true });
  const changed = shown.find(row => row.cls === 'diff-changed');
  assert.ok(changed.pieces.find(piece => piece.text === 'const').cls.includes('syn-keyword'));
  assert.ok(changed.pieces.find(piece => piece.text === '1').cls.split(' ').includes('syn-number'), 'the removed digit is coloured from the old line');
  assert.ok(changed.pieces.find(piece => piece.text === '2').cls.split(' ').includes('syn-number'), 'the added digit is coloured from the new line');
  const plain = displayRows(rows, { syntax });
  assert.equal(plain.length, rows.length);
  assert.ok(plain[1].pieces.some(piece => piece.cls.includes('syn-keyword')), 'context is coloured');
}
{
  // Word mode replaces whole words; line mode may still refine to the character.
  const seg = segmentPair("'--max-count=250'", "'--max-count=500'");
  assert.deepEqual(seg.merged.filter(piece => piece.type !== 'same').map(piece => [piece.type, piece.text]), [['del', '250'], ['add', '500']]);
  assert.ok(seg.new.some(piece => piece.type === 'add' && piece.text.length < 3), 'line mode keeps its character refinement');
}

// --- preferences -------------------------------------------------------------------------------
{
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(readDiffPrefs(storage), { mode: 'lines', syntax: true }, 'lines and colours by default');
  writeDiffPrefs(storage, { mode: 'words' });
  assert.deepEqual(readDiffPrefs(storage), { mode: 'words', syntax: true });
  writeDiffPrefs(storage, { syntax: false });
  assert.deepEqual(readDiffPrefs(storage), { mode: 'words', syntax: false });
  store.set('twig:diff-mode', 'garbage');
  assert.equal(readDiffPrefs(storage).mode, 'lines');
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.deepEqual(readDiffPrefs(broken), { mode: 'lines', syntax: true });
  writeDiffPrefs(broken, { mode: 'words' });
  assert.deepEqual(readDiffPrefs(null), { mode: 'lines', syntax: true });
}

// --- colours: tokens, classes and contrast on every diff background --------------------------------
const tokens = await read('renderer/src/ui/tokens.css');
const css = await read('renderer/src/ui/history.css');
const roles = SYNTAX_CLASSES.map(cls => cls.slice('syn-'.length));
for (const role of roles) assert.match(css, new RegExp(`\\.syn-${role} \\{ color: var\\(--syntax-${role}\\);`), `.syn-${role} is styled by its token`);
const tint = name => Number(new RegExp(`\\.diff-seg-${name} \\{ background: color-mix\\(in srgb, var\\(--\\w+\\) (\\d+)%`).exec(css)[1]) / 100;
const addTint = tint('add');
const delTint = tint('del');
const channels = hex => hex.match(/\w\w/g).map(c => parseInt(c, 16));
const luminance = hex => {
  const c = channels(hex).map(v => v / 255).map(v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (top, bottom, share) => channels(top).map((v, i) => Math.round(v * share + channels(bottom)[i] * (1 - share)).toString(16).padStart(2, '0')).join('');
for (const theme of ['dark', 'light']) {
  const source = tokens.split(theme === 'dark' ? ":root, :root[data-theme='dark'] {" : ":root[data-theme='light'] {")[1].split('}')[0];
  const palette = Object.fromEntries([...source.matchAll(/--([\w-]+): #(\w{6});/g)].map(match => [match[1], match[2]]));
  const panels = ['bg', 'surface', 'surface-raised', 'surface-hover'].map(name => palette[name]);
  const backgrounds = {
    bg: palette.bg, surface: palette.surface, 'surface-raised': palette['surface-raised'], 'surface-hover': palette['surface-hover'],
    'added line': palette['accent-bg'], 'removed line': palette['danger-bg'],
    'added words on an added line': mix(palette.accent, palette['accent-bg'], addTint),
    'removed words on a removed line': mix(palette.danger, palette['danger-bg'], delTint),
    ...Object.fromEntries(panels.flatMap((panel, i) => [
      [`added words in word mode (${i})`, mix(palette.accent, panel, addTint)],
      [`removed words in word mode (${i})`, mix(palette.danger, panel, delTint)]
    ]))
  };
  for (const foreground of [...roles.map(role => `syntax-${role}`), 'text']) {
    assert.ok(palette[foreground], `${theme}: --${foreground} is defined`);
    for (const [name, background] of Object.entries(backgrounds)) {
      const ratio = contrast(palette[foreground], background);
      assert.ok(ratio >= 4.5, `${theme}: --${foreground} on ${name} is ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrast(palette.accent, palette['accent-bg']) >= 4.5, `${theme}: + marker`);
  assert.ok(contrast(palette.danger, palette['danger-bg']) >= 4.5, `${theme}: - marker`);
  assert.ok(contrast(palette['lane-mint'], palette.bg) >= 4.5, `${theme}: ~ marker`);
}

console.log('Syntax checks passed: language map, Prism grammars, per-line ranges, hunk sides, piece merging, word mode, preferences, contrast.');
