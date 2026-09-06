import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const base = 'http://127.0.0.1:5190';
const artifacts = new URL('../artifacts/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('dist/downloads.json', import.meta.url), 'utf8'));
const browser = await chromium.launch({ headless: true, executablePath: process.env.TWIG_BROWSER_PATH || undefined });
const errors = [];
const external = [];
try {
  await mkdir(artifacts, { recursive: true });
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith(base + '/')) external.push(request.url()); });
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await page.goto(base);
    await page.evaluate(() => globalThis.document.fonts.ready);
    if (width === 1440) await page.screenshot({ path: new URL('site-desktop.png', artifacts).pathname });
    assert.equal(await page.locator('h1').count(), 1);
    const overflow = await page.evaluate(() => [...globalThis.document.querySelectorAll('body *')].filter((element) => element.getBoundingClientRect().right > globalThis.innerWidth + 1).map((element) => element.className));
    assert.equal(await page.evaluate(() => globalThis.document.documentElement.scrollWidth > globalThis.innerWidth), false, `Overflow at ${width}px: ${overflow.join(', ')}`);
    assert.equal(await page.locator('.download-link').count(), manifest.downloads.length);
    await page.locator('.hero-actions .primary').click();
    assert.equal(new URL(page.url()).hash, '#download');
    await page.locator('summary').click();
    assert.equal(await page.locator('details').getAttribute('open'), '');
    for (const img of await page.locator('img').all()) {
      await img.scrollIntoViewIfNeeded();
      assert.equal(await img.evaluate((element) => element.complete && element.naturalWidth > 0), true);
    }
    await page.getByRole('link', { name: 'Наверх', exact: true }).click();
    await page.screenshot({ path: new URL(`site-${width}.png`, artifacts).pathname, fullPage: true });
  }
  await page.goto(base);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator(':focus').textContent(), 'К содержимому');
  await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash, '#main');
  await page.route('**/downloads/*', (route) => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: 'Download link test fixture — not an installer.' }));
  for (const { href, filename } of manifest.downloads) {
    const pending = page.waitForEvent('download');
    await page.locator(`a[href="${href}"]`).click();
    const download = await pending;
    assert.equal(download.suggestedFilename(), filename);
    await download.cancel();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  console.log('Site checks passed: 375/768/1024/1440px, no overflow, local assets, anchors, keyboard, FAQ, five download links; JavaScript disabled. Installer responses are test fixtures.');
} finally {
  await browser.close();
}
