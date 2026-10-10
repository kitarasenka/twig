import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';

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
    const value = await readJsonFile(this.#file);
    if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
  }

  list(repoId) { return { ...this.#state[repoId] }; }

  #write(mutate) {
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      const repoId = mutate(state);
      await writeFileAtomic(this.#file, JSON.stringify(state, null, 2));
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

  /** Drop every mark for a repository — used when the demo sandbox is reset. */
  forget(repoId) {
    return this.#write(state => { delete state[repoId]; return repoId; });
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
