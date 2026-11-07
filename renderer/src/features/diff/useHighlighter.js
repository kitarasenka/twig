import { useEffect, useMemo, useState } from 'react';
import { createHighlightClient } from './highlight-client.js';

/**
 * Prism and its grammars run in a worker, a chunk of their own, started the
 * first time a diff wants colours: the window opens without them, and a block
 * of a diff shows plain until its colours arrive a moment later.
 */
let client = null;
const listeners = new Set();

function highlighter() {
  client ??= createHighlightClient({
    spawn: () => new Worker(new URL('./syntax-worker.js', import.meta.url), { type: 'module' }),
    fallback: () => import('./syntax.js').then(module => module.highlightLines),
    onReady: () => { for (const listener of listeners) listener(); }
  });
  return client;
}

/**
 * `(lines, language) => ranges`, or null when highlighting is off. It answers
 * at once, plain if need be; the function changes when more colours are in, so
 * a `useMemo` on it reads them.
 */
export default function useHighlighter(enabled) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    const listener = () => setVersion(value => value + 1);
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, [enabled]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new function is the signal that more is known
  return useMemo(() => (enabled ? (lines, language) => highlighter().highlight(lines, language) : null), [enabled, version]);
}
