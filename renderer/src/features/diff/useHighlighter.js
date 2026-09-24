import { useEffect, useState } from 'react';

/**
 * Prism and its grammars are a separate chunk, loaded the first time a diff
 * wants colours: the window opens without them, and a diff shown before they
 * arrive renders plain and gains its colours a moment later.
 */
let loaded = null;
let pending = null;

export function loadHighlighter() {
  pending ??= import('./syntax.js').then(module => { loaded = module.highlightLines; return loaded; });
  return pending;
}

/** `highlightLines`, or null while it loads or when highlighting is off. */
export default function useHighlighter(enabled) {
  const [highlight, setHighlight] = useState(() => loaded);
  useEffect(() => {
    if (!enabled || highlight) return undefined;
    let alive = true;
    loadHighlighter().then(fn => { if (alive) setHighlight(() => fn); }).catch(() => { /* stays plain text */ });
    return () => { alive = false; };
  }, [enabled, highlight]);
  return enabled ? highlight : null;
}
