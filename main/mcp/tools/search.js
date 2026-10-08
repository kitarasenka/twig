import vm from 'node:vm';
import { resolveRevision, validateFile, validateRevision } from '../../git/commit.js';
import { parseFilePatchV1 } from '../../git/diff-parser.js';
import { LIMIT_MAX, PATCH_MODES, SearchPatternError, searchCommits, validateSearchQuery } from '../../git/pickaxe.js';
import { McpError, checked } from '../errors.js';
import { readCursor } from '../arguments.js';
import { DIFF_BUDGET, commitLine, fileLine, hunkPatch, repositoryPreamble, shortHash } from '../serialize.js';
import { isGeneratedPath, shellWord } from '../file-patches.js';

/** Windows one file shows before it says how many more matched. */
export const WINDOWS_PER_FILE = 5;
/** A search that walks the whole history of a big repository can take long; MCP clients give up near 60 s. */
export const SEARCH_TIMEOUT_MS = 45_000;
/** How long marking the lines a regex matches may take, for a whole page. */
export const REGEX_TIMEOUT_MS = 1000;

/**
 * The lines a reader needs to see a match: each added or removed line that
 * matches, with `context` lines around it inside its hunk; windows that
 * touch are merged. Every window gets the header Git would print for it —
 * real line numbers on both sides and the hunk's heading — so it reads as a
 * small hunk of its own.
 * @param {import('../../git/diff-parser.js').Hunk} hunk
 * @param {(text: string) => boolean} matches
 * @param {number} context
 */
export function matchWindows(hunk, matches, context) {
  const hits = [];
  hunk.lines.forEach((line, index) => { if (line.kind !== 'context' && matches(line.text)) hits.push(index); });
  const ranges = [];
  for (const index of hits) {
    const from = Math.max(0, index - context);
    const to = Math.min(hunk.lines.length - 1, index + context);
    if (ranges.length && from <= ranges.at(-1)[1] + 1) ranges.at(-1)[1] = Math.max(ranges.at(-1)[1], to);
    else ranges.push([from, to]);
  }
  return ranges.map(([from, to]) => {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;
    for (const line of hunk.lines.slice(0, from)) {
      if (line.kind !== 'add') oldLine++;
      if (line.kind !== 'delete') newLine++;
    }
    const lines = hunk.lines.slice(from, to + 1);
    const oldLines = lines.filter(line => line.kind !== 'add').length;
    const newLines = lines.filter(line => line.kind !== 'delete').length;
    // Git names the line before an empty side (`-5,0`), and 0 at the top of a file.
    return {
      oldStart: oldLines === 0 ? Math.max(0, oldLine - 1) : oldLine, oldLines,
      newStart: newLines === 0 ? Math.max(0, newLine - 1) : newLine, newLines,
      heading: hunk.heading, lines
    };
  });
}

/**
 * Which changed lines match, as `{ matches }` or `{ reason }` when that
 * cannot be told here. Git's -G is POSIX extended regex, which JavaScript
 * reads nearly the same. The pattern comes from an agent and runs in the main
 * process, so it runs in a vm with a deadline: a pattern that backtracks
 * forever marks no lines instead of freezing 🌱 Twig.
 * @param {string} mode @param {string} query @param {string[]} texts every changed line of the page
 */
export function lineMatcher(mode, query, texts) {
  if (mode === 'code') return { matches: text => text.includes(query) };
  const unique = [...new Set(texts)];
  let flags;
  try {
    flags = vm.runInNewContext('lines.map(line => pattern.test(line))', { lines: unique, pattern: new RegExp(query) }, { timeout: REGEX_TIMEOUT_MS });
  } catch (error) {
    return { reason: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'the pattern is too slow to mark lines' : 'the pattern is not one JavaScript reads' };
  }
  const hits = new Set(unique.filter((_, index) => flags[index]));
  return { matches: text => hits.has(text) };
}

const DESCRIBE = {
  code: query => `where ${JSON.stringify(query)} was added or removed`,
  regex: query => `with an added or removed line matching /${query}/`,
  message: query => `whose message contains ${JSON.stringify(query)}`,
  author: query => `by an author matching ${JSON.stringify(query)}`
};

/** One matching file of one commit: its line, then the windows, or why there are none. */
function renderFile(file, oid, matcher, context, room) {
  const { parsed: patch } = file;
  const totals = patch.hunks.flatMap(hunk => hunk.lines).reduce((sum, line) => ({
    insertions: sum.insertions + (line.kind === 'add'), deletions: sum.deletions + (line.kind === 'delete')
  }), { insertions: 0, deletions: 0 });
  const letter = patch.added ? 'A' : patch.deleted ? 'D' : 'M';
  const head = `## ${fileLine({ letter, path: file.path ?? '(unnamed)', binary: patch.binary, ...totals })}`;
  const readIt = `git show --format= ${shortHash(oid)} -- ${shellWord(file.path ?? '')}`;
  if (patch.binary) return { text: `${head}\n(binary)\n`, cut: false };
  if (isGeneratedPath(file.path ?? '')) return { text: `${head}\n(lock or generated file: ${readIt})\n`, cut: false };
  if (!matcher.matches) return { text: `${head}\n(matching lines not marked: ${matcher.reason}; ${readIt})\n`, cut: false };
  const windows = patch.hunks.flatMap(hunk => matchWindows(hunk, matcher.matches, context));
  if (!windows.length) return { text: `${head}\n(the match spans several lines: ${readIt})\n`, cut: false };
  const shown = windows.slice(0, WINDOWS_PER_FILE).map(hunkPatch).join('');
  const more = windows.length - WINDOWS_PER_FILE;
  const text = `${head}\n${shown}${more > 0 ? `… ${more} more ${more === 1 ? 'match' : 'matches'} in this file: ${readIt}\n` : ''}`;
  if (Buffer.byteLength(text) <= room) return { text, cut: false };
  return { text: `${head}\n(${windows.length} ${windows.length === 1 ? 'match' : 'matches'} not shown: this answer is full; ${readIt})\n`, cut: true };
}

export async function searchHistory(ctx, args) {
  const repo = ctx.repository(args.repository);
  const query = checked(validateSearchQuery, args.query, 'query');
  const skip = readCursor(args.cursor);
  if (skip + args.limit + 1 > LIMIT_MAX) {
    throw new McpError('INVALID_ARGUMENT', `A search reads at most its first ${LIMIT_MAX} matching commits.`, { hint: 'Narrow it with path or branch.' });
  }
  const path = args.path === undefined ? null : checked(validateFile, args.path, 'path');
  let revision = 'HEAD';
  if (args.all) {
    if (args.branch !== null) throw new McpError('INVALID_ARGUMENT', 'Pass either branch or all: true, not both.');
  } else {
    revision = args.branch ?? 'HEAD';
    checked(validateRevision, revision, 'branch');
    const oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision });
    if (!oid) {
      if (args.branch === null) return `${repositoryPreamble(repo)}HEAD: no commits yet\n`;
      throw new McpError('REF_NOT_FOUND', `No branch, tag or commit is named ${JSON.stringify(revision)}.`, { hint: 'get_workspace_context names the current branch.' });
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  let page;
  try {
    page = await searchCommits({
      cwd: repo.path, log: ctx.log, signal: controller.signal,
      query, mode: args.mode, revision, all: args.all, path, limit: args.limit, skip, context: args.contextLines
    });
  } catch (error) {
    if (error instanceof SearchPatternError) throw new McpError('INVALID_ARGUMENT', `Git cannot use that pattern: ${error.message}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  if (page.cancelled) {
    throw new McpError('GIT_OPERATION_FAILED', `The search took longer than ${SEARCH_TIMEOUT_MS / 1000} s.`,
      { hint: 'Narrow it with path, a branch, or a smaller limit.' });
  }

  const where = `${args.all ? 'all branches' : args.branch ?? 'HEAD'}${path === null ? '' : `, in ${path}`}`;
  const lines = [`${where}: commits ${DESCRIBE[args.mode](query)}, newest first:`];
  if (!page.commits.length) lines[0] = `${where}: no commits ${skip ? 'left ' : ''}${DESCRIBE[args.mode](query)}`;
  const files = page.commits.flatMap(commit => commit.files);
  for (const file of files) file.parsed = parseFilePatchV1(file.patch);
  const matcher = PATCH_MODES.includes(args.mode)
    ? lineMatcher(args.mode, query, files.flatMap(file => file.parsed.hunks.flatMap(hunk => hunk.lines.filter(line => line.kind !== 'context').map(line => line.text))))
    : null;
  // Commits go in whole while they fit. The first always goes in, its files
  // cut to what fits; past it, a commit that does not fit starts the next page.
  let room = DIFF_BUDGET;
  let shown = 0;
  let full = false;
  for (const commit of page.commits) {
    const parts = [commitLine(commit)];
    let left = room - Buffer.byteLength(parts[0]) - 1;
    let cut = false;
    for (const file of commit.files) {
      const rendered = renderFile(file, commit.oid, matcher, args.contextLines, left);
      left -= Buffer.byteLength(rendered.text);
      cut ||= rendered.cut;
      parts.push(rendered.text.replace(/\n$/, ''));
    }
    if (shown && (cut || left < 0)) break;
    lines.push(...parts);
    room = left;
    full ||= cut;
    shown++;
  }
  const next = shown < page.commits.length ? skip + shown : page.nextSkip;
  if (full) lines.push('Some matches did not fit in one answer; each such file names the git show that reads it.');
  if (next !== null) lines.push(`… more: search_history with cursor "${next}"`);
  return `${repositoryPreamble(repo)}${lines.join('\n')}\n`;
}
