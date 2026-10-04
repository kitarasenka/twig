import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const normalize = value => ({ enabled: value?.enabled === true });

/**
 * Whether the MCP server listens, `mcp.json` in userData. A missing or damaged
 * file means Off: only the Settings choice turns it on. Same atomic write as
 * `FetchStore` — memory changes only after the rename lands.
 */
export class McpStore {
  #file;
  #state = normalize(null);

  constructor(directory) { this.#file = path.join(directory, 'mcp.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      this.#state = normalize(JSON.parse(await readFile(this.#file, 'utf8')));
    } catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    return this.get();
  }

  get() { return { ...this.#state }; }

  async save(value) {
    const next = normalize(value);
    const temporary = `${this.#file}.next`;
    await writeFile(temporary, JSON.stringify(next, null, 2), 'utf8');
    await rename(temporary, this.#file);
    this.#state = next;
    return this.get();
  }
}
