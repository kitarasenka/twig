import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_RUNS = 100;
const STREAM_CAP = 100_000; // per stream, per step, on disk

/**
 * Atomic JSON store for automation execution history, one file for every
 * repository: `{ [repoId]: execution[] }`, newest last, capped at MAX_RUNS.
 * Same write contract as `MarksStore`. Nothing here is ever committed into a
 * repository — it lives in `userData` only.
 */
export class AutomationRunsStore {
  #file;
  #state = {};
  #pending = Promise.resolve();

  constructor(directory) { this.#file = path.join(directory, 'automation-runs.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8'));
      if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  list(repoId) { return [...(this.#state[repoId] || [])].reverse(); }
  get(repoId, executionId) { return (this.#state[repoId] || []).find(run => run.id === executionId) || null; }

  append(repoId, execution) {
    const trimmed = {
      ...execution,
      steps: (execution.steps || []).map(step => ({
        ...step,
        stdout: typeof step.stdout === 'string' ? step.stdout.slice(0, STREAM_CAP) : '',
        stderr: typeof step.stderr === 'string' ? step.stderr.slice(0, STREAM_CAP) : ''
      }))
    };
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      const runs = state[repoId] || [];
      runs.push(trimmed);
      state[repoId] = runs.slice(-MAX_RUNS);
      const temporary = `${this.#file}.next`;
      await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
      await rename(temporary, this.#file);
      this.#state = state;
      return trimmed;
    });
    this.#pending = next.catch(() => {});
    return next;
  }
}
