import path from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';

function succeeded(result) { return result.code === 0; }

async function resolveRoot(directory, log) {
  const result = await runGit({ argv: ['rev-parse', '--show-toplevel'], cwd: directory, log, operation: 'Verify repository' });
  return succeeded(result) ? result.stdout.trimEnd() : null;
}

async function readStatus(directory, log) {
  const result = await runGit({ argv: ['status', '--porcelain=v2', '--branch', '-z'], cwd: directory, log, operation: 'Background: read working tree status' });
  if (!succeeded(result)) return { error: 'Git could not read this repository.' };
  return parseStatusV2(result.stdout);
}

/** @param {{ log: import('../command-log.js').CommandLog, store: import('../store.js').RepositoryStore }} options */
export function createRepositoryService({ log, store }) {
  let state = store.snapshot();

  async function statusFor(repository) {
    const root = await resolveRoot(repository.path, log);
    if (!root) return { ...repository, available: false, status: null };
    try {
      return { ...repository, path: root, available: true, status: await readStatus(root, log) };
    } catch {
      return { ...repository, path: root, available: true, status: { error: 'Git status is unavailable.' } };
    }
  }

  async function refresh() {
    const repositories = [];
    for (const repository of state.repositories) repositories.push(await statusFor(repository));
    state = { ...state, repositories };
    return state;
  }

  async function add(directory) {
    const root = await resolveRoot(directory, log);
    if (!root) throw new Error('Choose a folder that contains a Git repository.');
    const existing = state.repositories.find(repository => repository.path === root);
    const repository = existing || { id: root, path: root, name: path.basename(root) || root };
    const repositories = [...state.repositories.filter(item => item.id !== repository.id), repository];
    state = await store.save(repositories, repository.id);
    try {
      const status = await readStatus(root, log);
      state = { ...state, repositories: state.repositories.map(item => item.id === repository.id
        ? { ...repository, available: true, status }
        : item) };
    } catch {
      state = { ...state, repositories: state.repositories.map(item => item.id === repository.id
        ? { ...repository, available: true, status: { error: 'Git status is unavailable.' } }
        : item) };
    }
    return state;
  }

  async function select(id) {
    const repository = state.repositories.find(item => item.id === id);
    if (!repository) throw new Error('Unknown repository.');
    state = await store.save(state.repositories, repository.id);
    return refresh();
  }

  return {
    async load() { state = await store.load(); return refresh(); },
    add, select,
    snapshot: () => state
  };
}
