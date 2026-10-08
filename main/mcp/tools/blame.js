import { resolveRevision, validateFile, validateRevision } from '../../git/commit.js';
import { BlameError, loadBlameRange } from '../../git/blame.js';
import { McpError, checked } from '../errors.js';
import { DIFF_BUDGET, repositoryPreamble, shortHash } from '../serialize.js';
import { SEARCH_TIMEOUT_MS } from './search.js';

const UNCOMMITTED = /^0+$/;

/**
 * Consecutive lines that come from the same commit, as `{ oid, from, to, lines }`.
 * A blame answer is mostly these: a 1300-line file is a few hundred runs.
 */
export function blameRuns(lines) {
  const runs = [];
  for (const line of lines) {
    const last = runs.at(-1);
    if (last && last.oid === line.oid && last.to === line.line - 1) { last.to = line.line; last.lines.push(line.content); }
    else runs.push({ oid: line.oid, from: line.line, to: line.line, lines: [line.content] });
  }
  return runs;
}

const runLabel = oid => (UNCOMMITTED.test(oid) ? 'uncommitted' : shortHash(oid));
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const span = run => (run.from === run.to ? `${run.from}` : `${run.from}-${run.to}`);

/** `a1b2c3d4e5f6 2026-09-24 Ada Lovelace: subject` — the table under the runs, newest first. */
function commitRows(oids, commits) {
  return oids
    .filter(oid => !UNCOMMITTED.test(oid))
    .map(oid => commits[oid])
    .sort((a, b) => (b.author?.date ?? '').localeCompare(a.author?.date ?? ''))
    .map(commit => `${shortHash(commit.oid)} ${(commit.author?.date ?? '').slice(0, 10)} ${commit.author?.name ?? ''}: ${commit.summary}`);
}

const BLAME_ERRORS = {
  absent: ['FILE_NOT_FOUND', 'Pass a path as list_changes or get_commit prints it, relative to the repository root.'],
  range: ['INVALID_ARGUMENT', 'Ask for lines inside the file.'],
  binary: ['INVALID_ARGUMENT', 'A binary file has no lines to blame.'],
  'too-large': ['OUTPUT_TOO_LARGE', 'Pass startLine and endLine.']
};

export async function getBlame(ctx, args) {
  const repo = ctx.repository(args.repository);
  const path = checked(validateFile, args.path, 'path');
  const start = args.startLine ?? null;
  const end = args.endLine ?? null;
  if (start !== null && end !== null && end < start) throw new McpError('INVALID_ARGUMENT', 'endLine comes before startLine.');
  let oid = null;
  if (args.revision !== null) {
    checked(validateRevision, args.revision, 'revision');
    oid = await resolveRevision({ cwd: repo.path, log: ctx.log, revision: args.revision });
    if (!oid) throw new McpError('COMMIT_NOT_FOUND', `No commit matches ${JSON.stringify(args.revision)}.`, { hint: 'A short hash may be ambiguous: pass more of it, or a branch or tag name.' });
  }
  let blame;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    blame = await loadBlameRange({ cwd: repo.path, log: ctx.log, env: ctx.env, signal: controller.signal, oid, path, start, end });
  } catch (error) {
    if (!(error instanceof BlameError)) throw error;
    if (error.code === 'cancelled') {
      throw new McpError('GIT_OPERATION_FAILED', `Blame took longer than ${SEARCH_TIMEOUT_MS / 1000} s.`, { hint: 'Pass startLine and endLine.' });
    }
    const [code, hint] = BLAME_ERRORS[error.code] ?? ['GIT_OPERATION_FAILED', 'The command and its output are in 🌱 Twig’s console (Full History).'];
    throw new McpError(code, `${path}: ${error.message}`, { hint });
  } finally {
    clearTimeout(timer);
  }

  const runs = blameRuns(blame.lines);
  const shown = [];
  let room = DIFF_BUDGET;
  for (const run of runs) {
    const text = `${span(run)} ${runLabel(run.oid)}\n${args.code ? run.lines.map(line => `\t${line}\n`).join('') : ''}`;
    const size = Buffer.byteLength(text);
    if (size > room && shown.length) break;
    room -= size;
    shown.push(text);
  }
  const used = new Set(runs.slice(0, shown.length).map(run => run.oid));
  const all = new Set(runs.map(run => run.oid));
  const uncommitted = [...all].some(oid => UNCOMMITTED.test(oid));
  const committed = new Set([...all].filter(oid => !UNCOMMITTED.test(oid)));
  const first = blame.lines[0]?.line;
  const last = blame.lines.at(-1)?.line;
  const at = oid === null ? 'on disk' : `at ${shortHash(oid)}`;
  const lines = [
    `${path} ${at}, ${first === undefined ? 'no lines' : `lines ${first}-${last}`}: ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} from ${plural(committed.size, 'commit')}${uncommitted ? ', some not committed yet' : ''}`,
    shown.join('').replace(/\n$/, '')
  ];
  if (shown.length < runs.length) lines.push(`… lines ${runs[shown.length].from}-${last} not shown: get_blame with startLine ${runs[shown.length].from}`);
  const rows = commitRows([...used], blame.commits);
  if (rows.length) lines.push('commits:', ...rows);
  return `${repositoryPreamble(repo)}${lines.filter(Boolean).join('\n')}\n`;
}
