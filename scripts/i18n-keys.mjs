import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as espree from 'espree';
import { pluralKey, templateKey } from '../renderer/src/i18n/i18n.js';

/**
 * Every interface string in the source, by reading the code: t`…`, t('…'),
 * tn(n, '…', '…'), mark('…') in the renderer, ui`…`/uiN() for main's
 * messages, nt`…`/nt('…') for main's own windows. The catalogs are checked
 * against this list (scripts/checks/i18n.mjs) — a key is written once, in
 * English, where it is used.
 *
 *   node scripts/i18n-keys.mjs [out.json]   writes { key: { plural, at[] } }
 *   node scripts/i18n-keys.mjs --messages   rewrites renderer/src/i18n/messages.js
 *
 * A key is a *message* when main can send it to the window as English for
 * tr(): ui`…`/uiN() anywhere, and t`…`/tn()/mark() in a module main imports
 * (there t() speaks English). Only messages with placeholders are matched by
 * tr() as patterns — a key written for the renderer's own t`${n}s` is not a
 * pattern that every path ending in "s" should fit.
 */

const root = fileURLToPath(new URL('../', import.meta.url));
const SOURCES = ['renderer/src', 'main'];
const TAGS = new Set(['t', 'ui', 'nt']);
const CALLS = new Set(['t', 'mark', 'nt', 'tx']);
const PLURALS = new Set(['tn', 'uiN']);
const MAIN_TEXT = new Set(['ui', 'uiN']);
export const MESSAGES_FILE = path.join(root, 'renderer/src/i18n/messages.js');

async function files(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'locales') out.push(...await files(full)); }
    else if (/\.(js|jsx|mjs)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function literal(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'parent') continue;
    const value = node[key];
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

export async function collectKeys() {
  const keys = new Map();
  const problems = [];
  // Per file: the keys it uses (with the function) and what it imports.
  const uses = new Map();
  const imports = new Map();
  const add = (key, plural, at, forms, file, fn) => {
    if (!key.trim()) { problems.push(`${at}: empty key`); return; }
    const entry = keys.get(key) || { plural, forms, at: [], message: false };
    if (entry.plural !== plural) problems.push(`${at}: "${key}" is both plural and not`);
    entry.at.push(at);
    keys.set(key, entry);
    if (!uses.has(file)) uses.set(file, []);
    uses.get(file).push({ key, fn });
  };
  for (const source of SOURCES) {
    for (const file of await files(path.join(root, source))) {
      const text = await readFile(file, 'utf8');
      if (!/\b(t|ui|nt|tn|uiN|mark|tx)\b|\bfrom\b|\bimport\(/.test(text)) continue;
      let tree;
      try {
        tree = espree.parse(text, { ecmaVersion: 'latest', sourceType: 'module', loc: true, ecmaFeatures: { jsx: true } });
      } catch (error) {
        problems.push(`${path.relative(root, file)}: ${error.message}`);
        continue;
      }
      const where = node => `${path.relative(root, file)}:${node.loc.start.line}`;
      const imported = [];
      imports.set(file, imported);
      walk(tree, node => {
        const from = (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration'
          || node.type === 'ImportExpression') ? literal(node.source) : null;
        if (from?.startsWith('.')) imported.push(path.resolve(path.dirname(file), from));
        if (node.type === 'TaggedTemplateExpression' && node.tag.type === 'Identifier' && TAGS.has(node.tag.name)) {
          const key = templateKey(node.quasi.quasis.map(part => part.value.cooked));
          if (/\{\d+\}/.test(node.quasi.quasis.map(part => part.value.cooked).join(''))) problems.push(`${where(node)}: literal {digits} in "${key}"`);
          add(key, false, where(node), undefined, file, node.tag.name);
        } else if (node.type === 'CallExpression' && node.callee.type === 'Identifier') {
          const name = node.callee.name;
          if (CALLS.has(name) && node.arguments.length) {
            const key = literal(node.arguments[0]);
            if (key !== null) add(key, false, where(node), undefined, file, name);
          } else if (PLURALS.has(name)) {
            const one = literal(node.arguments[1]);
            const other = literal(node.arguments[2]);
            if (one === null || other === null) problems.push(`${where(node)}: ${name}() needs two string literals`);
            else add(pluralKey(one, other), true, where(node), { one, other }, file, name);
          }
        }
      });
    }
  }
  // What main loads: its own files and every module they import.
  const mainFiles = new Set();
  const queue = [...imports.keys()].filter(file => file.startsWith(path.join(root, 'main') + path.sep));
  while (queue.length) {
    const file = queue.pop();
    if (mainFiles.has(file)) continue;
    mainFiles.add(file);
    queue.push(...(imports.get(file) || []));
  }
  for (const [file, list] of uses) {
    for (const { key, fn } of list) {
      if (MAIN_TEXT.has(fn) || (mainFiles.has(file) && fn !== 'nt' && fn !== 'tx')) keys.get(key).message = true;
    }
  }
  return { keys, problems };
}

/** The keys tr() may match as patterns: messages with placeholders, sorted. */
export function messageKeys(keys) {
  return [...keys].filter(([key, entry]) => entry.message && key.includes('{')).map(([key]) => key).sort();
}

export function messagesModule(list) {
  return `// Generated by \`node scripts/i18n-keys.mjs --messages\`; checked by scripts/checks/i18n.mjs.
// The keys with placeholders that main sends to the window in English: the
// only ones tr() matches as patterns.
export const MESSAGE_KEYS = Object.freeze(${JSON.stringify(list, null, 2)});
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { keys, problems } = await collectKeys();
  for (const problem of problems) console.error(problem);
  const out = Object.fromEntries([...keys].sort(([a], [b]) => a.localeCompare(b)));
  if (process.argv[2] === '--messages') await writeFile(MESSAGES_FILE, messagesModule(messageKeys(keys)));
  else if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(out, null, 2));
  console.log(`${keys.size} keys, ${[...keys.values()].filter(item => item.plural).length} plural`);
}
