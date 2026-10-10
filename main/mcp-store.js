import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';

const normalize = value => ({ enabled: value?.enabled === true, allowCommits: value?.allowCommits === true });

/**
 * Whether the MCP server listens, and whether agents may propose commits —
 * `mcp.json` in userData. A missing or damaged file means both Off: only the
 * Settings choices turn them on, each on its own. Same atomic write as
 * `FetchStore` — memory changes only after the rename lands.
 */
export class McpStore {
  #file;
  #state = normalize(null);

  constructor(directory) { this.#file = path.join(directory, 'mcp.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#state = normalize(await readJsonFile(this.#file));
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalize(value);
    await writeFileAtomic(this.#file, JSON.stringify(next, null, 2));
    this.#state = next;
    return this.get();
  }
}
