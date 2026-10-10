import { open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * 🌱 Twig's own JSON files in userData: the connected repositories, marks,
 * automations, Undo chains, settings.
 *
 * Reading never stops the app. A missing file and a file that is not JSON
 * (cut short by a crash or a full disk, edited by hand) both read as
 * `undefined`, so each store starts from its defaults. A broken file is first
 * moved aside as `<name>.broken-<time>`: the person's data stays on disk to
 * recover, and the next save does not overwrite it. Before this, one torn
 * `marks.json` made 🌱 Twig exit at launch with no window and no message.
 * Any other read error (permissions, a folder in the way) still throws.
 */
export async function readJsonFile(file) {
  await removeStaleTemporaries(file);
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
  try { return JSON.parse(text); }
  catch {
    await rename(file, `${file}.broken-${Date.now()}`).catch(() => {});
    return undefined;
  }
}

let sequence = 0;

/**
 * Replaces `file` in one step: the data goes to a temporary file next to it,
 * is flushed to disk, and only then renamed over the old one. Without the
 * flush a crash right after the rename can leave an empty file behind; the
 * temporary name is unique per write, so two writers never share one.
 * @param {string} file
 * @param {string} data
 * @param {{ mode?: number }} [options]
 */
export async function writeFileAtomic(file, data, { mode = 0o666 } = {}) {
  const temporary = `${file}.${process.pid}-${++sequence}.tmp`;
  // `wx`: created here or not at all — never written through a link or an
  // existing file that happens to have the name.
  const handle = await open(temporary, 'wx', mode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally { await handle.close(); }
  try { await rename(temporary, file); }
  catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Temporary files a write left behind when the process ended before its
 * rename (a crash, a forced quit). Only one 🌱 Twig runs per userData folder,
 * so at load time every one of them is stale. Best effort: a leftover that
 * cannot be removed costs nothing but disk.
 */
export async function removeStaleTemporaries(file) {
  const base = path.basename(file);
  const pattern = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d+-\\d+\\.tmp$`);
  let names = [];
  try { names = await readdir(path.dirname(file)); } catch { return; }
  await Promise.all(names.filter(name => pattern.test(name)).map(name => unlink(path.join(path.dirname(file), name)).catch(() => {})));
}
