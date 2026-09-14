import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:5190';
const builtPage = new URL('dist/index.html', import.meta.url).href;
const builtRoot = new URL('dist/', import.meta.url).href;
const artifacts = new URL('../artifacts/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('dist/downloads.json', import.meta.url), 'utf8'));
// Download links may be a sibling downloads/ path or an absolute off-site URL
// (GitHub Releases). Resolve both against the page origin for matching.
const downloadUrl = ({ href }) => new URL(href, base + '/').href;
const isDownload = (url) => manifest.downloads.some((entry) => downloadUrl(entry) === url);
const browser = await chromium.launch({ headless: true, executablePath: process.env.TWIG_BROWSER_PATH || undefined });
const errors = [];
const external = [];
try {
  await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith(base + '/') && !isDownload(request.url())) external.push(request.url()); });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(base);
    await page.evaluate(() => globalThis.document.fonts.ready);
    if (width === 1440) await page.screenshot({ path: new URL('site-nojs-desktop.png', artifacts).pathname });
    assert.equal(await page.locator('h1').count(), 1);
    const overflow = await page.evaluate(() => [...globalThis.document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > globalThis.innerWidth + 1).map((element) => element.className));
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false, `Overflow at ${width}px: ${overflow.join(', ')}`);
    assert.equal(await page.locator('.download-link').count(), manifest.downloads.length);
    await page.locator('.hero-actions .primary').click();
    assert.equal(new URL(page.url()).hash, '#download');
    await page.locator('.install-help summary').click();
    assert.equal(await page.locator('.install-help').getAttribute('open'), '');
    // Version and release date sit in the hero; the patch notes are their own
    // section, with older releases folded away.
    assert.match(await page.locator('.hero-copy > .eyebrow').innerText(), new RegExp(`v${manifest.version.replace(/\./g, '\\.')}`));
    assert.equal(await page.locator('.hero-copy > .eyebrow time').getAttribute('datetime'), manifest.releaseDate);
    assert.match(await page.locator('#whats-new-title').innerText(), new RegExp(manifest.version.replace(/\./g, '\\.')));
    assert.ok(await page.locator('#whats-new .release-notes li').count() > 0, 'The release lists what appeared in it');
    await page.locator('.release-history summary').click();
    assert.equal(await page.locator('.release-history').getAttribute('open'), '');
    for (const img of await page.locator('img').all()) {
      await img.scrollIntoViewIfNeeded();
      assert.equal(await img.evaluate((element) => element.complete && element.naturalWidth > 0), true);
    }
    await page.getByRole('link', { name: 'Наверх', exact: true }).click();
    await page.screenshot({ path: new URL(`site-nojs-${width}.png`, artifacts).pathname, fullPage: true });
  }
  await page.goto(base);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'К содержимому');
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash, '#main');
  await page.route((url) => isDownload(url.href), (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'Download link test fixture — not an installer.' }));
  for (const { href, filename } of manifest.downloads) {
    const pending = page.waitForEvent('download');
    await page.locator(`a[href="${href}"]`).click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), filename);
    await download.cancel();
  }
  assert.equal(await page.locator('.demo-panel:visible').count(), 3);
  assert.equal(await page.locator('.demo-tabs:visible').count(), 0);
  const interactive = await browser.newContext({ reducedMotion: 'reduce' });
  const demo = await interactive.newPage();
  demo.on('pageerror', error => errors.push(error.message));
  demo.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  demo.on('request', request => { if (!request.url().startsWith(builtRoot) && !isDownload(request.url())) external.push(request.url()); });
  for (const width of [375, 768, 1024, 1440]) {
    await demo.setViewportSize({ width, height: 960 });
    await demo.goto(builtPage);
    await demo.evaluate(() => globalThis.document.fonts.ready);
    assert.equal(await demo.locator('[role="tabpanel"]:visible').count(), 1, errors.join('\n'));
    const heights = [];
    for (const id of ['checks', 'commands', 'marks']) {
      await demo.locator(`#tab-${id}`).click();
      assert.equal(await demo.locator(`#tab-${id}`).getAttribute('aria-selected'), 'true');
      assert.equal(await demo.locator(`#demo-${id}`).isVisible(), true);
      assert.equal(await demo.locator('[role="tabpanel"]:visible').count(), 1);
      heights.push((await demo.locator('.product-demo').boundingBox()).height);
      assert.equal(await demo.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false, `Interactive overflow at ${width}px / ${id}`);
      assert.equal(await demo.evaluate(() => globalThis.document.getAnimations().length), 0, 'Reduced motion disables all animations');
      if (width === 1440) await demo.screenshot({ path: new URL(`site-demo-${id}.png`, artifacts).pathname });
    }
    assert.ok(Math.max(...heights) - Math.min(...heights) < 2, `Tab switching shifts layout at ${width}px: ${heights}`);
    await demo.locator('#tab-checks').click();
    await demo.keyboard.press('ArrowRight');
    assert.equal(await demo.locator(':focus').getAttribute('id'), 'tab-commands');
    await demo.keyboard.press('End');
    assert.equal(await demo.locator(':focus').getAttribute('id'), 'tab-marks');
    await demo.keyboard.press('ArrowRight');
    assert.equal(await demo.locator(':focus').getAttribute('id'), 'tab-checks');
    await demo.keyboard.press('ArrowLeft');
    assert.equal(await demo.locator(':focus').getAttribute('id'), 'tab-marks');
    await demo.keyboard.press('Home');
    await demo.keyboard.press('Tab');
    assert.equal(await demo.locator(':focus').getAttribute('id'), 'demo-checks');
    const brokenAnchors = await demo.evaluate(() => [...globalThis.document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute('href').slice(1)).filter(id => id && !globalThis.document.getElementById(id)));
    assert.deepEqual(brokenAnchors, []);
    await demo.locator('h1').click();
    await demo.evaluate(() => globalThis.scrollTo(0, 0));
    if (width === 375) await demo.screenshot({ path: new URL('site-mobile.png', artifacts).pathname });
    if (width === 1440) await demo.screenshot({ path: new URL('site-desktop.png', artifacts).pathname });
    await demo.screenshot({ path: new URL(`site-${width}.png`, artifacts).pathname, fullPage: true });
  }
  await demo.emulateMedia({ reducedMotion: 'no-preference' });
  await demo.locator('#tab-commands').click();
  assert.ok(await demo.locator('#demo-commands').evaluate(element => element.getAnimations({ subtree: true }).length > 0), 'Selected scenario animates');
  await demo.locator('#features').scrollIntoViewIfNeeded();
  await demo.waitForFunction(() => !!globalThis.document.querySelector('.feature.is-revealed'));
  await demo.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await demo.evaluate(() => globalThis.document.getAnimations().length), 0, 'Changing motion preference stops animations');
  const scriptResponse = await page.request.get(base + '/site.js');
  if (!/javascript/.test(scriptResponse.headers()['content-type'] || '')) console.warn('Preview server needs a restart to serve site.js. Interactive checks use the built file directly.');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log(`Site checks passed: 375/768/1024/1440px without JS over HTTP and with JS from built HTML, no overflow, local assets, anchors, keyboard tabs, version and release notes, stable demo height, motion preferences, FAQ, ${manifest.downloads.length} download links. Installer responses are test fixtures.`);
} finally {
  await browser.close();
}
