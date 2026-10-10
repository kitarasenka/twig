import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateFile, validateOid } from './commit.js';
import { MAX_IMAGE_BYTES, imageType } from './image-types.js';

/**
 * Both versions of one image file, as bytes, for the image viewer.
 *
 * Where each side comes from is the same pair a text diff of that file
 * compares: a commit against its first parent (or against `base` in a range),
 * a stash against the commit it was made on,
 * the index against HEAD for staged changes, the file on disk against the
 * index for unstaged ones, and only the disk for an untracked file. Git is
 * asked twice at most: one `cat-file --batch-check` learns whether each side
 * exists and how big it is, one `cat-file --batch` reads the sides that fit.
 * Both always exit 0 — a missing side is an answer, not a failed command — and
 * the journal records the byte count of the read, not the bytes. Nothing here
 * writes to the repository.
 */

const SOURCE_KINDS = ['commit', 'stash', 'staged', 'unstaged', 'untracked'];

/** @returns {{ kind: string, oid?: string, base?: ?string, untracked?: boolean }} */
export function validateImageSource(source) {
  if (!source || typeof source !== 'object' || !SOURCE_KINDS.includes(source.kind)) throw new TypeError('Invalid image source');
  if (source.kind === 'stash') {
    validateOid(source.oid);
    if (typeof source.untracked !== 'boolean') throw new TypeError('Invalid image source');
    return { kind: 'stash', oid: source.oid, untracked: source.untracked };
  }
  if (source.kind !== 'commit') return { kind: source.kind };
  validateOid(source.oid);
  if (source.base !== null && source.base !== undefined) validateOid(source.base);
  return { kind: 'commit', oid: source.oid, base: source.base ?? null };
}

/** The `<rev>:<path>` names of each side; `null` is a side Git does not hold (the disk, or nothing). */
export function imageObjectNames(source, file) {
  // A stash is the work tree on top of `^1`; its untracked files live in the
  // third parent, the same sides the stash screen's text diff compares.
  if (source.kind === 'stash') return source.untracked
    ? { old: null, new: `${source.oid}^3:${file}` }
    : { old: `${source.oid}^1:${file}`, new: `${source.oid}:${file}` };
  if (source.kind === 'commit') return { old: `${source.base ?? `${source.oid}^`}:${file}`, new: `${source.oid}:${file}` };
  if (source.kind === 'staged') return { old: `HEAD:${file}`, new: `:0:${file}` };
  if (source.kind === 'unstaged') return { old: `:0:${file}`, new: null };
  return { old: null, new: null };
}

/** One `--batch-check` line: `{ oid, type, size }`, or null for a name Git does not resolve. */
export function parseBatchCheckLine(line) {
  const match = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) (\d+)$/.exec(line);
  return match ? { oid: match[1], type: match[2], size: Number(match[3]) } : null;
}

/** Splits `cat-file --batch` output into `oid → bytes`; anything malformed stops the reading. */
export function parseBatchOutput(buffer) {
  const objects = new Map();
  let at = 0;
  while (at < buffer.length) {
    const end = buffer.indexOf(0x0a, at);
    if (end < 0) break;
    const header = parseBatchCheckLine(buffer.toString('utf8', at, end));
    if (!header || end + 1 + header.size > buffer.length) break;
    objects.set(header.oid, buffer.subarray(end + 1, end + 1 + header.size));
    at = end + 1 + header.size + 1;
  }
  return objects;
}

async function readGitSides({ cwd, log, names }) {
  const wanted = Object.entries(names).filter(([, name]) => name !== null);
  const sides = {};
  if (wanted.length === 0) return sides;
  const check = await runGit({ cwd, log, argv: ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
    stdin: `${wanted.map(([, name]) => name).join('\n')}\n`, operation: 'Read image versions' });
  if (check.code !== 0) throw new Error('Git could not read this image. See the command console.');
  const lines = check.stdout.split('\n');
  const reads = [];
  wanted.forEach(([side], index) => {
    const found = parseBatchCheckLine(lines[index] ?? '');
    if (!found) sides[side] = { state: 'missing' };
    else if (found.type !== 'blob') sides[side] = { state: 'other', reason: 'Git holds something other than a file here.' };
    else if (found.size > MAX_IMAGE_BYTES) sides[side] = { state: 'large', size: found.size };
    else { sides[side] = { state: 'ok', size: found.size, oid: found.oid }; reads.push(found); }
  });
  if (reads.length === 0) return sides;
  const unique = [...new Map(reads.map(item => [item.oid, item])).values()];
  const total = unique.reduce((sum, item) => sum + item.size + 160, 0);
  const result = await runGit({ cwd, log, argv: ['cat-file', '--batch'], stdin: `${unique.map(item => item.oid).join('\n')}\n`,
    operation: 'Read image bytes', binary: true, maxBytes: total });
  if (result.code !== 0 || result.truncated) throw new Error('Git could not read this image. See the command console.');
  const objects = parseBatchOutput(result.stdout);
  for (const side of Object.keys(sides)) {
    if (sides[side].state !== 'ok') continue;
    const bytes = objects.get(sides[side].oid);
    sides[side] = bytes ? { state: 'ok', size: bytes.length, bytes } : { state: 'missing' };
  }
  return sides;
}

/** The file as it is on disk now — never through a symbolic link, never outside the working tree. */
export async function readDiskSide(cwd, file) {
  const root = await realpath(cwd);
  const absolute = path.resolve(root, ...file.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('Invalid file path');
  let stats;
  try { stats = await lstat(absolute); } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { state: 'missing' };
    throw error;
  }
  if (stats.isSymbolicLink()) return { state: 'other', reason: 'On disk this is a symbolic link, not an image.' };
  if (!stats.isFile()) return { state: 'missing' };
  // A folder on the way may itself be a link out of the working tree.
  const real = await realpath(absolute);
  const inside = path.relative(root, real);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new TypeError('Invalid file path');
  if (stats.size > MAX_IMAGE_BYTES) return { state: 'large', size: stats.size };
  const bytes = await readFile(real);
  return { state: 'ok', size: bytes.length, bytes };
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, file: string, source: object }} options
 * @returns {Promise<{ type: string, old: object, new: object }>}
 */
export async function loadImagePair({ cwd, log, file, source }) {
  validateFile(file);
  if (/[\n\r]/.test(file)) throw new TypeError('Invalid file path');
  const type = imageType(file);
  if (!type) throw new TypeError('Not an image path');
  const checked = validateImageSource(source);
  const names = imageObjectNames(checked, file);
  const sides = await readGitSides({ cwd, log, names });
  const fromDisk = checked.kind === 'unstaged' || checked.kind === 'untracked';
  const strip = side => (side?.state === 'ok' ? { state: 'ok', size: side.size, bytes: side.bytes } : side);
  return {
    type,
    old: names.old === null ? { state: 'missing' } : strip(sides.old),
    new: fromDisk ? await readDiskSide(cwd, file) : strip(sides.new)
  };
}
