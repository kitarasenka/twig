import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { backgroundFetch } from '../../main/git/sync.js';
import { UndoService } from '../../main/undo.js';
import { createCommit } from '../../main/git/commit-ops.js';
import { FetchStore } from '../../main/fetch-store.js';
import { BACKGROUND_FETCH_ARGV, FETCH_INTERVALS, FIRST_FETCH_DELAY, RETRY_DELAY, createFetchScheduler, normalizeFetchSettings } from '../../main/background-fetch.js';
import { fetchExplanation, fetchStatusLine, intervalLabel, pullTitle } from '../../renderer/src/app/background-fetch-view.js';
import { isUserCommand } from '../../renderer/src/app/command-source.js';

// --- the consent ----------------------------------------------------------------------------
assert.deepEqual(normalizeFetchSettings(null), { interval: 0 }, 'no file means Off');
assert.deepEqual(normalizeFetchSettings({ interval: 7 }), { interval: 0 }, 'an interval outside the list means Off');
assert.deepEqual(normalizeFetchSettings({ interval: 15 }), { interval: 15 });
assert.equal(FETCH_INTERVALS[0], 0);
assert.deepEqual(BACKGROUND_FETCH_ARGV, ['fetch', '--all', '--no-tags', '--no-recurse-submodules'],
  'only remote-tracking branches move: no tags, no prune, no submodules');
assert.equal(isUserCommand('Background: fetch all remotes'), false, 'the console lists it under Full History, not My');

// --- the schedule, on a fake clock ------------------------------------------------------------
function harness({ busy = () => false } = {}) {
  let clock = 1_000_000;
  let next = 1;
  const timers = new Map();
  const runs = [];
  let respond = null;
  const scheduler = createFetchScheduler({
    now: () => clock,
    setTimer: (fn, ms) => { const id = next++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: id => timers.delete(id),
    isBusy: busy,
    run: (cwd, signal) => new Promise(resolve => { runs.push({ cwd, signal }); respond = resolve; })
  });
  return {
    scheduler, runs, timers,
    get clock() { return clock; },
    pending: () => [...timers.values()].map(timer => timer.at - clock),
    async advance(ms) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
    async finish(result) { respond(result); await new Promise(resolve => setImmediate(resolve)); }
  };
}

{
  const h = harness();
  h.scheduler.follow('/repo');
  assert.equal(h.timers.size, 0, 'Off means no timer at all, even with a repository open');
  h.scheduler.configure(15);
  assert.deepEqual(h.pending(), [FIRST_FETCH_DELAY], 'turned on: the open repository is fetched a few seconds later');
  await h.advance(FIRST_FETCH_DELAY);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].cwd, '/repo');
  assert.equal(h.scheduler.status('/repo').running, true);
  assert.equal(h.timers.size, 0, 'no second fetch is armed while one runs');
  await h.finish({ ok: true });
  const status = h.scheduler.status('/repo');
  assert.equal(status.lastSuccess, h.clock); assert.equal(status.error, null); assert.equal(status.interval, 15);
  assert.deepEqual(h.pending(), [15 * 60_000], 'the next one is a full interval away');
  await h.advance(15 * 60_000);
  await h.finish({ ok: false, message: 'Fetch failed: Could not resolve host' });
  assert.equal(h.scheduler.status('/repo').error, 'Fetch failed: Could not resolve host');
  assert.deepEqual(h.pending(), [15 * 60_000], 'a failure waits for the next interval instead of retrying in a loop');

  h.scheduler.follow('/other');
  assert.deepEqual(h.pending(), [FIRST_FETCH_DELAY], 'only the active repository is fetched; a new one soon after it opens');
  h.scheduler.follow('/repo');
  assert.ok(h.pending()[0] <= 15 * 60_000, 'switching back keeps the old schedule');
  h.scheduler.follow(null);
  assert.equal(h.timers.size, 0, 'no repository open, no timer');
  h.scheduler.follow('/repo');
  h.scheduler.configure(0);
  assert.equal(h.timers.size, 0, 'turned off: the timer is gone');
  assert.equal(h.scheduler.status('/repo').interval, 0);
}

{
  let busy = true;
  const h = harness({ busy: () => busy });
  h.scheduler.configure(5); h.scheduler.follow('/repo');
  await h.advance(FIRST_FETCH_DELAY);
  assert.equal(h.runs.length, 0, 'no fetch starts while the person’s action runs on that repository');
  assert.deepEqual(h.pending(), [RETRY_DELAY]);
  busy = false;
  await h.advance(RETRY_DELAY);
  assert.equal(h.runs.length, 1);
  h.scheduler.cancel('/repo');
  assert.equal(h.runs[0].signal.aborted, true, 'an action that starts cancels the running fetch');
  await h.finish({ ok: false, cancelled: true });
  assert.equal(h.scheduler.status('/repo').lastAttempt, null, 'a cancelled fetch does not count as an attempt');
  assert.deepEqual(h.pending(), [RETRY_DELAY], 'and it tries again a minute later');
  await h.advance(RETRY_DELAY);
  h.scheduler.configure(0);
  assert.equal(h.runs[1].signal.aborted, true, 'turning it off stops a fetch in flight');
  h.scheduler.stop();
}

// --- the words --------------------------------------------------------------------------------
assert.equal(intervalLabel(0), 'Off');
assert.equal(intervalLabel(15), 'Every 15 minutes');
assert.equal(intervalLabel(60), 'Every hour');
assert.match(fetchExplanation(0), /does not reach the network by itself/);
assert.match(fetchExplanation(30), /git fetch --all --no-tags .* every 30 minutes/);
assert.match(fetchExplanation(30), /only network access/);
assert.equal(fetchStatusLine({ interval: 0 }), '');
assert.equal(fetchStatusLine({ interval: 5, running: true }), 'Fetching now…');
assert.equal(fetchStatusLine({ interval: 5, lastSuccess: 1_000_000, running: false, error: null }, 1_000_000 + 180_000), 'Last fetched 3 minutes ago.');
assert.equal(fetchStatusLine({ interval: 5, error: 'Fetch failed: offline' }), 'Fetch failed: offline');
assert.match(pullTitle(null), /last fetch knew/);
assert.match(pullTitle({ interval: 5, lastSuccess: 1_000_000 }, 1_000_000 + 7_200_000), /remote checked 2 hours ago/);

// --- the store, and a real fetch -------------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-fetch-'));
try {
  const store = new FetchStore(root);
  assert.deepEqual(await store.load(), { interval: 0 }, 'a first start is Off');
  await store.save({ interval: 30 });
  assert.deepEqual(await new FetchStore(root).load(), { interval: 30 }, 'the choice survives a restart');
  await writeFile(path.join(root, 'background-fetch.json'), '{ broken');
  assert.deepEqual(await new FetchStore(root).load(), { interval: 0 }, 'a damaged file means Off');

  const log = new CommandLog(root); await log.load();
  const run = async (cwd, argv) => { const result = await runGit({ cwd, log, argv }); assert.equal(result.code, 0, result.stderr); return result.stdout.trim(); };
  const remote = path.join(root, 'remote.git');
  await run(root, ['init', '--bare', '--initial-branch=main', remote]);
  const configure = async cwd => { for (const [key, value] of [['user.name', 'Twig Test'], ['user.email', 'test@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await run(cwd, ['config', key, value]); };
  const other = path.join(root, 'other'); await mkdir(other);
  await run(other, ['init', '--initial-branch=main']); await configure(other);
  await writeFile(path.join(other, 'app.txt'), 'one\n'); await run(other, ['add', 'app.txt']); await run(other, ['commit', '-m', 'One']);
  await run(other, ['remote', 'add', 'origin', remote]); await run(other, ['push', '-u', 'origin', 'main']);
  const cwd = path.join(root, 'mine');
  await run(root, ['clone', remote, cwd]); await configure(cwd);

  // Local work with an Undo chain, then someone else pushes a commit and a tag.
  const undo = new UndoService({ directory: root, log }); await undo.load();
  await writeFile(path.join(cwd, 'draft.txt'), 'uncommitted\n');
  await writeFile(path.join(cwd, 'mine.txt'), 'mine\n'); await run(cwd, ['add', 'mine.txt']);
  await undo.perform(cwd, 'worktree:commit', [], () => createCommit({ cwd, log, message: 'Mine' }));
  const head = await run(cwd, ['rev-parse', 'HEAD']);
  await writeFile(path.join(other, 'app.txt'), 'two\n'); await run(other, ['commit', '-am', 'Two']);
  await run(other, ['tag', 'v1']); await run(other, ['push', 'origin', 'main', 'v1']);
  const theirs = await run(other, ['rev-parse', 'HEAD']);

  const result = await backgroundFetch({ cwd, log });
  assert.deepEqual(result, { ok: true, cancelled: false, message: null });
  assert.equal(await run(cwd, ['rev-parse', 'origin/main']), theirs, 'the remote-tracking branch moved');
  assert.equal(await run(cwd, ['rev-parse', 'HEAD']), head, 'HEAD and the local branch did not');
  assert.equal(await run(cwd, ['tag', '--list']), '', 'no tag came in behind the person’s back');
  assert.equal(await readFile(path.join(cwd, 'draft.txt'), 'utf8'), 'uncommitted\n');
  assert.equal(await run(cwd, ['rev-list', '--count', 'HEAD..origin/main']), '1', 'so the Pull badge can say 1');
  assert.equal((await undo.inspect(cwd)).undo, true, 'a fetch that only moved remote-tracking refs keeps the Undo chain');
  assert.ok(log.list().some(entry => entry.operation === 'Background: fetch all remotes'), 'it is journaled like every other command');

  const cancelled = new AbortController(); cancelled.abort();
  assert.equal((await backgroundFetch({ cwd, log, signal: cancelled.signal })).cancelled, true);

  await run(cwd, ['remote', 'add', 'broken', 'https://someone:s3cret-token@127.0.0.1:9/nothing.git']);
  const failed = await backgroundFetch({ cwd, log });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /^Fetch failed: /);
  assert.ok(!failed.message.includes('s3cret-token'), 'a credential in a remote URL never reaches the Settings line');
} finally { await rm(root, { recursive: true, force: true }); }

console.log('Background fetch checks passed: Off by default, one timer only while on, active repository only, gives way to actions, cancel, failure spacing, words, store, real fetch moves only remote-tracking refs, Undo chain kept, credentials hidden.');
