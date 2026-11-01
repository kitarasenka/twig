import { setLocale } from './i18n.js';
import { MESSAGE_KEYS } from './messages.js';

// One chunk per language: only the chosen catalog is ever downloaded.
const catalogs = import.meta.glob('./locales/*.json', { import: 'default' });
const REOPEN = 'twig:reopen-settings';
let current = { choice: 'system', locale: 'en', system: 'en' };

/** Loads the catalog of `locale` and makes it the renderer's language. */
export async function loadLocale(locale) {
  const loader = catalogs[`./locales/${locale}.json`];
  let catalog = null;
  if (loader) {
    try { catalog = await loader(); } catch { catalog = null; }
  }
  setLocale(loader ? locale : 'en', catalog, MESSAGE_KEYS);
  // Han characters are drawn by the system font in the language's own style.
  document.documentElement.lang = loader ? locale : 'en';
}

/** Before the first paint: the language main has, with its catalog loaded. */
export async function startLanguage() {
  try { current = await window.twig.getLanguage(); } catch { current = { choice: 'system', locale: 'en', system: 'en' }; }
  await loadLocale(current.locale);
  return current;
}

export function languageChoice() {
  return current.choice;
}

/** The language "System" stands for on this machine. */
export function systemLanguage() {
  return current.system;
}

/**
 * Switches the language everywhere: main saves it and redraws its menu, the
 * renderer loads the catalog, and the window is drawn again from the top —
 * memoized screens would otherwise keep their old words. Settings, where the
 * switch is, opens again.
 */
export async function changeLanguage(choice) {
  current = await window.twig.setLanguage(choice);
  await loadLocale(current.locale);
  try { sessionStorage.setItem(REOPEN, '1'); } catch { /* Settings just stays closed */ }
  window.dispatchEvent(new CustomEvent('twig:language', { detail: current.locale }));
}

/** True once after a language switch: App opens Settings again. */
export function takeReopenSettings() {
  try {
    const value = sessionStorage.getItem(REOPEN) === '1';
    sessionStorage.removeItem(REOPEN);
    return value;
  } catch { return false; }
}
