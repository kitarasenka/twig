import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
    try {
      this.#state = normalizeUpdateSettings(JSON.parse(await readFile(this.#file, 'utf8')), this.#defaultAuto);
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = { auto: Boolean(value && typeof value === 'object' && value.auto === true) };
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.get();
  }
}
