import path from 'node:path';
import { runGit } from './exec.js';
import { parseStatusV2 } from './status-parser.js';
import { SANDBOX_NAME, ensureSandbox, resetSandbox } from './sandbox.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

// How many repositories a launch reads at once after the window's own tab: more
// only competes with the window for the disk and the processor.
const STATUS_BATCH = 6;

function succeeded(result) { return result.code === 0; }

async function resolveRoot(directory, log, { ungated = false } = {}) {
  const result = await runGit({ argv: ['rev-parse', '--show-toplevel'], cwd: directory, log, operation: 'Verify repository', ungated });
  return succeeded(result) ? result.stdout.trimEnd() : null;
}

/** `safe.bareRepository=explicit` hides a bare repository from discovery, so this one is named outright; it only reads. */
async function isBare(directory, log) {
  const result = await runGit({ argv: ['--git-dir=.', 'rev-parse', '--is-bare-repository'], cwd: directory, log, operation: 'Verify repository', ungated: true });
  return succeeded(result) && result.stdout.trim() === 'true';
}

/** The reason a folder with no working tree of its own is refused. */
async function refusal(directory, log) {
  return await isBare(directory, log)
    ? ui`This is a bare repository: it has no working files to show. Open a clone of it instead.`
    : ui`Choose a folder that contains a Git repository.`;
}

async function readStatus(directory, log) {
  const result = await runGit({ argv: ['status', '--porcelain=v2', '--branch', '-z'], cwd: directory, log, operation: 'Background: read working tree status' });
  if (!succeeded(result)) return { error: ui`Git could not read this repository.` };
  return parseStatusV2(result.stdout);
}

/**
 * `movers` are the stores keyed by a repository's id, which is its path: each
 * has `rekey(from, to)`, and a repository that moved takes all of it along.
 * A repository whose `available` is not set yet has simply not been read: a
 * launch reads the window's own tab first and the others behind it.
 * @param {{ log: import('../command-log.js').CommandLog, store: import('../store.js').RepositoryStore,
 *   sandbox?: { dir: string, remoteDir: string, markerFile: string },
 *   undo?: import('../undo.js').UndoService, marks?: import('../marks-store.js').MarksStore,
 *   trust?: ReturnType<import('../repository-trust.js').createRepositoryTrust>,
 *   movers?: { rekey: (from: string, to: string) => Promise<unknown> }[] }} options
 */
export function createRepositoryService({ log, store, sandbox = null, undo = null, marks = null, trust = null, movers = [] }) {
  let state = store.snapshot();
  let sandboxEntry = sandbox
    ? { id: sandbox.dir, path: sandbox.dir, name: SANDBOX_NAME, sandbox: true, status: null }
    : null;
  const listeners = new Set();
  let pending = Promise.resolve();
  const serialize = action => (...args) => {
    const next = pending.then(() => action(...args));
    pending = next.catch(() => {});
    return next;
  };

  /**
   * The sandbox is the first tab; it is derived, never persisted as a repository.
   * Closing it persists one flag (`sandboxHidden`) instead: the files stay on
   * disk, so showing it again is the same sandbox, not a fresh seed.
   */
  const decorate = current => sandboxEntry && !current.sandboxHidden
    ? { ...current, repositories: [sandboxEntry, ...current.repositories] }
    : current;

  async function statusFor(repository) {
    const root = await resolveRoot(repository.path, log);
    if (!root) return { ...repository, available: false, status: null, blocked: Boolean(trust?.blocked(repository.path)) };
    try {
      return { ...repository, path: root, available: true, status: await readStatus(root, log), blocked: false };
    } catch {
      return { ...repository, path: root, available: true, status: { error: ui`Git status is unavailable.` }, blocked: false };
    }
  }

  async function refreshSandbox() {
    if (!sandbox || state.sandboxHidden) return;
    sandboxEntry = await statusFor({ id: sandbox.dir, path: sandbox.dir, name: SANDBOX_NAME, sandbox: true });
  }

  const publish = () => { for (const listener of listeners) listener(decorate(state)); };

  /** A failed seed leaves the demo tab saying so; it never stops the window from opening. */
  async function readDemo() {
    if (!sandbox || state.sandboxHidden) return;
    try {
      await ensureSandbox({ ...sandbox, log });
      await refreshSandbox();
    } catch (error) {
      sandboxEntry = { id: sandbox.dir, path: sandbox.dir, name: SANDBOX_NAME, sandbox: true, available: false, status: null, seedError: error.message };
    }
  }

  async function readRepositories(items) {
    const fresh = new Map((await Promise.all(items.map(statusFor))).map(item => [item.id, item]));
    state = { ...state, repositories: state.repositories.map(item => fresh.get(item.id) || item) };
  }

  /**
   * What a launch reads. `first` is the repository the window opens on, the only
   * one it waits for; the others follow in batches, each published when it is
   * in, and a tab click in between waits for one batch, not for all of them.
   * A closed demo costs nothing: no seeding, no status, no git.
   */
  function start() {
    const demo = Boolean(sandbox) && !state.sandboxHidden;
    const opening = state.repositories.find(item => item.id === state.activeId) || (demo ? null : state.repositories[0]) || null;
    const first = serialize(async () => {
      // Before any Git runs in them: a launch with nothing changed only compares file stamps here.
      // A guard that could not save still holds in memory, so a full disk does not cost the window.
      if (trust) await Promise.all(state.repositories.map(repository => trust.guard(repository.path).catch(() => {})));
      if (opening) await readRepositories([opening]); else await readDemo();
      return decorate(state);
    })();
    const settled = first.then(async () => {
      const others = state.repositories.filter(item => item.id !== opening?.id);
      for (let at = 0; at < others.length; at += STATUS_BATCH) {
        await serialize(readRepositories)(others.slice(at, at + STATUS_BATCH));
        publish();
      }
      if (opening && demo) { await serialize(readDemo)(); publish(); }
      return decorate(state);
    });
    settled.catch(() => {});
    return { first, settled };
  }

  /** `repository` (or inside one), `bare`, or `none`: what opening this folder would mean. */
  async function inspect(directory) {
    // Before the person answered, and a stopped repository is a repository: this only reads where it is.
    if (await resolveRoot(directory, log, { ungated: true })) return 'repository';
    return await isBare(directory, log) ? 'bare' : 'none';
  }

  /** `made`: 🌱 Twig created this repository itself just now, a clone; nothing in it needs the person's answer. */
  async function add(directory, { made = false } = {}) {
    const root = await resolveRoot(directory, log);
    if (!root) throw new Error(await refusal(directory, log));
    await (made ? trust?.adopt(root) : trust?.guard(root));
    const existing = state.repositories.find(repository => repository.path === root);
    const repository = existing || { id: root, path: root, name: path.basename(root) || root };
    const repositories = [...state.repositories.filter(item => item.id !== repository.id), repository];
    state = await store.save(repositories, repository.id);
    try {
      const status = await readStatus(root, log);
      state = { ...state, repositories: state.repositories.map(item => item.id === repository.id
        ? { ...repository, available: true, status, blocked: false }
        : item) };
    } catch {
      state = { ...state, repositories: state.repositories.map(item => item.id === repository.id
        ? { ...repository, available: true, status: { error: ui`Git status is unavailable.` }, blocked: false }
        : item) };
    }
    return decorate(state);
  }

  /**
   * Selecting a repository — a tab click, and the refresh after every action
   * and every return to the window — reads that repository alone. The others
   * keep the status they had and are read when they are selected; reading all
   * of them each time was most of the git processes 🌱 Twig ran (a refresh
   * with ten connected repositories was twenty-odd processes, half a second).
   * The file is written only when the active repository actually changes.
   */
  async function select(id) {
    if (sandbox && id === sandbox.dir) { await refreshSandbox(); return decorate(state); }
    const repository = state.repositories.find(item => item.id === id);
    if (!repository) throw new Error(ui`Unknown repository.`);
    if (state.activeId !== repository.id) state = await store.save(state.repositories, repository.id);
    const fresh = await statusFor(repository);
    state = { ...state, repositories: state.repositories.map(item => (item.id === repository.id ? fresh : item)) };
    return decorate(state);
  }

  /** Close or reopen the demo tab. Nothing on disk is touched either way. */
  async function setSandboxVisible(visible) {
    if (!sandbox) throw new Error(ui`No demo workspace to show or hide.`);
    state = await store.save(state.repositories, state.activeId, !visible);
    if (visible) {
      await ensureSandbox({ ...sandbox, log });
      await refreshSandbox();
    }
    return decorate(state);
  }

  async function remove(id) {
    if (sandbox && id === sandbox.dir) throw new Error(ui`The demo workspace cannot be removed.`);
    if (!state.repositories.some(item => item.id === id)) throw new Error(ui`Unknown repository.`);
    const gone = state.repositories.find(item => item.id === id);
    const repositories = state.repositories.filter(item => item.id !== id);
    const activeId = state.activeId === id ? repositories.find(item => item.available)?.id || repositories[0]?.id || null : state.activeId;
    state = await store.save(repositories, activeId);
    await trust?.forget(gone.path);
    return decorate(state);
  }

  /**
   * A repository that moved: its entry follows it to the new folder, and with
   * the path its id, so everything stored under the old id moves first. A store
   * that refuses puts the ones before it back, and the entry stays where it was.
   */
  async function relocate(id, directory) {
    if (sandbox && id === sandbox.dir) throw new Error(ui`The demo workspace cannot be moved.`);
    const repository = state.repositories.find(item => item.id === id);
    if (!repository) throw new Error(ui`Unknown repository.`);
    const root = await resolveRoot(directory, log);
    if (!root) throw new Error(await refusal(directory, log));
    const other = state.repositories.find(item => item.id !== id && item.path === root);
    if (other) throw new Error(ui`${other.name} is already connected at this folder. Remove it from the list first.`);
    await trust?.guard(root);
    const next = { id: root, path: root, name: path.basename(root) || root };
    if (root !== id) {
      const done = [];
      try {
        for (const mover of movers) { await mover.rekey(id, root); done.push(mover); }
        state = await store.save(state.repositories.map(item => (item.id === id ? next : item)), state.activeId === id ? root : state.activeId);
      } catch (error) {
        for (const mover of done.reverse()) await mover.rekey(root, id).catch(() => {});
        throw error;
      }
    }
    await readRepositories([next]);
    return { workspace: decorate(state), from: id, to: root };
  }

  async function reset() {
    if (!sandbox) throw new Error(ui`No demo workspace to reset.`);
    if (state.sandboxHidden) throw new Error(ui`The demo workspace is closed.`);
    await resetSandbox({ dir: sandbox.dir, remoteDir: sandbox.remoteDir, log });
    await undo?.forget(sandbox.dir);
    await marks?.forget(sandbox.dir);
    await refreshSandbox();
    return decorate(state);
  }

  const loadStored = serialize(async () => { state = await store.load(); return decorate(state); });

  return {
    loadStored, start,
    /** The whole read in one step, for callers with no window to show meanwhile. */
    load: async () => { await loadStored(); return start().settled; },
    add: serialize(add), select: serialize(select), remove: serialize(remove), resetSandbox: serialize(reset),
    setSandboxVisible: serialize(setSandboxVisible), relocate: serialize(relocate), inspect,
    onUpdate: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => decorate(state)
  };
}
