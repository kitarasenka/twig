import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { SEARCH_MODES, buildSearchArgv, searchHistory } from '../../main/git/history.js';
import { SEARCH_MODE_OPTIONS, searchEmpty, searchSummary } from '../../renderer/src/features/graph/search-modes.js';

// --- argv, without Git ---------------------------------------------------------------------
assert.deepEqual(SEARCH_MODE_OPTIONS.map(option => option.id), SEARCH_MODES, 'the renderer offers exactly the modes main accepts');
const tail = argv => argv.slice(argv.indexOf('-z') + 1).filter(part => !part.startsWith('--format=') && !part.startsWith('--max-count='));
assert.deepEqual(tail(buildSearchArgv('Fix', 200, 'message')), ['-i', '--fixed-strings', '--grep=Fix']);
assert.deepEqual(tail(buildSearchArgv('maya', 200, 'author')), ['-i', '--fixed-strings', '--author=maya']);
assert.deepEqual(tail(buildSearchArgv('--output=/tmp/x', 200, 'content')), ['-S--output=/tmp/x'], 'a query that looks like a flag stays one token');
assert.deepEqual(tail(buildSearchArgv('a.*b', 200, 'regex')), ['-Ga.*b']);
assert.deepEqual(tail(buildSearchArgv('a*[b]?', 200, 'file')), ['--', ':(glob,icase)**/*a\\*\\[b\\]\\?*', ':(glob,icase)**/*a\\*\\[b\\]\\?*/**'],
  'glob characters in a path query are escaped');
for (const mode of SEARCH_MODES) {
  const argv = buildSearchArgv('x', 200, mode);
  assert.ok(argv.indexOf('--exclude=refs/twig/*') < argv.indexOf('--all'), `${mode}: backups are excluded`);
}
assert.throws(() => buildSearchArgv('x', 200, 'shell'), TypeError);
assert.throws(() => buildSearchArgv('', 200, 'author'), TypeError);
assert.equal(searchSummary({ query: 'maya', mode: 'author', count: 3, truncated: false }), '3 commits match “maya” in the author');
assert.equal(searchSummary({ query: 'x', mode: 'content', count: 200, truncated: true }), '200+ commits match “x” in the added or removed code');
assert.equal(searchSummary({ query: 'x', mode: 'content', count: 0, truncated: false, loading: true }), 'Searching every change (-S) for “x”…');
assert.match(searchEmpty('x', 'file'), /No commit changed a path containing “x”/);

// --- on a real repository --------------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-search-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async (argv, env = null) => { const result = await runGit({ cwd, log, argv, env }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  const commit = async (message, author, files) => {
    for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); }
    await git(['add', '-A']);
    const [name, email] = author;
    await git(['commit', '-m', message], { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
    return git(['rev-parse', 'HEAD']);
  };
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  const maya = ['Maya Chen', 'maya@example.invalid'];
  const alex = ['Alex Morgan', 'alex@example.invalid'];
  const c1 = await commit('Set up the app', maya, { 'src/app.js': 'export const pages = 250;\n', 'README.md': '# App\n' });
  const c2 = await commit('Add the console', alex, { 'src/console/log.js': 'export function log() {}\n' });
  const c3 = await commit('Bigger pages', maya, { 'src/app.js': 'export const pages = 500;\n' });
  const c4 = await commit('Touch the readme', alex, { 'README.md': '# App\n\nMore words.\n', 'a*[weird]?.txt': 'odd name\n' });
  const c5 = await commit('Move pages into a helper', alex, { 'src/app.js': 'import { pages } from "./pages.js";\n', 'src/pages.js': 'export const pages = 500;\n' });
  const find = async (query, mode) => (await searchHistory({ cwd, log, query, mode })).commits.map(item => item.oid);

  assert.deepEqual(await find('pages', 'message'), [c5, c3]);
  assert.deepEqual(await find(c2.slice(0, 8), 'message'), [c2], 'a hash prefix still resolves in message mode');
  assert.deepEqual(await find('MAYA', 'author'), [c3, c1], 'author: any case, name');
  assert.deepEqual(await find('alex@example', 'author'), [c5, c4, c2], 'author: email');
  assert.deepEqual(await find('console', 'file'), [c2], 'file: a folder name matches everything under it');
  assert.deepEqual(await find('APP.JS', 'file'), [c5, c3, c1], 'file: any case');
  assert.deepEqual(await find('*[weird]', 'file'), [c4], 'file: glob characters are literal');
  assert.deepEqual(await find('pages = 250', 'content'), [c3, c1], '-S: where the text appeared and where it disappeared');
  assert.deepEqual(await find('pages = 500', 'content'), [c5, c3], '-S counts per file: moving the text to another file shows up in both');
  assert.deepEqual(await find('PAGES = 500', 'content'), [], '-S is exact case');
  assert.deepEqual(await find('pages = [0-9]+', 'regex'), [c5, c3, c1], '-G: every change to a matching line, including the move');
  const broken = await searchHistory({ cwd, log, query: 'pages = [0-9', mode: 'regex' });
  assert.deepEqual(broken.commits, []);
  assert.match(broken.invalid, /^Git cannot use that pattern: /, 'a broken regex is an answer with Git’s reason, not a failure');
  assert.deepEqual(await find('nothing like this', 'content'), []);

  // 🌱 Twig's discard backups never show up, even when they would match.
  const tree = await git(['write-tree']);
  const backup = await git(['commit-tree', tree, '-m', 'Bigger pages backup'], { GIT_AUTHOR_NAME: 'Maya Chen', GIT_AUTHOR_EMAIL: 'maya@example.invalid', GIT_COMMITTER_NAME: 'x', GIT_COMMITTER_EMAIL: 'x@x' });
  await git(['update-ref', 'refs/twig/discard', backup]);
  assert.ok(!(await find('pages', 'message')).includes(backup));
  assert.ok(!(await find('maya', 'author')).includes(backup));

  // A search replaced by a newer one is cancelled, not left running.
  const controller = new AbortController();
  controller.abort();
  const cancelled = await searchHistory({ cwd, log, query: 'pages', mode: 'content', signal: controller.signal });
  assert.equal(cancelled.cancelled, true);
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Search checks passed: modes and argv, literal author/file/content, -S appear/disappear, -G, broken regex, glob escaping, hidden backups, cancellation.');
