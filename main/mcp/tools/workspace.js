import { loadWorktree } from '../../git/worktree.js';
import { loadOperationState } from '../../git/operation-state.js';

// The kind a path counts as in the summary: a staged add, delete, rename or
// copy says more about the path than a later edit on disk does; otherwise a
// delete on disk wins over "modified".
const BUCKETS = { A: 'added', C: 'added', D: 'deleted', R: 'renamed', M: 'modified', T: 'modified' };

/**
 * Per-path counts for the workspace summary, from the same three lists
 * `loadWorktree` gives the staging screen. A path changed both in the index
 * and on disk is one path here, while `staged` and `unstaged` count it once on
 * each side — the way Git and list_changes model it.
 */
export function summarizeWorktree({ staged, unstaged, untracked }) {
  const counts = { clean: false, staged: staged.length, unstaged: 0, untracked: untracked.length, conflicts: 0, modified: 0, added: 0, deleted: 0, renamed: 0 };
  const index = new Map(staged.map(file => [file.path, file.status]));
  const disk = new Map();
  for (const file of unstaged) {
    if (file.status === 'U') counts.conflicts++;
    else { counts.unstaged++; disk.set(file.path, file.status); }
  }
  for (const path of new Set([...index.keys(), ...disk.keys()])) {
    const inIndex = index.get(path);
    const onDisk = disk.get(path);
    const letter = inIndex && inIndex !== 'M' ? inIndex : onDisk === 'D' ? 'D' : inIndex || onDisk;
    const bucket = BUCKETS[letter];
    if (bucket) counts[bucket]++;
  }
  counts.clean = counts.staged + counts.unstaged + counts.untracked + counts.conflicts === 0;
  return counts;
}

export async function getWorkspaceContext(ctx, args) {
  const repo = ctx.repository(args.repository);
  const cwd = repo.path;
  const worktree = await loadWorktree(ctx.worktree(cwd));
  const operation = await loadOperationState({ cwd, log: ctx.log, env: ctx.env, gitDir: await ctx.gitDir(cwd) });
  const { branch } = worktree;
  const ui = ctx.uiFor(repo.id);
  return {
    repository: { name: repo.name, path: repo.path, openInTwig: repo.active, ...(repo.note ? { note: repo.note } : {}) },
    branch: {
      name: branch.name, detached: branch.detached, unborn: branch.unborn,
      head: branch.oid ? branch.oid.slice(0, 12) : null,
      upstream: branch.upstream,
      ahead: branch.upstream ? branch.ahead : null,
      behind: branch.upstream ? branch.behind : null
    },
    operation: operation.kind === 'none' ? null
      : { kind: operation.kind, step: operation.step, total: operation.total, conflicts: operation.conflicts.length },
    workingTree: summarizeWorktree(worktree),
    selection: ui ? { view: ui.view, commit: ui.selectedCommit, file: ui.selectedFile?.path ?? null } : null
  };
}

export function listRepositories(ctx) {
  const activeId = ctx.activeId();
  return {
    repositories: ctx.repositories().map(repo => ({
      name: repo.name, path: repo.path, openInTwig: repo.id === activeId, available: Boolean(repo.available),
      ...(repo.sandbox ? { demo: true } : {})
    }))
  };
}
