import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { redactCredentials } from './git/redact.js';

const MAX_RUNS = 100;
const STREAM_CAP = 100_000; // per stream, per step, on disk

/** What a step printed and said, without the credentials in it — the journal keeps none either. */
function clean(execution) {
  return {
    ...execution,
    steps: (execution.steps || []).map(step => ({
      ...step, stdout: redactCredentials(step.stdout), stderr: redactCredentials(step.stderr), detail: redactCredentials(step.detail)
    }))
  };
}

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
    const value = await readJsonFile(this.#file);
    if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
    // Runs recorded before step output was cleaned: the file is rewritten once, clean.
    const before = JSON.stringify(this.#state);
    this.#state = Object.fromEntries(Object.entries(this.#state).map(([repoId, runs]) => [repoId, runs.map(clean)]));
    if (JSON.stringify(this.#state) !== before) await writeFileAtomic(this.#file, JSON.stringify(this.#state, null, 2));
  }

  /** Forgets every recorded run. */
  clear() {
    const next = this.#pending.then(async () => {
      await writeFileAtomic(this.#file, '{}');
      this.#state = {};
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  list(repoId) { return [...(this.#state[repoId] || [])].reverse(); }
  get(repoId, executionId) { return (this.#state[repoId] || []).find(run => run.id === executionId) || null; }

  /** A repository that moved keeps its run history. */
  rekey(from, to) {
    const next = this.#pending.then(async () => {
      if (!this.#state[from]) return;
      const state = JSON.parse(JSON.stringify(this.#state));
      state[to] = [...state[to] || [], ...state[from]].slice(-MAX_RUNS);
      delete state[from];
      await writeFileAtomic(this.#file, JSON.stringify(state, null, 2));
      this.#state = state;
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  append(repoId, execution) {
    const trimmed = clean({
      ...execution,
      steps: (execution.steps || []).map(step => ({
        ...step,
        stdout: typeof step.stdout === 'string' ? step.stdout.slice(0, STREAM_CAP) : '',
        stderr: typeof step.stderr === 'string' ? step.stderr.slice(0, STREAM_CAP) : ''
      }))
    });
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      const runs = state[repoId] || [];
      runs.push(trimmed);
      state[repoId] = runs.slice(-MAX_RUNS);
      await writeFileAtomic(this.#file, JSON.stringify(state, null, 2));
      this.#state = state;
      return trimmed;
    });
    this.#pending = next.catch(() => {});
    return next;
  }
}
