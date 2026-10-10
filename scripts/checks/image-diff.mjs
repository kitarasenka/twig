import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CommandLog } from '../../main/command-log.js';
import { runGit } from '../../main/git/exec.js';
import { IMAGE_TYPES, MAX_IMAGE_BYTES, imageType } from '../../main/git/image-types.js';
import {
  imageObjectNames, loadImagePair, parseBatchCheckLine, parseBatchOutput, validateImageSource
} from '../../main/git/image-blob.js';
import {
  IMAGE_MODES, cellSize, compareScale, compareSummary, diffMask, differencePixels, findRegions,
  readImagePrefs, regionLabel, scaleRegions, writeImagePrefs
} from '../../renderer/src/features/diff/image-diff.js';

// --- which files open in the viewer ---

assert.equal(imageType('assets/logo.png'), 'image/png');
assert.equal(imageType('PHOTO.JPG'), 'image/jpeg');
assert.equal(imageType('a/b.webp'), 'image/webp');
for (const name of ['icon.svg', 'notes.txt', 'png', '.png', 'dir.png/file', '', null, 42]) assert.equal(imageType(name), null, `${String(name)} is not an image`);
assert.equal(Object.values(IMAGE_TYPES).includes('image/svg+xml'), false, 'SVG keeps its text diff');

// --- where each side comes from ---

const OID = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'commit', oid: OID, base: null }), 'x.png'), { old: `${OID}^:x.png`, new: `${OID}:x.png` });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'commit', oid: OID, base: BASE }), 'x.png'), { old: `${BASE}:x.png`, new: `${OID}:x.png` });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'staged' }), 'x.png'), { old: 'HEAD:x.png', new: ':0:x.png' });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'unstaged' }), 'x.png'), { old: ':0:x.png', new: null });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'untracked' }), 'x.png'), { old: null, new: null });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'stash', oid: OID, untracked: false }), 'x.png'), { old: `${OID}^1:x.png`, new: `${OID}:x.png` });
assert.deepEqual(imageObjectNames(validateImageSource({ kind: 'stash', oid: OID, untracked: true }), 'x.png'), { old: null, new: `${OID}^3:x.png` });
for (const bad of [null, 'commit', {}, { kind: 'disk' }, { kind: 'commit', oid: 'HEAD' }, { kind: 'commit', oid: OID, base: 'main' }, { kind: 'commit', oid: `${OID} --x` },
  { kind: 'stash', oid: OID }, { kind: 'stash', oid: 'stash@{0}', untracked: false }, { kind: 'stash', oid: OID, untracked: 'yes' }]) {
  assert.throws(() => validateImageSource(bad), TypeError, `source ${JSON.stringify(bad)} is refused`);
}
assert.deepEqual(parseBatchCheckLine(`${OID} blob 12`), { oid: OID, type: 'blob', size: 12 });
assert.equal(parseBatchCheckLine(`${OID}^:a b blob 12 missing`), null);
assert.equal(parseBatchCheckLine('HEAD:x.png missing'), null);
const twoObjects = Buffer.concat([Buffer.from(`${OID} blob 3\n`), Buffer.from([0, 10, 255]), Buffer.from(`\n${BASE} blob 2\n`), Buffer.from([10, 10]), Buffer.from('\n')]);
const parsed = parseBatchOutput(twoObjects);
assert.deepEqual([...parsed.get(OID)], [0, 10, 255], 'newlines and NULs inside an object do not split it');
assert.deepEqual([...parsed.get(BASE)], [10, 10]);
assert.equal(parseBatchOutput(twoObjects.subarray(0, 40)).size, 0, 'a cut-off record is not returned half-read');

// --- changed pixels and areas ---

function canvas(width, height, fill = [10, 20, 30, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let at = 0; at < data.length; at += 4) data.set(fill, at);
  return data;
}
function paint(data, width, x, y, w, h, color) {
  for (let row = y; row < y + h; row++) for (let column = x; column < x + w; column++) data.set(color, (row * width + column) * 4);
}

{
  const before = canvas(200, 100);
  assert.equal(diffMask(before, canvas(200, 100), 200, 100).changed, 0, 'identical pixels');
  const clearA = canvas(4, 1, [1, 2, 3, 0]);
  const clearB = canvas(4, 1, [9, 9, 9, 0]);
  assert.equal(diffMask(clearA, clearB, 4, 1).changed, 0, 'fully transparent pixels are equal whatever their colour');
  assert.equal(diffMask(canvas(4, 1, [1, 2, 3, 254]), canvas(4, 1, [1, 2, 3, 255]), 4, 1).changed, 4, 'alpha alone is a change');
  assert.throws(() => diffMask(before, canvas(10, 10), 200, 100), RangeError);

  const after = canvas(200, 100);
  paint(after, 200, 10, 12, 5, 3, [200, 0, 0, 255]);
  paint(after, 200, 150, 70, 20, 10, [0, 200, 0, 255]);
  const { mask, changed } = diffMask(before, after, 200, 100);
  assert.equal(changed, 5 * 3 + 20 * 10);
  const { regions, more } = findRegions(mask, 200, 100);
  assert.equal(more, 0);
  assert.deepEqual(regions.map(({ x, y, width, height }) => [x, y, width, height]), [[10, 12, 5, 3], [150, 70, 20, 10]],
    'each area is the tightest box around its pixels, in reading order');
  assert.deepEqual(regions.map(region => region.pixels), [15, 200]);
  assert.equal(regionLabel(regions[0]), '5 × 3 at 10, 12');

  // Two changes a few pixels apart read as one area; far apart they stay two.
  const near = canvas(200, 100);
  paint(near, 200, 40, 40, 3, 3, [0, 0, 0, 255]);
  paint(near, 200, 50, 40, 3, 3, [0, 0, 0, 255]);
  const nearRegions = findRegions(diffMask(before, near, 200, 100).mask, 200, 100).regions;
  assert.deepEqual(nearRegions.map(({ x, y, width, height }) => [x, y, width, height]), [[40, 40, 13, 3]]);

  // One changed pixel still gets a box.
  const dot = canvas(200, 100);
  paint(dot, 200, 199, 99, 1, 1, [0, 0, 0, 255]);
  assert.deepEqual(findRegions(diffMask(before, dot, 200, 100).mask, 200, 100).regions.map(r => [r.x, r.y, r.width, r.height]), [[199, 99, 1, 1]]);

  // Boxes whose cells are not neighbours but whose rectangles overlap are merged.
  const ring = new Uint8Array(100 * 100);
  for (let i = 0; i < 100; i++) { ring[i] = 1; ring[99 * 100 + i] = 1; ring[i * 100] = 1; ring[i * 100 + 99] = 1; }
  ring[50 * 100 + 50] = 1;
  const ringRegions = findRegions(ring, 100, 100, { cell: 4, gap: 0 }).regions;
  assert.equal(ringRegions.length, 1, 'a rectangle never sits inside another');
  assert.deepEqual([ringRegions[0].x, ringRegions[0].y, ringRegions[0].width, ringRegions[0].height], [0, 0, 100, 100]);

  // Past the limit the largest areas are kept and the rest counted.
  const speckle = new Uint8Array(400 * 400);
  for (let y = 0; y < 400; y += 40) for (let x = 0; x < 400; x += 40) speckle[y * 400 + x] = 1;
  speckle[0] = 0;
  for (let i = 0; i < 5; i++) speckle[i * 400 + 1] = 1; // a taller one at the top-left
  const limited = findRegions(speckle, 400, 400, { limit: 10 });
  assert.equal(limited.regions.length, 10);
  assert.equal(limited.more, 100 - 10);
  assert.ok(limited.regions.some(region => region.height === 5), 'the largest area survives the limit');
}

assert.equal(compareScale(1000, 1000), 1);
assert.ok(Math.abs(compareScale(4000, 4000) * 4000 * compareScale(4000, 4000) * 4000 - 8_000_000) < 1);
assert.equal(cellSize(10, 10), 4);
assert.equal(cellSize(1000, 1000), 10);
assert.deepEqual(scaleRegions([{ x: 5, y: 5, width: 10, height: 10, pixels: 1 }], 0.5, 25, 25), [{ x: 10, y: 10, width: 15, height: 15, pixels: 1 }],
  'scaled back to full pixels, clipped at the image edge');

{
  const before = canvas(2, 1, [0, 0, 0, 255]);
  const after = canvas(2, 1, [255, 255, 255, 255]);
  const mask = Uint8Array.from([1, 0]);
  const out = differencePixels(before, after, mask, [255, 0, 0]);
  assert.deepEqual([...out.subarray(0, 4)], [255, 0, 0, 255], 'a changed pixel is the highlight colour, opaque');
  assert.deepEqual([...out.subarray(4, 8)], [255, 255, 255, 76], 'an unchanged one is the after-image in grey, faint over the page background');
}

const same = { width: 800, height: 600 };
assert.equal(compareSummary({ before: same, after: same, changed: 0, total: 480000, regions: [], more: 0, scale: 1 }),
  '800 × 600 · Pixels are identical — only the file’s bytes changed');
assert.equal(compareSummary({ before: same, after: { width: 1024, height: 768 }, changed: 4800, total: 786432, regions: [{}, {}], more: 1, scale: 1 }),
  'Size 800 × 600 → 1024 × 768 · 3 changed areas · 0.6% of pixels');
assert.equal(compareSummary({ before: same, after: same, changed: 1, total: 480000, regions: [{}], more: 0, scale: 0.5 }),
  '800 × 600 · 1 changed area · <0.1% of pixels · compared at 50% scale');

{
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  assert.deepEqual(readImagePrefs(storage), { mode: 'side', areas: true });
  writeImagePrefs(storage, { mode: 'swipe', areas: false });
  assert.deepEqual(readImagePrefs(storage), { mode: 'swipe', areas: false });
  store.set('twig:image-mode', 'bogus');
  assert.equal(readImagePrefs(storage).mode, 'side');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(readImagePrefs(broken), { mode: 'side', areas: true });
  assert.doesNotThrow(() => writeImagePrefs(broken, { mode: 'onion', areas: true }));
  assert.deepEqual(IMAGE_MODES.map(mode => mode.id), ['side', 'swipe', 'onion', 'difference']);
}

// --- both versions read from real Git ---

const root = await mkdtemp(path.join(tmpdir(), 'twig-image-'));
const repo = path.join(root, 'repo');
const log = new CommandLog(root);
try {
  await log.load();
  await mkdir(path.join(repo, 'art'), { recursive: true });
  const git = async (argv) => {
    const result = await runGit({ argv, cwd: repo, log, operation: 'Check setup' });
    assert.equal(result.code, 0, `git ${argv.join(' ')}: ${result.stderr}`);
    return result.stdout;
  };
  const bytesA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 10, 13, 10, 1, 2, 3]);
  const bytesB = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 10, 13, 10, 9, 9]);
  const bytesC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 10, 7]);
  const file = 'art/logo one.png';
  await git(['init', '-q', '-b', 'main', '.']);
  await git(['config', 'user.email', 'check@example.invalid']);
  await git(['config', 'user.name', 'Twig Check']);
  await writeFile(path.join(repo, file), bytesA);
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'add logo']);
  const first = (await git(['rev-parse', 'HEAD'])).trim();
  await writeFile(path.join(repo, file), bytesB);
  await git(['commit', '-q', '-am', 'change logo']);
  const second = (await git(['rev-parse', 'HEAD'])).trim();

  const bytes = side => [...side.bytes];
  const added = await loadImagePair({ cwd: repo, log, file, source: { kind: 'commit', oid: first, base: null } });
  assert.equal(added.type, 'image/png');
  assert.deepEqual(added.old, { state: 'missing' }, 'a root commit has no before');
  assert.deepEqual(bytes(added.new), [...bytesA]);
  const changed = await loadImagePair({ cwd: repo, log, file, source: { kind: 'commit', oid: second, base: null } });
  assert.deepEqual(bytes(changed.old), [...bytesA]);
  assert.deepEqual(bytes(changed.new), [...bytesB]);
  assert.equal(changed.new.size, bytesB.length);
  const range = await loadImagePair({ cwd: repo, log, file, source: { kind: 'commit', oid: second, base: first } });
  assert.deepEqual(bytes(range.old), [...bytesA]);

  await writeFile(path.join(repo, file), bytesC);
  await git(['add', file]);
  await writeFile(path.join(repo, file), bytesA);
  const staged = await loadImagePair({ cwd: repo, log, file, source: { kind: 'staged' } });
  assert.deepEqual(bytes(staged.old), [...bytesB], 'staged: HEAD before');
  assert.deepEqual(bytes(staged.new), [...bytesC], 'staged: the index after');
  const unstaged = await loadImagePair({ cwd: repo, log, file, source: { kind: 'unstaged' } });
  assert.deepEqual(bytes(unstaged.old), [...bytesC], 'unstaged: the index before');
  assert.deepEqual(bytes(unstaged.new), [...bytesA], 'unstaged: the disk after');

  await writeFile(path.join(repo, 'art/new.png'), bytesC);
  const untracked = await loadImagePair({ cwd: repo, log, file: 'art/new.png', source: { kind: 'untracked' } });
  assert.deepEqual(untracked.old, { state: 'missing' });
  assert.deepEqual(bytes(untracked.new), [...bytesC]);

  // A stash: its work tree against the commit it was made on, and an
  // untracked image from its third parent with no "before".
  await git(['stash', 'push', '-q', '--include-untracked']);
  const stashOid = (await git(['rev-parse', 'refs/stash'])).trim();
  const stashed = await loadImagePair({ cwd: repo, log, file, source: { kind: 'stash', oid: stashOid, untracked: false } });
  assert.deepEqual(bytes(stashed.old), [...bytesB], 'stash: ^1 before');
  assert.deepEqual(bytes(stashed.new), [...bytesA], 'stash: its work tree after');
  const stashedNew = await loadImagePair({ cwd: repo, log, file: 'art/new.png', source: { kind: 'stash', oid: stashOid, untracked: true } });
  assert.deepEqual(stashedNew.old, { state: 'missing' });
  assert.deepEqual(bytes(stashedNew.new), [...bytesC], 'stash: an untracked file from ^3');
  await git(['stash', 'pop', '-q', '--index']);

  await rm(path.join(repo, 'art/new.png'));
  await git(['rm', '-q', '-f', '--cached', '--', file]);
  const deleted = await loadImagePair({ cwd: repo, log, file, source: { kind: 'staged' } });
  assert.deepEqual(deleted.new, { state: 'missing' }, 'removed from the index: no after');
  assert.deepEqual(bytes(deleted.old), [...bytesB]);

  // A link on disk is not followed — not even to a file inside the repository.
  await writeFile(path.join(repo, 'outside.png'), bytesA);
  await symlink(path.join(repo, 'outside.png'), path.join(repo, 'art/link.png'));
  const linked = await loadImagePair({ cwd: repo, log, file: 'art/link.png', source: { kind: 'untracked' } });
  assert.equal(linked.new.state, 'other');
  // A folder that is a link out of the working tree is refused.
  const elsewhere = path.join(root, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, 'secret.png'), bytesA);
  await symlink(elsewhere, path.join(repo, 'escape'));
  await assert.rejects(loadImagePair({ cwd: repo, log, file: 'escape/secret.png', source: { kind: 'untracked' } }), TypeError);

  // Too big to read: reported by size, the bytes are not read.
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1, 7);
  await writeFile(path.join(repo, 'art/huge.png'), huge);
  assert.deepEqual((await loadImagePair({ cwd: repo, log, file: 'art/huge.png', source: { kind: 'untracked' } })).new, { state: 'large', size: huge.length });
  await git(['add', 'art/huge.png']);
  assert.deepEqual((await loadImagePair({ cwd: repo, log, file: 'art/huge.png', source: { kind: 'staged' } })).new, { state: 'large', size: huge.length });

  for (const bad of ['../x.png', '/abs.png', 'notes.txt', 'a\nb.png', '']) {
    await assert.rejects(loadImagePair({ cwd: repo, log, file: bad, source: { kind: 'staged' } }), TypeError, `${JSON.stringify(bad)} is refused`);
  }

  // Every read exited 0 and the journal holds byte counts, never image bytes.
  const reads = log.list().filter(entry => entry.operation.startsWith('Read image'));
  assert.ok(reads.length >= 8);
  assert.ok(reads.every(entry => entry.code === 0), 'a missing side is an answer, not a failed command');
  const bytesRead = reads.filter(entry => entry.operation.startsWith('Read image bytes'));
  assert.ok(bytesRead.every(entry => /^\d+ bytes of binary output, not shown\.\n$/.test(entry.stdout)));
  const journal = await readFile(path.join(root, 'command-log.jsonl'), 'utf8');
  assert.equal(journal.includes('\\u0000\\n\\r\\n'), false, 'no image bytes in the journal file');
  assert.equal(journal.includes('"type":"Buffer"'), false);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('image diff: areas, prefs and both versions from real Git checked');
