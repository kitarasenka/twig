import { streamGit } from './exec.js';
import { buildHistoryStreamArgv, loadHistoryPage } from './history.js';
import { HISTORY_FIELD_COUNT, commitFromFields } from './history-parser.js';

/**
 * The history graph's pages, read from one `git log` per repository.
 *
 * Paging with `--skip` made Git walk and sort the whole history again for
 * every page: on 100 000 commits without a commit-graph each page cost 0.55 s
 * whatever it held, restoring eight pages took 4 s and following a sidebar
 * click to an old tag took 3.5 minutes — while the whole history in
 * topological order is one 0.8 s read. Here a page asking to start over
 * (skip 0) opens one read, and the pages after it continue the same read. Git
 * is paused once enough commits wait (the pipe fills and Git sleeps), resumed
 * when a page needs more, and stopped when a new read replaces it or nobody
 * has asked for more for a while — journaled as stopped by 🌱 Twig, not as a
 * failure. A page asked for out of order (a reader that is not this session)
 * is read the old way and leaves the session alone.
 *
 * No imports from Electron: the Node check drives it directly.
 */

/** Commits read ahead before Git is paused. */
export const READ_AHEAD = 3000;
/**
 * A read nobody has asked anything of for this long is stopped; the next page
 * starts over. Short on purpose: the read-ahead covers ordinary scrolling, a
 * paused `git log` holds the commit graph in memory, and the console shows it
 * as running until it ends.
 */
export const IDLE_MS = 10_000;

const SUPERSEDED = 'Stopped by 🌱 Twig: a newer read of this history replaced it.\n';
const IDLE = 'Stopped by 🌱 Twig: no more of this history was asked for.\n';

/** A page asked of a read that was replaced meanwhile. The reader that asked has moved on too. */
export class HistoryReadReplaced extends Error {
  constructor() { super('This history read was replaced by a newer one.'); this.name = 'HistoryReadReplaced'; }
}

/** Splits streamed text into commits: eight NUL-terminated fields each, across chunk boundaries. */
export function createCommitReader() {
  // The text after the last NUL, in the pieces it came in: joined once a NUL
  // arrives, not on every chunk (a message of megabytes would be copied over
  // and over).
  let pending = [];
  let fields = [];
  return {
    push(text, onCommit) {
      if (!text.includes('\0')) { pending.push(text); return; }
      const parts = text.split('\0');
      parts[0] = pending.join('') + parts[0];
      pending = [parts.pop()];
      for (const part of parts) {
        fields.push(part);
        if (fields.length === HISTORY_FIELD_COUNT) { onCommit(commitFromFields(fields)); fields = []; }
      }
    },
    /** Throws when the text ended inside a commit. */
    end() { if (pending.join('') || fields.length) throw new Error('truncated history record'); }
  };
}

/**
 * @param {{ log: import('../command-log.js').CommandLog, readAhead?: number, idleMs?: number,
 *   setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} options
 */
export function createHistoryStreams({ log, readAhead = READ_AHEAD, idleMs = IDLE_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const streams = new Map();

  const waiting = stream => stream.queue.length - stream.head;
  // Where the next page of a read starts: what it has handed out plus what
  // pages already asked of it will take.
  const nextStart = stream => stream.delivered + stream.promised;
  const wake = stream => { for (const waiter of stream.waiters) waiter(); stream.waiters.clear(); };

  function stop(stream, note) {
    clearTimer(stream.timer);
    stream.replaced = true;
    if (!stream.done) stream.git.stop(note);
    wake(stream);
    if (streams.get(stream.cwd) === stream) streams.delete(stream.cwd);
  }

  function open(cwd) {
    const previous = streams.get(cwd);
    if (previous) stop(previous, SUPERSEDED);
    const stream = { cwd, queue: [], head: 0, delivered: 0, promised: 0, done: false, failure: null, replaced: false, paused: false,
      waiters: new Set(), timer: null, chain: Promise.resolve(), reader: createCommitReader() };
    stream.git = streamGit({
      argv: buildHistoryStreamArgv(), cwd, log, operation: 'Read commit history',
      onData: text => {
        if (stream.failure) return;
        try { stream.reader.push(text, commit => stream.queue.push(commit)); }
        catch (error) { stream.failure = error; stream.git.stop('Stopped by 🌱 Twig: the history could not be read.\n'); }
        if (!stream.paused && waiting(stream) >= readAhead) { stream.paused = true; stream.git.pause(); }
        wake(stream);
      },
      onEnd: ({ code, cancelled }) => {
        stream.done = true;
        if (!cancelled && !stream.failure) {
          if (code !== 0) stream.failure = new Error('Git could not read commit history.');
          else try { stream.reader.end(); } catch (error) { stream.failure = error; }
        }
        wake(stream);
      }
    });
    streams.set(cwd, stream);
    return stream;
  }

  /** Resolves once `count` commits wait, or the read ended, failed or was replaced. */
  async function enough(stream, count) {
    while (waiting(stream) < count && !stream.done && !stream.failure && !stream.replaced) {
      if (stream.paused) { stream.paused = false; stream.git.resume(); }
      await new Promise(resolve => stream.waiters.add(resolve));
    }
  }

  function take(stream, count) {
    const commits = stream.queue.slice(stream.head, stream.head + count);
    stream.head += commits.length;
    stream.delivered += commits.length;
    if (stream.head > 4096) { stream.queue = stream.queue.slice(stream.head); stream.head = 0; }
    return commits;
  }

  // Also once Git has finished: the commits read ahead are released when
  // nobody comes back for them.
  function touch(stream) {
    clearTimer(stream.timer);
    stream.timer = setTimer(() => stop(stream, IDLE), idleMs);
  }

  async function serve(stream, skip, limit) {
    if (stream.replaced) throw new HistoryReadReplaced();
    // Started over after an idle stop: read up to where the graph is.
    while (stream.delivered < skip) {
      await enough(stream, Math.min(readAhead, skip - stream.delivered));
      if (stream.replaced) throw new HistoryReadReplaced();
      if (stream.failure) throw stream.failure;
      if (!waiting(stream)) return { commits: [], nextSkip: null };
      take(stream, Math.min(waiting(stream), skip - stream.delivered));
    }
    await enough(stream, limit);
    if (stream.replaced) throw new HistoryReadReplaced();
    if (stream.failure) throw stream.failure;
    const commits = take(stream, limit);
    const finished = stream.done && !waiting(stream);
    if (finished) { clearTimer(stream.timer); if (streams.get(stream.cwd) === stream) streams.delete(stream.cwd); }
    else touch(stream);
    return { commits, nextSkip: finished || commits.length < limit ? null : stream.delivered };
  }

  return {
    /**
     * One page: `skip` 0 starts a new read of the repository's history, and
     * each page after it continues where the last one ended.
     * @param {{ cwd: string, skip: number, limit: number }} request
     */
    page({ cwd, skip, limit }) {
      let stream = streams.get(cwd);
      if (skip === 0 || !stream) stream = open(cwd);
      else if (nextStart(stream) !== skip) return loadHistoryPage({ cwd, log, skip, limit });
      // Pages of one read are served in the order they were asked for.
      stream.promised += limit;
      const run = stream.chain.then(() => serve(stream, skip, limit)).finally(() => { stream.promised -= limit; });
      stream.chain = run.catch(() => {});
      return run;
    },
    /** Stops every read of `cwd` (a removed repository), or of every repository. */
    close(cwd = null) {
      for (const stream of [...streams.values()]) if (cwd === null || stream.cwd === cwd) stop(stream, IDLE);
    },
    /** For the check: whether a read of `cwd` is open, and whether Git is paused. */
    state(cwd) {
      const stream = streams.get(cwd);
      return stream ? { delivered: stream.delivered, waiting: waiting(stream), paused: stream.paused, done: stream.done } : null;
    }
  };
}
