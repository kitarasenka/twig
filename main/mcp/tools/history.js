import { loadCommit, loadCommitPatch, loadFileDiff, resolveRevision, validateFile, validateRevision } from '../../git/commit.js';
import { loadHistoryPage, loadRefHistory } from '../../git/history.js';
import { loadCommitNumstat } from '../../git/numstat.js';
import { parseFilePatchV1, splitPatchFiles } from '../../git/diff-parser.js';
import { McpError, checked } from '../errors.js';
import { readCursor } from '../arguments.js';
import {
  DIFF_BUDGET, TRUNCATED_DIFF_HINT, commitLine, describeHunks, fileLine, fitHunks, hunkTotals, parseHunkId, renderHunks,
  repositoryPreamble, shortHash
} from '../serialize.js';
import { renderHunk } from './changes.js';

/** Files a get_commit answer lists before it says the rest were left out. */
export const COMMIT_FILE_LIMIT = 300;
/** A whole-commit diff is read only below these; above them the answer is the file list. */
export const WHOLE_COMMIT_FILES = 60;
export const WHOLE_COMMIT_LINES = 4000;
const COMMIT_CONTEXT = 3;

async function resolveCommit(ctx, repo, hash) {
  checked(validateRevision, hash, 'hash');
  const oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision: hash });
  if (!oid) throw new McpError('COMMIT_NOT_FOUND', `No commit matches ${JSON.stringify(hash)}.`, { hint: 'A short hash may be ambiguous; get_history lists the commits.' });
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
      if (args.branch === null) return `${repositoryPreamble(repo)}HEAD: no commits yet\n`;
      throw new McpError('REF_NOT_FOUND', `No branch, tag or commit is named ${JSON.stringify(ref)}.`, { hint: 'get_workspace_context names the current branch.' });
    }
    page = await loadRefHistory({ ...options, revision: oid });
  }
  const lines = [`${ref === '--all' ? 'all branches' : ref}, newest first:`, ...page.commits.map(commitLine)];
  if (page.nextSkip !== null) lines.push(`… more: get_history with cursor "${page.nextSkip}"`);
  return `${repositoryPreamble(repo)}${lines.join('\n')}\n`;
}

const totalsLine = totals => `${totals.files} ${totals.files === 1 ? 'file' : 'files'}, +${totals.insertions} -${totals.deletions}`;

async function commitWithCounts(ctx, repo, oid) {
  const commit = await loadCommit({ cwd: repo.path, log: ctx.log, oid });
  const counts = await loadCommitNumstat({ cwd: repo.path, log: ctx.log, oid, parent: commit.parents[0] ?? null });
  const files = commit.files.map(file => {
    const count = counts.get(file.path);
    return {
      path: file.path, letter: file.status,
      insertions: count ? count.insertions : null, deletions: count ? count.deletions : null, binary: Boolean(count?.binary)
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
  const shown = files.length > COMMIT_FILE_LIMIT ? files.slice(0, COMMIT_FILE_LIMIT) : files;
  const { author } = commit;
  const lines = [
    `${commit.oid} ${commit.subject}`,
    `author: ${author.name} <${author.email}> ${author.date}`,
    ...(commit.committedAt !== author.date ? [`committed: ${commit.committedAt}`] : []),
    `parents: ${commit.parents.length ? commit.parents.map(shortHash).join(' ') : 'none (root commit)'}`
  ];
  const body = commit.body.trim();
  if (body) lines.push('', body, '');
  lines.push(`${totalsLine(totals)}:`, ...shown.map(fileLine));
  if (shown !== files) lines.push(`… ${files.length - shown.length} more files; get_commit_diff with a path reads any of them.`);
  return `${repositoryPreamble(repo)}${lines.join('\n')}\n`;
}

/** A file of a commit as text: its line, then its hunks or why there are none. */
function renderFile(header, patch, fitted) {
  const body = patch.binary ? '(binary: no text diff)\n' : fitted.hunks.length ? renderHunks(fitted.hunks) : `(${patch.mode ? 'mode change only' : 'no text change'})\n`;
  return `${header}\n${body}`;
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
    return renderHunk(repo, `${path} in ${shortHash(oid)}`, hunk);
  }
  const fitted = fitHunks(hunks, DIFF_BUDGET);
  const letter = patch.added ? 'A' : patch.deleted ? 'D' : 'M';
  const header = `${fileLine({ letter, path, binary: patch.binary, ...hunkTotals(hunks) })} (${shortHash(oid)})`;
  return repositoryPreamble(repo) + renderFile(header, patch, fitted) + (fitted.truncated ? `${TRUNCATED_DIFF_HINT}\n` : '');
}

/**
 * A whole commit, but only when it is small: the line counts decide before the
 * patch is read, so a vendored blob is never pulled into memory to be thrown
 * away. Chunks pair with the file list by order — both come from the same diff
 * machinery with `--no-renames` — and a count mismatch falls back to the list.
 */
async function wholeCommitDiff(ctx, repo, oid) {
  const { commit, files, totals } = await commitWithCounts(ctx, repo, oid);
  const title = `${shortHash(oid)} ${commit.subject} (${totalsLine(totals)})`;
  const list = () => `${title}\n${files.map(file => fileLine(file)).join('\n')}\nThis commit is too large to read whole: get_commit_diff with a path reads one file.\n`;
  if (files.length > WHOLE_COMMIT_FILES || totals.insertions + totals.deletions > WHOLE_COMMIT_LINES) return list();
  const chunks = splitPatchFiles(await loadCommitPatch({ cwd: repo.path, log: ctx.log, oid }));
  if (chunks.length !== files.length) return list();
  let budget = DIFF_BUDGET;
  let truncated = false;
  const parts = files.map((file, index) => {
    const patch = parseFilePatchV1(chunks[index]);
    const fitted = fitHunks(describeHunks(patch, 'c', COMMIT_CONTEXT, file.path), budget);
    budget -= fitted.used;
    truncated ||= fitted.truncated;
    return renderFile(`## ${fileLine(file)}`, patch, fitted);
  });
  return `${title}\n${parts.join('')}${truncated ? `${TRUNCATED_DIFF_HINT} (get_commit_diff with the path and hunkId)\n` : ''}`;
}

export async function getCommitDiff(ctx, args) {
  const repo = ctx.repository(args.repository);
  if (args.hunkId !== undefined && args.path === undefined) throw new McpError('INVALID_ARGUMENT', 'hunkId needs the path it belongs to.');
  const oid = await resolveCommit(ctx, repo, args.hash);
  if (args.path !== undefined) return commitFileDiff(ctx, repo, oid, args);
  return repositoryPreamble(repo) + await wholeCommitDiff(ctx, repo, oid);
}
