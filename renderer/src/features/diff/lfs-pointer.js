/**
 * Git LFS pointer files, recognised in a diff so they read as "a large file
 * stored in LFS" instead of three lines of hashes. No imports: Vite and the
 * Node check both load it.
 *
 * A pointer is `version <spec>`, then `oid sha256:<hex>` and `size <bytes>`
 * (keys sorted, one per line). Anything else is an ordinary text file.
 */

const SPECS = ['https://git-lfs.github.com/spec/v1', 'https://hawser.github.com/spec/v1'];

/** @param {string} text @returns {?{ oid: string, size: number }} */
export function parseLfsPointer(text) {
  if (typeof text !== 'string' || text.length > 1024) return null;
  const lines = text.replace(/\n$/, '').split('\n');
  const version = /^version (\S+)$/.exec(lines[0] || '');
  if (!version || !SPECS.includes(version[1])) return null;
  const fields = {};
  for (const line of lines.slice(1)) {
    const match = /^([a-z0-9.-]+) (\S+)$/.exec(line);
    if (!match) return null;
    fields[match[1]] = match[2];
  }
  const oid = /^sha256:([0-9a-f]{64})$/.exec(fields.oid || '');
  if (!oid || !/^\d+$/.test(fields.size || '')) return null;
  return { oid: oid[1], size: Number(fields.size) };
}

/**
 * Both sides of a one-file patch, rebuilt from its hunks: context and removed
 * lines are the old side, context and added lines the new one.
 * @param {string} patch
 */
export function patchSides(patch) {
  const before = []; const after = [];
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('diff --git')) { inHunk = false; continue; }
    if (line.startsWith('-')) before.push(line.slice(1));
    else if (line.startsWith('+')) after.push(line.slice(1));
    else if (line.startsWith(' ')) { before.push(line.slice(1)); after.push(line.slice(1)); }
  }
  return { before: before.join('\n'), after: after.join('\n') };
}

/**
 * The pointers on each side when a patch changes an LFS pointer and nothing
 * else: added (no before), removed (no after) or replaced. Null otherwise.
 * @param {string} patch
 * @returns {?{ before: ?{ oid: string, size: number }, after: ?{ oid: string, size: number } }}
 */
export function lfsPointerDiff(patch) {
  if (typeof patch !== 'string' || (!patch.includes('git-lfs') && !patch.includes('hawser'))) return null;
  const sides = patchSides(patch);
  const before = sides.before ? parseLfsPointer(sides.before) : null;
  const after = sides.after ? parseLfsPointer(sides.after) : null;
  if ((sides.before && !before) || (sides.after && !after) || (!before && !after)) return null;
  return { before, after };
}

/** 1536 → "1.5 KB"; bytes as a person reads them. */
export function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024; let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
}

/** What the change did to the stored file, in words. */
export function lfsChangeLabel(diff) {
  if (!diff) return '';
  if (!diff.before) return `Added ${formatSize(diff.after.size)} to Git LFS`;
  if (!diff.after) return `Removed ${formatSize(diff.before.size)} from Git LFS`;
  if (diff.before.oid === diff.after.oid) return `Unchanged in Git LFS (${formatSize(diff.after.size)})`;
  return `Replaced in Git LFS: ${formatSize(diff.before.size)} → ${formatSize(diff.after.size)}`;
}
