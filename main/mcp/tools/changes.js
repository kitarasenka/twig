import path from 'node:path';
import { loadUntrackedDiff, loadWorktree, loadWorktreeDiff, loadWorktreeDiffs } from '../../git/worktree.js';
import { loadWorktreeNumstat } from '../../git/numstat.js';
import { validateFile } from '../../git/commit.js';
import { McpError, checked } from '../errors.js';
import { readCursor } from '../arguments.js';
import {
  DIFF_BUDGET, TRUNCATED_DIFF_HINT, capHunk, describeHunks, fileLine, fitHunks, hunkPatch, hunkTotals, parseHunkId,
  renderHunks, repositoryPreamble
} from '../serialize.js';

/** A file with more changed lines than this is listed, not inlined, by list_changes with diffs. */
export const FILE_LINE_LIMIT = 400;
/** Untracked files list_changes reads in one answer; each is its own `git diff --no-index`. */
export const UNTRACKED_READS = 40;
/** What list_changes with diffs may weigh by default, and the least an agent can ask for. */
export const DEFAULT_MAX_BYTES = 60_000;
export const MIN_MAX_BYTES = 4096;
/** Room kept per listed file for its counts and a "(why it is not shown)" line. */
const NOTE_RESERVE = 80;

/**
 * Files whose diff says nothing a reader wants: lock files and minified or
 * source-map output. Their line counts are still listed. A repository can
 * mark more with `-diff` in .gitattributes — Git then counts them as binary.
 */
const LOCK_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'Cargo.lock',
  'Gemfile.lock', 'poetry.lock', 'Pipfile.lock', 'uv.lock', 'composer.lock', 'go.sum', 'flake.lock', 'Podfile.lock',
  'pubspec.lock', 'mix.lock', 'packages.lock.json', 'gradle.lockfile'
]);
const GENERATED = /\.min\.(?:js|mjs|css)$|\.(?:js|css)\.map$/;

export function isGeneratedPath(file) {
  return LOCK_FILES.has(path.posix.basename(file)) || GENERATED.test(file);
}

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

/** Why a file is listed without its diff, or null when it can be read. */
function skipReason(entry) {
  if (entry.letter === 'U') return 'conflicted: resolve it in 🌱 Twig, or read the file';
  if (entry.submodule) return 'submodule: its own history holds the diff';
  if (entry.binary) return null;
  if (entry.letter === 'T') return 'type changed: get_diff reads it';
  if (entry.side === 'untracked' && entry.path.endsWith('/')) return 'untracked folder';
  if (isGeneratedPath(entry.path)) return 'lock or generated file: get_diff reads it';
  if (entry.originalPath && (entry.insertions || entry.deletions)) return 'renamed with edits: get_diff shows it as a new file';
  if ((entry.insertions ?? 0) + (entry.deletions ?? 0) > FILE_LINE_LIMIT) return `over ${FILE_LINE_LIMIT} changed lines: get_diff reads it`;
  return null;
}

/**
 * Reads the patches of the page's files that are worth reading: one
 * `git diff` per side for tracked files, one per untracked file (at most
 * UNTRACKED_READS). Patches share what is left of `maxBytes` once every
 * file line and a note for each are counted; small files are fitted first, so
 * the budget runs out on the big ones, and a file is shown whole or not at all.
 */
async function attachDiffs(ctx, repo, page, context, maxBytes, head) {
  const overhead = Buffer.byteLength(head) + 32
    + page.reduce((sum, entry) => sum + Buffer.byteLength(fileLine(entry)) + 4 + NOTE_RESERVE, 0);
  let budget = Math.max(0, maxBytes - overhead);
  for (const entry of page) entry.note = skipReason(entry);
  const readable = page.filter(entry => !entry.note && !entry.binary && !entry.originalPath);
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
    if (untrackedReads++ >= UNTRACKED_READS) { entry.note = 'not read: too many untracked files in one answer; get_diff reads it'; continue; }
    const result = await loadUntrackedDiff({ cwd: repo.path, log: ctx.log, path: entry.path, context, limit: budget });
    if (result.directory) entry.note = 'untracked folder';
    else if (result.tooLarge) entry.note = `${result.size} bytes, more than this answer has room for: get_diff reads it`;
    else {
      entry.patch = result;
      if (result.binary) entry.binary = true;
    }
  }
  const sized = readable.filter(entry => entry.patch && !entry.binary).map(entry => {
    entry.text = entry.patch.hunks.map(hunkPatch).join('');
    entry.bytes = Buffer.byteLength(entry.text);
    if (entry.side === 'untracked') ({ insertions: entry.insertions, deletions: entry.deletions } = hunkTotals(describeHunks(entry.patch, 'u', context ?? 3, entry.path)));
    return entry;
  });
  for (const entry of [...sized].sort((a, b) => a.bytes - b.bytes)) {
    if (entry.bytes <= budget) budget -= entry.bytes;
    else { entry.note = 'did not fit in this answer: get_diff reads it'; entry.text = null; }
  }
  for (const entry of page) {
    if (entry.note || entry.text || entry.binary) continue;
    if (entry.originalPath) entry.note = 'renamed, content unchanged';
    else if (entry.patch) entry.note = entry.patch.mode ? 'mode change only' : 'no text change';
  }
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
    const line = fileLine(entry);
    if (!args.diffs) { lines.push(line); continue; }
    lines.push(`## ${line}`);
    if (entry.text) lines.push(entry.text.replace(/\n$/, ''));
    else if (entry.note) lines.push(`(${entry.note})`);
  }
  const next = start + page.length;
  if (next < entries.length) lines.push(`… ${entries.length - next} more: list_changes with cursor "${next}"`);
  return lines.join('\n') + '\n';
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
  if (entry.status === 'U') return { note: 'conflicted: the file has unresolved conflict markers on disk. Resolve it in 🌱 Twig’s conflict editor, or read the file itself.' };
  if (entry.submodule) return { note: 'submodule: a submodule changed; its own history holds the diff.' };
  if (side === 'untracked') {
    const result = await loadUntrackedDiff({ cwd: repo.path, log: ctx.log, path: entry.path, context });
    if (result.directory) return { note: 'untracked folder: Git lists it as one entry until something in it is added.' };
    if (result.tooLarge) return { note: `${result.size} bytes: this untracked file is too large to show as a diff.` };
    return { patch: result };
  }
  const patch = await loadWorktreeDiff({ cwd: repo.path, log: ctx.log, env: ctx.env, path: entry.path, staged: side === 'staged', context });
  return { patch };
}

/** `M +2 -0 src/app.js (staged)` — the line a single-file answer starts with. */
function diffHeader(entry, side, hunks, patch) {
  const totals = hunks ? hunkTotals(hunks) : { insertions: null, deletions: null };
  const line = fileLine({ letter: entry.status, path: entry.path, binary: Boolean(patch?.binary), ...totals });
  return side === 'untracked' ? line : `${line} (${side})`;
}

export async function getDiff(ctx, args) {
  const repo = ctx.repository(args.repository);
  const path = checked(validateFile, args.path, 'path');
  const entry = await locate(ctx, repo, path, args.staged ? 'staged' : 'unstaged');
  const side = entry.status === '?' ? 'untracked' : args.staged ? 'staged' : 'unstaged';
  const read = await readSide(ctx, repo, entry, side, args.contextLines);
  const preamble = repositoryPreamble(repo);
  if (read.note) return `${preamble}${diffHeader(entry, side, null, null)}\n(${read.note})\n`;
  const hunks = describeHunks(read.patch, SIDE_LETTER[side], args.contextLines, path);
  const fitted = fitHunks(hunks, DIFF_BUDGET);
  const body = read.patch.binary ? '(binary: no text diff)\n' : hunks.length ? renderHunks(fitted.hunks) : `(${read.patch.mode ? 'mode change only' : 'no text change'})\n`;
  return `${preamble}${diffHeader(entry, side, hunks, read.patch)}\n${body}${fitted.truncated ? `${TRUNCATED_DIFF_HINT}\n` : ''}`;
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
  return renderHunk(repo, `${path} (${side})`, hunk);
}

/** One hunk as text, cut at HUNK_BUDGET with a line saying how much was left out. */
export function renderHunk(repo, title, hunk) {
  const capped = capHunk(hunk);
  const cut = capped.truncated ? `(… ${capped.omittedLines} more lines not shown: the hunk is larger than one answer)\n` : '';
  return `${repositoryPreamble(repo)}${title} [${hunk.id}: +${hunk.added} -${hunk.removed}]\n${capped.patch}${cut}`;
}
