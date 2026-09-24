import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { UndoService } from '../../main/undo.js';
import { buildUndoPlan } from '../../main/git/undo-plan.js';
import { addIgnoreRule } from '../../main/git/ignore.js';
import { appendIgnoreRule, escapeIgnoreSegment, ignoreChoice, ignoreChoices, ignoreInverse, validIgnorePath } from '../../main/git/ignore-plan.js';
import { buildFileMenu, ignoreMenuItems } from '../../renderer/src/features/diff/file-menu.js';

// "Ignore this file / all .ext files / this folder" on an untracked path.

// --- patterns, no Git ------------------------------------------------------------------------
assert.equal(escapeIgnoreSegment('plain.txt'), 'plain.txt');
assert.equal(escapeIgnoreSegment('[draft] *?.txt'), '\\[draft] \\*\\?.txt', 'wildcards are escaped');
assert.equal(escapeIgnoreSegment('#notes'), '\\#notes', 'a leading # would be a comment');
assert.equal(escapeIgnoreSegment('!keep'), '\\!keep', 'a leading ! would be a negation');
assert.equal(escapeIgnoreSegment('back\\slash'), 'back\\\\slash');
assert.equal(escapeIgnoreSegment('trailing  '), 'trailing\\ \\ ', 'trailing spaces are kept');
assert.deepEqual(ignoreChoices('logs/app.log'), [
  { kind: 'file', pattern: '/logs/app.log', text: 'Ignore this file' },
  { kind: 'extension', pattern: '*.log', text: 'Ignore all .log files' },
  { kind: 'folder', pattern: '/logs/', text: 'Ignore folder logs/' }
]);
assert.deepEqual(ignoreChoices('build/').map(choice => [choice.kind, choice.pattern]), [['folder', '/build/']], 'an untracked folder offers only itself');
assert.deepEqual(ignoreChoices('.env').map(choice => choice.kind), ['file'], 'a dot-file has no extension and no parent folder');
assert.deepEqual(ignoreChoices('archive.tar.gz').map(choice => choice.pattern), ['/archive.tar.gz', '*.gz']);
assert.deepEqual(ignoreChoices('a/#b/c d .txt').map(choice => choice.pattern), ['/a/\\#b/c d .txt', '*.txt', '/a/\\#b/']);
for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a\nb', 'a\0b', 'a//b', './a', 42]) {
  assert.equal(validIgnorePath(bad), false, String(bad));
  assert.throws(() => ignoreChoices(bad), TypeError);
}
assert.throws(() => ignoreChoice('.env', 'extension'), TypeError, 'a kind the path does not offer is refused');
assert.deepEqual(appendIgnoreRule('', '*.log'), { content: '*.log\n', added: true });
assert.deepEqual(appendIgnoreRule('node_modules/', '*.log'), { content: 'node_modules/\n*.log\n', added: true }, 'a missing final newline is added first');
assert.deepEqual(appendIgnoreRule('a\r\nb\r\n', '*.log'), { content: 'a\r\nb\r\n*.log\r\n', added: true }, 'the file keeps its line endings');
assert.deepEqual(appendIgnoreRule('x\n*.log\n', '*.log'), { content: 'x\n*.log\n', added: false }, 'a rule is not added twice');
{
  const saved = { before: 'a'.repeat(40), after: 'b'.repeat(40), created: false };
  assert.deepEqual(ignoreInverse(saved, 'undo'), [{ argv: ['restore', `--source=${'a'.repeat(40)}`, '--worktree', '--', ':(literal).gitignore'] }]);
  assert.deepEqual(ignoreInverse({ ...saved, created: true }, 'undo'), [{ argv: ['clean', '-f', '-x', '--', ':(literal).gitignore'] }]);
  assert.deepEqual(ignoreInverse(saved, 'redo'), [{ argv: ['restore', `--source=${'b'.repeat(40)}`, '--worktree', '--', ':(literal).gitignore'] }]);
  const entry = args => ({ kind: 'worktree:ignore', args, before: { head: null, branch: null, paths: [] }, after: { head: null, branch: null, paths: [] } });
  assert.equal(buildUndoPlan(entry(saved), 'undo').destructive, false);
  for (const bad of [null, { ...saved, before: '--oops' }, { ...saved, created: 'yes' }]) assert.throws(() => buildUndoPlan(entry(bad), 'undo'), TypeError);
}
// The menu: only untracked rows, and the hint is the exact line.
{
  const handlers = { openInEditor() {}, reveal() {}, copyPath() {}, copyFullPath() {}, fileHistory() {}, blame() {}, discard() {}, ignore() {} };
  const keys = items => items.filter(item => !item.separator).map(item => item.key);
  assert.deepEqual(keys(buildFileMenu({ path: 'x.log', platform: 'darwin', tracked: false, discard: 'untracked', handlers })).filter(key => key.startsWith('ignore')),
    ['ignore-file', 'ignore-extension']);
  assert.ok(!keys(buildFileMenu({ path: 'x.log', platform: 'darwin', discard: 'changes', handlers })).some(key => key.startsWith('ignore')), 'a tracked file cannot be ignored this way');
  assert.equal(ignoreMenuItems({ path: 'a/b.log', run() {} })[1].hint, '*.log');
  assert.deepEqual(ignoreMenuItems({ path: '../evil', run() {} }), [], 'a path the module refuses gets no items');
}

// --- a real repository, through the real Undo service ----------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-ignore-'));
try {
  const cwd = path.join(root, 'repo'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const undo = new UndoService({ directory: root, log }); await undo.load();
  const options = { cwd, log };
  const git = async argv => { const result = await runGit({ ...options, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout; };
  const write = async (file, text) => { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await writeFile(path.join(cwd, file), text); };
  const exists = file => lstat(path.join(cwd, file)).then(() => true, () => false);
  const untracked = async () => (await git(['status', '--porcelain=v1', '-z'])).split('\0').filter(line => line.startsWith('??')).map(line => line.slice(3)).sort();
  const ignore = (file, kind) => undo.perform(cwd, 'worktree:ignore', [file, kind], () => addIgnoreRule({ ...options, path: file, kind }));
  const move = direction => undo.move(cwd, direction, async () => true);

  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false']]) await git(['config', key, value]);
  await write('readme.md', 'hi\n'); await git(['add', '.']); await git(['commit', '-q', '-m', 'Base']);
  await write('debug.log', 'x\n'); await write('logs/app.log', 'x\n'); await write('[draft] #1.txt', 'x\n'); await write('#1.txt', 'keep me\n');
  await write('build/out.bin', 'x\n'); await write('docs/build/out.bin', 'x\n');
  const head = (await git(['rev-parse', 'HEAD'])).trim();
  assert.deepEqual(await untracked(), ['#1.txt', '[draft] #1.txt', 'build/', 'debug.log', 'docs/', 'logs/']);

  // 1. No .gitignore yet: the rule creates it, and Undo deletes it again.
  const first = await ignore('debug.log', 'extension');
  assert.equal(first.ok, true); assert.equal(first.created, true); assert.equal(first.pattern, '*.log'); assert.equal(first.stillShown, false);
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '*.log\n');
  assert.deepEqual(await untracked(), ['#1.txt', '.gitignore', '[draft] #1.txt', 'build/', 'docs/'], 'every .log file is ignored, logs/ held nothing else');
  assert.equal((await undo.inspect(cwd)).undo, true, 'the edit is on the Undo chain');
  await move('undo');
  assert.equal(await exists('.gitignore'), false, 'Undo removes the .gitignore the rule created');
  assert.ok((await untracked()).includes('debug.log'));
  await move('redo');
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '*.log\n', 'Redo writes it again');

  // 2. An existing file keeps its content and line endings; a name with
  //    wildcard and comment characters is ignored as exactly that name.
  await writeFile(path.join(cwd, '.gitignore'), '# mine\r\n*.log');
  await git(['add', '.gitignore']); await git(['commit', '-q', '-m', 'Ignore file']);
  const exact = await ignore('[draft] #1.txt', 'file');
  assert.equal(exact.pattern, '/\\[draft] #1.txt');
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '# mine\r\n*.log\r\n/\\[draft] #1.txt\r\n');
  assert.deepEqual(await untracked(), ['#1.txt', 'build/', 'docs/'], 'only that file went; #1.txt is still shown');
  await move('undo');
  assert.equal(await readFile(path.join(cwd, '.gitignore'), 'utf8'), '# mine\r\n*.log', 'Undo restores the committed version byte for byte');
  assert.equal((await git(['status', '--porcelain=v1', '--', '.gitignore'])).trim(), '', 'and Git sees no change');
  await move('redo');

  // 3. An anchored folder rule does not reach a folder of the same name deeper down.
  const folder = await ignore('build/', 'folder');
  assert.equal(folder.pattern, '/build/');
  assert.deepEqual(await untracked(), ['#1.txt', 'docs/']);
  assert.equal((await git(['check-ignore', '--no-index', '-q', 'docs/build/out.bin']).catch(() => 'not ignored')), 'not ignored');

  // 4. Refusals: a path that is not untracked (anymore), a kind it does not
  //    offer, a .gitignore that is a link, a path that tries to leave the tree.
  await assert.rejects(() => addIgnoreRule({ ...options, path: 'readme.md', kind: 'file' }), /not untracked/);
  await assert.rejects(() => addIgnoreRule({ ...options, path: 'debug.log', kind: 'file' }), /not untracked/, 'already ignored');
  await assert.rejects(() => addIgnoreRule({ ...options, path: '#1.txt', kind: 'folder' }), TypeError, 'a root file has no folder to ignore');
  await assert.rejects(() => addIgnoreRule({ ...options, path: '../outside', kind: 'file' }), TypeError);
  await assert.rejects(() => addIgnoreRule({ ...options, path: '#1.txt', kind: 'pattern' }), TypeError);
  const outside = path.join(root, 'outside.txt'); await writeFile(outside, 'secret\n');
  const saved = await readFile(path.join(cwd, '.gitignore'), 'utf8');
  await rm(path.join(cwd, '.gitignore')); await symlink(outside, path.join(cwd, '.gitignore'));
  await assert.rejects(() => addIgnoreRule({ ...options, path: '#1.txt', kind: 'file' }), /not a regular file/);
  assert.equal(await readFile(outside, 'utf8'), 'secret\n', 'nothing was written through the link');
  await rm(path.join(cwd, '.gitignore')); await writeFile(path.join(cwd, '.gitignore'), saved);

  // 5. A rule that is already there, yet the file still shows: said, not repeated.
  await writeFile(path.join(cwd, '.gitignore'), `${saved}\n/\\#1.txt\n!/\\#1.txt\n`);
  const again = await addIgnoreRule({ ...options, path: '#1.txt', kind: 'file' });
  assert.equal(again.ok, false);
  assert.match(again.message, /already in \.gitignore/);
  await writeFile(path.join(cwd, '.gitignore'), saved);

  assert.equal((await git(['rev-parse', 'HEAD~1'])).trim(), head, 'only the one commit this check made itself');
  assert.equal((await git(['log', '--format=%s', '-1'])).trim(), 'Ignore file', 'adding rules never commits anything');
  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.match(journal, /"executable":"🌱 Twig","argv":\["append",".gitignore","\*\.log"\]/, 'the write is journaled with the exact line');
  console.log('ignore check: ok');
} finally {
  await rm(root, { recursive: true, force: true });
}
