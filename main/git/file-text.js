import { validateFile } from './commit.js';
import { imageObjectNames, readDiskSide, readGitSides, validateImageSource } from './image-blob.js';

/**
 * Both versions of one file as text, for the whole-file view: the file before
 * and after the change a diff shows. The sides are the same pair the diff and
 * the image viewer compare (see image-blob.js) — a commit against its first
 * parent or against `base`, the index against HEAD, the disk against the
 * index, the disk alone for an untracked file — and they are read the same
 * way: two `cat-file` calls that always exit 0, the journal holding a byte
 * count instead of the file. Nothing here writes to the repository.
 */

/** Past this a version is named by its size, unread — the conflict editor's ceiling. */
export const MAX_TEXT_BYTES = 5 * 1024 * 1024;

/** Git's own test for a binary file: a NUL among the first 8000 bytes. */
export function looksBinary(bytes) {
  return bytes.subarray(0, 8000).includes(0);
}

const decoder = new TextDecoder('utf-8');

/** A side as the view takes it: text, or why there is none. Bytes that are not UTF-8 read as U+FFFD. */
export function textSide(side) {
  if (side?.state !== 'ok') return side ?? { state: 'missing' };
  if (looksBinary(side.bytes)) return { state: 'binary', size: side.size };
  return { state: 'ok', size: side.size, text: decoder.decode(side.bytes) };
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog, file: string, source: object }} options
 * @returns {Promise<{ old: object, new: object }>}
 */
export async function loadTextPair({ cwd, log, file, source }) {
  validateFile(file);
  if (/[\n\r]/.test(file)) throw new TypeError('Invalid file path');
  const checked = validateImageSource(source);
  const names = imageObjectNames(checked, file);
  const sides = await readGitSides({ cwd, log, names, maxBytes: MAX_TEXT_BYTES, what: 'file' });
  const fromDisk = checked.kind === 'unstaged' || checked.kind === 'untracked';
  return {
    old: names.old === null ? { state: 'missing' } : textSide(sides.old),
    new: fromDisk ? textSide(await readDiskSide(cwd, file, MAX_TEXT_BYTES)) : textSide(sides.new)
  };
}
