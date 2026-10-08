import { loadUntrackedDiff, loadWorktree, loadWorktreeDiffs } from '../../git/worktree.js';
import { loadWorktreeNumstat } from '../../git/numstat.js';
import { readCursor } from '../arguments.js';
import { fileLine, repositoryPreamble } from '../serialize.js';
import { fileBlocks, fitPatches, leftOutLine, patchBudget, patchTotals, shellWord, sizeReason, unifiedFlag } from '../file-patches.js';

/** Untracked files list_changes reads in one answer; each is its own `git diff --no-index`. */
export const UNTRACKED_READS = 40;

/** Every changed path on every side, with its counts, in list order. */
async function readEntries(ctx, repo) {
  const [worktree, counts] = await Promise.all([loadWorktree(ctx.worktree(repo.path)), loadWorktreeNumstat({ cwd: repo.path, log: ctx.log, env: ctx.env })]);
  const tracked = (file, side) => {
    const count = side === 'staged' ? counts.staged.get(file.path) : counts.unstaged.get(file.path);
    const conflicted = file.status === 'U';
    return {
      side, path: file.path, originalPath: file.originalPath, letter: file.status, submodule: file.submodule,
      insertions: conflicted ? null : count?.insertions ?? null, deletions: conflicted ? null : count?.deletions ?? null,
      binary: Boolean(count?.binary)
    };
  };
  const entries = [
    ...worktree.staged.map(file => tracked(file, 'staged')),
    ...worktree.unstaged.map(file => tracked(file, 'unstaged')),
    ...worktree.untracked.map(file => ({ side: 'untracked', path: file.path, originalPath: null, letter: '?', submodule: false, insertions: null, deletions: null, binary: false }))
  ];
  return { branch: worktree.branch, entries };
}

function branchLine(branch, entries) {
  const where = branch.detached ? `detached at ${branch.oid ? branch.oid.slice(0, 12) : 'HEAD'}` : `on ${branch.name}${branch.unborn ? ' (no commits yet)' : ''}`;
  if (!entries.length) return `${where}: no changes`;
  const count = side => entries.filter(entry => entry.side === side).length;
  const conflicts = entries.filter(entry => entry.letter === 'U').length;
  const parts = [`${count('staged')} staged`, `${count('unstaged') - conflicts} unstaged`, `${count('untracked')} untracked`]
    .filter(part => !part.startsWith('0 '));
  if (conflicts) parts.push(`${conflicts} conflicted`);
  return `${where}: ${parts.join(', ')}`;
}

/**
 * How the agent reads a file this answer left out, with the context lines it
 * asked for: the `git diff` for its side, or the file itself when it is new.
 */
export function readCommand(entry, context) {
  if (entry.side === 'untracked') return 'read the file itself';
  const paths = entry.originalPath ? `-M -- ${shellWord(entry.originalPath)} ${shellWord(entry.path)}` : `-- ${shellWord(entry.path)}`;
  return `git diff${entry.side === 'staged' ? ' --cached' : ''}${unifiedFlag(context)} ${paths}`;
}

/** One `git diff` for several files of one side. */
const diffCommand = (side, context) => paths => `git diff${side === 'staged' ? ' --cached' : ''}${unifiedFlag(context)} -- ${paths.map(shellWord).join(' ')}`;

/** Why a file is listed without its diff before anything is read, or null when it can be read. */
function skipReason(entry, read) {
  if (entry.letter === 'U') return 'conflicted: resolve it in 🌱 Twig, or read the file';
  if (entry.submodule) return 'submodule: its own history holds the diff';
  if (entry.binary) return null;
  if (entry.letter === 'T') return `type changed: ${read}`;
  if (entry.side === 'untracked' && entry.path.endsWith('/')) return 'untracked folder';
  if (entry.originalPath && (entry.insertions || entry.deletions)) return `renamed with edits: ${read}`;
  if (entry.originalPath) return 'renamed, content unchanged';
  return sizeReason(entry, read);
}

/**
 * Reads the patches of the page's files that are worth reading: one
 * `git diff` per side for tracked files, one per untracked file (at most
 * UNTRACKED_READS), then fits them into `maxBytes`.
 */
async function attachDiffs(ctx, repo, page, context, maxBytes, head) {
  const read = entry => readCommand(entry, context);
  let budget = patchBudget(maxBytes, head, page);
  for (const entry of page) entry.note = skipReason(entry, read(entry));
  const readable = page.filter(entry => !entry.note && !entry.binary);
  const bySide = side => readable.filter(entry => entry.side === side).map(entry => entry.path);
  const [staged, unstaged] = await Promise.all(['staged', 'unstaged'].map(side => loadWorktreeDiffs({
    cwd: repo.path, log: ctx.log, env: ctx.env, paths: bySide(side), staged: side === 'staged', context
  })));
  let untrackedReads = 0;
  for (const entry of readable) {
    if (entry.side !== 'untracked') {
      entry.patch = (entry.side === 'staged' ? staged : unstaged).get(entry.path);
      continue;
    }
    if (untrackedReads++ >= UNTRACKED_READS) { entry.note = `not read: too many untracked files in one answer; ${read(entry)}`; continue; }
    const result = await loadUntrackedDiff({ cwd: repo.path, log: ctx.log, path: entry.path, context, limit: budget });
    if (result.directory) entry.note = 'untracked folder';
    else if (result.tooLarge) entry.note = `${result.size} bytes, more than this answer has room for: ${read(entry)}`;
    else if (result.binary) entry.binary = true;
    else {
      entry.patch = result;
      ({ insertions: entry.insertions, deletions: entry.deletions } = patchTotals(result));
    }
  }
  // A tracked file that does not fit is read with the others of its side in one git diff; a new one is read as a file.
  fitPatches(page, budget, entry => (entry.side === 'untracked' ? read(entry) : null));
}

export async function listChanges(ctx, args) {
  const repo = ctx.repository(args.repository);
  const { branch, entries } = await readEntries(ctx, repo);
  const start = readCursor(args.cursor);
  const page = entries.slice(start, start + args.limit);
  const head = repositoryPreamble(repo) + branchLine(branch, entries);
  if (args.diffs) await attachDiffs(ctx, repo, page, args.contextLines, args.maxBytes, head);
  const lines = [head];
  let side = null;
  for (const entry of page) {
    if (entry.side !== side) { side = entry.side; lines.push(`${side}:`); }
    if (args.diffs) lines.push(...fileBlocks([entry]));
    else lines.push(fileLine(entry));
  }
  if (args.diffs) {
    for (const side of ['staged', 'unstaged']) {
      const left = leftOutLine(page.filter(entry => entry.side === side), diffCommand(side, args.contextLines));
      if (left) lines.push(left);
    }
  }
  const next = start + page.length;
  if (next < entries.length) lines.push(`… ${entries.length - next} more: list_changes with cursor "${next}"`);
  return lines.join('\n') + '\n';
}
