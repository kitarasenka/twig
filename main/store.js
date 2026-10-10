import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';

// Only what identifies a connected repository goes to disk. Whether it is
// available and its `git status` are read afresh on every launch — writing
// them meant every changed file's path of every repository, rewritten on
// every tab switch.
const persisted = ({ id, path: location, name }) => ({ id, path: location, name });

export class RepositoryStore {
  #file;
  #state = { repositories: [], activeId: null, sandboxHidden: false };

  constructor(directory) { this.#file = path.join(directory, 'repositories.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const value = await readJsonFile(this.#file);
    // `sandboxHidden` arrived later than this file: anything but an explicit
    // `true` means the demo tab is open, so older files keep working.
    if (value && Array.isArray(value.repositories) && (typeof value.activeId === 'string' || value.activeId === null)) {
      this.#state = { repositories: value.repositories.map(persisted), activeId: value.activeId, sandboxHidden: value.sandboxHidden === true };
    }
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
    await writeFileAtomic(this.#file, JSON.stringify({ ...next, repositories: repositories.map(persisted) }, null, 2));
    this.#state = next;
    return this.snapshot();
  }
}
