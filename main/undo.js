import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { captureState } from './git/undo-snapshot.js';
import { buildUndoPlan, inverseReason } from './git/undo-plan.js';
import { runGit } from './git/exec.js';

export class UndoService {
  #states = new Map(); #busy = new Set(); #listeners = new Set(); #writes = Promise.resolve(); #versions = new Map();
  constructor({ directory, log }) { this.file = path.join(directory, 'operations.json'); this.log = log; }
  async load() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const entries = JSON.parse(await readFile(this.file, 'utf8'));
      if (Array.isArray(entries)) this.#states = new Map(entries);
    } catch (error) { if (error.code !== 'ENOENT') this.#states.clear(); }
  }
  #state(cwd) {
    if (!this.#states.has(cwd)) this.#states.set(cwd, { undo: [], redo: [], reason: 'No application actions to undo.' });
    return this.#states.get(cwd);
  }
  #break(cwd, reason) { this.#states.set(cwd, { undo: [], redo: [], reason }); }
  /** Whether a person's action (or an Undo/Redo) is running on this repository right now. */
  isBusy(cwd) { return this.#busy.has(cwd); }
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #emit(cwd) { this.#versions.set(cwd, (this.#versions.get(cwd) || 0) + 1); for (const listener of this.#listeners) listener(cwd); }
  async #save() {
    const next = this.#writes.catch(() => {}).then(async () => {
      await writeFile(`${this.file}.next`, JSON.stringify([...this.#states]), { mode: 0o600 });
      await rename(`${this.file}.next`, this.file);
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

  async inspect(cwd) {
    const state = this.#state(cwd);
    const summary = reason => ({ undo: false, redo: false, undoReason: reason, redoReason: reason });
    if (this.#busy.has(cwd)) return summary('A repository action is running.');
    if (!state.undo.length && !state.redo.length) return summary(state.reason);
    const version = this.#versions.get(cwd);
    const current = await captureState({ cwd, log: this.log });
    if (version !== this.#versions.get(cwd)) return summary('Repository actions changed while checking Undo.');
    const expected = state.redo.at(-1)?.redoState || state.undo.at(-1)?.after;
    if (current.digest !== expected?.digest) {
      this.#break(cwd, 'The repository changed outside the recorded action. The Undo chain has ended.');
      await this.#save(); return summary(this.#state(cwd).reason);
    }
    return { undo: Boolean(state.undo.length), redo: Boolean(state.redo.length),
      undoReason: state.undo.length ? `Undo ${state.undo.at(-1).kind.replaceAll(':', ' ')}` : 'No earlier action.',
      redoReason: state.redo.length ? `Redo ${state.redo.at(-1).kind.replaceAll(':', ' ')}` : 'No next action.' };
  }
  async perform(cwd, kind, args, action) {
    if (this.#busy.has(cwd)) throw new Error('Another repository action is running. Wait for it to finish.');
    this.#busy.add(cwd); this.#emit(cwd);
    let before; let result; let failure;
    try {
      before = await captureState({ cwd, log: this.log });
      const state = this.#state(cwd);
      const expected = state.redo.at(-1)?.redoState || state.undo.at(-1)?.after;
      if (expected && before.digest !== expected.digest) this.#break(cwd, 'External changes ended the Undo chain.');
      try { result = await action(); } catch (error) { failure = error; }
      const after = await captureState({ cwd, log: this.log });
      const changed = before.digest !== after.digest;
      // A fetch only moves remote-tracking refs, which the Undo state leaves
      // out, so it ends the chain only when it changed something else (tags).
      const fetchOnly = kind === 'sync:run' && typeof args[0] === 'string' && args[0].startsWith('fetch');
      const irreversibleAttempt = ['sync:run', 'sync:push-ref', 'sync:drop', 'ops:rebase'].includes(kind) && !fetchOnly && !(failure instanceof TypeError) && !result?.notStarted;
      if (changed || irreversibleAttempt) {
        let reason = inverseReason(kind, before, after, args);
        if (failure || result?.ok === false) reason = 'The operation did not finish normally. Continue or abort it explicitly.';
        if (!reason && kind === 'worktree:discard' && !result?.undo) reason = 'The discard did not record its backup. Its content is in refs/twig/discard.';
        if (!reason && kind === 'reflog:move-branch' && !result?.undo) reason = 'The branch move did not report where it started.';
        if (!reason && kind === 'worktree:ignore' && !result?.undo) reason = 'The .gitignore edit did not record its backup.';
        if (kind === 'refs:create-branch' && !reason) {
          const ancestor = await runGit({ cwd, log: this.log, argv: ['merge-base', '--is-ancestor', args[1], before.head], operation: 'Background: check safe branch deletion' });
          if (ancestor.code !== 0) reason = 'The new branch contains unmerged commits; branch -d would refuse its deletion.';
        }
        if (reason) this.#break(cwd, reason);
        else {
          const active = this.#state(cwd);
          // Only branch/stash parameters are needed; never persist commit bodies or file contents.
          // A discard keeps the ids of its two backup commits and the paths — the
          // content itself lives in Git's object store under refs/twig/discard.
          // A reflog move keeps the branch name and its two ends; a .gitignore
          // rule keeps its two backups and whether the file was new.
          const savedArgs = ['worktree:discard', 'reflog:move-branch', 'worktree:ignore'].includes(kind) ? result.undo
            : ['refs:create-branch', 'stash:push', 'stash:pop', 'stash:apply'].includes(kind) ? args : [];
          active.undo.push({ kind, args: savedArgs, before, after }); active.undo = active.undo.slice(-100);
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
    const available = await this.inspect(cwd);
    if (!available[direction]) throw new Error(available[`${direction}Reason`]);
    if (this.#busy.has(cwd)) throw new Error('Another repository action is running.');
    this.#busy.add(cwd); this.#emit(cwd);
    const state = this.#state(cwd); const entry = state[direction].at(-1);
    try {
      const plan = buildUndoPlan(entry, direction);
      if (plan.destructive && !await confirm(plan, direction)) return { ok: false, cancelled: true };
      const current = await captureState({ cwd, log: this.log });
      if (current.digest !== (direction === 'undo' ? entry.after : entry.redoState).digest) {
        this.#break(cwd, 'The repository changed before confirmation. Nothing was reversed.');
        throw new Error(this.#state(cwd).reason);
      }
      for (const command of plan.commands) {
        // A command is argv, or { argv, stdin } when its path list goes over stdin.
        const { argv, stdin = null } = Array.isArray(command) ? { argv: command } : command;
        const result = await runGit({ cwd, log: this.log, argv, stdin, operation: `${direction === 'undo' ? 'Undo' : 'Redo'} ${entry.kind}` });
        if (result.code !== 0) {
          this.#break(cwd, 'The inverse stopped. Inspect Git output and resolve the repository explicitly.');
          throw new Error(this.#state(cwd).reason);
        }
      }
      const after = await captureState({ cwd, log: this.log });
      state[direction].pop();
      if (direction === 'undo') { entry.redoState = after; state.redo.push(entry); }
      else { entry.before = entry.redoState; entry.after = after; state.undo.push(entry); }
      return { ok: true, cancelled: false };
    } finally { try { await this.#save(); } finally { this.#busy.delete(cwd); this.#emit(cwd); } }
  }
}
