import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gitFileLeadsTo, inspectRepository, readStamp } from './git/config-risk.js';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { ui } from '../renderer/src/i18n/i18n.js';

/**
 * What the person accepted of each connected repository: the programs and push
 * settings its `.git` names (main/git/config-risk.js), by id. Keyed by the
 * repository's common directory, so its linked worktrees share one answer.
 * Saved with the files to watch and how they looked, so a launch with nothing
 * changed asks Git nothing.
 */
export class TrustStore {
  #file;
  #state = {};
  #pending = Promise.resolve();

  constructor(directory) { this.#file = path.join(directory, 'repository-trust.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    const value = await readJsonFile(this.#file);
    if (value && typeof value === 'object' && !Array.isArray(value)) this.#state = value;
  }

  get(common) { return this.#state[common] ?? null; }

  find(folder) {
    const found = Object.entries(this.#state).find(([, record]) => record.connected?.includes(folder));
    return found ? { common: found[0], record: found[1] } : null;
  }

  #write(mutate) {
    const next = this.#pending.then(async () => {
      const state = JSON.parse(JSON.stringify(this.#state));
      mutate(state);
      await writeFileAtomic(this.#file, JSON.stringify(state, null, 2));
      this.#state = state;
    });
    this.#pending = next.catch(() => {});
    return next;
  }

  set(common, record) { return this.#write(state => { state[common] = record; }); }
  forget(common) { return this.#write(state => { delete state[common]; }); }
}

const inside = (folder, target) => target === folder || target.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);

/**
 * The check before every Git process. Each connected repository is held to what
 * the person accepted: if its config or hooks changed since, Git is asked what
 * they hold now, and anything new stops all Git in that repository — refresh,
 * MCP reads, a commit — until they answer. Nothing in the repository's own files
 * can be run to find out, because reading settings runs nothing.
 *
 * Normal work costs a few `lstat`s per Git process. 🌱 Twig's own writes to
 * `.git/config` (a remote, an upstream, the profile) change the file but not the
 * set of findings, so they cost one reading of the settings and no question.
 * A finding that went away asks nothing either.
 *
 * A check and the Git process after it are not one step: a change in that
 * instant is seen by the next process.
 *
 * No imports from Electron: the Node check drives it directly.
 * @param {{ store: TrustStore, log: object }} options
 */
export function createRepositoryTrust({ store, log }) {
  const entries = new Map();

  // A stopped repository is saved with no stamp: the next launch has to look again, not find everything as it was.
  const snapshot = entry => ({ root: entry.root, connected: [...entry.connected], linked: entry.linked, approved: [...entry.approved],
    lazyFetch: entry.lazyFetch, watch: entry.watch, stamp: entry.blocked ? null : entry.stamp });

  function fromRecord(common, record) {
    const entry = { common, root: record.root, connected: new Set(record.connected), linked: record.linked ?? [], approved: new Set(record.approved),
      lazyFetch: Boolean(record.lazyFetch), watch: record.watch, stamp: record.stamp, blocked: null, inspection: null, declined: null, asking: false, checking: null };
    entries.set(common, entry);
    return entry;
  }

  const entryOf = common => {
    if (entries.has(common)) return entries.get(common);
    const record = store.get(common);
    return record ? fromRecord(common, record) : null;
  };

  /** The repository `cwd` belongs to: the one with the deepest connected folder or linked checkout around it. */
  function locate(cwd) {
    let best = null;
    let depth = -1;
    for (const entry of entries.values()) {
      for (const folder of [...entry.connected, ...entry.linked.map(link => link.checkout)]) {
        if (folder.length > depth && inside(folder, cwd)) { best = entry; depth = folder.length; }
      }
    }
    return best;
  }

  function take(entry, inspection) {
    entry.linked = inspection.linked;
    entry.watch = inspection.watch;
    entry.inspection = inspection;
    const fresh = inspection.findings.filter(item => !entry.approved.has(item.id));
    entry.blocked = fresh.length ? fresh : null;
    entry.lazyFetch = !fresh.length && inspection.partialClone;
  }

  async function reread(entry, before) {
    const previous = JSON.stringify(entry.watch);
    const inspection = await inspectRepository(entry.root, log);
    if (!inspection) { entry.stamp = before; return; } // the folder is gone: Git says so itself
    take(entry, inspection);
    // Taken before reading: a change while Git was asked shows at the next check.
    entry.stamp = JSON.stringify(inspection.watch) === previous ? before : inspection.stamp;
    if (!entry.blocked) await store.set(entry.common, snapshot(entry));
  }

  async function verify(entry) {
    if (entry.checking) return entry.checking;
    const stamp = await readStamp(entry.watch);
    if (stamp === entry.stamp) return undefined;
    entry.checking = reread(entry, stamp).finally(() => { entry.checking = null; });
    return entry.checking;
  }

  /** Records `inspection` as what the person accepted: all of it, as they saw it. */
  async function approve(inspection) {
    const entry = entryOf(inspection.common) ?? fromRecord(inspection.common, { root: inspection.root, connected: [], approved: [], watch: inspection.watch, stamp: inspection.stamp });
    entry.connected.add(inspection.root);
    entry.approved = new Set(inspection.findings.map(item => item.id));
    entry.stamp = inspection.stamp;
    entry.declined = null;
    take(entry, inspection);
    await store.set(entry.common, snapshot(entry));
    return entry;
  }

  return {
    /** For `setGitGate`. */
    async gate(cwd, { explicit = false } = {}) {
      const entry = locate(cwd);
      if (!entry) return null;
      await verify(entry);
      if (entry.blocked) return { refused: ui`🌱 Twig stopped here: this repository’s Git settings changed and wait for your answer.` };
      if (!explicit) {
        // A linked worktree's `.git` file lies in the folder its agent writes to.
        const link = entry.linked.filter(item => inside(item.checkout, cwd)).sort((a, b) => b.checkout.length - a.checkout.length)[0];
        if (link && !await gitFileLeadsTo(link.checkout, link.admin)) return { refused: ui`The .git file of this folder does not lead to its repository.` };
      }
      return entry.lazyFetch ? { lazyFetch: true } : null;
    },
    /**
     * A folder joins the checks. Known from an earlier run: nothing is asked of
     * Git until something changed. Unknown (connected before this check existed)
     * with nothing to show: accepted. Unknown with findings: stopped until the
     * person has seen them.
     */
    async guard(folder) {
      const known = store.find(folder);
      if (known) { entryOf(known.common); return; }
      if ([...entries.values()].some(entry => entry.connected.has(folder))) return;
      const inspection = await inspectRepository(folder, log);
      if (!inspection) return;
      const entry = entryOf(inspection.common);
      if (entry) {
        entry.connected.add(folder);
        await verify(entry);
        await store.set(entry.common, snapshot(entry));
      } else if (inspection.findings.length) {
        const waiting = fromRecord(inspection.common, { root: inspection.root, connected: [folder], approved: [], watch: inspection.watch, stamp: inspection.stamp });
        take(waiting, inspection);
      } else await approve(inspection);
    },
    /** A repository 🌱 Twig made itself, a clone: nobody else wrote its `.git`. */
    async adopt(folder) {
      const inspection = await inspectRepository(folder, log);
      if (inspection) await approve(inspection);
    },
    approve,
    /** What of `inspection` the person has not accepted yet. */
    unapproved(inspection) {
      const entry = entryOf(inspection.common);
      return inspection.findings.filter(item => !entry?.approved.has(item.id));
    },
    blocked: folder => Boolean(locate(folder)?.blocked),
    /** Runs the check for `folder` now, without a Git command behind it. */
    async check(folder) {
      const entry = locate(folder);
      if (entry) await verify(entry);
    },
    /** What to ask about `folder`, once per change: not while it is being asked, not after "keep stopped". */
    pending(folder) {
      const entry = locate(folder);
      if (!entry?.blocked || entry.asking) return null;
      const key = entry.blocked.map(item => item.id).join();
      if (entry.declined === key) return null;
      entry.asking = true;
      return { findings: entry.blocked, name: path.basename(entry.root) };
    },
    async answer(folder, allowed) {
      const entry = locate(folder);
      if (!entry) return;
      entry.asking = false;
      if (allowed && entry.inspection) await approve(entry.inspection);
      else if (entry.blocked) entry.declined = entry.blocked.map(item => item.id).join();
    },
    /** The repository left the list. Its linked worktrees stay checked while one of them is connected. */
    async forget(folder) {
      const entry = [...entries.values()].find(item => item.connected.has(folder));
      if (!entry) return;
      entry.connected.delete(folder);
      if (entry.connected.size) { await store.set(entry.common, snapshot(entry)); return; }
      entries.delete(entry.common);
      await store.forget(entry.common);
    }
  };
}
