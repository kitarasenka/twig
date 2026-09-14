import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { FOCUS_WINDOW_MS, entryFinishedAt, pickFailedEntry } from '../../renderer/src/app/console-focus.js';

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

console.log('Console focus checks passed: newest failure, staleness window, running commands, render parity.');
