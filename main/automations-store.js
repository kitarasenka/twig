import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeConfig } from '../renderer/src/features/automations/schema.js';

/**
 * Atomic JSON store for local automation config, one file for every repository:
 * `{ [repoId]: { config, trust } }`. Same contract as `MarksStore` — writes are
 * serialised and memory changes only after the rename lands.
 *
 * `config` is the pipelines the user built inside Twig (trusted by
 * construction). `trust` records which parts of a repository-provided
 * `.twig/hooks.json` the user has explicitly enabled:
 * `{ digest, approvedCommands: string[], enabledRepoPipelineIds: string[] }`.
 */
const EMPTY_TRUST = { digest: null, approvedCommands: [], enabledRepoPipelineIds: [] };

export class AutomationsStore {
  #file;
  #state = {};
  #pending = Promise.resolve();

  constructor(directory) { this.#file = path.join(directory, 'automations.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  config(repoId) { return normalizeConfig(this.#state[repoId]?.config); }
  trust(repoId) { return { ...EMPTY_TRUST, ...this.#state[repoId]?.trust }; }

  #write(mutate) {
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      const repoId = mutate(state);
      const temporary = `${this.#file}.next`;
      await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await rename(temporary, this.#file);
      this.#state = state;
      return { config: this.config(repoId), trust: this.trust(repoId) };
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  saveConfig(repoId, rawConfig) {
    const clean = normalizeConfig(rawConfig);
    return this.#write(state => {
      (state[repoId] ||= {}).config = clean;
      return repoId;
    });
  }

  setTrust(repoId, trust) {
    return this.#write(state => {
      (state[repoId] ||= {}).trust = {
        digest: typeof trust.digest === 'string' ? trust.digest : null,
        approvedCommands: Array.isArray(trust.approvedCommands) ? trust.approvedCommands.map(String) : [],
        enabledRepoPipelineIds: Array.isArray(trust.enabledRepoPipelineIds) ? trust.enabledRepoPipelineIds.map(String) : []
      };
      return repoId;
    });
  }
}
