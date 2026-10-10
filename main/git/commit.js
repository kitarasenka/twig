import { runGit } from './exec.js';
import { parseFilePatchV1, splitPatchFiles } from './diff-parser.js';
import { chunkPath } from './worktree.js';

export function validateOid(oid) {
  if (typeof oid !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid)) throw new TypeError('Invalid commit identifier');
  return oid;
}

export function validateFile(file) {
  if (typeof file !== 'string' || !file || file.length > 32768 || file.includes('\0')
    || file.startsWith('/') || file.split('/').some(part => part === '..')) throw new TypeError('Invalid file path');
  return file;
}

// A short or full hash, or a ref name with `~N` / `^N` steps after it. The
// name is not checked for existence here — `resolveRevision` asks Git — only
// that it cannot be read as an option or as revision syntax Git would expand.
const HEX_REVISION = /^[0-9a-f]{4,64}$/i;
const REF_REVISION = /^([^~^]+)((?:~\d{0,6}|\^\d?)*)$/;
const REF_FORBIDDEN = /[\0-\x20\x7f:?*[\\]/;

export function validateRevision(revision) {
  if (typeof revision !== 'string' || !revision || revision.length > 255) throw new TypeError('Invalid revision');
  if (HEX_REVISION.test(revision)) return revision;
  const match = REF_REVISION.exec(revision);
  const name = match?.[1];
  if (!name || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.')
    || name.endsWith('.lock') || name.includes('..') || name.includes('//') || name.includes('@{')
    || REF_FORBIDDEN.test(name) || name.split('/').some(part => part.startsWith('.'))) throw new TypeError('Invalid revision');
  return revision;
}

async function execute(cwd, log, argv, operation) {
  const result = await runGit({ cwd, log, argv, operation });
  if (result.code !== 0) throw new Error(`${operation} failed. See the command console.`);
  return result.stdout;
}

export function parseChangedFiles(output) {
  if (!output) return [];
  const tokens = output.split('\0');
  if (tokens.pop() !== '' || tokens.length % 2) throw new Error('Invalid changed-file output');
  const result = [];
  for (let i = 0; i < tokens.length; i += 2) {
    if (!/^[AMDTUXB]$/.test(tokens[i]) || !tokens[i + 1]) throw new Error('Invalid changed-file record');
    result.push({ status: tokens[i], path: tokens[i + 1] });
  }
  return result;
}

export async function loadCommit({ cwd, log, oid }) {
  validateOid(oid);
  const raw = await execute(cwd, log, ['show', '--no-patch', '--no-show-signature', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B', oid, '--'], 'Read commit');
  const fields = raw.split('\0');
  if (fields.length !== 7) throw new Error('Invalid commit output');
  const [id, parentText, name, email, date, committedAt, message] = fields;
  const parents = parentText ? parentText.split(' ') : [];
  const changed = await execute(cwd, log, ['diff-tree', '--root', '-r', '--no-commit-id', '--name-status', '-z', '--no-renames', ...(parents.length ? [parents[0]] : []), oid, '--'], 'Read changed files');
  const body = message.replace(/\n$/, '');
  const newline = body.indexOf('\n');
  return { oid: id, parents, author: { name, email, date }, committedAt,
    subject: newline < 0 ? body : body.slice(0, newline), body: newline < 0 ? '' : body.slice(newline + 1), files: parseChangedFiles(changed) };
}

export async function loadCommitFiles({ cwd, log, oid }) {
  validateOid(oid);
  const raw = await execute(cwd, log, ['ls-tree', '-r', '--name-only', '-z', oid, '--'], 'Read commit tree');
  return raw.split('\0').filter(Boolean).map(file => ({ path: file, status: ' ' }));
}

export async function loadFileDiff({ cwd, log, oid, file, base = null }) {
  validateOid(oid); validateFile(file);
  if (base !== null) validateOid(base);
  // `-c color.ui=false` does not override a person's more specific
  // `color.diff = always`: without `--no-color` this diff arrived with escape
  // codes and the panel could not find a single hunk in it.
  const plain = ['--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--no-renames'];
  const argv = base
    ? ['diff', ...plain, base, oid, '--', `:(literal)${file}`]
    : ['show', '--format=', '--first-parent', ...plain, oid, '--', `:(literal)${file}`];
  const patch = await execute(cwd, log, argv, 'Read file diff');
  return { patch, binary: /^(?:Binary files |GIT binary patch)/m.test(patch) };
}

export async function loadRangeFiles({ cwd, log, base, oid }) {
  validateOid(base); validateOid(oid);
  return parseChangedFiles(await execute(cwd, log, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, oid, '--'], 'Compare commits'));
}

/**
 * Resolves a short hash, a ref name or `HEAD~2` to a full commit id, or null
 * when nothing by that name is a commit — including an ambiguous short hash and
 * an unborn HEAD. `--end-of-options` keeps the revision a revision.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, revision: string }} options
 * @returns {Promise<?string>}
 */
export async function resolveRevision({ cwd, log, revision }) {
  validateRevision(revision);
  const result = await runGit({ cwd, log, argv: ['rev-parse', '--verify', '--quiet', '--end-of-options', `${revision}^{commit}`], operation: 'Resolve commit id' });
  const oid = result.code === 0 ? result.stdout.trim() : '';
  return /^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(oid) ? oid : null;
}

/**
 * Several files' patches in one commit, against its first parent (a root
 * commit against nothing), each path literal. `context` is the number of
 * unchanged lines around each change, Git's own 3 when null.
 */
export function buildCommitDiffsArgv({ oid, paths, context = null }) {
  validateOid(oid);
  if (!Array.isArray(paths) || paths.length === 0) throw new TypeError('Invalid path list');
  if (context !== null && (!Number.isInteger(context) || context < 0 || context > 100)) throw new TypeError('Invalid context line count');
  return ['show', '--format=', '--first-parent', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--src-prefix=a/', '--dst-prefix=b/',
    ...(context === null ? [] : [`--unified=${context}`]), oid, '--', ...paths.map(file => `:(literal)${validateFile(file)}`)];
}

/**
 * Patches of the named files of one commit, by path — one `git show` for all
 * of them, its chunks matched to paths by their headers the way
 * `loadWorktreeDiffs` does. A path whose chunk cannot be matched for certain
 * is read on its own; one with no chunk had no text change.
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, oid: string, paths: string[], context?: ?number }} options
 * @returns {Promise<Map<string, import('./diff-parser.js').FilePatch>>}
 */
export async function loadCommitDiffs({ cwd, log, oid, paths, context = null }) {
  const patches = new Map();
  if (paths.length === 0) return patches;
  const read = async files => execute(cwd, log, buildCommitDiffsArgv({ oid, paths: files, context }), 'Read commit diff');
  const wanted = new Set(paths);
  const chunks = new Map();
  let unsure = false;
  for (const chunk of splitPatchFiles(await read(paths))) {
    const file = chunkPath(chunk);
    if (file === null || !wanted.has(file)) unsure = true;
    else if (chunks.has(file)) chunks.set(file, null);
    else chunks.set(file, chunk);
  }
  for (const file of paths) {
    const chunk = chunks.get(file);
    if (chunk) patches.set(file, parseFilePatchV1(chunk));
    else if (chunk === null || unsure) patches.set(file, parseFilePatchV1(await read([file])));
    else patches.set(file, parseFilePatchV1(''));
  }
  return patches;
}
