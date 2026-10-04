import { loadCommit, loadCommitPatch, loadFileDiff, resolveRevision, validateFile, validateRevision } from '../../git/commit.js';
import { loadHistoryPage, loadRefHistory } from '../../git/history.js';
import { loadCommitNumstat } from '../../git/numstat.js';
import { parseFilePatchV1, splitPatchFiles } from '../../git/diff-parser.js';
import { McpError, checked } from '../errors.js';
import { readCursor } from '../arguments.js';
import { DIFF_BUDGET, TRUNCATED_DIFF_HINT, capHunk, compactCommit, describeHunks, fitHunks, parseHunkId, statusWord } from '../serialize.js';

/** Files a get_commit answer lists before it says the rest were left out. */
export const COMMIT_FILE_LIMIT = 300;
/** A whole-commit diff is read only below these; above them the answer is the file list. */
export const WHOLE_COMMIT_FILES = 60;
export const WHOLE_COMMIT_LINES = 4000;
const COMMIT_CONTEXT = 3;

async function resolveCommit(ctx, repo, hash) {
  checked(validateRevision, hash, 'hash');
  const oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision: hash });
  if (!oid) throw new McpError('COMMIT_NOT_FOUND', `No commit matches ${JSON.stringify(hash)}.`, { hint: 'A short hash may be ambiguous; get_history lists full hashes.' });
  return oid;
}

export async function getHistory(ctx, args) {
  const repo = ctx.repository(args.repository);
  const skip = readCursor(args.cursor);
  const options = { cwd: repo.path, log: ctx.log, limit: args.limit, skip };
  let page;
  let ref;
  if (args.all) {
    if (args.branch !== null) throw new McpError('INVALID_ARGUMENT', 'Pass either branch or all: true, not both.');
    ref = '--all';
    page = await loadHistoryPage(options);
  } else {
    ref = args.branch ?? 'HEAD';
    checked(validateRevision, ref, 'branch');
    const oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision: ref });
    if (!oid) {
      if (args.branch === null) return { repository: repo.path, ref, commits: [], nextCursor: null, unborn: true };
      throw new McpError('REF_NOT_FOUND', `No branch, tag or commit is named ${JSON.stringify(ref)}.`, { hint: 'get_workspace_context names the current branch.' });
    }
    page = await loadRefHistory({ ...options, revision: oid });
  }
  return {
    repository: repo.path, ref,
    commits: page.commits.map(compactCommit),
    nextCursor: page.nextSkip === null ? null : String(page.nextSkip)
  };
}

async function commitWithCounts(ctx, repo, oid) {
  const commit = await loadCommit({ cwd: repo.path, log: ctx.log, oid });
  const counts = await loadCommitNumstat({ cwd: repo.path, log: ctx.log, oid, parent: commit.parents[0] ?? null });
  const files = commit.files.map(file => {
    const count = counts.get(file.path);
    return {
      path: file.path, status: statusWord(file.status),
      insertions: count ? count.insertions : null, deletions: count ? count.deletions : null,
      ...(count?.binary ? { binary: true } : {})
    };
  });
  const totals = files.reduce((sum, file) => ({
    files: sum.files + 1, insertions: sum.insertions + (file.insertions ?? 0), deletions: sum.deletions + (file.deletions ?? 0)
  }), { files: 0, insertions: 0, deletions: 0 });
  return { commit, files, totals };
}

export async function getCommit(ctx, args) {
  const repo = ctx.repository(args.repository);
  const oid = await resolveCommit(ctx, repo, args.hash);
  const { commit, files, totals } = await commitWithCounts(ctx, repo, oid);
  const truncated = files.length > COMMIT_FILE_LIMIT;
  return {
    repository: repo.path,
    hash: commit.oid, parents: commit.parents,
    author: commit.author, committedAt: commit.committedAt,
    subject: commit.subject, body: commit.body.trim(),
    files: truncated ? files.slice(0, COMMIT_FILE_LIMIT) : files, totals,
    ...(truncated ? { truncated: true, hint: `Only the first ${COMMIT_FILE_LIMIT} files are listed; get_commit_diff with a path reads any of them.` } : {})
  };
}

function fileFlags(patch) {
  return { binary: patch.binary, ...(patch.added ? { added: true } : {}), ...(patch.deleted ? { deleted: true } : {}) };
}

async function commitFileDiff(ctx, repo, oid, args) {
  const path = checked(validateFile, args.path, 'path');
  const { patch: text } = await loadFileDiff({ cwd: repo.path, log: ctx.log, oid, file: path });
  if (!text.trim()) throw new McpError('FILE_NOT_FOUND', `${path} did not change in this commit.`, { hint: 'get_commit lists the files a commit changed.' });
  const patch = parseFilePatchV1(text);
  const hunks = describeHunks(patch, 'c', COMMIT_CONTEXT, path);
  if (args.hunkId !== undefined) {
    if (parseHunkId(args.hunkId).side !== 'c') throw new McpError('INVALID_HUNK', 'That hunk belongs to the working tree.', { hint: 'Call get_diff_hunk for it.' });
    const hunk = hunks.find(item => item.id === args.hunkId);
    if (!hunk) throw new McpError('INVALID_HUNK', `Hunk ${args.hunkId} is not in ${path} in this commit.`);
    return { path, hunk: capHunk(hunk) };
  }
  const fitted = fitHunks(hunks, DIFF_BUDGET);
  return { path, ...fileFlags(patch), hunks: fitted.hunks, truncated: fitted.truncated, ...(fitted.truncated ? { hint: TRUNCATED_DIFF_HINT } : {}) };
}

/**
 * A whole commit, but only when it is small: the line counts decide before the
 * patch is read, so a vendored blob is never pulled into memory to be thrown
 * away. Chunks pair with the file list by order — both come from the same diff
 * machinery with `--no-renames` — and a count mismatch falls back to the list.
 */
async function wholeCommitDiff(ctx, repo, oid) {
  const { files, totals } = await commitWithCounts(ctx, repo, oid);
  const list = { files, totals, truncated: true, hint: 'This commit is too large to read whole. Call get_commit_diff with a path.' };
  if (files.length > WHOLE_COMMIT_FILES || totals.insertions + totals.deletions > WHOLE_COMMIT_LINES) return list;
  const chunks = splitPatchFiles(await loadCommitPatch({ cwd: repo.path, log: ctx.log, oid }));
  if (chunks.length !== files.length) return list;
  let budget = DIFF_BUDGET;
  let truncated = false;
  const diffs = files.map((file, index) => {
    const patch = parseFilePatchV1(chunks[index]);
    const fitted = fitHunks(describeHunks(patch, 'c', COMMIT_CONTEXT, file.path), budget);
    budget -= fitted.used;
    truncated ||= fitted.truncated;
    return { path: file.path, status: file.status, ...fileFlags(patch), hunks: fitted.hunks };
  });
  return { files: diffs, totals, truncated, ...(truncated ? { hint: TRUNCATED_DIFF_HINT } : {}) };
}

export async function getCommitDiff(ctx, args) {
  const repo = ctx.repository(args.repository);
  if (args.hunkId !== undefined && args.path === undefined) throw new McpError('INVALID_ARGUMENT', 'hunkId needs the path it belongs to.');
  const oid = await resolveCommit(ctx, repo, args.hash);
  const body = args.path !== undefined ? await commitFileDiff(ctx, repo, oid, args) : await wholeCommitDiff(ctx, repo, oid);
  return { repository: repo.path, hash: oid, ...body };
}
