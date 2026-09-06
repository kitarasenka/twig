import { runGit } from './exec.js';
import { validateFile, validateOid } from './commit.js';
import { parseFilePatchV1 } from './diff-parser.js';
import { mapLineBack } from './blame-map.js';

const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MAX_LINES = 50000;

export class BlameError extends Error {
  constructor(message, code = 'git') {
    super(message);
    this.name = 'BlameError';
    this.code = code;
  }
}

export function validateLine(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_LINES) throw new TypeError('Invalid line number');
  return value;
}

/**
 * `git blame` treats every argv token after `--` as a pathspec magic-free
 * path, unlike `git log`/`git diff` where a bare name is still glob-expanded
 * and `:(literal)` has to be spelled out. So the path is passed raw after `--`
 * here — adding `:(literal)` would make blame look for a file whose name
 * literally starts with `:(literal)`. `--no-textconv` forbids any external
 * textconv filter from running while the blob is read.
 */
export function buildBlameArgv(oid, path) {
  validateOid(oid);
  validateFile(path);
  return ['blame', '--line-porcelain', '--no-textconv', oid, '--', path];
}

/**
 * Reverse blame over `START..END`: for every line of the file as it stands in
 * START, the newest commit in the range in which that line still existed. A
 * line that reaches END is attributed to END itself (no `boundary` marker in
 * this mode), which is the only signal that separates "present at end" from
 * "last present in <commit>".
 */
export function buildReverseBlameArgv(startOid, endOid, path) {
  validateOid(startOid);
  validateOid(endOid);
  validateFile(path);
  return ['blame', '--line-porcelain', '--no-textconv', '--reverse', `${startOid}..${endOid}`, '--', path];
}

/** Undo Git's C-quoting of a path (`core.quotePath`): octal escapes are UTF-8 bytes. */
function unquotePath(value) {
  if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) return value;
  const body = value.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue; }
    const next = body[++i];
    if (next === 'n') bytes.push(10);
    else if (next === 't') bytes.push(9);
    else if (next === 'r') bytes.push(13);
    else if (next === 'b') bytes.push(8);
    else if (next === 'f') bytes.push(12);
    else if (next === '"') bytes.push(34);
    else if (next === '\\') bytes.push(92);
    else if (next >= '0' && next <= '7') { bytes.push(parseInt(body.slice(i, i + 3), 8) & 0xff); i += 2; }
    else bytes.push(...Buffer.from(next, 'utf8'));
  }
  return Buffer.from(bytes).toString('utf8');
}

function isoFromEpoch(seconds, tz) {
  const match = /^([+-])(\d{2})(\d{2})$/.exec(tz) || ['', '+', '00', '00'];
  const offset = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  const shifted = new Date((seconds + offset * 60) * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
    + `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
    + `${match[1] || '+'}${match[2]}:${match[3]}`;
}

const HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) (\d+) (\d+)(?: (\d+))?$/i;

/**
 * Parses `git blame --line-porcelain` output. Every line carries a full
 * header block, so commit metadata is de-duplicated into `commits` and each
 * entry in `lines` keeps only what is per-line: the numbers, the boundary and
 * previous markers, the filename at that commit and the raw text.
 *
 * The text is everything after the first TAB of the content line: a code line
 * that itself begins with a TAB keeps that TAB.
 * @param {string} output
 * @returns {{ lines: object[], commits: Record<string, object> }}
 */
export function parseBlamePorcelain(output) {
  if (typeof output !== 'string') throw new BlameError('blame output must be a string', 'parse');
  const lines = [];
  const commits = {};
  if (output.length === 0) return { lines, commits };
  const rows = output.split('\n');
  if (rows.at(-1) === '') rows.pop();

  let i = 0;
  while (i < rows.length) {
    const head = HEADER.exec(rows[i++]);
    if (!head) throw new BlameError('malformed blame header', 'parse');
    const oid = head[1].toLowerCase();
    const entry = { oid, origLine: Number(head[2]), line: Number(head[3]), boundary: false, previous: null, filename: null };
    const meta = commits[oid] || (commits[oid] = { oid, boundary: false, summary: '', author: null, committer: null });
    const raw = { author: {}, committer: {} };
    let content = null;
    for (; i < rows.length; i++) {
      const row = rows[i];
      if (row.startsWith('\t')) { content = row.slice(1); i++; break; }
      const gap = row.indexOf(' ');
      const key = gap === -1 ? row : row.slice(0, gap);
      const value = gap === -1 ? '' : row.slice(gap + 1);
      if (key === 'boundary') { entry.boundary = true; meta.boundary = true; }
      else if (key === 'filename') entry.filename = unquotePath(value);
      else if (key === 'previous') {
        const space = value.indexOf(' ');
        if (space === -1 || !OID.test(value.slice(0, space))) throw new BlameError('malformed previous marker', 'parse');
        entry.previous = { oid: value.slice(0, space).toLowerCase(), path: unquotePath(value.slice(space + 1)) };
      }
      else if (key === 'summary') meta.summary = value;
      else if (key === 'author') raw.author.name = value;
      else if (key === 'author-mail') raw.author.email = value.replace(/^<|>$/g, '');
      else if (key === 'author-time') raw.author.time = Number(value);
      else if (key === 'author-tz') raw.author.tz = value;
      else if (key === 'committer') raw.committer.name = value;
      else if (key === 'committer-mail') raw.committer.email = value.replace(/^<|>$/g, '');
      else if (key === 'committer-time') raw.committer.time = Number(value);
      else if (key === 'committer-tz') raw.committer.tz = value;
    }
    if (content === null) throw new BlameError('truncated blame group', 'parse');
    if (content.includes('\0')) throw new BlameError('binary file', 'binary');
    if (!meta.author && raw.author.name !== undefined) {
      meta.author = { name: raw.author.name, email: raw.author.email || '', date: isoFromEpoch(raw.author.time, raw.author.tz || '+0000') };
      meta.committer = { name: raw.committer.name || raw.author.name, email: raw.committer.email || '', date: isoFromEpoch(raw.committer.time ?? raw.author.time, raw.committer.tz || raw.author.tz || '+0000') };
    }
    entry.content = content;
    lines.push(entry);
    if (lines.length > MAX_LINES) throw new BlameError('This file is too large to blame.', 'too-large');
  }
  return { lines, commits };
}

function classify(stderr) {
  const text = (stderr || '').trim();
  if (/no such path|does not exist in|no such ref/i.test(text)) return new BlameError('This file does not exist in that version.', 'absent');
  if (/is a directory/i.test(text)) return new BlameError('That path is a directory, not a file.', 'absent');
  return new BlameError('Git could not blame this file. Show output in the console.', 'git');
}

/** @param {{ cwd: string, log: object, oid: string, path: string, signal?: ?AbortSignal }} options */
export async function loadBlame({ cwd, log, oid, path, signal = null }) {
  const argv = buildBlameArgv(oid, path);
  const result = await runGit({ argv, cwd, log, operation: 'Blame file', signal });
  if (result.cancelled) throw new BlameError('Blame was cancelled.', 'cancelled');
  if (result.code !== 0) throw classify(result.stderr);
  const parsed = parseBlamePorcelain(result.stdout);
  return { mode: 'blame', oid, path, ...parsed };
}

/**
 * @param {{ cwd: string, log: object, startOid: string, endOid: string, path: string, signal?: ?AbortSignal }} options
 */
export async function loadReverseBlame({ cwd, log, startOid, endOid, path, signal = null }) {
  validateOid(startOid); validateOid(endOid); validateFile(path);
  // Resolving happens in the IPC layer; here START..END is assumed valid and
  // START==END is the caller's job to route to loadBlame. A plain guard stays
  // so a bad range never reaches Git as `X..X`.
  if (startOid === endOid) throw new TypeError('Reverse blame needs a non-empty range');
  const argv = buildReverseBlameArgv(startOid, endOid, path);
  const result = await runGit({ argv, cwd, log, operation: 'Reverse blame file', signal });
  if (result.cancelled) throw new BlameError('Reverse blame was cancelled.', 'cancelled');
  if (result.code !== 0) throw classify(result.stderr);
  const parsed = parseBlamePorcelain(result.stdout);
  return { mode: 'reverse', startOid, endOid, path, ...parsed };
}

async function git(cwd, log, argv, operation, signal) {
  const result = await runGit({ argv, cwd, log, operation, signal });
  return result;
}

/**
 * Where "Blame before this change" should land for one line.
 *
 * The authoritative source is the `previous` marker Git itself computed for
 * that line (it already followed renames to find it). For a merge commit the
 * caller can ask for a specific parent instead; the line's path in that parent
 * is checked for existence and, failing that, for a rename, so an approximate
 * path is never blamed silently.
 *
 * @param {{ cwd, log, oid, path, line, parentIndex?: ?number, signal?: ?AbortSignal }} options
 */
export async function loadBlameBefore({ cwd, log, oid, path, line, parentIndex = null, signal = null }) {
  validateOid(oid); validateFile(path); validateLine(line);
  if (parentIndex !== null && (!Number.isInteger(parentIndex) || parentIndex < 0)) throw new TypeError('Invalid parent index');

  const parentsRaw = await git(cwd, log, ['rev-list', '--parents', '-n', '1', oid], 'Read commit parents', signal);
  if (parentsRaw.code !== 0) throw classify(parentsRaw.stderr);
  const ids = parentsRaw.stdout.trim().split(/\s+/).slice(1).filter(id => OID.test(id));
  if (ids.length === 0) return { kind: 'root', message: 'This is the first commit; the file has no earlier version here.' };
  if (parentIndex !== null && parentIndex >= ids.length) throw new TypeError('Invalid parent index');

  let target = null;
  if (parentIndex === null) {
    const current = await loadBlame({ cwd, log, oid, path, signal });
    const row = current.lines.find(item => item.line === line);
    if (!row) throw new BlameError('That line is not in this version of the file.', 'absent');
    if (row.previous) target = { oid: row.previous.oid, path: row.previous.path };
    else if (row.boundary) return { kind: 'shallow', message: 'The earlier version is outside this clone (shallow history).' };
    else if (ids.length > 1) target = null; // fall through to parent picker
    else target = { oid: ids[0], path };
  } else {
    target = { oid: ids[parentIndex], path };
  }

  if (!target) {
    const summaries = await Promise.all(ids.map(async id => {
      const shown = await git(cwd, log, ['show', '--no-patch', '--format=%s', id], 'Read parent subject', signal);
      return { oid: id, short: id.slice(0, 7), subject: shown.code === 0 ? shown.stdout.trim() : '' };
    }));
    return { kind: 'need-parent', message: 'This is a merge commit. Choose which parent to step back into.', parents: summaries };
  }

  // Confirm the path exists in the parent; otherwise look for a rename whose
  // new name is the path we have, and step back to the old name.
  const exists = await git(cwd, log, ['cat-file', '-e', `${target.oid}:${target.path}`], 'Check file in parent', signal);
  if (exists.code !== 0) {
    const renames = await git(cwd, log, ['diff', '-M', '--diff-filter=R', '--name-status', '-z', target.oid, oid, '--'], 'Find rename', signal);
    let renamed = null;
    if (renames.code === 0) {
      const tokens = renames.stdout.split('\0');
      for (let i = 0; i + 2 < tokens.length; i += 3) {
        if (/^R\d+$/.test(tokens[i]) && tokens[i + 2] === path) { renamed = tokens[i + 1]; break; }
      }
    }
    if (!renamed) return { kind: 'absent-in-parent', parent: target.oid.slice(0, 7), message: `The file did not exist in ${target.oid.slice(0, 7)}; there is nothing to blame before this.` };
    target = { oid: target.oid, path: renamed };
  }

  const blame = await loadBlame({ cwd, log, oid: target.oid, path: target.path, signal });
  const diff = await git(cwd, log, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', `${target.oid}:${target.path}`, `${oid}:${path}`], 'Read diff for line mapping', signal);
  let mapping = { range: null, exact: false, note: null };
  if (diff.code === 0) {
    try { mapping = mapLineBack(parseFilePatchV1(diff.stdout), line); }
    catch { mapping = { range: null, exact: false, note: null }; }
  }
  return { kind: 'ok', mode: 'blame', oid: target.oid, path: target.path, via: parentIndex !== null || ids.length > 1 ? target.oid.slice(0, 7) : null, mapping, ...blame };
}
