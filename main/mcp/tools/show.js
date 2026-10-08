import { loadCommit, loadCommitDiffs, resolveRevision, validateRevision } from '../../git/commit.js';
import { loadCommitNumstat } from '../../git/numstat.js';
import { McpError, checked } from '../errors.js';
import { fileLine, repositoryPreamble, shortHash } from '../serialize.js';
import { fileBlocks, fitPatches, leftOutLine, patchBudget, shellWord, sizeReason, unifiedFlag } from '../file-patches.js';

/** Files a get_commit answer lists before it says the rest were left out. */
export const COMMIT_FILE_LIMIT = 300;

async function resolveCommit(ctx, repo, hash) {
  checked(validateRevision, hash, 'hash');
  const oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision: hash });
  if (!oid) throw new McpError('COMMIT_NOT_FOUND', `No commit matches ${JSON.stringify(hash)}.`, { hint: 'A short hash may be ambiguous: pass more of it, or a branch or tag name.' });
  return oid;
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

/**
 * How to read files of this commit the answer left out: their patch only —
 * the answer already gave the message — and a merge's against its first
 * parent, as here, not as Git's combined diff.
 * @param {string[]} paths
 */
export function showCommand(commit, paths, context) {
  return `git show --format=${commit.parents.length > 1 ? ' --first-parent' : ''}${unifiedFlag(context)} ${shortHash(commit.oid)} -- ${paths.map(shellWord).join(' ')}`;
}

/**
 * One commit in one answer: its message and every changed file with its
 * patch against the first parent, the way list_changes shows the working
 * tree — lock and generated files, files over the line limit and whatever does
 * not fit are listed with the git command that reads them.
 */
export async function getCommit(ctx, args) {
  const repo = ctx.repository(args.repository);
  const oid = await resolveCommit(ctx, repo, args.hash);
  const { commit, files, totals } = await commitWithCounts(ctx, repo, oid);
  const page = files.slice(0, COMMIT_FILE_LIMIT);
  const { author } = commit;
  const lines = [
    `${commit.oid} ${commit.subject}`,
    `author: ${author.name} <${author.email}> ${author.date}`,
    ...(commit.committedAt !== author.date ? [`committed: ${commit.committedAt}`] : []),
    `parents: ${commit.parents.length ? commit.parents.map(shortHash).join(' ') : 'none (root commit)'}`
  ];
  const body = commit.body.trim();
  if (body) lines.push('', body, '');
  lines.push(`${totalsLine(totals)}${commit.parents.length > 1 ? ' against the first parent' : ''}:`);
  if (!args.diffs) lines.push(...page.map(fileLine));
  else {
    const command = paths => showCommand(commit, paths, args.contextLines);
    const read = file => command([file.path]);
    const budget = patchBudget(args.maxBytes, lines.join('\n'), page);
    for (const file of page) file.note = file.binary ? null : sizeReason(file, read(file));
    const readable = page.filter(file => !file.note && !file.binary);
    const patches = await loadCommitDiffs({ cwd: repo.path, log: ctx.log, oid, paths: readable.map(file => file.path), context: args.contextLines });
    for (const file of readable) file.patch = patches.get(file.path);
    fitPatches(page, budget);
    lines.push(...fileBlocks(page));
    const left = leftOutLine(page, command);
    if (left) lines.push(left);
  }
  if (page.length < files.length) lines.push(`… ${files.length - page.length} more files: git show --name-status ${shortHash(oid)}`);
  return `${repositoryPreamble(repo)}${lines.join('\n')}\n`;
}
