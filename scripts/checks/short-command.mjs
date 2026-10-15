import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { COMMAND_VIEW_KEY, PATH_VIEW_KEY, commandLine, commandWords, readCommandView, readPathView, shortArgv, writeCommandView, writePathView } from '../../renderer/src/app/short-command.js';
import { BASE_ARGS } from '../../main/git/exec.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const git = (...argv) => ({ argv: [...BASE_ARGS, ...argv] });

// Every git call's prefix goes, whatever -c pairs it holds.
assert.equal(commandLine(git('status', '--porcelain=v2', '--branch', '-z'), true), '$ git status --porcelain=v2 --branch');
assert.equal(commandLine(git('--version'), true), '$ git --version');
assert.deepEqual(shortArgv(['-c', 'a=b', '--no-pager', '-c', 'x=y', 'log']), ['log']);
// Full is the exact argv.
assert.equal(commandLine(git('status'), false), `$ git ${BASE_ARGS.join(' ')} status`);

// The separator and literal pathspec magic are plumbing...
assert.equal(commandLine(git('branch', '-d', '--', 'ui-branch'), true), '$ git branch -d ui-branch');
assert.equal(commandLine(git('add', '--', ':(literal)src/a b.js'), true), '$ git add src/a b.js');
// ...except where `--` keeps a name that looks like an option a name.
assert.equal(commandLine(git('branch', '--', '-weird'), true), '$ git branch -- -weird');
assert.equal(commandLine(git('diff', '--'), true), '$ git diff');
// Long parser formats shrink; meaningful options stay.
assert.equal(commandLine(git('log', '--topo-order', '-z', '--format=%H%x00%P%x00%an', '--max-count=200'), true),
  '$ git log --topo-order --format=… --max-count=200');
assert.equal(commandLine(git('log', '--format=%h'), true), '$ git log --format=%h');
assert.equal(commandLine(git('reset', '--soft', '63888aa'), true), '$ git reset --soft 63888aa');
assert.equal(commandLine(git('diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD'), true), '$ git diff HEAD');
assert.equal(commandLine(git('push', '--progress', 'origin', '--', 'refs/tags/v1'), true), '$ git push origin refs/tags/v1');

// Full object ids shrink to git's short form; anything else hex-looking stays.
const oid = 'db9d8774d8a37faa78b9a8c77a7ee115ba856cba';
assert.equal(commandLine(git('cat-file', 'commit', oid), true), '$ git cat-file commit db9d877');
assert.equal(commandLine(git('cat-file', 'commit', oid), false).endsWith(oid), true);
assert.equal(commandLine(git('show', `${oid}^1`, 'deadbeef'), true), `$ git show ${oid}^1 deadbeef`);

// A program run by an automation is shown as it was configured.
assert.equal(commandLine({ executable: 'npm', argv: ['test', '--', '-z'] }, true), '$ npm test -- -z');
assert.deepEqual(shortArgv(null), []);
assert.equal(commandLine({}, true), '$ git ');

// Short by default; a broken storage does not break the console.
const memory = () => { const map = new Map(); return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value) }; };
const storage = memory();
assert.equal(readCommandView(storage), 'short');
writeCommandView(storage, 'full');
assert.equal(storage.getItem(COMMAND_VIEW_KEY), 'full');
assert.equal(readCommandView(storage), 'full');
writeCommandView(storage, 'nonsense');
assert.equal(readCommandView(storage), 'short');
const broken = { getItem() { throw new Error('no'); }, setItem() { throw new Error('no'); } };
assert.equal(readCommandView(broken), 'short');
writeCommandView(broken, 'full');
assert.equal(readCommandView(undefined), 'short');

// The path is hidden by default and remembered once shown.
const paths = memory();
assert.equal(readPathView(paths), false);
writePathView(paths, true);
assert.equal(paths.getItem(PATH_VIEW_KEY), 'show');
assert.equal(readPathView(paths), true);
writePathView(paths, false);
assert.equal(readPathView(paths), false);
assert.equal(readPathView(broken), false);
writePathView(broken, true);

// The line itself has no prompt: the console puts `$` or 🌱 in front.
assert.equal(commandWords(git('status'), true), 'git status');
assert.equal(commandLine(git('status'), true), `$ ${commandWords(git('status'), true)}`);

// Copy and the hover keep the exact command.
const consoleSource = await readFile(path.join(root, 'renderer/src/app/Console.jsx'), 'utf8');
assert.ok(consoleSource.includes('function commandText(entry) { return commandLine(entry, false); }'), 'commandText is the exact command');
assert.ok(consoleSource.includes('copy(`${commandText(entry)}'), 'Copy entry takes the exact command');
assert.ok(consoleSource.includes('{commandWords(entry, short)}</code>{showPath && <span>(cwd: {entry.cwd})</span>}'), 'the folder shows only when asked');
assert.ok(consoleSource.includes("`${commandText(entry)}\\n(cwd: ${entry.cwd})`"), 'the hover has the exact command and its folder');
// What 🌱 Twig runs on its own starts with 🌱; what the person asked for, with $.
assert.ok(consoleSource.includes("{isUserCommand(entry.operation) ? '$' : '🌱 :'}"));

console.log('Short console commands passed.');
