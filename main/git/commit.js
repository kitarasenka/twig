import { runGit } from './exec.js';

export function validateOid(oid) {
  if (typeof oid !== 'string' || !/^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid)) throw new TypeError('Invalid commit identifier');
  return oid;
}

export function validateFile(file) {
  if (typeof file !== 'string' || !file || file.length > 32768 || file.includes('\0')
    || file.startsWith('/') || file.split('/').some(part => part === '..')) throw new TypeError('Invalid file path');
  return file;
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
  const raw = await execute(cwd, log, ['show', '--no-patch', '--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%B', oid, '--'], 'Read commit');
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
  const argv = base
    ? ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', base, oid, '--', `:(literal)${file}`]
    : ['show', '--format=', '--first-parent', '--no-ext-diff', '--no-textconv', '--no-renames', oid, '--', `:(literal)${file}`];
  const patch = await execute(cwd, log, argv, 'Read file diff');
  return { patch, binary: /^(?:Binary files |GIT binary patch)/m.test(patch) };
}

export async function loadRangeFiles({ cwd, log, base, oid }) {
  validateOid(base); validateOid(oid);
  return parseChangedFiles(await execute(cwd, log, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-status', '-z', base, oid, '--'], 'Compare commits'));
}
