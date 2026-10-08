/**
 * Where two versions of an image differ, as rectangles — the arithmetic of
 * the image viewer, kept free of the DOM and of imports so the Node checks
 * run it on plain pixel arrays.
 *
 * Both versions are laid on one canvas, aligned at the top-left corner, as
 * wide and tall as the larger of them. A pixel has changed when any of its
 * four channels differs; two fully transparent pixels are equal whatever
 * their colour channels hold. Where only one version has pixels (the image
 * grew or shrank), a transparent pixel against a visible one is a change.
 * Changed pixels are gathered into cells, neighbouring cells into areas, and
 * each area is reported as the tightest rectangle around its changed pixels.
 */

/** Pixels compared at most; a larger canvas is compared scaled down. */
export const COMPARE_BUDGET = 8_000_000;
/** Areas listed at most; the rest are counted, not drawn. */
export const REGION_LIMIT = 60;
/** Empty cells between two changed cells that still make them one area. */
export const GAP_CELLS = 2;

/** The factor (≤ 1) a canvas of this size is compared at. */
export function compareScale(width, height, budget = COMPARE_BUDGET) {
  const pixels = width * height;
  return pixels > budget ? Math.sqrt(budget / pixels) : 1;
}

/** The side of a grouping cell in compared pixels: about a hundredth of the image's size, never under 4. */
export function cellSize(width, height) {
  return Math.max(4, Math.ceil(Math.sqrt(width * height) / 100));
}

/**
 * One byte per pixel, 1 where the two RGBA buffers differ.
 * @param {Uint8ClampedArray|Uint8Array} before
 * @param {Uint8ClampedArray|Uint8Array} after
 */
export function diffMask(before, after, width, height) {
  if (before.length !== width * height * 4 || after.length !== before.length) throw new RangeError('Pixel buffers do not match the size');
  const mask = new Uint8Array(width * height);
  let changed = 0;
  for (let pixel = 0, at = 0; pixel < mask.length; pixel++, at += 4) {
    const alphaBefore = before[at + 3];
    const alphaAfter = after[at + 3];
    if (alphaBefore === 0 && alphaAfter === 0) continue;
    if (alphaBefore !== alphaAfter || before[at] !== after[at] || before[at + 1] !== after[at + 1] || before[at + 2] !== after[at + 2]) {
      mask[pixel] = 1;
      changed++;
    }
  }
  return { mask, changed };
}

const overlaps = (a, b, gap) => a.x <= b.x + b.width + gap && b.x <= a.x + a.width + gap
  && a.y <= b.y + b.height + gap && b.y <= a.y + a.height + gap;

function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y, pixels: a.pixels + b.pixels };
}

/**
 * Rectangles around the changed pixels of a mask, in reading order (top to
 * bottom, then left to right). Areas that touch or overlap after growing are
 * merged, so a rectangle never sits inside another. When there are more than
 * `limit`, the largest are kept and `more` says how many were left out.
 * @returns {{ regions: { x: number, y: number, width: number, height: number, pixels: number }[], more: number }}
 */
export function findRegions(mask, width, height, { cell = cellSize(width, height), gap = GAP_CELLS, limit = REGION_LIMIT } = {}) {
  const columns = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const count = new Int32Array(columns * rows);
  const minX = new Int32Array(columns * rows).fill(width);
  const minY = new Int32Array(columns * rows).fill(height);
  const maxX = new Int32Array(columns * rows).fill(-1);
  const maxY = new Int32Array(columns * rows).fill(-1);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    const cellRow = Math.floor(y / cell) * columns;
    for (let x = 0; x < width; x++) {
      if (!mask[rowStart + x]) continue;
      const index = cellRow + Math.floor(x / cell);
      count[index]++;
      if (x < minX[index]) minX[index] = x;
      if (x > maxX[index]) maxX[index] = x;
      if (y < minY[index]) minY[index] = y;
      if (y > maxY[index]) maxY[index] = y;
    }
  }
  const seen = new Uint8Array(columns * rows);
  let regions = [];
  const queue = [];
  for (let start = 0; start < count.length; start++) {
    if (!count[start] || seen[start]) continue;
    seen[start] = 1;
    queue.length = 0;
    queue.push(start);
    const box = { left: width, top: height, right: -1, bottom: -1, pixels: 0 };
    for (let head = 0; head < queue.length; head++) {
      const index = queue[head];
      box.left = Math.min(box.left, minX[index]); box.right = Math.max(box.right, maxX[index]);
      box.top = Math.min(box.top, minY[index]); box.bottom = Math.max(box.bottom, maxY[index]);
      box.pixels += count[index];
      const cx = index % columns;
      const cy = (index - cx) / columns;
      for (let ny = Math.max(0, cy - gap); ny <= Math.min(rows - 1, cy + gap); ny++) {
        for (let nx = Math.max(0, cx - gap); nx <= Math.min(columns - 1, cx + gap); nx++) {
          const next = ny * columns + nx;
          if (count[next] && !seen[next]) { seen[next] = 1; queue.push(next); }
        }
      }
    }
    regions.push({ x: box.left, y: box.top, width: box.right - box.left + 1, height: box.bottom - box.top + 1, pixels: box.pixels });
  }
  // Two areas whose rectangles overlap read as one change; merge until none do.
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < regions.length; i++) {
      for (let j = i + 1; j < regions.length;) {
        if (overlaps(regions[i], regions[j], 0)) {
          regions[i] = union(regions[i], regions[j]);
          regions[j] = regions[regions.length - 1];
          regions.pop();
          merged = true;
        } else j++;
      }
    }
  }
  let more = 0;
  if (regions.length > limit) {
    more = regions.length - limit;
    regions = [...regions].sort((a, b) => b.width * b.height - a.width * a.height).slice(0, limit);
  }
  regions.sort((a, b) => a.y - b.y || a.x - b.x);
  return { regions, more };
}

/** Rectangles found on a canvas compared at `scale`, in the full image's pixels, never past its edges. */
export function scaleRegions(regions, scale, width, height) {
  if (scale === 1) return regions;
  return regions.map(region => {
    const x = Math.max(0, Math.floor(region.x / scale));
    const y = Math.max(0, Math.floor(region.y / scale));
    return { ...region, x, y,
      width: Math.min(width - x, Math.ceil((region.x + region.width) / scale) - x),
      height: Math.min(height - y, Math.ceil((region.y + region.height) / scale) - y) };
  });
}

/**
 * The Difference view: changed pixels solid in `highlight` (`[r, g, b]`),
 * everything else the after-image in grey at 30 % opacity. The page's
 * background shows through the rest, so the view follows the theme without
 * being painted again.
 */
export function differencePixels(before, after, mask, highlight) {
  const out = new Uint8ClampedArray(after.length);
  for (let pixel = 0, at = 0; pixel < mask.length; pixel++, at += 4) {
    if (mask[pixel]) {
      out[at] = highlight[0]; out[at + 1] = highlight[1]; out[at + 2] = highlight[2]; out[at + 3] = 255;
      continue;
    }
    const source = after[at + 3] ? after : before;
    const grey = 0.299 * source[at] + 0.587 * source[at + 1] + 0.114 * source[at + 2];
    out[at] = grey; out[at + 1] = grey; out[at + 2] = grey;
    out[at + 3] = source[at + 3] * 0.3;
  }
  return out;
}

/** `800 × 600`. */
export const dimensions = image => `${image.width} × ${image.height}`;

/** One area for the list: where it is and how big, in image pixels. */
export function regionLabel(region) {
  return `${region.width} × ${region.height} at ${region.x}, ${region.y}`;
}

/** The sentence above the viewer about what the comparison found. */
export function compareSummary({ before, after, changed, total, regions, more, scale }) {
  const parts = [];
  if (before.width !== after.width || before.height !== after.height) parts.push(`Size ${dimensions(before)} → ${dimensions(after)}`);
  else parts.push(dimensions(after));
  if (changed === 0) {
    parts.push(scale < 1 ? 'No visible difference at the compared scale' : 'Pixels are identical — only the file’s bytes changed');
    return parts.join(' · ');
  }
  const areas = regions.length + more;
  parts.push(`${areas} changed ${areas === 1 ? 'area' : 'areas'}`);
  const share = changed / total * 100;
  parts.push(`${share < 0.1 ? '<0.1' : share.toFixed(share < 10 ? 1 : 0)}% of pixels`);
  if (scale < 1) parts.push(`compared at ${Math.round(scale * 100)}% scale`);
  return parts.join(' · ');
}

export const IMAGE_MODES = Object.freeze([
  { id: 'side', label: 'Side by side', title: 'Before and after next to each other' },
  { id: 'swipe', label: 'Swipe', title: 'Drag across the image: before on the left, after on the right' },
  { id: 'onion', label: 'Onion skin', title: 'After laid over before; the slider fades between them' },
  { id: 'difference', label: 'Difference', title: 'Only the changed pixels, coloured; the rest greyed out' }
]);

const MODE_KEY = 'twig:image-mode';
const AREAS_KEY = 'twig:image-areas';

/** The viewer's remembered mode and whether rectangles are drawn; storage that throws gives the defaults. */
export function readImagePrefs(storage) {
  let mode = 'side';
  let areas = true;
  try {
    const saved = storage?.getItem(MODE_KEY);
    if (IMAGE_MODES.some(item => item.id === saved)) mode = saved;
    areas = storage?.getItem(AREAS_KEY) !== 'hide';
  } catch { /* defaults */ }
  return { mode, areas };
}

export function writeImagePrefs(storage, { mode, areas }) {
  try {
    storage?.setItem(MODE_KEY, mode);
    storage?.setItem(AREAS_KEY, areas ? 'show' : 'hide');
  } catch { /* the choice lasts for this session */ }
}
