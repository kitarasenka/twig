import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { collectKeys, messageKeys, messagesModule, MESSAGES_FILE } from '../i18n-keys.mjs';
import { createI18n, LANGUAGE_CODES, mark, resolveLocale, ui, uiN } from '../../renderer/src/i18n/i18n.js';
import { effectiveLocale, normalizeLanguage } from '../../main/language.js';

// The translator itself.
{
  const i18n = createI18n();
  assert.equal(i18n.t`Delete ${'main'}?`, 'Delete main?');
  assert.equal(i18n.t('Refresh'), 'Refresh');
  assert.equal(i18n.tn(1, '{n} file', '{n} files'), '1 file');
  assert.equal(i18n.tn(5, '{n} file', '{n} files'), '5 files');
  assert.equal(i18n.tr('Anything at all'), 'Anything at all');
  i18n.setLocale('ru', {
    'Delete {0}?': 'Удалить {0}?',
    Refresh: 'Обновить',
    '{n} file|{n} files': { one: '{n} файл', few: '{n} файла', many: '{n} файлов', other: '{n} файла' },
    '{n} commit ahead of {base}|{n} commits ahead of {base}': { one: 'на {n} commit впереди {base}', few: 'на {n} commit впереди {base}', many: 'на {n} commit впереди {base}', other: 'на {n} commit впереди {base}' },
    'Finish or abort the {0} first.': 'Сначала завершите или прервите {0}.',
    'Branch {0} is not fully merged.': 'Branch {0} слита не полностью.',
    'Show output in the console.': 'Подробности — в консоли.',
    // Keys the renderer only ever looks up whole: never patterns for tr().
    '{0}s': '{0} с',
    '{0} is {1}': '{0}: {1}',
    'Run {0}': 'Выполнить {0}'
  }, ['{n} file|{n} files', 'Finish or abort the {0} first.', 'Branch {0} is not fully merged.']);
  assert.equal(i18n.t`Delete ${'main'}?`, 'Удалить main?');
  assert.equal(i18n.t('Refresh'), 'Обновить');
  assert.equal(i18n.t('Not in the catalog'), 'Not in the catalog');
  assert.equal(i18n.tn(1, '{n} file', '{n} files'), '1 файл');
  assert.equal(i18n.tn(3, '{n} file', '{n} files'), '3 файла');
  assert.equal(i18n.tn(11, '{n} file', '{n} files'), '11 файлов');
  assert.equal(i18n.tn(2, '{n} commit ahead of {base}', '{n} commits ahead of {base}', { base: 'main' }), 'на 2 commit впереди main');
  // Messages from main: exact, by pattern, plural by pattern, sentence by sentence.
  assert.equal(i18n.tr('Refresh'), 'Обновить');
  assert.equal(i18n.tr('Finish or abort the merge first.'), 'Сначала завершите или прервите merge.');
  assert.equal(i18n.tr('5 files'), '5 файлов');
  assert.equal(i18n.tr('Branch feature/x is not fully merged. Show output in the console.'), 'Branch feature/x слита не полностью. Подробности — в консоли.');
  assert.equal(i18n.tr('fatal: not a git repository'), 'fatal: not a git repository');
  // Data that happens to fit a key of the renderer's own stays as written.
  assert.equal(i18n.tr('src/main.js'), 'src/main.js');
  assert.equal(i18n.tr('Run tests'), 'Run tests');
  assert.equal(i18n.tr("The branch 'x' is not fully merged."), "The branch 'x' is not fully merged.");
  // Sentences translated one by one keep the line breaks between them.
  assert.equal(i18n.tr('Finish or abort the merge first.\nShow output in the console.'), 'Сначала завершите или прервите merge.\nПодробности — в консоли.');
  assert.equal(i18n.failureText(new Error("Error invoking remote method 'ops:merge': Error: Finish or abort the rebase first.")), 'Сначала завершите или прервите rebase.');
  assert.equal(i18n.failureText(null, 'Could not read.'), 'Could not read.');
  assert.equal(i18n.failureText({ message: '' }, 'fallback'), 'fallback');
  // An unknown language is English, never a half state.
  i18n.setLocale('xx', { Refresh: 'nope' });
  assert.equal(i18n.getLocale(), 'en');
  assert.equal(i18n.t('Refresh'), 'Refresh');
  // Main's helpers write English whatever the renderer speaks.
  assert.equal(ui`Finish or abort the ${'merge'} first.`, 'Finish or abort the merge first.');
  assert.equal(uiN(2, '{n} possible secret in {where}', '{n} possible secrets in {where}', { where: 'the index' }), '2 possible secrets in the index');
  assert.equal(mark('Stage all'), 'Stage all');
}

// The system language and the stored choice.
assert.equal(resolveLocale(['ru-BY']), 'ru');
assert.equal(resolveLocale(['pt-BR', 'zh-Hans-CN']), 'zh');
assert.equal(resolveLocale(['ja_JP']), 'ja');
assert.equal(resolveLocale(['pt-BR']), 'en');
assert.equal(resolveLocale([]), 'en');
assert.equal(normalizeLanguage('de'), 'de');
assert.equal(normalizeLanguage('../etc'), 'system');
assert.equal(effectiveLocale('system', ['uk-UA'], {}), 'uk');
assert.equal(effectiveLocale('fr', ['uk-UA'], {}), 'fr');
assert.equal(effectiveLocale('fr', ['uk-UA'], { TWIG_LANGUAGE: 'en' }), 'en');
assert.equal(effectiveLocale('system', ['uk-UA'], { TWIG_LANGUAGE: 'bogus' }), 'uk');

// The source and the catalogs.
const { keys, problems } = await collectKeys();
assert.deepEqual(problems, [], 'every interface string is extractable');
assert.ok(keys.size > 0);
// tr() matches only main's messages as patterns; the list is generated from the source.
assert.equal(await readFile(MESSAGES_FILE, 'utf8'), messagesModule(messageKeys(keys)),
  'renderer/src/i18n/messages.js is out of date: run node scripts/i18n-keys.mjs --messages');
assert.ok(messageKeys(keys).includes('Undo {0}'), 'a ui`…` key from main is a message');
assert.ok(!messageKeys(keys).includes('{0}s'), 'a renderer-only t`…` key is not');

const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();

// Git's words stay Git's words: "branch" is never "ветка". A catalog that
// translates one of them fails here, not in front of the person.
const GIT_WORDS = {
  ru: /(?<!\p{L})ветк|(?<!\p{L})(?:не)?сли[тл]|коммит|комит|слияни|ребейз|ребэйз|(?<!\p{L})пуш|(?<!\p{L})т[еэ]г|ст[еэ]ш|бранч|воркт/iu,
  uk: /гілк|коміт|злитт|ребейз|(?<!\p{L})пуш|(?<!\p{L})т[еэ]г|ст[еэ]ш|сташ|бранч/iu,
  be: /галін|каміт|коміт|зліцц|рэбейз|(?<!\p{L})пуш|(?<!\p{L})т[еэ]г|ст[еэ]ш|бранч/iu,
  de: /Zweig|Zusammenführ/u,
  es: /\bramas?\b|\bfusion/iu,
  fr: /\bbranche\b|\bfusionn/iu,
  zh: /分支|合并|变基|储藏|标签|推送|拉取|暂存区/u,
  ja: /ブランチ|コミット|マージ|リベース|スタッシュ|タグ|プッシュ|プル(?!ダウン)/u
};

const root = fileURLToPath(new URL('../../renderer/src/i18n/locales/', import.meta.url));
const failures = [];
// `node scripts/checks/i18n.mjs ru de` checks only those catalogs.
const only = process.argv.slice(2);
for (const locale of LANGUAGE_CODES.filter(code => code !== 'en' && (!only.length || only.includes(code)))) {
  const catalog = JSON.parse(await readFile(`${root}${locale}.json`, 'utf8'));
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
  const missing = [...keys.keys()].filter(key => !Object.hasOwn(catalog, key));
  const orphans = Object.keys(catalog).filter(key => !keys.has(key));
  if (missing.length) failures.push(`${locale}: ${missing.length} missing, e.g. ${JSON.stringify(missing.slice(0, 5))}`);
  if (orphans.length) failures.push(`${locale}: ${orphans.length} not in the source, e.g. ${JSON.stringify(orphans.slice(0, 5))}`);
  for (const [key, value] of Object.entries(catalog)) {
    const source = keys.get(key);
    if (!source) continue;
    const texts = [];
    if (source.plural) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { failures.push(`${locale}: "${key}" needs plural forms`); continue; }
      const english = new Set([...placeholders(source.forms.one), ...placeholders(source.forms.other)]);
      // "many" in Spanish and French is for millions; without it "other" is used.
      for (const category of categories.filter(item => !(item === 'many' && ['es', 'fr'].includes(locale)))) {
        if (typeof value[category] !== 'string' || !value[category].trim()) failures.push(`${locale}: "${key}" lacks "${category}"`);
      }
      for (const [category, text] of Object.entries(value)) {
        if (!categories.includes(category)) failures.push(`${locale}: "${key}" has "${category}", which ${locale} does not use`);
        else {
          texts.push(text);
          const stray = placeholders(text).filter(name => !english.has(name));
          if (stray.length) failures.push(`${locale}: "${key}" ${category} has unknown {${stray.join('}, {')}}`);
        }
      }
      if (typeof value.other === 'string' && placeholders(value.other).join() !== placeholders(source.forms.other).join()) {
        failures.push(`${locale}: "${key}" other must keep {${placeholders(source.forms.other).join('}, {')}}`);
      }
    } else {
      if (typeof value !== 'string' || !value.trim()) { failures.push(`${locale}: "${key}" is empty`); continue; }
      texts.push(value);
      if (placeholders(value).join() !== placeholders(key).join()) failures.push(`${locale}: "${key}" → "${value}" changes the placeholders`);
    }
    for (const text of texts) {
      const bare = text.replace(/\{\w+\}/g, '');
      if (GIT_WORDS[locale].test(bare) && !GIT_WORDS[locale].test(key)) failures.push(`${locale}: "${key}" → "${text}" translates a Git word`);
    }
  }
}
assert.deepEqual(failures, [], `catalogs:\n${failures.join('\n')}`);

console.log(`i18n checks passed: ${keys.size} keys in ${LANGUAGE_CODES.length - 1} catalogs`);
