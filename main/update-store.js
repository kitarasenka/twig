import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';

/**
 * A saved choice wins; with none (no file, damaged file, no boolean) the
 * default applies — on for an installed copy, off when running from source.
 */
export function normalizeUpdateSettings(value, defaultAuto = false) {
  const saved = value && typeof value === 'object' ? value.auto : undefined;
  return { auto: typeof saved === 'boolean' ? saved : defaultAuto === true };
}

/**
 * The automatic update check setting, `updates.json` in userData. Main owns it
 * because main makes the request. An installed copy checks at launch unless the
 * person chose "Only when I ask"; from source (and in the smoke runs) a missing
 * or damaged file means Off. Same atomic write as `FetchStore` — memory changes
 * only after the rename lands.
 */
export class UpdateStore {
  #file;
  #defaultAuto;
  #state;

  constructor(directory, { defaultAuto = false } = {}) {
    this.#file = path.join(directory, 'updates.json');
    this.#defaultAuto = defaultAuto === true;
    this.#state = normalizeUpdateSettings(null, this.#defaultAuto);
  }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#state = normalizeUpdateSettings(await readJsonFile(this.#file), this.#defaultAuto);
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = { auto: Boolean(value && typeof value === 'object' && value.auto === true) };
    await writeFileAtomic(this.#file, JSON.stringify(next, null, 2));
    this.#state = next;
    return this.get();
  }
}
