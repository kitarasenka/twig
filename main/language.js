import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonFile, writeFileAtomic } from './json-file.js';
import { createI18n, LANGUAGE_CODES, resolveLocale } from '../renderer/src/i18n/i18n.js';

const CATALOGS = fileURLToPath(new URL('../renderer/src/i18n/locales/', import.meta.url));

/**
 * The interface language: 'system' (the default) or one of LANGUAGE_CODES,
 * `language.json` in userData. It lives in main because main's own windows —
 * the menu bar, open/save panels, message boxes — speak it too.
 *
 * `TWIG_LANGUAGE` in the environment wins over both: the smoke tests pin
 * English with it, whatever language the machine running them prefers.
 */
export function normalizeLanguage(value) {
  return value === 'system' || LANGUAGE_CODES.includes(value) ? value : 'system';
}

export function effectiveLocale(choice, systemTags, env = process.env) {
  if (env.TWIG_LANGUAGE && LANGUAGE_CODES.includes(env.TWIG_LANGUAGE)) return env.TWIG_LANGUAGE;
  return choice === 'system' ? resolveLocale(systemTags) : choice;
}

export async function readCatalog(locale) {
  if (locale === 'en' || !LANGUAGE_CODES.includes(locale)) return null;
  try { return JSON.parse(await readFile(path.join(CATALOGS, `${locale}.json`), 'utf8')); }
  catch { return null; }
}

export class LanguageStore {
  #file;
  #choice = 'system';

  constructor(directory) { this.#file = path.join(directory, 'language.json'); }

  async load() {
    await mkdir(path.dirname(this.#file), { recursive: true });
    this.#choice = normalizeLanguage((await readJsonFile(this.#file))?.language);
    return this.#choice;
  }

  get() { return this.#choice; }

  async save(value) {
    const next = normalizeLanguage(value);
    await writeFileAtomic(this.#file, JSON.stringify({ language: next }, null, 2));
    this.#choice = next;
    return next;
  }
}

/** Main's own translator: menus and native dialogs. Shared modules stay English. */
export const native = createI18n();
export const nt = native.t;
