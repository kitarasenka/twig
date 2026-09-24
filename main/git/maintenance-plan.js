/**
 * Repository maintenance: the exact commands behind the two buttons, and the
 * reading of `git count-objects -v` they are judged by. One module for both
 * sides — main runs these argv, the screen prints them verbatim — with no
 * imports, so Vite and Node both load it.
 *
 * - `optimize` runs only the `git maintenance` tasks that delete nothing
 *   Git could still need: a commit-graph (faster history walks), loose
 *   objects packed and small packs merged behind a multi-pack-index — then
 *   `git prune-packed`, because the loose-objects task only deletes the loose
 *   copies of what it packed on its *next* run; prune-packed removes exactly
 *   those copies (objects a pack already holds) and nothing else.
 * - `gc` is Git's full clean-up. Besides repacking it expires old reflog
 *   entries and prunes unreachable objects older than two weeks — the one
 *   place where lost work can finally disappear, so the screen asks first.
 */

/** Each task is a list of commands, run in order; the first that fails or is cancelled stops the rest. */
export const MAINTENANCE_COMMANDS = Object.freeze({
  optimize: Object.freeze([
    Object.freeze(['maintenance', 'run', '--task=commit-graph', '--task=loose-objects', '--task=incremental-repack']),
    Object.freeze(['prune-packed'])
  ]),
  gc: Object.freeze([Object.freeze(['gc'])])
});
export const MAINTENANCE_TASKS = Object.keys(MAINTENANCE_COMMANDS);

/** @returns {string[][]} fresh copies, so a caller cannot change what runs */
export function maintenanceCommands(task) {
  if (!MAINTENANCE_TASKS.includes(task)) throw new TypeError('Unknown maintenance task');
  return MAINTENANCE_COMMANDS[task].map(argv => [...argv]);
}

/** How the screen prints a task: one `git …` line per command. */
export const maintenanceText = task => maintenanceCommands(task).map(argv => `git ${argv.join(' ')}`);

export const COUNT_OBJECTS_ARGV = Object.freeze(['count-objects', '-v']);

/**
 * Git runs `gc --auto` by itself past these defaults (`gc.auto`,
 * `gc.autoPackLimit`); the screen uses them to say whether anything is due.
 */
export const AUTO_LOOSE = 6700;
export const AUTO_PACKS = 50;

const FIELDS = {
  count: 'loose', size: 'looseBytes', 'in-pack': 'packed', packs: 'packs', 'size-pack': 'packBytes',
  'prune-packable': 'prunable', garbage: 'garbage', 'size-garbage': 'garbageBytes'
};
const KIB = new Set(['looseBytes', 'packBytes', 'garbageBytes']);

/**
 * `count-objects -v` prints `key: value` lines, sizes in KiB. Unknown keys
 * are ignored (newer Git may add some); a missing one reads as 0.
 * @returns {{ loose: number, looseBytes: number, packed: number, packs: number, packBytes: number,
 *   prunable: number, garbage: number, garbageBytes: number, objects: number, diskBytes: number }}
 */
export function parseCountObjects(text) {
  const stats = Object.fromEntries(Object.values(FIELDS).map(key => [key, 0]));
  let known = 0;
  for (const line of String(text).split('\n')) {
    const match = /^([a-z-]+): (\d+)$/.exec(line.trim());
    if (!match || !FIELDS[match[1]]) continue;
    const key = FIELDS[match[1]];
    stats[key] = Number(match[2]) * (KIB.has(key) ? 1024 : 1);
    known += 1;
  }
  if (!known) throw new Error('Unexpected count-objects output');
  return { ...stats, objects: stats.loose + stats.packed, diskBytes: stats.looseBytes + stats.packBytes + stats.garbageBytes };
}

/** Whether Git itself would consider a clean-up due, and why — in words. */
export function maintenanceAdvice(stats) {
  if (!stats) return null;
  if (stats.loose >= AUTO_LOOSE) return `${stats.loose.toLocaleString('en')} loose objects: Git tidies up by itself past ${AUTO_LOOSE.toLocaleString('en')}. Optimize packs them now.`;
  if (stats.packs >= AUTO_PACKS) return `${stats.packs} packs: Git merges them by itself past ${AUTO_PACKS}. Optimize or Clean up merges them now.`;
  if (stats.garbage > 0) return `${stats.garbage} garbage ${stats.garbage === 1 ? 'file' : 'files'} in the object store. Clean up (git gc) removes ${stats.garbage === 1 ? 'it' : 'them'}.`;
  return null;
}

/** Bytes as a short human size: 0 B, 512 B, 12.3 KB, 4.1 MB, 1.2 GB. */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${Math.max(0, Math.round(bytes || 0))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
