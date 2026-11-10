/**
 * Interface languages. No imports: Vite, the main process and the Node checks
 * all load this module.
 *
 * The English text is the key, gettext-style. English needs no catalog, and a
 * string a catalog lacks stays English instead of turning into a key name.
 *
 *   t`Delete ${name}?`          key "Delete {0}?" — placeholders by position
 *   t('Refresh')                key "Refresh"
 *   t(label)                    a string marked elsewhere with mark()
 *   tn(count, '{n} file', '{n} files', { base })
 *                               key "{n} file|{n} files", forms by Intl.PluralRules
 *   tr(text)                    English that came from main or from data built
 *                               in English: exact key, else one of main's
 *                               messages (messages.js) matched as a pattern,
 *                               else as is
 *
 * Git's own words — branch, commit, merge, rebase, stash, tag, remote, HEAD,
 * push, pull, fetch, worktree, staged, untracked — commands, paths, ref names
 * and folder names stay as they are in every language. The catalogs keep them.
 *
 * The main process writes its messages in English (the journal, the MCP
 * server and the checks read them) with ui`…` and uiN(): the extractor
 * collects those keys, the renderer translates them with tr() when it shows
 * them. Main's own windows (menus, native dialogs) have a separate translator
 * from createI18n(), so a module shared with main never speaks the person's
 * language into the journal.
 */

export const LANGUAGES = Object.freeze([
  { code: 'en', name: 'English' },
  { code: 'ru', name: 'Русский' },
  { code: 'uk', name: 'Українська' },
  { code: 'be', name: 'Беларуская' },
  { code: 'de', name: 'Deutsch' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'zh', name: '简体中文' },
  { code: 'ja', name: '日本語' }
]);

export const LANGUAGE_CODES = Object.freeze(LANGUAGES.map(item => item.code));

/** The first of the system's preferred languages 🌱 Twig speaks, else English. */
export function resolveLocale(tags) {
  for (const tag of Array.isArray(tags) ? tags : [tags]) {
    if (typeof tag !== 'string') continue;
    const code = tag.toLowerCase().split(/[-_]/)[0];
    if (LANGUAGE_CODES.includes(code)) return code;
  }
  return 'en';
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** The key a tagged template stands for: the text with {0}, {1}… in place of values. */
export function templateKey(strings) {
  let key = strings[0];
  for (let index = 1; index < strings.length; index++) key += `{${index - 1}}` + strings[index];
  return key;
}

export function pluralKey(one, other) {
  return `${one}|${other}`;
}

function fill(text, values) {
  if (!values) return text;
  return text.replace(PLACEHOLDER, (whole, name) => (Object.hasOwn(values, name) ? String(values[name]) : whole));
}

/** The name on screen: the sprout and the word never part at a line break. The keys keep a plain space. */
export const BRAND = '🌱\u00a0Twig';

function keepBrand(text) {
  return typeof text === 'string' && text.includes('🌱 Twig') ? text.replaceAll('🌱 Twig', BRAND) : text;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compile(template) {
  const names = [];
  let source = '';
  let last = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    source += escapeRegExp(template.slice(last, match.index));
    if (names.includes(match[1])) source += `\\k<p${names.indexOf(match[1])}>`;
    else { source += `(?<p${names.length}>[\\s\\S]+?)`; names.push(match[1]); }
    last = match.index + match[0].length;
  }
  if (!names.length) return null;
  source += escapeRegExp(template.slice(last));
  return { regex: new RegExp(`^${source}$`), names };
}

const ELECTRON_PREFIX = /^Error invoking remote method '[^']*': (?:\w*Error: )?/;

/** A translator with its own language. The module's exports are the renderer's one. */
export function createI18n() {
  let state = { locale: 'en', catalog: null, messages: [], patterns: null, plural: null };
  const formats = new Map();

  function pickForm(entry, count, one, other) {
    if (!state.plural || !entry) return Number(count) === 1 ? one : other;
    if (typeof entry === 'string') return entry;
    return entry[state.plural.select(Number(count))] ?? entry.other ?? other;
  }

  function patterns() {
    if (state.patterns) return state.patterns;
    const list = [];
    for (const key of state.messages) {
      const value = state.catalog?.[key];
      if (!key.includes('{') || value == null) continue;
      const bar = key.indexOf('|');
      if (bar > 0 && value && typeof value === 'object') {
        const one = key.slice(0, bar);
        const other = key.slice(bar + 1);
        for (const form of [one, other]) {
          const compiled = compile(form);
          if (compiled) list.push({ ...compiled, plural: { one, other, entry: value } });
        }
      } else if (typeof value === 'string') {
        const compiled = compile(key);
        if (compiled) list.push({ ...compiled, value });
      }
    }
    // Longer literal text first: the more specific pattern wins.
    list.sort((a, b) => b.regex.source.length - a.regex.source.length);
    state.patterns = list;
    return list;
  }

  function formatter(kind, options) {
    const id = `${state.locale}|${kind}|${JSON.stringify(options)}`;
    let value = formats.get(id);
    if (!value) {
      value = kind === 'number' ? new Intl.NumberFormat(state.locale === 'en' ? 'en-GB' : state.locale, options)
        : kind === 'relative' ? new Intl.RelativeTimeFormat(state.locale === 'en' ? 'en-GB' : state.locale, options)
          : kind === 'list' ? new Intl.ListFormat(state.locale === 'en' ? 'en-GB' : state.locale, options)
            : new Intl.DateTimeFormat(state.locale === 'en' ? 'en-GB' : state.locale, options);
      formats.set(id, value);
    }
    return value;
  }

  function message(text) {
    if (typeof text !== 'string' || !text) return text ?? '';
    if (!state.catalog) return text;
    const exact = state.catalog[text];
    if (typeof exact === 'string') return exact;
    for (const pattern of patterns()) {
      const match = pattern.regex.exec(text);
      if (!match) continue;
      const values = {};
      pattern.names.forEach((name, index) => { values[name] = match.groups[`p${index}`]; });
      if (pattern.plural) {
        const { one, other, entry } = pattern.plural;
        return fill(pickForm(entry, values.n, one, other), values);
      }
      return fill(pattern.value, values);
    }
    // A message made of sentences the catalog knows one by one. The
    // whitespace between them — a line break in a reason with details —
    // stays as it was.
    const pieces = text.split(/(?<=[.!?:])(\s+)(?=[A-Z"“(`]|🌱)/u);
    if (pieces.length > 1) {
      const parts = pieces.map((part, index) => (index % 2 ? part : message(part)));
      if (parts.some((part, index) => part !== pieces[index])) return parts.join('');
    }
    return text;
  }

  const api = {
    getLocale: () => state.locale,

    /**
     * Switches the language. `catalog` is the parsed locales/<code>.json;
     * English takes none. `messages` — MESSAGE_KEYS from messages.js — are
     * the keys tr() matches as patterns, compiled on the first message that
     * needs one. Any other key is only ever looked up whole.
     */
    setLocale(locale, catalog = null, messages = []) {
      const code = LANGUAGE_CODES.includes(locale) ? locale : 'en';
      state = {
        locale: code,
        catalog: code === 'en' ? null : catalog || {},
        messages: Array.isArray(messages) ? messages : [],
        patterns: null,
        plural: code === 'en' ? null : new Intl.PluralRules(code)
      };
    },

    /**
     * t`text ${value}` or t('text', { name: value }). A key the catalog lacks
     * is shown in English with its values filled in.
     */
    t(first, ...rest) {
      if (Array.isArray(first) && Object.hasOwn(first, 'raw')) {
        const key = templateKey(first);
        const values = {};
        rest.forEach((value, index) => { values[index] = value; });
        const text = state.catalog?.[key];
        return keepBrand(fill(typeof text === 'string' ? text : key, values));
      }
      if (typeof first !== 'string') return first == null ? '' : String(first);
      const text = state.catalog?.[first];
      return keepBrand(fill(typeof text === 'string' ? text : first, rest[0]));
    },

    /** A count with its noun: tn(3, '{n} file', '{n} files'). `{n}` is the count. */
    tn(count, one, other, values = null) {
      const form = pickForm(state.catalog?.[pluralKey(one, other)], count, one, other);
      return keepBrand(fill(form, { ...values, n: count }));
    },

    /**
     * English text built elsewhere — a main-process message, a reason, a
     * label from a shared module — in the current language when the catalog
     * has it.
     */
    // A shared module's t() may already have kept the brand; the key has a plain space.
    tr: text => keepBrand(message(typeof text === 'string' ? text.replaceAll(BRAND, '🌱 Twig') : text)),

    /** The message of a failure from IPC, in the current language, or the fallback. */
    failureText(failure, fallback = '') {
      const raw = typeof failure === 'string' ? failure : failure?.message;
      // What Git said rides after this mark (main/git/failure.js); it is not part of the sentence.
      const text = typeof raw === 'string' ? raw.split('\u0000twig:detail\u0000')[0].replace(ELECTRON_PREFIX, '').replace(/^Error:\s*/, '').trim() : '';
      return text ? api.tr(text) : fallback;
    },

    /** A date and time in the interface language; text that is not a date comes back as is. */
    formatDateTime(value, options = { dateStyle: 'medium', timeStyle: 'short' }) {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? String(value ?? '') : formatter('date', options).format(date);
    },

    formatNumber: (value, options = {}) => formatter('number', options).format(value),

    /** "3 days ago", "yesterday" in the interface language. */
    formatRelative: (amount, unit) => formatter('relative', { numeric: 'always' }).format(amount, unit),

    /** "a, b and c" in the interface language. */
    formatList: (items, type = 'conjunction') => formatter('list', { style: 'long', type }).format(items)
  };
  return api;
}

const renderer = createI18n();
export const { getLocale, setLocale, t, tn, tr, failureText, formatDateTime, formatNumber, formatRelative, formatList } = renderer;

/** Marks a string for the extractor; t(it) translates it where it is shown. */
export function mark(text) {
  return text;
}

/**
 * For the main process: the English message with its values, under a key the
 * extractor collects. The renderer translates the result with tr().
 */
export function ui(strings, ...values) {
  let text = strings[0];
  for (let index = 1; index < strings.length; index++) text += String(values[index - 1]) + strings[index];
  return text;
}

/** For the main process: the English count phrase, translated by tr() in the renderer. */
export function uiN(count, one, other, values = null) {
  return fill(Number(count) === 1 ? one : other, { ...values, n: count });
}
