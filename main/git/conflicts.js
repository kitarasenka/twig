import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runGit } from './exec.js';
import { validateFile } from './commit.js';

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
  return absolute;
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

async function readStage(cwd, log, stage, file) {
  const result = await runGit({ argv: buildStageContentArgv(stage, file), cwd, log, operation: `Read conflict stage ${stage}` });
  return result.code === 0 ? result.stdout : null;
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, path: string }} options
 * @returns {Promise<{ binary: boolean, merged: ?string, ours: ?string, base: ?string, theirs: ?string, mtimeMs: number, size: number }>}
 */
export async function loadConflict({ cwd, log, path: file }) {
  const absolute = resolveInside(cwd, file);
  const info = await stat(absolute);
  if (info.size > MAX_BYTES) throw new Error('This file is too large to open in the conflict editor.');
  const buffer = await readFile(absolute);
  const binary = isBinary(buffer);
  const sides = Object.fromEntries(await Promise.all(
    STAGES.map(async ([name, stage]) => [name, binary ? null : await readStage(cwd, log, stage, file)])
  ));
  return {
    binary,
    merged: binary ? null : buffer.toString('utf8'),
    ...sides,
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
  const absolute = resolveInside(cwd, file);
  const info = await stat(absolute);
  if (info.mtimeMs !== mtimeMs || info.size !== size) {
    throw new Error('This file changed on disk while the editor was open. Reopen it to see the current version.');
  }
  await writeFile(absolute, content, 'utf8');
  return markResolved({ cwd, log, path: file });
}

/** @param {{ cwd: string, log: object, path: string }} options */
export async function markResolved({ cwd, log, path: file }) {
  const result = await runGit({ argv: buildMarkResolvedArgv(file), cwd, log, operation: 'Mark conflict resolved' });
  if (result.code !== 0) throw new Error('Git could not mark this file resolved. See the command console.');
  return true;
}

/**
 * Whole-side resolution, the only thing that makes sense for a binary file.
 * @param {{ cwd: string, log: object, path: string, side: 'ours'|'theirs' }} options
 */
export async function takeSide({ cwd, log, path: file, side }) {
  const result = await runGit({ argv: buildTakeSideArgv(side, file), cwd, log, operation: `Take ${side} version` });
  if (result.code !== 0) throw new Error(`Git could not take the ${side} version. See the command console.`);
  return markResolved({ cwd, log, path: file });
}
