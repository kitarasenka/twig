import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { loadHistoryPage } from '../../main/git/history.js';
import { HistoryReadReplaced, createCommitReader, createHistoryStreams } from '../../main/git/history-stream.js';
import { pickFailedEntry } from '../../renderer/src/app/console-focus.js';

// The graph's pages come from one `git log` per repository instead of a new
// full walk for every page (`--skip`): on 100 000 commits without a
// commit-graph that took a page from 0.55 s to the cost of reading it.

// --- the reader, across chunk boundaries -----------------------------------------
const record = (oid, parents = '') => `${oid}\x00${parents}\x00Ada\x00ada@example.invalid\x002026-10-10T10:00:00+00:00\x002026-10-10T10:00:00+00:00\x00Subject\x00Body\nline\x00`;
const text = record('a'.repeat(40), 'b'.repeat(40)) + record('b'.repeat(40));
for (let cut = 0; cut <= text.length; cut += 7) {
  const reader = createCommitReader();
  const commits = [];
  reader.push(text.slice(0, cut), commit => commits.push(commit));
  reader.push(text.slice(cut), commit => commits.push(commit));
  reader.end();
  assert.deepEqual(commits.map(commit => commit.oid), ['a'.repeat(40), 'b'.repeat(40)], `cut at ${cut}`);
  assert.equal(commits[0].body, 'Body\nline');
}
const torn = createCommitReader();
torn.push(text.slice(0, 50), () => {});
assert.throws(() => torn.end(), /truncated/);

// --- on a real repository ----------------------------------------------------------
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-history-stream-'));
try {
  const cwd = path.join(root, 'repo');
  await mkdir(cwd);
  const git = (args, input) => {
    const result = spawnSync('git', args, { cwd, input, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q', '--initial-branch=main']);
  // 1300 commits: a main line and a branch merged back, in one fast-import.
  let stream = '';
  let mark = 0;
  const commit = (ref, parent, merge = null) => {
    mark += 1;
    const message = `Commit ${mark}\n`;
    stream += `commit ${ref}\nmark :${mark}\ncommitter Stream Check <stream@example.invalid> ${1700000000 + mark * 60} +0000\ndata ${Buffer.byteLength(message)}\n${message}`
      + `${parent ? `from :${parent}\n` : ''}${merge ? `merge :${merge}\n` : ''}M 100644 inline f${mark % 7}.txt\ndata ${String(mark).length + 1}\n${mark}\n\n`;
    return mark;
  };
  let main = commit('refs/heads/main', null);
  let side = null;
  for (let i = 0; i < 1299; i++) {
    if (i % 50 === 10) side = main;
    if (side && i % 50 > 10 && i % 50 < 30) side = commit('refs/heads/side', side);
    else if (side && i % 50 === 30) { main = commit('refs/heads/main', main, side); side = null; }
    else main = commit('refs/heads/main', main);
  }
  git(['fast-import', '--quiet'], stream);
  git(['checkout', '-q', '-f', 'main']);
  const total = Number(git(['rev-list', '--all', '--count']));

  const log = new CommandLog(path.join(root, 'journal'));
  await log.load();
  const reads = () => log.list().filter(entry => entry.operation === 'Read commit history');
  const expected = [];
  for (let skip = 0; skip !== null;) {
    const page = await loadHistoryPage({ cwd, log, skip, limit: 2000 });
    expected.push(...page.commits.map(item => item.oid));
    skip = page.nextSkip;
  }
  assert.equal(expected.length, total);

  // Every page continues the same read, in Git's own order.
  const timers = [];
  const streams = createHistoryStreams({ log, readAhead: 400, setTimer: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimer: () => {} });
  const before = reads().length;
  const got = [];
  for (let skip = 0, limit = 250; skip !== null; limit = limit === 250 ? 500 : 250) {
    const page = await streams.page({ cwd, skip, limit });
    got.push(...page.commits.map(item => item.oid));
    skip = page.nextSkip;
  }
  assert.deepEqual(got, expected, 'the pages are the history, in order');
  assert.equal(reads().length - before, 1, 'one git log for every page');
  assert.equal(streams.state(cwd), null, 'a read that is finished and handed out is gone');

  // Git is paused once enough commits wait, and goes on when a page needs them.
  await streams.page({ cwd, skip: 0, limit: 100 });
  const sessionEntry = reads().at(-1);
  for (let wait = 0; wait < 100 && !streams.state(cwd)?.paused; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  const paused = streams.state(cwd);
  assert.equal(paused.paused, true, 'paused with commits waiting');
  assert.ok(paused.waiting >= 400 && paused.waiting < total - 100, `read ahead, not to the end: ${paused.waiting}`);
  const next = await streams.page({ cwd, skip: 100, limit: 1000 });
  assert.equal(next.commits[0].oid, expected[100], 'and the read resumes for a page bigger than what waits');

  // A page asked out of order is read on its own and leaves the session alone.
  const delivered = streams.state(cwd).delivered;
  const elsewhere = await streams.page({ cwd, skip: 50, limit: 10 });
  assert.deepEqual(elsewhere.commits.map(item => item.oid), expected.slice(50, 60));
  assert.equal(streams.state(cwd).delivered, delivered);

  // A new read stops the old one: journaled as stopped by 🌱 Twig, not failed.
  await streams.page({ cwd, skip: 0, limit: 50 });
  const finished = () => log.list().find(entry => entry.id === sessionEntry.id);
  for (let wait = 0; wait < 200 && finished().state !== 'finished'; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  const stoppedRead = finished();
  assert.equal(stoppedRead.cancelled, true, 'the replaced read is marked stopped');
  assert.equal(log.outputOf(stoppedRead.id).stderr.includes('Stopped by 🌱 Twig: a newer read'), true);
  assert.equal(pickFailedEntry(log.list()), null, '"Show output" does not point at it');

  // A page still waiting on a read that gets replaced is refused as such.
  const waiting = streams.page({ cwd, skip: 50, limit: 10 });
  streams.close(cwd);
  await assert.rejects(waiting, HistoryReadReplaced);

  // Nobody asked for more for a while: the read stops, and the next page
  // starts a new one that catches up to where the graph was.
  await streams.page({ cwd, skip: 0, limit: 300 });
  timers.at(-1).run();
  assert.equal(streams.state(cwd), null, 'the idle read is stopped');
  const resumed = await streams.page({ cwd, skip: 300, limit: 200 });
  assert.deepEqual(resumed.commits.map(item => item.oid), expected.slice(300, 500), 'the next page continues where the graph was');

  // Git finished with the whole history read ahead, and nobody came back for
  // it: the buffered commits are released when the read goes idle.
  const allTimers = [];
  const whole = createHistoryStreams({ log, readAhead: 5000, setTimer: run => { allTimers.push(run); return allTimers.length; }, clearTimer: () => {} });
  await whole.page({ cwd, skip: 0, limit: 10 });
  for (let wait = 0; wait < 200 && !whole.state(cwd)?.done; wait++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(whole.state(cwd).done, true);
  assert.equal(whole.state(cwd).waiting, total - 10, 'everything else waits in the buffer');
  allTimers.at(-1)();
  assert.equal(whole.state(cwd), null, 'and is released once the read goes idle');

  // A failure is a failure.
  const plain = path.join(root, 'not-a-repo');
  await mkdir(plain);
  await assert.rejects(streams.page({ cwd: plain, skip: 0, limit: 10 }), /Git could not read commit history/);
  streams.close();
  console.log(`History stream checks passed: ${total} commits in one read, read-ahead pause, out-of-order pages, replaced and idle reads, failures.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
