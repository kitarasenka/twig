import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * Interface languages in the real window: English to start with, Settings →
 * Language switches the whole window (and Settings opens again), the choice
 * survives a restart, Git's words stay Git's, and the menu bar follows.
 */
const profile = await mkdtemp(path.join(tmpdir(), 'twig-i18n-'));
await mkdir('artifacts', { recursive: true });
const catalog = async code => JSON.parse(await readFile(`renderer/src/i18n/locales/${code}.json`, 'utf8'));
const errors = [];
let app;

async function launch() {
  // No TWIG_LANGUAGE here: this run is about the stored choice.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.TWIG_DEV; delete env.TWIG_LANGUAGE;
  app = await electron.launch({ args: ['.', `--user-data-dir=${profile}`], env, timeout: 30000 });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  return page;
}

try {
  // Start in English whatever this machine prefers.
  await writeFile(path.join(profile, 'language.json'), JSON.stringify({ language: 'en' }));
  let page = await launch();
  await page.getByRole('listbox', { name: 'Commit history', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');

  const shots = [['ru', 'Русский'], ['de', 'Deutsch'], ['ja', '日本語']];
  for (const [code] of shots) {
    const words = await catalog(code);
    await page.locator('button[aria-label="Settings"], button[aria-label]').filter({ has: page.locator('svg.lucide-settings') }).first().click();
    await page.locator('#language').selectOption(code);
    // The window is drawn again in the new language and Settings is open again.
    await page.getByRole('dialog', { name: words.Settings }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), code);
    await page.screenshot({ path: `artifacts/i18n-${code}-settings.png` });
    await page.keyboard.press('Escape');
    await page.getByRole('listbox', { name: words['Commit history'], exact: true }).waitFor();
    // Git's own words are kept: the history still names its branches as Git does.
    const toolbar = await page.locator('.toolbar').innerText();
    assert.ok(toolbar.includes('Push') || toolbar.includes('Pull'), `${code}: Pull/Push stay Git words`);
    await page.screenshot({ path: `artifacts/i18n-${code}-history.png` });
  }

  const ja = await catalog('ja');

  // The choice survives a restart; the menu bar follows it too.
  await app.close();
  page = await launch();
  await page.getByRole('listbox', { name: ja['Commit history'], exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'ja');
  const menu = await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map(item => item.label));
  assert.ok(menu.includes(ja.Edit) && menu.includes(ja.View), `menu bar in Japanese: ${menu.join(', ')}`);
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'language.json'), 'utf8')), { language: 'ja' });

  // Back to "System": the stored choice says so, and nothing breaks.
  await page.locator('button[aria-label]').filter({ has: page.locator('svg.lucide-settings') }).first().click();
  await page.locator('#language').selectOption('system');
  await page.waitForFunction(async () => (await window.twig.getLanguage()).choice === 'system');
  await page.locator('#language').waitFor();
  assert.deepEqual(JSON.parse(await readFile(path.join(profile, 'language.json'), 'utf8')), { language: 'system' });
  assert.deepEqual(errors, []);
  console.log('i18n smoke: English start, ru/de/ja switch with Settings reopened, Git words kept, restart keeps the language, menu bar, back to System');
} finally {
  await app?.close().catch(() => {});
  await rm(profile, { recursive: true, force: true });
}
