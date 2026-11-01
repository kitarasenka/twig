import { createElement, Fragment } from 'react';
import { t } from './i18n.js';

/**
 * A sentence with elements inside it, translated whole:
 *   tx('The {name} tab is a real sandbox repository.', { name: <strong>workspace-demo</strong> })
 * Translators move {name} where their language needs it; the element keeps its markup.
 */
export function tx(key, values) {
  const text = t(key);
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/\{(\w+)\}/g)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push(Object.hasOwn(values, match[1]) ? values[match[1]] : match[0]);
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return createElement(Fragment, null, ...parts);
}
