import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
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
    try {
      this.#state = normalizeEditorSettings(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalizeEditorSettings(value);
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.get();
  }
}
