import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Anything but an explicit `true` means "only when I press the button". */
export function normalizeUpdateSettings(value) {
  return { auto: Boolean(value && typeof value === 'object' && value.auto === true) };
}

/**
 * The automatic update check consent, `updates.json` in userData. Main owns it
 * because main makes the request: a missing or damaged file means Off. Same
 * atomic write as `FetchStore` — memory changes only after the rename lands.
 */
export class UpdateStore {
  #file;
  #state = normalizeUpdateSettings(null);

  constructor(directory) { this.#file = path.join(directory, 'updates.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      this.#state = normalizeUpdateSettings(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalizeUpdateSettings(value);
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.get();
  }
}
