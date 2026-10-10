import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { redactCredentials } from './git/redact.js';
import { removeStaleTemporaries, writeFileAtomic } from './json-file.js';
import { isUserCommand } from './command-source.js';

const MAX_ENTRIES = 2000;
// One Git command can print megabytes — a history page, a blame, a diff of a
// generated file. The console shows the beginning of it, which is what a human
// reads; keeping all of it would put the same megabytes in memory, in the
// renderer payload and in the journal file on every refresh. Real numbers: a
// 882 MB journal, of which 265 MB were `git log` pages replayed by refreshes.
const MAX_STREAM = 256 * 1024;
// 🌱 Twig's own reads — history pages, status, refs, the Undo checks — are
// most of the journal and are read back only when one failed. Their output is
// kept shorter, and it reaches the window only when someone opens the entry.
const BACKGROUND_STREAM = 32 * 1024;
const notice = cap => `\n… output truncated by 🌱 Twig at ${cap / 1024} KB.\n`;
// The journal is append-only during a session; past this much appended it is
// rewritten from the entries that are still kept, so the file cannot outgrow
// what the console can actually show.
const COMPACT_BYTES = 16 * 1024 * 1024;

const capOf = entry => (entry.background ? BACKGROUND_STREAM : MAX_STREAM);
/** Output as the journal keeps it: the first `cap` characters, and a notice that there was more. */
const keep = (text, cap) => (text.length > cap ? `${text.slice(0, cap)}${notice(cap)}` : text);

/**
 * An entry as the window gets it. The output of an automatic read is left out
 * (`lazy`: there is some, ask for it); everything a person ran comes whole.
 */
function publicEntry(entry) {
  const lazy = entry.background && Boolean(entry.stdout || entry.stderr);
  return {
    id: entry.id, argv: [...entry.argv], cwd: entry.cwd, operation: entry.operation,
    ...(entry.executable ? { executable: entry.executable } : {}),
    startedAt: entry.startedAt, ms: entry.ms, code: entry.code, state: entry.state, background: entry.background, cancelled: Boolean(entry.cancelled),
    stdout: entry.background ? '' : entry.stdout, stderr: entry.background ? '' : entry.stderr, lazy
  };
}

function startEvent(entry) {
  return {
    type: 'start',
    entry: {
      id: entry.id, argv: [...entry.argv], cwd: entry.cwd, operation: entry.operation,
      ...(entry.executable ? { executable: entry.executable } : {}), startedAt: entry.startedAt
    }
  };
}

export class CommandLog {
  #file;
  #entries = new Map();
  #listeners = new Set();
  #pending = Promise.resolve();
  // Events already applied in memory and not yet in the file. They are written
  // together, one append per burst instead of one per event.
  #lines = [];
  #flushing = false;
  #failed = false;
  // Set when a finished command's clean output replaced what had been streamed
  // (a credential split across two chunks): the next write rewrites the file,
  // so the pieces of the token do not stay in it until some later compaction.
  #scrub = false;
  // Bytes appended since the last compaction — not the file's total size. Kept
  // entries can themselves add up to more than COMPACT_BYTES (a page of `git log`
  // output alone can be past it); comparing against the total would then trip
  // compaction on every single append forever, turning each command into a full
  // rewrite of the journal.
  #appended = 0;

  constructor(directory) {
    this.#file = path.join(directory, 'command-log.jsonl');
  }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    await removeStaleTemporaries(this.#file);
    // Read line by line rather than in one string: a journal grown past V8's
    // 512 MB string limit would make `readFile` throw and the app never start.
    await new Promise((resolve, reject) => {
      const stream = createReadStream(this.#file, 'utf8');
      stream.on('error', (error) => (error.code === 'ENOENT' ? resolve() : reject(error)));
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      lines.on('error', () => {}); // The stream handler above decides; readline only echoes it.
      lines.on('line', (line) => {
        if (!line) return;
        try { this.#apply(JSON.parse(line), false); } catch { /* A torn final journal line is ignored. */ }
      });
      lines.on('close', resolve);
    });
    this.#trim();
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') void this.finish(entry.id, {
        code: -1, ms: Math.max(0, Date.now() - Date.parse(entry.startedAt)),
        stdout: entry.stdout, stderr: `${entry.stderr}Process ended when 🌱 Twig closed.\n`
      });
    }
    // Whatever the file held, the journal starts the session at the size of what
    // it kept — the entries above, nothing else. The rewrite runs behind the
    // launch instead of in front of the window; `settled()` waits for it.
    void this.#queue(() => this.#compact());
  }

  /** Resolves once everything recorded so far is in the file. */
  settled() { return this.#pending; }

  list() { return [...this.#entries.values()].slice(-MAX_ENTRIES).map(publicEntry); }

  /** The kept output of one entry, for the window to show when it is opened. */
  outputOf(id) {
    const entry = this.#entries.get(id);
    return entry ? { stdout: entry.stdout, stderr: entry.stderr } : null;
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Credentials inside URLs never reach the journal, the console or its file:
  // `git remote -v`, a fetch error or a typed `ls-remote https://token@…` would
  // otherwise store the token in plain text.
  start(entry) {
    return this.#record({ type: 'start', entry: { ...entry, argv: entry.argv.map(redactCredentials) } });
  }
  output(id, stream, chunk) { return this.#record({ type: 'output', id, stream, chunk: redactCredentials(chunk) }); }
  finish(id, result) {
    const clean = { ...result };
    for (const stream of ['stdout', 'stderr']) if (typeof result[stream] === 'string') clean[stream] = redactCredentials(result[stream]);
    if (Array.isArray(result.argv)) clean.argv = result.argv.map(redactCredentials);
    return this.#record({ type: 'finish', id, result: clean });
  }

  #queue(step) {
    // The journal on disk is best effort: one failed write (a full disk) must
    // not stop every write after it — nor, through `runGit`, every git command.
    this.#pending = this.#pending.then(step).catch(error => {
      if (!this.#failed) console.error('🌱 Twig could not write its command journal:', error.message);
      this.#failed = true;
    });
    return this.#pending;
  }

  /** Applies the event in memory and to the window now; the file follows in the next write. */
  #record(event) {
    const written = this.#apply(event, true);
    if (!written) return this.#pending; // The chunk was past the cap: nothing to remember, nothing to write.
    this.#lines.push(JSON.stringify(written));
    if (this.#flushing) return this.#pending;
    this.#flushing = true;
    return this.#queue(async () => {
      this.#flushing = false;
      if (!this.#lines.length) return;
      const text = `${this.#lines.join('\n')}\n`;
      this.#lines = [];
      await appendFile(this.#file, text, 'utf8');
      this.#appended += Buffer.byteLength(text);
      if (this.#appended > COMPACT_BYTES || this.#scrub) await this.#compact();
    });
  }

  /**
   * Applies one event to the kept entries. Returns the event to write to the
   * file (an output chunk may be clipped, a finish carries only what changed),
   * or null when nothing is kept. With `publish`, listeners get the event as
   * the window needs it: no output of automatic reads, no second copy of what
   * was already streamed.
   */
  #apply(event, publish) {
    let written = event;
    let published = event;
    if (event.type === 'start') {
      const entry = { ...event.entry, background: !isUserCommand(event.entry.operation), stdout: '', stderr: '', state: 'running', code: null, ms: null };
      this.#entries.set(entry.id, entry);
      published = { type: 'start', entry: { ...startEvent(entry).entry, background: entry.background } };
    }
    const entry = this.#entries.get(event.id);
    if (event.type === 'output') {
      if (!entry) return null;
      const chunk = this.#clip(entry, event.stream, event.chunk);
      if (!chunk) return null;
      entry[event.stream] += chunk;
      written = chunk === event.chunk ? event : { ...event, chunk };
      published = entry.background ? null : written;
    }
    if (event.type === 'finish') {
      if (!entry) return null;
      const { stdout, stderr, ...rest } = event.result;
      // The whole output, redacted at once, kept to the same cap as the stream
      // was: it differs from what was streamed only where a credential was split
      // across two chunks — then the clean copy replaces it — and only then is
      // it written and sent again.
      const changed = {};
      for (const [stream, text] of [['stdout', stdout], ['stderr', stderr]]) {
        if (typeof text !== 'string') continue;
        const kept = keep(text, capOf(entry));
        if (kept !== entry[stream]) changed[stream] = kept;
      }
      Object.assign(entry, rest, changed, { state: 'finished' });
      if (publish && Object.keys(changed).length) this.#scrub = true;
      // `cancelled`: 🌱 Twig stopped it (a newer search, a history read no longer
      // needed) — not a failure, and "Show output" must not point at it.
      const stoppedByTwig = entry.cancelled ? { cancelled: true } : {};
      written = { type: 'finish', id: event.id, result: { code: entry.code, ms: entry.ms, ...stoppedByTwig, ...changed } };
      published = entry.background
        ? { type: 'finish', id: event.id, result: { code: entry.code, ms: entry.ms, ...stoppedByTwig, lazy: Boolean(entry.stdout || entry.stderr) } }
        : written;
    }
    this.#trim();
    if (publish && published) for (const listener of this.#listeners) listener(published);
    return written;
  }

  #clip(entry, stream, chunk) {
    const cap = capOf(entry);
    const room = cap - entry[stream].length;
    if (room <= 0) return '';
    if (chunk.length <= room) return chunk;
    return `${chunk.slice(0, room)}${notice(cap)}`;
  }

  /** Rewrites the file as the shortest journal that replays into the entries kept right now. */
  async #compact() {
    // Everything recorded so far is in memory, so lines still waiting for their
    // write are part of this snapshot: they are dropped, not appended after it.
    this.#lines = [];
    this.#scrub = false;
    const lines = [];
    for (const entry of [...this.#entries.values()].slice(-MAX_ENTRIES)) {
      lines.push(JSON.stringify(startEvent(entry)));
      for (const stream of ['stdout', 'stderr']) {
        if (entry[stream]) lines.push(JSON.stringify({ type: 'output', id: entry.id, stream, chunk: entry[stream] }));
      }
      if (entry.state === 'finished') lines.push(JSON.stringify({ type: 'finish', id: entry.id, result: { code: entry.code, ms: entry.ms, ...(entry.cancelled ? { cancelled: true } : {}) } }));
    }
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    await writeFileAtomic(this.#file, text);
    this.#appended = 0;
  }

  #trim() {
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
  }
}
