import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateFile } from './commit.js';
import { ui } from '../../renderer/src/i18n/i18n.js';

/**
 * The three sides of a conflicted file plus the merged text Git left in the
 * working tree.
 *
 * Stages 1/2/3 of the index are base, ours and theirs. A conflict does not
 * always have all three — an add/add conflict has no base, a delete/modify has
 * no ours or no theirs — so a missing stage is reported as null rather than as
 * an error.
 */

const STAGES = [['base', 1], ['ours', 2], ['theirs', 3]];
const MAX_BYTES = 5 * 1024 * 1024;
// Git's own rule: a NUL byte anywhere in the first 8000 bytes means binary.
const SNIFF_BYTES = 8000;

function isBinary(buffer) {
  return buffer.subarray(0, SNIFF_BYTES).includes(0);
}

function resolveInside(cwd, file) {
  const absolute = path.resolve(cwd, validateFile(file));
  const relative = path.relative(cwd, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new TypeError('Invalid file path');
  if (relative.split(path.sep)[0].toLowerCase() === '.git') throw new TypeError('Invalid file path');
  return absolute;
}

/**
 * The conflicted file the editor may read and write: inside the working tree
 * (not under `.git`, not through a symbolic link on the way or at the end),
 * and one Git itself lists as unmerged. A lexical check alone would let a
 * write land in `.git/hooks` or, through a tracked link, outside the tree.
 */
async function conflictFile(cwd, log, file, { missingOk = false } = {}) {
  const absolute = resolveInside(cwd, file);
  const root = await realpath(cwd);
  let info = null;
  try { info = await lstat(absolute); } catch (error) { if (error.code !== 'ENOENT' || !missingOk) throw error; }
  if (info) {
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(ui`This conflict is not a regular file. Take a whole side instead.`);
    const inside = path.relative(root, await realpath(absolute));
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) throw new TypeError('Invalid file path');
  }
  const unmerged = await runGit({
    argv: ['ls-files', '--unmerged', '-z', '--', `:(literal)${validateFile(file)}`], cwd, log,
    operation: 'Read conflict state'
  });
  if (unmerged.code !== 0 || !unmerged.stdout) throw new Error(ui`This file is no longer in conflict.`);
  return { absolute, onDisk: Boolean(info), stages: parseStages(unmerged.stdout) };
}

/** The stage numbers `ls-files --unmerged -z` lists: `<mode> <oid> <stage>\t<path>`. */
export function parseStages(output) {
  return new Set(output.split('\0').filter(Boolean).map(entry => Number(entry.split('\t')[0].split(' ')[2])));
}

/** Which side deleted the file: a modify/delete conflict has no stage for it. */
export function deletedSide(stages) {
  const ours = stages.has(2);
  const theirs = stages.has(3);
  return ours && theirs ? null : ours ? 'theirs' : theirs ? 'ours' : 'both';
}

export function buildStageContentArgv(stage, file) {
  return ['show', `:${stage}:${validateFile(file)}`];
}

export function buildTakeSideArgv(side, file) {
  if (side !== 'ours' && side !== 'theirs') throw new TypeError('Unknown conflict side');
  return ['checkout', `--${side}`, '--', `:(literal)${validateFile(file)}`];
}

export function buildMarkResolvedArgv(file) {
  return ['add', '--', `:(literal)${validateFile(file)}`];
}

/** Puts a file resolved during this operation back in conflict, from the stages the index kept (resolve-undo). */
export function buildRestoreConflictArgv(file) {
  return ['checkout', '--merge', '--', `:(literal)${validateFile(file)}`];
}

export function buildDeleteConflictArgv(file) {
  return ['rm', '--force', '--quiet', '--', `:(literal)${validateFile(file)}`];
}

async function readStage(cwd, log, stage, file) {
  const result = await runGit({ argv: buildStageContentArgv(stage, file), cwd, log, operation: `Read conflict stage ${stage}` });
  return result.code === 0 ? result.stdout : null;
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, path: string }} options
 * @returns {Promise<{ binary: boolean, merged: ?string, ours: ?string, base: ?string, theirs: ?string,
 *   deleted: ?'ours'|'theirs'|'both', onDisk: boolean, mtimeMs: number, size: number }>}
 */
export async function loadConflict({ cwd, log, path: file }) {
  const { absolute, onDisk, stages } = await conflictFile(cwd, log, file, { missingOk: true });
  const info = onDisk ? await stat(absolute) : { mtimeMs: 0, size: 0 };
  if (info.size > MAX_BYTES) throw new Error(ui`This file is too large to open in the conflict editor.`);
  const buffer = onDisk ? await readFile(absolute) : Buffer.alloc(0);
  const binary = isBinary(buffer);
  const sides = Object.fromEntries(await Promise.all(
    STAGES.map(async ([name, stage]) => [name, binary || !stages.has(stage) ? null : await readStage(cwd, log, stage, file)])
  ));
  return {
    binary,
    merged: binary ? null : buffer.toString('utf8'),
    ...sides,
    deleted: deletedSide(stages),
    onDisk,
    mtimeMs: info.mtimeMs,
    size: info.size
  };
}

/**
 * Writes the resolved text and marks the file resolved with `git add`.
 *
 * The file may have been edited outside 🌱 Twig while the editor was open, so
 * the caller echoes back the mtime and size it read; a mismatch refuses the
 * write instead of overwriting someone else's work in silence.
 * @param {{ cwd: string, log: object, path: string, content: string, mtimeMs: number, size: number }} options
 */
export async function saveResolution({ cwd, log, path: file, content, mtimeMs, size }) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new TypeError('Invalid resolved content');
  const { absolute } = await conflictFile(cwd, log, file);
  const info = await stat(absolute);
  if (info.mtimeMs !== mtimeMs || info.size !== size) {
    throw new Error(ui`This file changed on disk while the editor was open. Reopen it to see the current version.`);
  }
  await writeFile(absolute, content, 'utf8');
  return markResolved({ cwd, log, path: file });
}

/** @param {{ cwd: string, log: object, path: string }} options */
export async function markResolved({ cwd, log, path: file }) {
  const result = await runGit({ argv: buildMarkResolvedArgv(file), cwd, log, operation: 'Mark conflict resolved' });
  if (result.code !== 0) throw new Error(ui`Git could not mark this file resolved. See the command console.`);
  return true;
}

/**
 * A file one side deleted and the other changed: it is either kept as it stands
 * in the working tree or deleted with `git rm`. There is nothing to merge.
 * @param {{ cwd: string, log: object, path: string, keep: boolean }} options
 */
export async function settleDeletion({ cwd, log, path: file, keep }) {
  const { onDisk, stages } = await conflictFile(cwd, log, file, { missingOk: true });
  if (!deletedSide(stages)) throw new Error(ui`Both sides still have this file. Resolve it in the editor.`);
  if (keep) {
    if (!onDisk) throw new Error(ui`The file is not in the working tree, so there is nothing to keep.`);
    return markResolved({ cwd, log, path: file });
  }
  const result = await runGit({ argv: buildDeleteConflictArgv(file), cwd, log, operation: 'Delete conflicted file' });
  if (result.code !== 0) throw new Error(ui`Git could not delete this file. See the command console.`);
  return true;
}

/**
 * Whole-side resolution, the only thing that makes sense for a binary file.
 * @param {{ cwd: string, log: object, path: string, side: 'ours'|'theirs' }} options
 */
export async function takeSide({ cwd, log, path: file, side }) {
  const result = await runGit({ argv: buildTakeSideArgv(side, file), cwd, log, operation: `Take ${side} version` });
  if (result.code !== 0) throw new Error(side === 'ours' ? ui`Git could not take the ours version. See the command console.` : ui`Git could not take the theirs version. See the command console.`);
  return markResolved({ cwd, log, path: file });
}

/**
 * Undoes a resolution: the file gets its conflict markers back and is listed
 * as unmerged again. Git can only do that while the index still holds the
 * stages `git add` replaced, so a file it has no record of is refused before
 * anything runs; what is in the file now is replaced by the markers.
 * @param {{ cwd: string, log: object, path: string }} options
 */
export async function restoreConflict({ cwd, log, path: file }) {
  resolveInside(cwd, file);
  const recorded = await runGit({ argv: ['ls-files', '--resolve-undo', '-z', '--', `:(literal)${validateFile(file)}`], cwd, log,
    operation: 'Read resolved conflict state' });
  if (recorded.code !== 0 || !recorded.stdout) throw new Error(ui`Git no longer remembers this conflict, so it cannot be put back.`);
  const result = await runGit({ argv: buildRestoreConflictArgv(file), cwd, log, operation: 'Put the conflict back' });
  if (result.code !== 0) throw new Error(ui`Git could not put the conflict back. See the command console.`);
  return true;
}
