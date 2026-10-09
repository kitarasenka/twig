import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CommandLog } from '../main/command-log.js';
import { runGit } from '../main/git/exec.js';

// A graph column narrower than its lanes clips them and scrolls sideways on its
// own: the lanes never draw over the message column, and a sideways swipe or
// ← → bring the hidden dots into view. There is no scrollbar for it.
const root = await mkdtemp(path.join(os.tmpdir(), 'twig-graph-scroll-'));
let app;
try {
  const cwd = path.join(root, 'lanes'); await mkdir(cwd);
  const log = new CommandLog(root); await log.load();
  const git = async argv => {
    const result = await runGit({ cwd, log, argv });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.replace(/\n$/, '');
  };
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.name', 'Twig Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await git(['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=', 'commit', '--allow-empty', '-m', 'Root']);
  const base = await git(['rev-parse', 'HEAD']);
  const tree = await git(['rev-parse', 'HEAD^{tree}']);
  // Fourteen branches off the root, joined by one octopus merge at the top: all
  // fourteen lanes are open at once, ~276 px of graph.
  const tips = [];
  for (let i = 0; i < 14; i++) {
    let tip = base;
    for (let j = 0; j < 2; j++) tip = await git(['commit-tree', tree, '-p', tip, '-m', `Lane ${i} commit ${j}`]);
    tips.push(tip);
  }
  const merge = await git(['commit-tree', tree, ...tips.flatMap(tip => ['-p', tip]), '-m', 'Octopus']);
  await git(['update-ref', 'refs/heads/main', merge]);

  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV;
  app = await electron.launch({ args: ['.', `--user-data-dir=${path.join(root, 'profile')}`], env });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 880 });
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, cwd);
  await page.getByRole('button', { name: 'New repository tab', exact: true }).click();
  await page.getByRole('button', { name: 'Open repository', exact: true }).click();
  const list = page.getByRole('listbox', { name: 'Commit history', exact: true });
  await list.getByRole('option').first().waitFor();
  const cssPx = name => list.evaluate((node, prop) =>
    parseFloat(getComputedStyle(node.closest('.real-history')).getPropertyValue(prop)), name);
  const waitScroll = (op, arg = 0) => page.waitForFunction(([kind, value]) => {
    const node = [...document.querySelectorAll('[aria-label="Commit history"]')].find(item => item.offsetParent);
    const scroll = parseFloat(getComputedStyle(node.closest('.real-history')).getPropertyValue('--graph-scroll'));
    return kind === '>' ? scroll > value : scroll === value;
  }, [op, arg]);

  const content = await cssPx('--graph-content');
  assert.ok(content > 200, `fourteen lanes need a wide graph: ${content}`);
  assert.equal(await cssPx('--graph-width'), content, 'auto width fits every lane');

  // Narrow the graph by dragging its handle far left: it stops at a tenth of its maximum.
  const handle = page.getByRole('separator', { name: 'Resize Graph column' });
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 600, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  const width = await cssPx('--graph-width');
  assert.equal(width, 64, `graph narrowed to its minimum: ${width}`);
  assert.equal(await handle.getAttribute('aria-valuemin'), '64');

  // The lanes are clipped by their own cell: nothing reaches into the message column.
  const row = list.getByRole('option').first();
  const clip = await row.evaluate(node => {
    const cell = node.querySelector('.lane-cell').getBoundingClientRect();
    const message = node.querySelector('.commit-subject').getBoundingClientRect();
    return { overflow: getComputedStyle(node.querySelector('.lane-cell')).overflow, right: cell.right, message: message.left };
  });
  assert.equal(clip.overflow, 'hidden');
  assert.ok(clip.right <= clip.message + 0.5, `graph ends before the message: ${clip.right} vs ${clip.message}`);
  assert.ok(await list.locator('xpath=ancestor::*[contains(@class,"graph-clip-right")]').count(), 'a soft edge marks hidden lanes on the right');

  // A sideways swipe over the graph moves the lanes, not the table.
  const lane = await row.locator('.lane-cell').boundingBox();
  await page.mouse.move(lane.x + 40, lane.y + lane.height / 2);
  await page.mouse.wheel(60, 0);
  await waitScroll('>', 0);
  const scrolled = await cssPx('--graph-scroll');
  assert.equal(await list.evaluate(node => node.scrollLeft), 0, 'the table itself did not scroll');
  const shift = await row.locator('.lane-track').evaluate(node => new DOMMatrix(getComputedStyle(node).transform).m41);
  assert.equal(shift, -scrolled, 'the lanes moved by the scroll');
  assert.ok(await list.locator('xpath=ancestor::*[contains(@class,"graph-clip-left")]').count(), 'a soft edge on the left now too');
  await page.mouse.wheel(5000, 0);
  await waitScroll('=', content - width);

  // A swipe the other way brings it back to the start.
  await page.mouse.wheel(-5000, 0);
  await waitScroll('=', 0);

  // ← → in the list move it two lanes at a time.
  await list.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await cssPx('--graph-scroll'), 36);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await cssPx('--graph-scroll'), 0);

  // Selecting a commit on a hidden lane brings its dot into view.
  const rightmost = await list.evaluate(node => {
    const rows = [...node.querySelectorAll('.real-commit-row')];
    const x = row => Number(row.querySelector('.real-lane circle').getAttribute('cx'));
    return rows.reduce((best, row) => (x(row) > x(best) ? row : best)).id;
  });
  const dotX = await page.locator(`#${rightmost} .real-lane circle`).first().getAttribute('cx');
  assert.ok(Number(dotX) > width, 'that commit sits on a lane past the visible width');
  await page.locator(`#${rightmost} .commit-subject`).click();
  const reveal = await cssPx('--graph-scroll');
  assert.ok(Number(dotX) - reveal > 0 && Number(dotX) - reveal < width, `selected dot is visible: x=${dotX}, scroll=${reveal}`);
  await page.screenshot({ path: 'artifacts/graph-scroll.png' });

  // Double-click returns the automatic width, and with it nothing to scroll.
  await handle.dblclick();
  assert.equal(await cssPx('--graph-width'), content);
  assert.equal(await cssPx('--graph-scroll'), 0);
  assert.deepEqual(errors, []);
  console.log('graph scroll smoke passed');
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
