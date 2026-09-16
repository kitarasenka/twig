import path from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';
import { SANDBOX_NAME, ensureSandbox, resetSandbox } from './sandbox.js';

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

/**
 * @param {{ log: import('../command-log.js').CommandLog, store: import('../store.js').RepositoryStore,
 *   sandbox?: { dir: string, remoteDir: string, markerFile: string },
 *   undo?: import('../undo.js').UndoService, marks?: import('../marks-store.js').MarksStore }} options
 */
export function createRepositoryService({ log, store, sandbox = null, undo = null, marks = null }) {
  let state = store.snapshot();
  let sandboxEntry = sandbox
    ? { id: sandbox.dir, path: sandbox.dir, name: SANDBOX_NAME, sandbox: true, available: false, status: null }
    : null;
  let pending = Promise.resolve();
  const serialize = action => (...args) => {
    const next = pending.then(() => action(...args));
    pending = next.catch(() => {});
    return next;
  };

  /** The sandbox is always the first tab; it is derived, never persisted. */
  const decorate = current => sandboxEntry
    ? { ...current, repositories: [sandboxEntry, ...current.repositories] }
    : current;

  async function statusFor(repository) {
    const root = await resolveRoot(repository.path, log);
    if (!root) return { ...repository, available: false, status: null };
    try {
      return { ...repository, path: root, available: true, status: await readStatus(root, log) };
    } catch {
      return { ...repository, path: root, available: true, status: { error: 'Git status is unavailable.' } };
    }
  }

  async function refreshSandbox() {
    if (!sandbox) return;
    sandboxEntry = await statusFor({ id: sandbox.dir, path: sandbox.dir, name: SANDBOX_NAME, sandbox: true });
  }

  async function refresh() {
    // Each repository's status is an independent pair of `git` spawns; running them
    // one after another serialized N repositories behind N round-trips at startup.
    const [repositories] = await Promise.all([
      Promise.all(state.repositories.map(statusFor)),
      refreshSandbox()
    ]);
    state = { ...state, repositories };
    return decorate(state);
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
    return decorate(state);
  }

  async function select(id) {
    if (sandbox && id === sandbox.dir) { await refreshSandbox(); return decorate(state); }
    const repository = state.repositories.find(item => item.id === id);
    if (!repository) throw new Error('Unknown repository.');
    state = await store.save(state.repositories, repository.id);
    return refresh();
  }

  async function remove(id) {
    if (sandbox && id === sandbox.dir) throw new Error('The demo workspace cannot be removed.');
    if (!state.repositories.some(item => item.id === id)) throw new Error('Unknown repository.');
    const repositories = state.repositories.filter(item => item.id !== id);
    const activeId = state.activeId === id ? repositories.find(item => item.available)?.id || repositories[0]?.id || null : state.activeId;
    state = await store.save(repositories, activeId);
    return decorate(state);
  }

  async function reset() {
    if (!sandbox) throw new Error('No demo workspace to reset.');
    await resetSandbox({ dir: sandbox.dir, remoteDir: sandbox.remoteDir, log });
    await undo?.forget(sandbox.dir);
    await marks?.forget(sandbox.dir);
    await refreshSandbox();
    return decorate(state);
  }

  return {
    load: serialize(async () => {
      state = await store.load();
      if (sandbox) await ensureSandbox({ ...sandbox, log });
      return refresh();
    }),
    add: serialize(add), select: serialize(select), remove: serialize(remove), resetSandbox: serialize(reset),
    snapshot: () => decorate(state)
  };
}
