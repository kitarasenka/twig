import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FOCUS_WINDOW_MS, entryFinishedAt, pickFailedEntry } from '../../renderer/src/app/console-focus.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (name) => readFile(path.join(root, name), 'utf8');

const now = Date.parse('2026-09-14T12:00:00Z');
const at = (secondsAgo, extra = {}) => ({ id: `e${secondsAgo}`, startedAt: new Date(now - secondsAgo * 1000).toISOString(), ms: 10, code: 0, ...extra });

assert.equal(entryFinishedAt({ startedAt: '2026-09-14T11:59:00Z', ms: 500 }), now - 59500);
assert.equal(entryFinishedAt({ startedAt: 'not a date', ms: 5 }), null);
assert.equal(entryFinishedAt({ startedAt: '2026-09-14T11:59:00Z', ms: null }), now - 60000);

// Nothing to point at.
assert.equal(pickFailedEntry([], now), null);
assert.equal(pickFailedEntry(null, now), null);
assert.equal(pickFailedEntry([at(1), at(2)], now), null);

// The newest failure wins, even when the reload that followed it succeeded.
const failed = at(3, { id: 'boom', code: 128 });
assert.equal(pickFailedEntry([at(9, { id: 'old', code: 1 }), failed, at(1), at(0)], now).id, 'boom');

// A command still running is not a failure yet.
assert.equal(pickFailedEntry([at(2, { id: 'running', code: null, ms: null })], now), null);

// An old failure is not the error the banner is showing: say nothing rather than guess.
assert.equal(pickFailedEntry([at(FOCUS_WINDOW_MS / 1000 + 5, { code: 1 })], now), null);
assert.equal(pickFailedEntry([at(FOCUS_WINDOW_MS / 1000 - 5, { id: 'fresh', code: 1 })], now).id, 'fresh');
// A newer success does not rescue an old failure.
assert.equal(pickFailedEntry([at(600, { code: 1 }), at(1)], now), null);
// An unreadable timestamp is not treated as recent.
assert.equal(pickFailedEntry([{ id: 'x', code: 1, startedAt: 'nonsense', ms: 1 }], now), null);

// Parity: the console renders the class this module's target gets, and App feeds it.
const console_ = await read('renderer/src/app/Console.jsx');
assert.ok(console_.includes("focusedId === entry.id ? 'focused' : ''"), 'Console marks the focused entry');
assert.ok(console_.includes('scrollIntoView'), 'Console scrolls the focused entry into view');
const css = await read('renderer/src/ui/layout.css');
assert.ok(/\.console-entry\.focused\s*\{/.test(css), 'layout.css styles the focused entry');
const app = await read('renderer/src/app/App.jsx');
assert.ok(app.includes('pickFailedEntry(entriesRef.current)'), 'App picks the failed entry from the freshest journal');
assert.ok(!/onConsole=\{\(\) => setConsoleOpen\(true\)\}/.test(app), 'every "Show output" path goes through showConsole');

// --- what the "My" filter keeps -------------------------------------------
// Commands a person asked for.
for (const label of ['Console command', 'Commit', 'Amend the last commit', 'Check out branch', 'Check out commit',
  'Create and check out branch', 'Merge', 'Rebase', 'Cherry-pick', 'Revert', 'Reset --hard', 'Stage file',
  'Stage all tracked changes', 'Unstage everything', 'Stash changes', 'Pop stash', 'Delete branch',
  'Delete tag v1', 'Rename branch a to b', 'Remote push: origin', 'Fetch and prune: origin', 'Clone repository',
  'Blame file', 'Reverse blame file', 'Mark conflict resolved', 'Take ours version', 'Undo commit',
  'Automation: npm test', 'Generate SSH key', 'Update global Git profile: user.name']) {
  assert.equal(isUserCommand(label), true, `"${label}" is something the user did`);
}
// Commands 🌱 Twig runs for itself: they belong in Full History only.
for (const label of ['Background: check Git installation', 'Background: read working tree status',
  'Read commit history', 'Read branches and tags', 'Read working tree', 'Read remotes', 'Read file history',
  'Read conflict stage 2', 'Read staged diff', 'Read the commit being amended', 'Resolve commit id',
  'Resolve blame revision', 'Verify repository', 'Check file at start', 'Check reverse-blame range',
  'Search commit history', 'Seed demo workspace']) {
  assert.equal(isUserCommand(label), false, `"${label}" is the app's own command`);
}
// A missing label is not a reason to hide the entry: an unnamed command still ran.
assert.equal(isUserCommand(undefined), true);
assert.equal(isUserCommand(''), true);

// Parity: every operation label main gives runGit is classified deliberately —
// a new automatic read must not silently land in "My".
const main = await Promise.all(['main/git/history.js', 'main/git/refs.js', 'main/git/worktree.js', 'main/git/commit.js',
  'main/git/repository.js', 'main/git/blame.js'].map(read));
for (const source of main) {
  for (const [, label] of source.matchAll(/operation: '([^']+)'/g)) {
    const automatic = label.startsWith('Background') || label.startsWith('Read ') || label.startsWith('Resolve ')
      || label.startsWith('Verify ') || label.startsWith('Check ') || label.startsWith('Search ');
    if (automatic && label !== 'Check out branch') {
      assert.equal(isUserCommand(label), false, `"${label}" reads state and belongs in Full History`);
    }
  }
}

// Parity: the console renders the two named filters and starts on "My".
assert.ok(console_.includes("useState('mine')"), 'the console opens on My');
assert.ok(console_.includes('>Full History<') && console_.includes('>My<'), 'the filters are named Full History and My');
assert.ok(console_.includes('isUserCommand(entry.operation)'), 'the console filters through the shared rule');
// The toolbar no longer carries a second switch for the console.
assert.ok(!/>Terminal</.test(app), 'the toolbar has no Terminal button');

console.log('Console focus checks passed: newest failure, staleness window, running commands, My/Full History split, render parity.');
