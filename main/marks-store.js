import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Atomic JSON store for local commit marks, one file for every repository:
 * `{ [repoId]: { [oid]: { color, note, updatedAt } } }`. Writes are serialised
 * and memory changes only after the rename lands, the same contract as
 * `RepositoryStore`.
 */
export class MarksStore {
  #file;
  #state = {};
  #pending = Promise.resolve();

  constructor(directory) { this.#file = path.join(directory, 'marks.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  list(repoId) { return { ...this.#state[repoId] }; }

  #write(mutate) {
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      const repoId = mutate(state);
      const temporary = `${this.#file}.next`;
      await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await rename(temporary, this.#file);
      this.#state = state;
      return this.list(repoId);
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  set(repoId, oid, mark) {
    return this.#write(state => {
      (state[repoId] ||= {})[oid] = { ...mark, updatedAt: new Date().toISOString() };
      return repoId;
    });
  }

  clear(repoId, oid) {
    return this.#write(state => {
      if (state[repoId]) {
        delete state[repoId][oid];
        if (!Object.keys(state[repoId]).length) delete state[repoId];
      }
      return repoId;
    });
  }
}
