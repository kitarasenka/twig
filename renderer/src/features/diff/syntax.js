import './prism-setup.js';
import Prism from 'prismjs';
// Grammars in dependency order (markup, css, clike and javascript ship with the
// core). The list matches `LANGUAGES` in languages.js; the self-check keeps
// the two in step.
import 'prismjs/components/prism-jsx.js';
import 'prismjs/components/prism-typescript.js';
import 'prismjs/components/prism-tsx.js';
import 'prismjs/components/prism-json.js';
import 'prismjs/components/prism-scss.js';
import 'prismjs/components/prism-less.js';
import 'prismjs/components/prism-markdown.js';
import 'prismjs/components/prism-python.js';
import 'prismjs/components/prism-ruby.js';
import 'prismjs/components/prism-markup-templating.js';
import 'prismjs/components/prism-php.js';
import 'prismjs/components/prism-go.js';
import 'prismjs/components/prism-rust.js';
import 'prismjs/components/prism-java.js';
import 'prismjs/components/prism-kotlin.js';
import 'prismjs/components/prism-scala.js';
import 'prismjs/components/prism-groovy.js';
import 'prismjs/components/prism-swift.js';
import 'prismjs/components/prism-c.js';
import 'prismjs/components/prism-cpp.js';
import 'prismjs/components/prism-csharp.js';
import 'prismjs/components/prism-objectivec.js';
import 'prismjs/components/prism-dart.js';
import 'prismjs/components/prism-lua.js';
import 'prismjs/components/prism-perl.js';
import 'prismjs/components/prism-r.js';
import 'prismjs/components/prism-elixir.js';
import 'prismjs/components/prism-haskell.js';
import 'prismjs/components/prism-bash.js';
import 'prismjs/components/prism-powershell.js';
import 'prismjs/components/prism-batch.js';
import 'prismjs/components/prism-sql.js';
import 'prismjs/components/prism-graphql.js';
import 'prismjs/components/prism-yaml.js';
import 'prismjs/components/prism-toml.js';
import 'prismjs/components/prism-ini.js';
import 'prismjs/components/prism-docker.js';
import 'prismjs/components/prism-makefile.js';
import 'prismjs/components/prism-hcl.js';
import 'prismjs/components/prism-protobuf.js';
import 'prismjs/components/prism-nginx.js';
import 'prismjs/components/prism-diff.js';
import 'prismjs/components/prism-git.js';

/**
 * Syntax highlighting as data: Prism tokenizes a block of source, and this
 * turns its token tree into per-line ranges `{ start, end, cls }` over the
 * line's own characters. Nothing here produces HTML — the diff renderer
 * merges these ranges with its own change segments, and React escapes the
 * text as usual.
 *
 * Prism's many token names fold into seven roles, each with one colour token
 * (`--syntax-*`) per theme. Anything else — identifiers, punctuation,
 * operators — keeps the ordinary text colour.
 */
const ROLES = {
  comment: 'comment', prolog: 'comment', doctype: 'comment', cdata: 'comment', shebang: 'comment',
  string: 'string', char: 'string', 'attr-value': 'string', regex: 'string', url: 'string',
  'template-string': 'string', 'string-property': 'property', 'triple-quoted-string': 'string',
  number: 'number', boolean: 'number', constant: 'number', symbol: 'number', entity: 'number', null: 'number',
  keyword: 'keyword', important: 'keyword', atrule: 'keyword', rule: 'keyword', directive: 'keyword',
  'control-flow': 'keyword', module: 'keyword',
  function: 'function', 'function-definition': 'function', method: 'function', macro: 'function',
  'class-name': 'type', tag: 'type', builtin: 'type', namespace: 'type', selector: 'type',
  annotation: 'type', decorator: 'type', 'maybe-class-name': 'type',
  property: 'property', 'attr-name': 'property', key: 'property', variable: 'property', parameter: 'property'
};

export const SYNTAX_CLASSES = Object.freeze([...new Set(Object.values(ROLES))].map(role => `syn-${role}`));

/**
 * Past these sizes the text shows plain. Some grammars (markdown, C#, SCSS,
 * Less, CSS, nginx) take time that grows much faster than the text on repeated
 * input, and a regular expression cannot be interrupted: 40 KB of `[[` cost 7 s.
 * Off the main thread a deadline ends that (see highlight-client.js), so the
 * worker may read as far as the WORKER_ limits; these are for running here.
 */
export const MAX_BLOCK_CHARS = 32_000;
export const MAX_LINE_CHARS = 500;
export const WORKER_BLOCK_CHARS = 300_000;
export const WORKER_LINE_CHARS = 2_000;

function roleOf(token) {
  if (Object.hasOwn(ROLES, token.type)) return ROLES[token.type];
  const aliases = Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [];
  for (const alias of aliases) if (Object.hasOwn(ROLES, alias)) return ROLES[alias];
  return null;
}

/**
 * Highlight consecutive lines of one file as a single block, so a string or a
 * comment that spans lines is coloured on all of them.
 * @param {string[]} lines the lines, without newlines
 * @param {string | null} language a Prism grammar id from languages.js
 * @param {{ maxBlock?: number, maxLine?: number }} [limits]
 * @returns {({ start: number, end: number, cls: string }[] | null)[]} ranges
 *   per line, or null for a line left plain: one over the limit, or every line
 *   when the block is
 */
export function highlightLines(lines, language, { maxBlock = MAX_BLOCK_CHARS, maxLine = MAX_LINE_CHARS } = {}) {
  const none = lines.map(() => null);
  const grammar = language ? Prism.languages[language] : null;
  if (!grammar || !lines.length) return none;
  // A long line stays plain by itself: a paragraph in a README is no reason to lose the rest.
  const text = lines.map(line => (line.length > maxLine ? '' : line));
  if (text.reduce((sum, line) => sum + line.length + 1, 0) > maxBlock) return none;

  const ranges = lines.map(() => []);
  let line = 0;
  let column = 0;
  // Walk the token tree in order; a string piece is plain text, a token
  // colours its content with its own role, or its parent's when it has none.
  const walk = (content, inherited) => {
    if (typeof content === 'string') {
      const parts = content.split('\n');
      parts.forEach((part, index) => {
        if (index > 0) { line++; column = 0; }
        if (part && inherited && ranges[line]) ranges[line].push({ start: column, end: column + part.length, cls: `syn-${inherited}` });
        column += part.length;
      });
      return;
    }
    if (Array.isArray(content)) { for (const item of content) walk(item, inherited); return; }
    walk(content.content, roleOf(content) || inherited);
  };
  walk(Prism.tokenize(text.join('\n'), grammar), null);
  return ranges.map(list => (list.length ? list : null));
}
