import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { normalizeFetchSettings } from './background-fetch.js';

/**
 * The background-fetch consent, `background-fetch.json` in userData. It lives
 * in main because main runs the fetch: a missing or damaged file means Off,
 * and nothing but the Settings choice turns it on. Same atomic write as
 * `EditorStore` — memory changes only after the rename lands.
 */
export class FetchStore {
  #file;
  #state = normalizeFetchSettings(null);

  constructor(directory) { this.#file = path.join(directory, 'background-fetch.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#state = normalizeFetchSettings(await readJsonFile(this.#file));
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalizeFetchSettings(value);
    await writeFileAtomic(this.#file, JSON.stringify(next, null, 2));
    this.#state = next;
    return this.get();
  }
}
