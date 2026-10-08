import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// The image viewer in a real Electron window against a real repository: a
// committed PNG change shows its two changed areas as rectangles, every view
// mode draws, an area can be picked from the list, the rectangles can be
// hidden, and the uncommitted panel and the staging screen open the same
// viewer for a resized image on disk and for an untracked one.

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = CRC[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
/** A real RGBA PNG; `pixel(x, y)` gives `[r, g, b, a]`. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const inside = (x, y, [left, top, width, height]) => x >= left && x < left + width && y >= top && y < top + height;
const scene = (extra = []) => (x, y) => {
  for (const [box, color] of extra) if (inside(x, y, box)) return color;
  return y < 110 ? [70 + Math.round(x / 3), 130 + Math.round(y / 2), 210, 255] : [60, 140 - Math.round((y - 110) / 2), 70, 255];
};
const BADGE = [[40, 30, 30, 20], [220, 40, 60, 255]];
const BLUE = [[180, 100, 25, 25], [40, 70, 200, 255]];
const AMBER = [[180, 100, 25, 25], [240, 180, 40, 255]];

const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'twig-image-smoke-')));
let app;
try {
  const cwd = path.join(root, 'app');
  const log = new CommandLog(path.join(root, 'journal')); await log.load();
  const git = async argv => {
    const result = await runGit({ argv, cwd, log });
    assert.equal(result.code, 0, `${argv.join(' ')}: ${result.stderr}`);
    return result.stdout.replace(/\n$/, '');
  };
  await mkdir(path.join(cwd, 'art'), { recursive: true });
  await git(['init', '--initial-branch=main']);
  for (const [key, value] of [['user.name', 'Me Myself'], ['user.email', 'me@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', '']]) await git(['config', key, value]);
  await writeFile(path.join(cwd, 'art/logo.png'), png(240, 160, scene([BLUE])));
  await git(['add', '.']);
  await git(['commit', '-q', '-m', 'Add logo']);
  await writeFile(path.join(cwd, 'art/logo.png'), png(240, 160, scene([BADGE, AMBER])));
  await git(['commit', '-q', '-am', 'Badge and amber block']);
  // On disk: the same picture, 20 px wider.
  await writeFile(path.join(cwd, 'art/logo.png'), png(260, 160, scene([BADGE, AMBER])));
  await writeFile(path.join(cwd, 'art/new.png'), png(32, 32, (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [200, 60, 60, 255] : [0, 0, 0, 0]));

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(20000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const setTheme = async theme => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('dialog', { name: 'Settings' }).getByLabel('Appearance').selectOption(theme);
    await page.keyboard.press('Escape');
  };
  // Each area button is its number badge, then the label.
  const areaLabels = group => group.getByRole('button').evaluateAll(buttons => buttons.map(button => button.lastChild.textContent));
  // Theme changes animate; the picture is taken once they have finished.
  const shot = async name => { await page.waitForTimeout(500); await page.screenshot({ path: `artifacts/${name}.png` }); };

  await app.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await list.waitFor();
  if (await page.getByRole('textbox', { name: 'Search command log' }).isVisible()) await page.locator('.console-status').click();

  // --- A committed change: two areas, found where they were painted -----------------------------
  await list.getByRole('option').filter({ hasText: 'Badge and amber block' }).first().click();
  await page.getByRole('button', { name: 'Modified art/logo.png', exact: true }).click();
  const viewer = page.locator('.image-diff');
  await viewer.waitFor();
  await viewer.getByText('240 × 160 · 2 changed areas').waitFor();
  const areas = viewer.getByRole('group', { name: 'Changed areas' });
  assert.deepEqual(await areaLabels(areas), ['30 × 20 at 40, 30', '25 × 25 at 180, 100'],
    'the rectangles are exactly the painted blocks, in reading order');
  assert.equal(await viewer.locator('.image-area').count(), 4, 'both areas framed on both sides');
  assert.equal(await viewer.locator('canvas').count(), 2);
  assert.equal(await page.getByText('Binary file changed').count(), 0);
  await setTheme('dark');
  await shot('image-side-dark');

  await areas.getByRole('button', { name: /25 × 25 at 180, 100/ }).click();
  assert.equal(await areas.getByRole('button', { name: /25 × 25/ }).getAttribute('aria-pressed'), 'true');
  assert.equal(await viewer.locator('.image-area.active').count(), 2);

  for (const [mode, check] of [
    ['Swipe', () => viewer.getByRole('slider', { name: 'Swipe position' }).waitFor()],
    ['Onion skin', () => viewer.getByRole('slider', { name: 'After opacity' }).waitFor()],
    ['Difference', () => viewer.getByText(/Changed pixels/).waitFor()]
  ]) {
    await viewer.getByRole('button', { name: mode, exact: true }).click();
    assert.equal(await viewer.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'), 'true');
    await check();
    assert.ok(await viewer.locator('canvas').count() >= 1);
    assert.equal(await viewer.locator('.image-area').count(), 2, `${mode}: one frame per area`);
  }
  await shot('image-difference-dark');
  // Swipe follows the pointer on the picture, not only the slider.
  await viewer.getByRole('button', { name: 'Swipe', exact: true }).click();
  const stage = viewer.locator('.image-stage');
  const box = await stage.boundingBox();
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
  assert.ok(Math.abs(Number(await viewer.getByRole('slider', { name: 'Swipe position' }).inputValue()) - 25) <= 1);
  await setTheme('light');
  await shot('image-swipe-light');

  await viewer.getByRole('checkbox', { name: 'Changed areas' }).uncheck();
  assert.equal(await viewer.locator('.image-area').count(), 0);
  assert.equal(await areas.count(), 0);
  await viewer.getByRole('checkbox', { name: 'Changed areas' }).check();
  await viewer.getByRole('button', { name: '2:1', exact: true }).click();
  assert.equal(Math.round((await stage.boundingBox()).width), 480, '2:1 is two screen pixels per image pixel');
  await viewer.getByRole('button', { name: 'Fit', exact: true }).click();
  await viewer.getByRole('button', { name: 'Side by side', exact: true }).click();

  // The first commit has no "before".
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  await list.getByRole('option').filter({ hasText: 'Add logo' }).first().click();
  await page.getByRole('button', { name: 'Added art/logo.png', exact: true }).click();
  await viewer.getByText('Added in this change').waitFor();
  assert.equal(await viewer.getByRole('group', { name: 'Image view' }).count(), 0, 'one version: no comparison modes');

  // --- Uncommitted: a resized image on disk and an untracked one -------------------------------
  await page.getByRole('button', { name: 'Close diff', exact: true }).click();
  await page.getByRole('button', { name: /Uncommitted changes, 2 files\b/ }).click();
  const uncommitted = page.getByRole('complementary', { name: 'Uncommitted changes', exact: true });
  await uncommitted.getByRole('region', { name: 'Changed files', exact: true }).locator('.commit-file').filter({ hasText: 'logo.png' }).click();
  await viewer.getByText('Size 240 × 160 → 260 × 160 · 1 changed area').waitFor();
  assert.deepEqual(await areaLabels(viewer.getByRole('group', { name: 'Changed areas' })), ['20 × 160 at 240, 0'],
    'the new columns are the change');
  await uncommitted.getByRole('region', { name: 'Untracked files', exact: true }).locator('.commit-file').filter({ hasText: 'new.png' }).click();
  await viewer.getByText('New file, not in Git yet').waitFor();
  assert.equal(await page.getByText(/Untracked — Git has no diff/).count(), 0);
  assert.equal(await git(['status', '--porcelain', '--', 'art/new.png']), '?? art/new.png', 'looking did not track the file');
  await setTheme('dark');
  await shot('image-untracked-dark');

  // --- The staging screen shows the same viewer for a binary image ------------------------------
  await uncommitted.getByRole('button', { name: 'Open staging', exact: true }).click();
  await page.getByRole('region', { name: 'Unstaged changes' }).locator('.worktree-open').filter({ hasText: 'logo.png' }).click();
  await page.locator('.stage-diff .image-diff').getByText(/Size 240 × 160 → 260 × 160/).waitFor();
  assert.equal(await page.getByText('Binary file changed. Stage it whole').count(), 0);

  // Every image read exited 0, and no command failed on the way.
  const entries = await page.evaluate(() => window.twig.getConsoleEntries());
  const reads = entries.filter(entry => entry.operation?.startsWith('Read image'));
  assert.ok(reads.length >= 4, 'the viewer read through the journal');
  assert.ok(reads.every(entry => entry.code === 0));
  assert.ok(reads.filter(entry => entry.operation === 'Read image bytes').every(entry => /bytes of binary output, not shown/.test(entry.stdout)));
  assert.deepEqual(errors, []);

  // A path outside the working tree or a made-up source is refused, not answered.
  const id = await page.evaluate(() => window.twig.getWorkspace()).then(state => state.repositories.find(item => !item.sandbox).id);
  for (const [file, source] of [['../x.png', { kind: 'staged' }], ['art/logo.png', { kind: 'disk' }], ['notes.txt', { kind: 'staged' }], ['art/logo.png', { kind: 'commit', oid: 'HEAD' }]]) {
    await assert.rejects(page.evaluate(([repository, f, s]) => window.twig.getImagePair(repository, f, s), [id, file, source]));
  }
  console.log('image smoke: areas, four views, uncommitted, untracked, staging and IPC refusals passed');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
