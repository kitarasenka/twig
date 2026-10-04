import { loadUntrackedDiff, loadWorktree, loadWorktreeDiff } from '../../git/worktree.js';
import { loadWorktreeNumstat } from '../../git/numstat.js';
import { validateFile } from '../../git/commit.js';
import { McpError, checked } from '../errors.js';
import { readCursor } from '../arguments.js';
import { DIFF_BUDGET, TRUNCATED_DIFF_HINT, capHunk, describeHunks, fitHunks, parseHunkId, statusWord } from '../serialize.js';

function counted(file, counts) {
  const count = counts?.get(file.path);
  return {
    path: file.path,
    ...(file.originalPath ? { originalPath: file.originalPath } : {}),
    insertions: count ? count.insertions : null,
    deletions: count ? count.deletions : null,
    ...(count?.binary ? { binary: true } : {}),
    ...(file.submodule ? { submodule: true } : {})
  };
}

export async function listChanges(ctx, args) {
  const repo = ctx.repository(args.repository);
  const [worktree, counts] = await Promise.all([loadWorktree(ctx.worktree(repo.path)), loadWorktreeNumstat({ cwd: repo.path, log: ctx.log, env: ctx.env })]);
  const files = [
    ...worktree.staged.map(file => ({ ...counted(file, counts.staged), status: statusWord(file.status), staged: true })),
    ...worktree.unstaged.map(file => file.status === 'U'
      ? { path: file.path, status: 'conflicted', staged: false, insertions: null, deletions: null }
      : { ...counted(file, counts.unstaged), status: statusWord(file.status), staged: false }),
    ...worktree.untracked.map(file => ({ path: file.path, status: 'untracked', staged: false, insertions: null, deletions: null }))
  ];
  const start = readCursor(args.cursor);
  const page = files.slice(start, start + args.limit);
  const next = start + page.length;
  return {
    repository: repo.path,
    total: files.length,
    files: page,
    nextCursor: next < files.length ? String(next) : null
  };
}

const SIDE_LETTER = { staged: 's', unstaged: 'w', untracked: 'u' };
const LETTER_SIDE = { s: 'staged', w: 'unstaged', u: 'untracked' };

/**
 * Finds what the working tree holds for one path, on the side asked for. A
 * path that is changed only on the other side gets a FILE_NOT_FOUND that says
 * so, instead of an empty diff an agent could read as "no changes".
 */
async function locate(ctx, repo, path, side) {
  const worktree = await loadWorktree(ctx.worktree(repo.path));
  const staged = worktree.staged.find(file => file.path === path);
  const unstaged = worktree.unstaged.find(file => file.path === path);
  const untracked = worktree.untracked.find(file => file.path === path);
  const entry = side === 'staged' ? staged : side === 'unstaged' ? unstaged : untracked;
  if (entry) return entry;
  if (side === 'unstaged' && untracked) return untracked;
  if (side === 'staged' && (unstaged || untracked)) {
    throw new McpError('FILE_NOT_FOUND', `${path} has no staged changes; its changes are not staged.`, { hint: 'Call get_diff with staged: false.' });
  }
  if (side !== 'staged' && staged) {
    throw new McpError('FILE_NOT_FOUND', `${path} has no unstaged changes; its changes are staged.`, { hint: 'Call get_diff with staged: true.' });
  }
  throw new McpError('FILE_NOT_FOUND', `${path} has no changes in the working tree.`, { hint: 'list_changes lists the changed paths.' });
}

/**
 * Reads one file's patch for a side. Untracked files are read as the patch
 * that would add them; conflicts and submodules are described, not diffed.
 */
async function readSide(ctx, repo, entry, side, context) {
  const base = { path: entry.path, side, status: statusWord(entry.status) };
  if (entry.status === 'U') {
    return { describe: { ...base, conflict: true, hunks: [], hint: 'The file has unresolved conflict markers on disk. Resolve it in 🌱 Twig’s conflict editor or read the file itself.' } };
  }
  if (entry.submodule) return { describe: { ...base, submodule: true, hunks: [], hint: 'A submodule changed; its own history holds the diff.' } };
  if (side === 'untracked') {
    const result = await loadUntrackedDiff({ cwd: repo.path, log: ctx.log, path: entry.path, context });
    if (result.directory) return { describe: { ...base, directory: true, hunks: [], hint: 'An untracked folder: Git lists it as one entry until something in it is added.' } };
    if (result.tooLarge) return { describe: { ...base, hunks: [], truncated: true, size: result.size, hint: 'This untracked file is too large to show as a diff.' } };
    return { patch: result };
  }
  const patch = await loadWorktreeDiff({ cwd: repo.path, log: ctx.log, env: ctx.env, path: entry.path, staged: side === 'staged', context });
  return { patch };
}

function fileFlags(patch) {
  return { binary: patch.binary, ...(patch.added ? { added: true } : {}), ...(patch.deleted ? { deleted: true } : {}) };
}

export async function getDiff(ctx, args) {
  const repo = ctx.repository(args.repository);
  const path = checked(validateFile, args.path, 'path');
  const entry = await locate(ctx, repo, path, args.staged ? 'staged' : 'unstaged');
  const side = entry.status === '?' ? 'untracked' : args.staged ? 'staged' : 'unstaged';
  const read = await readSide(ctx, repo, entry, side, args.contextLines);
  if (read.describe) return { repository: repo.path, ...read.describe };
  const hunks = describeHunks(read.patch, SIDE_LETTER[side], args.contextLines, path);
  const fitted = fitHunks(hunks, DIFF_BUDGET);
  return {
    repository: repo.path, path, side, status: statusWord(entry.status), ...fileFlags(read.patch),
    hunks: fitted.hunks, truncated: fitted.truncated, ...(fitted.truncated ? { hint: TRUNCATED_DIFF_HINT } : {})
  };
}

export async function getDiffHunk(ctx, args) {
  const repo = ctx.repository(args.repository);
  const path = checked(validateFile, args.path, 'path');
  const { side: letter, context } = parseHunkId(args.hunkId);
  if (letter === 'c') throw new McpError('INVALID_HUNK', 'That hunk belongs to a commit.', { hint: 'Call get_commit_diff with the commit hash, the path and this hunkId.' });
  if (context > 20) throw new McpError('INVALID_HUNK', 'That hunk id was not issued by get_diff.');
  const side = LETTER_SIDE[letter];
  const entry = await locate(ctx, repo, path, side);
  const read = await readSide(ctx, repo, entry, entry.status === '?' ? 'untracked' : side, context);
  const hunk = read.patch ? describeHunks(read.patch, letter, context, path).find(item => item.id === args.hunkId) : null;
  if (!hunk) throw new McpError('INVALID_HUNK', `Hunk ${args.hunkId} is no longer in ${path}: the file changed since it was read.`, { hint: 'Call get_diff again for fresh hunk ids.' });
  return { repository: repo.path, path, side, hunk: capHunk(hunk) };
}
