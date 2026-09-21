import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class RepositoryStore {
  #file;
  #state = { repositories: [], activeId: null, sandboxHidden: false };

  constructor(directory) { this.#file = path.join(directory, 'repositories.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      // `sandboxHidden` arrived later than this file: anything but an explicit
      // `true` means the demo tab is open, so older files keep working.
      if (Array.isArray(value.repositories) && (typeof value.activeId === 'string' || value.activeId === null)) {
        this.#state = { repositories: value.repositories, activeId: value.activeId, sandboxHidden: value.sandboxHidden === true };
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.snapshot();
  }

  snapshot() {
    return {
      repositories: this.#state.repositories.map(repository => ({ ...repository })),
      activeId: this.#state.activeId,
      sandboxHidden: this.#state.sandboxHidden
    };
  }

  /** `sandboxHidden` defaults to the stored value so ordinary saves never flip it. */
  async save(repositories, activeId, sandboxHidden = this.#state.sandboxHidden) {
    const next = { repositories, activeId, sandboxHidden: sandboxHidden === true };
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.snapshot();
  }
}
