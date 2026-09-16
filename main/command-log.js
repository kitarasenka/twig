import { createReadStream } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';

const MAX_ENTRIES = 2000;
// One Git command can print megabytes — a history page, a blame, a diff of a
// generated file. The console shows the beginning of it, which is what a human
// reads; keeping all of it would put the same megabytes in memory, in the
// renderer payload and in the journal file on every refresh. Real numbers: a
// 882 MB journal, of which 265 MB were `git log` pages replayed by refreshes.
const MAX_STREAM = 256 * 1024;
const TRUNCATED = '\n… output truncated by 🌱 Twig at 256 KB.\n';
// The journal is append-only during a session; past this much appended it is
// rewritten from the entries that are still kept, so the file cannot outgrow
// what the console can actually show.
const COMPACT_BYTES = 16 * 1024 * 1024;

function publicEntry(entry) {
  return {
    id: entry.id, argv: [...entry.argv], cwd: entry.cwd, operation: entry.operation,
    ...(entry.executable ? { executable: entry.executable } : {}),
    startedAt: entry.startedAt, ms: entry.ms, code: entry.code, stdout: entry.stdout,
    stderr: entry.stderr, state: entry.state
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
      if (entry.state === 'running') await this.finish(entry.id, {
        code: -1, ms: Math.max(0, Date.now() - Date.parse(entry.startedAt)),
        stdout: entry.stdout, stderr: `${entry.stderr}Process ended when 🌱 Twig closed.\n`
      });
    }
    // Whatever the file held, the journal starts the session at the size of what
    // it kept — the entries above, nothing else.
    await this.#queue(() => this.#compact());
  }

  list() { return [...this.#entries.values()].slice(-MAX_ENTRIES).map(publicEntry); }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(entry) { await this.#record({ type: 'start', entry }); }
  async output(id, stream, chunk) { await this.#record({ type: 'output', id, stream, chunk }); }
  async finish(id, result) { await this.#record({ type: 'finish', id, result }); }

  #queue(step) {
    this.#pending = this.#pending.then(step);
    return this.#pending;
  }

  async #record(event) {
    return this.#queue(async () => {
      const stored = this.#apply(event, true);
      if (!stored) return; // The chunk was past the cap: nothing to remember, nothing to write.
      const line = `${JSON.stringify(stored)}\n`;
      await appendFile(this.#file, line, 'utf8');
      this.#appended += Buffer.byteLength(line);
      if (this.#appended > COMPACT_BYTES) await this.#compact();
    });
  }

  /** Returns the event as it was stored (an output chunk may be clipped), or null when it was dropped. */
  #apply(event, publish) {
    let stored = event;
    if (event.type === 'start') this.#entries.set(event.entry.id, { ...event.entry, stdout: '', stderr: '', state: 'running', code: null, ms: null });
    const entry = this.#entries.get(event.id);
    if (event.type === 'output') {
      if (!entry) return null;
      const chunk = this.#clip(entry, event.stream, event.chunk);
      if (!chunk) return null;
      entry[event.stream] += chunk;
      stored = chunk === event.chunk ? event : { ...event, chunk };
    }
    if (event.type === 'finish') {
      if (!entry) return null;
      Object.assign(entry, event.result, { state: 'finished' });
      entry.stdout = entry.stdout.slice(0, MAX_STREAM + TRUNCATED.length);
      entry.stderr = entry.stderr.slice(0, MAX_STREAM + TRUNCATED.length);
      stored = { ...event, result: { ...event.result, stdout: entry.stdout, stderr: entry.stderr } };
    }
    this.#trim();
    // `list()` copies every kept entry's full stdout/stderr (up to 256 KB each) — too
    // expensive to build on every streamed output chunk when no listener asks for it.
    if (publish) for (const listener of this.#listeners) listener(stored);
    return stored;
  }

  #clip(entry, stream, chunk) {
    const room = MAX_STREAM - entry[stream].length;
    if (room <= 0) return '';
    if (chunk.length <= room) return chunk;
    return `${chunk.slice(0, room)}${TRUNCATED}`;
  }

  /** Rewrites the file as the shortest journal that replays into the entries kept right now. */
  async #compact() {
    const lines = [];
    for (const entry of [...this.#entries.values()].slice(-MAX_ENTRIES)) {
      lines.push(JSON.stringify(startEvent(entry)));
      for (const stream of ['stdout', 'stderr']) {
        if (entry[stream]) lines.push(JSON.stringify({ type: 'output', id: entry.id, stream, chunk: entry[stream] }));
      }
      if (entry.state === 'finished') lines.push(JSON.stringify({ type: 'finish', id: entry.id, result: { code: entry.code, ms: entry.ms } }));
    }
    const text = lines.length ? `${lines.join('\n')}\n` : '';
    const temporary = `${this.#file}.tmp`;
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, this.#file);
    this.#appended = 0;
  }

  #trim() {
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
  }
}
