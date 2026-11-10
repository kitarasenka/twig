import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { captureFiles, captureRefs, captureState, digestFiles, stampFiles } from './git/undo-snapshot.js';
import { INDEX_KINDS, UNDOABLE_KINDS, buildUndoPlan, entryFiles, inverseReason, undoLabel, undoScope } from './git/undo-plan.js';
import { runGit } from './git/exec.js';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { ui } from '../renderer/src/i18n/i18n.js';

// The state a skipped snapshot stands for when only a reason is needed: no
// operation in progress, nothing left in the working tree to lose.
const QUIET_STATE = Object.freeze({ operation: 'none', clean: true, paths: [], head: null, branch: null });
// Entries written by an older 🌱 Twig hold a digest of file contents, which
// nothing computes any more; that chain ends on load, in words.
const FORMAT = 2;
const NOTHING = ui`No application actions to undo.`;
const KEEPS_PATHS = ['stash:pop', 'stash:apply'];
/** What is stored of a state: a path list on every action would make this file grow by megabytes on a large change. */
const stored = (kind, { paths, ...state }) => (KEEPS_PATHS.includes(kind) ? { ...state, paths } : state);
const retired = state => ({ format: FORMAT, undo: [], redo: [],
  reason: state?.undo?.length || state?.redo?.length ? ui`🌱 Twig was updated, so the earlier Undo chain has ended.` : NOTHING });

export class UndoService {
  #states = new Map(); #busy = new Set(); #listeners = new Set(); #writes = Promise.resolve(); #versions = new Map(); #inspections = new Map();
  constructor({ directory, log }) { this.file = path.join(directory, 'operations.json'); this.log = log; }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const entries = await readJsonFile(this.file);
      if (Array.isArray(entries)) this.#states = new Map(entries.map(([cwd, state]) => [cwd, state?.format === FORMAT ? state : retired(state)]));
    } catch { this.#states.clear(); }
  }
  #state(cwd) {
    if (!this.#states.has(cwd)) this.#states.set(cwd, { format: FORMAT, undo: [], redo: [], reason: NOTHING });
    return this.#states.get(cwd);
  }
  /** Ends the chain. A discard in it stays reachable, and the reason says where. */
  #break(cwd, reason) {
    const state = this.#states.get(cwd);
    const discarded = [...(state?.undo ?? []), ...(state?.redo ?? [])].some(entry => entry.kind === 'worktree:discard');
    this.#states.set(cwd, { format: FORMAT, undo: [], redo: [], reason: discarded ? `${reason} ${ui`What you discarded is still in Reflog, under Discarded changes.`}` : reason });
  }
  /** One capture of each kind per check, shared by the two ends of the chain. `whole` is passed when one was just taken. */
  #reader(cwd, whole = null) {
    let state = whole; let refs = whole;
    return {
      all: () => (state ??= captureState({ cwd, log: this.log })),
      refs: () => (refs ??= captureRefs({ cwd, log: this.log }))
    };
  }
  /** Whether what this entry's inverse depends on is still as `expected` recorded it. */
  async #holds(cwd, entry, expected, reader) {
    const scope = undoScope(entry.kind);
    if (scope === 'all') return (await reader.all()).digest === expected?.digest;
    if (scope === 'refs') return (await reader.refs()).refs === expected?.refs;
    if (!expected?.files) return false;
    const paths = entryFiles(entry);
    const stamp = await stampFiles({ cwd, paths });
    if (stamp === expected.files.stamp) return true;
    if (await digestFiles({ cwd, paths }) !== expected.files.content) return false;
    expected.files.stamp = stamp;
    return true;
  }
  /** Checks the entry next in each direction. */
  async #check(cwd, state, reader) {
    const undoEntry = state.undo.at(-1); const redoEntry = state.redo.at(-1);
    const [undo, redo] = await Promise.all([undoEntry ? this.#holds(cwd, undoEntry, undoEntry.after, reader) : true,
      redoEntry ? this.#holds(cwd, redoEntry, redoEntry.redoState, reader) : true]);
    return { undo, redo, stale: undo ? redoEntry : undoEntry };
  }
  /** Acts on a failed check: a stale Redo goes on its own, a stale Undo ends the chain. False when nothing is left. */
  #settle(cwd, state, { undo, stale }, reason) {
    if (undo && state.undo.length) { state.redo = []; return true; }
    this.#break(cwd, stale?.kind === 'worktree:discard' ? ui`A discarded file changed since, so Undo cannot put it back safely.` : reason);
    return false;
  }
  /** Whether a person's action (or an Undo/Redo) is running on this repository right now. */
  isBusy(cwd) { return this.#busy.has(cwd); }
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(cwd) { this.#versions.set(cwd, (this.#versions.get(cwd) || 0) + 1); for (const listener of this.#listeners) listener(cwd); }
  async #save() {
    const next = this.#writes.catch(() => {}).then(async () => {
      await writeFileAtomic(this.file, JSON.stringify([...this.#states]), { mode: 0o600 });
    });
    this.#writes = next; await next;
  }
  /** Drop the recorded chain for a repository — used when the demo sandbox is reset. */
  async forget(cwd) {
    if (!this.#states.has(cwd) && !this.#busy.has(cwd)) return;
    this.#states.delete(cwd);
    await this.#save();
    this.#emit(cwd);
  }

  /** A repository that moved keeps its chain: everything recorded is relative to its root. */
  async rekey(from, to) {
    if (!this.#states.has(from)) return;
    this.#states.set(to, this.#states.get(from));
    this.#states.delete(from);
    await this.#save();
  }

  /** Asked on every focus and every change: callers while one check is running share its answer. */
  inspect(cwd) {
    const running = this.#inspections.get(cwd);
    if (running) return running;
    const check = this.#inspect(cwd).finally(() => this.#inspections.delete(cwd));
    this.#inspections.set(cwd, check);
    return check;
  }
  async #inspect(cwd) {
    const state = this.#state(cwd);
    const summary = (undoReason, redoReason = undoReason) => ({ undo: false, redo: false, undoReason, redoReason });
    if (this.#busy.has(cwd)) return summary(ui`A repository action is running.`);
    if (!state.undo.length && !state.redo.length) return summary(state.reason, state.reason === NOTHING ? ui`No application actions to redo.` : state.reason);
    const version = this.#versions.get(cwd);
    const result = await this.#check(cwd, state, this.#reader(cwd));
    if (version !== this.#versions.get(cwd)) return summary(ui`Repository actions changed while checking Undo.`);
    if (!(result.undo && result.redo)) {
      const kept = this.#settle(cwd, state, result, ui`The repository changed outside the recorded action. The Undo chain has ended.`);
      await this.#save();
      if (!kept) return summary(this.#state(cwd).reason);
    }
    return { undo: Boolean(state.undo.length), redo: Boolean(state.redo.length),
      undoReason: state.undo.length ? undoLabel(state.undo.at(-1), 'undo') : ui`No earlier action.`,
      redoReason: state.redo.length ? undoLabel(state.redo.at(-1), 'redo') : ui`No next action.` };
  }
  async perform(cwd, kind, args, action) {
    if (this.#busy.has(cwd)) throw new Error(ui`Another repository action is running. Wait for it to finish.`);
    this.#busy.add(cwd); this.#emit(cwd);
    let before; let result; let failure;
    try {
      const state = this.#state(cwd);
      // A fetch only moves remote-tracking refs, which the Undo state leaves
      // out, so it ends the chain only when it changed something else (tags).
      const fetchOnly = kind === 'sync:run' && typeof args[0] === 'string' && args[0].startsWith('fetch');
      const attempted = () => ['sync:run', 'sync:push-ref', 'sync:drop', 'ops:rebase'].includes(kind) && !fetchOnly && !(failure instanceof TypeError) && !result?.notStarted;
      // Nothing to protect and nothing to record: an action Undo cannot reverse
      // (staging, a push, a fetch…), with no chain to end, runs without the two
      // snapshots around it — each reads every changed file and the whole index.
      // It still leaves its reason, which the Undo button shows.
      if (!UNDOABLE_KINDS.includes(kind) && !state.undo.length && !state.redo.length) {
        try { result = await action(); } catch (error) { failure = error; }
        const finished = !failure && result?.ok !== false;
        if (attempted() || (finished && !fetchOnly)) {
          const reason = finished ? inverseReason(kind, QUIET_STATE, QUIET_STATE, args) : ui`The operation did not finish normally. Continue or abort it explicitly.`;
          if (reason && reason !== state.reason) { this.#break(cwd, reason); await this.#save(); }
        }
        if (failure) throw failure;
        return result;
      }
      // Staging leaves refs and files alone, so only an entry that depends on
      // the index notices it: one check after, nothing recorded.
      if (INDEX_KINDS.includes(kind)) {
        try { result = await action(); } catch (error) { failure = error; }
        const check = await this.#check(cwd, state, this.#reader(cwd));
        if (!(check.undo && check.redo)) {
          this.#settle(cwd, state, check, inverseReason(kind, QUIET_STATE, QUIET_STATE, args));
          await this.#save();
        }
        if (failure) throw failure;
        return result;
      }
      before = await captureState({ cwd, log: this.log });
      const check = await this.#check(cwd, state, this.#reader(cwd, before));
      if (!(check.undo && check.redo)) this.#settle(cwd, state, check, ui`External changes ended the Undo chain.`);
      try { result = await action(); } catch (error) { failure = error; }
      const after = await captureState({ cwd, log: this.log });
      const changed = before.digest !== after.digest;
      const irreversibleAttempt = attempted();
      if (changed || irreversibleAttempt) {
        let reason = inverseReason(kind, before, after, args);
        if (failure || result?.ok === false) reason = ui`The operation did not finish normally. Continue or abort it explicitly.`;
        if (!reason && kind === 'worktree:discard' && !result?.undo) reason = ui`The discard did not record its backup. Look for it in Reflog, under Discarded changes.`;
        if (!reason && kind === 'worktree:restore-discard' && !result?.undo) reason = ui`The restore did not record what it replaced.`;
        if (!reason && kind === 'reflog:move-branch' && !result?.undo) reason = ui`The branch move did not report where it started.`;
        if (!reason && kind === 'worktree:ignore' && !result?.undo) reason = ui`The .gitignore edit did not record its backup.`;
        if (!reason && kind === 'refs:create-tag' && !result?.undo) reason = ui`The tag did not report what it points to.`;
        if (kind === 'refs:create-branch' && !reason) {
          const ancestor = await runGit({ cwd, log: this.log, argv: ['merge-base', '--is-ancestor', args[1], before.head], operation: 'Background: check safe branch deletion' });
          if (ancestor.code !== 0) reason = ui`The new branch contains unmerged commits; branch -d would refuse its deletion.`;
        }
        if (reason) this.#break(cwd, reason);
        else {
          const active = this.#state(cwd);
          // Only branch/stash parameters are needed; never persist commit bodies or file contents.
          // A discard keeps the ids of its two backup commits and the paths — the
          // content itself lives in Git's object store under refs/twig/discard.
          // A reflog move keeps the branch name and its two ends; a .gitignore
          // rule keeps its two backups and whether the file was new; a tag its
          // name and what it points to.
          const savedArgs = ['worktree:discard', 'worktree:restore-discard', 'reflog:move-branch', 'worktree:ignore', 'refs:create-tag'].includes(kind) ? result.undo
            : ['refs:create-branch', 'stash:push', 'stash:pop', 'stash:apply'].includes(kind) ? args
              : kind === 'ops:reset' ? [args[0]] : [];
          const entry = { kind, args: savedArgs, before: stored(kind, before), after: stored(kind, after) };
          if (undoScope(kind) === 'files') entry.after.files = await captureFiles({ cwd, paths: entryFiles(entry) });
          active.undo.push(entry); active.undo = active.undo.slice(-100);
          active.redo = []; active.reason = '';
        }
      }
      await this.#save();
      if (failure) throw failure;
      return result;
    } finally { this.#busy.delete(cwd); this.#emit(cwd); }
  }
  async move(cwd, direction, confirm) {
    if (!['undo', 'redo'].includes(direction)) throw new TypeError('Invalid Undo direction');
    const available = await this.#inspect(cwd);
    if (!available[direction]) throw new Error(available[`${direction}Reason`]);
    if (this.#busy.has(cwd)) throw new Error(ui`Another repository action is running.`);
    this.#busy.add(cwd); this.#emit(cwd);
    const state = this.#state(cwd); const entry = state[direction].at(-1);
    try {
      const plan = buildUndoPlan(entry, direction);
      if (plan.destructive && !await confirm(plan, direction)) return { ok: false, cancelled: true };
      if (!await this.#holds(cwd, entry, direction === 'undo' ? entry.after : entry.redoState, this.#reader(cwd))) {
        this.#break(cwd, ui`The repository changed before confirmation. Nothing was reversed.`);
        throw new Error(this.#state(cwd).reason);
      }
      for (const command of plan.commands) {
        // A command is argv, or { argv, stdin } when its path list goes over stdin.
        const { argv, stdin = null } = Array.isArray(command) ? { argv: command } : command;
        const result = await runGit({ cwd, log: this.log, argv, stdin, operation: undoLabel(entry, direction) });
        if (result.code !== 0) {
          this.#break(cwd, ui`The inverse stopped. Inspect Git output and resolve the repository explicitly.`);
          throw new Error(this.#state(cwd).reason);
        }
      }
      const after = stored(entry.kind, await captureState({ cwd, log: this.log }));
      if (undoScope(entry.kind) === 'files') after.files = await captureFiles({ cwd, paths: entryFiles(entry) });
      state[direction].pop();
      if (direction === 'undo') { entry.redoState = after; state.redo.push(entry); }
      else { entry.before = entry.redoState; entry.after = after; state.undo.push(entry); }
      // An inverse that replaces files leaves the state before it with new
      // times. Its own check has just passed, so if Git sees the same state as
      // recorded, the next entry in this direction stands.
      const next = direction === 'undo' ? state.undo.at(-1) : state.redo.at(-1);
      const expected = direction === 'undo' ? next?.after : next?.redoState;
      if (undoScope(entry.kind) === 'all' && next && undoScope(next.kind) === 'all' && expected?.shape === after.shape) expected.digest = after.digest;
      return { ok: true, cancelled: false };
    } finally { try { await this.#save(); } finally { this.#busy.delete(cwd); this.#emit(cwd); } }
  }
}
