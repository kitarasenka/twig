/**
 * Ordering the tag list on the "Branches and tags" screen: by version (the
 * default — what a release list is read by), by date, or by name.
 *
 * Version order compares digit runs as numbers, so `v1.10.0` follows `v1.9.0`,
 * and puts a pre-release before its release (`v2.0.0-rc.1` < `v2.0.0`), the
 * way Git's `versionsort.suffix` is usually configured. Tags that hold no
 * number at all (`latest`, `stable`) cannot be placed on that scale and go
 * after every versioned tag, by name.
 *
 * No imports: Vite and the Node check both load this file.
 */

export const TAG_SORTS = [
  { id: 'version', label: 'Version, newest first' },
  { id: 'date', label: 'Date, newest first' },
  { id: 'name', label: 'Name, A to Z' }
];
const STORAGE_KEY = 'twig:tag-sort';
const PRE_RELEASE = /^[-._~+]?(?:alpha|beta|rc|pre|preview|dev|snapshot|nightly|canary|a|b)(?![a-z])/i;

/** Digit runs as numbers, everything else as lower-case text. */
function chunks(name) {
  return String(name).match(/\d+|\D+/g) || [];
}

const hasNumber = name => /\d/.test(name);

/**
 * Ascending version comparison of two tag names: negative when `a` is the
 * older version.
 */
export function compareVersions(a, b) {
  const left = chunks(a);
  const right = chunks(b);
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const x = left[index];
    const y = right[index];
    if (x === y) continue;
    const xNumber = /^\d/.test(x);
    const yNumber = /^\d/.test(y);
    if (xNumber && yNumber) {
      const difference = BigInt(x) - BigInt(y);
      if (difference !== 0n) return difference < 0n ? -1 : 1;
      // `01` and `1` are the same number; the longer spelling goes second.
      return x.length - y.length;
    }
    // One side carries on with a pre-release suffix where the other has a
    // number or text of its own (`1.0-rc` against `1.0.1`): the suffix ends
    // the version, so it is older than anything that continues it.
    const xPre = !xNumber && PRE_RELEASE.test(x);
    const yPre = !yNumber && PRE_RELEASE.test(y);
    if (xPre !== yPre) return xPre ? -1 : 1;
    if (xNumber !== yNumber) return xNumber ? 1 : -1;
    const text = x.toLowerCase().localeCompare(y.toLowerCase(), 'en');
    if (text !== 0) return text;
  }
  if (left.length === right.length) return 0;
  // One name is the other plus a tail: a pre-release tail makes it older
  // (`v2.0.0-rc1` < `v2.0.0`), any other tail makes it newer (`v2.0.0.1`).
  const [longer, sign] = left.length > right.length ? [left, 1] : [right, -1];
  return PRE_RELEASE.test(longer.slice(length).join('')) ? -sign : sign;
}

/**
 * @param {{ name: string, date?: ?number }[]} tags
 * @param {'version' | 'date' | 'name'} mode
 * @returns a new, sorted array
 */
export function sortTags(tags, mode) {
  const byName = (a, b) => a.name.localeCompare(b.name, 'en');
  const list = [...tags];
  if (mode === 'name') return list.sort(byName);
  if (mode === 'date') {
    // A tag whose date could not be read goes last, not first.
    return list.sort((a, b) => (Number.isFinite(b.date) ? b.date : -Infinity) - (Number.isFinite(a.date) ? a.date : -Infinity) || byName(a, b));
  }
  return list.sort((a, b) => {
    const versioned = Number(hasNumber(b.name)) - Number(hasNumber(a.name));
    if (versioned) return versioned;
    if (!hasNumber(a.name)) return byName(a, b);
    return compareVersions(b.name, a.name) || byName(a, b);
  });
}

/** The saved order, or `version`; storage may be unavailable, so nothing here throws. */
export function readTagSort(storage) {
  try {
    const value = storage?.getItem(STORAGE_KEY);
    return TAG_SORTS.some(sort => sort.id === value) ? value : 'version';
  } catch { return 'version'; }
}

export function writeTagSort(storage, mode) {
  if (!TAG_SORTS.some(sort => sort.id === mode)) return;
  try { storage?.setItem(STORAGE_KEY, mode); } catch { /* the order just is not remembered */ }
}
