import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { normalizeEditorSettings } from './editor.js';

/**
 * The external editor setting, `editor.json` in userData. It lives in main,
 * not in the renderer's localStorage, because it names a program to run: the
 * renderer may pick a preset, never supply a path. Same atomic write as
 * `RepositoryStore` — memory changes only after the rename lands.
 */
export class EditorStore {
  #file;
  #state = normalizeEditorSettings(null);

  constructor(directory) { this.#file = path.join(directory, 'editor.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#state = normalizeEditorSettings(await readJsonFile(this.#file));
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalizeEditorSettings(value);
    await writeFileAtomic(this.#file, JSON.stringify(next, null, 2));
    this.#state = next;
    return this.get();
  }
}
