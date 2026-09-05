import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ENTRIES = 2000;

function publicEntry(entry) {
  return {
    id: entry.id, argv: [...entry.argv], cwd: entry.cwd, operation: entry.operation,
    startedAt: entry.startedAt, ms: entry.ms, code: entry.code, stdout: entry.stdout,
    stderr: entry.stderr, state: entry.state
  };
}

export class CommandLog {
  #file;
  #entries = new Map();
  #listeners = new Set();
  #pending = Promise.resolve();

  constructor(directory) {
    this.#file = path.join(directory, 'command-log.jsonl');
  }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    let contents = '';
    try { contents = await readFile(this.#file, 'utf8'); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const line of contents.split('\n')) {
      if (!line) continue;
      try { this.#apply(JSON.parse(line), false); } catch { /* A torn final journal line is ignored. */ }
    }
    this.#trim();
    for (const entry of this.#entries.values()) {
      if (entry.state === 'running') await this.finish(entry.id, {
        code: -1, ms: Math.max(0, Date.now() - Date.parse(entry.startedAt)),
        stdout: entry.stdout, stderr: `${entry.stderr}Process ended when 🌱Twig closed.\n`
      });
    }
  }

  list() { return [...this.#entries.values()].slice(-MAX_ENTRIES).map(publicEntry); }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async start(entry) { await this.#record({ type: 'start', entry }); }
  async output(id, stream, chunk) { await this.#record({ type: 'output', id, stream, chunk }); }
  async finish(id, result) { await this.#record({ type: 'finish', id, result }); }

  async #record(event) {
    this.#pending = this.#pending.then(async () => {
      this.#apply(event, true);
      await appendFile(this.#file, `${JSON.stringify(event)}\n`, 'utf8');
    });
    return this.#pending;
  }

  #apply(event, publish) {
    if (event.type === 'start') this.#entries.set(event.entry.id, { ...event.entry, stdout: '', stderr: '', state: 'running', code: null, ms: null });
    const entry = this.#entries.get(event.id);
    if (event.type === 'output' && entry) entry[event.stream] += event.chunk;
    if (event.type === 'finish' && entry) Object.assign(entry, event.result, { state: 'finished' });
    this.#trim();
    if (publish) for (const listener of this.#listeners) listener(event, this.list());
  }

  #trim() {
    while (this.#entries.size > MAX_ENTRIES) this.#entries.delete(this.#entries.keys().next().value);
  }
}
