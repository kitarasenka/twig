import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export class RepositoryStore {
  #file;
  #state = { repositories: [], activeId: null };

  constructor(directory) { this.#file = path.join(directory, 'repositories.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      if (Array.isArray(value.repositories) && (typeof value.activeId === 'string' || value.activeId === null)) this.#state = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return this.snapshot();
  }

  snapshot() { return { repositories: this.#state.repositories.map(repository => ({ ...repository })), activeId: this.#state.activeId }; }

  async save(repositories, activeId) {
    const next = { repositories, activeId };
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.snapshot();
  }
}
