import { useCallback, useEffect, useState } from 'react';
import { DIFF_PREFS_EVENT, readDiffPrefs, writeDiffPrefs } from './diff-prefs.js';

function storage() {
  try { return window.localStorage; } catch { return null; }
}

// The session's value, kept here too so a storage that refuses writes still
// switches every diff on screen together.
let current = readDiffPrefs(storage());

/** The shared diff preferences, and a setter that updates every diff on screen. */
export default function useDiffPrefs() {
  const [prefs, setPrefs] = useState(current);
  useEffect(() => {
    const sync = () => setPrefs(current);
    window.addEventListener(DIFF_PREFS_EVENT, sync);
    return () => window.removeEventListener(DIFF_PREFS_EVENT, sync);
  }, []);
  const update = useCallback(next => {
    current = { ...current, ...next };
    writeDiffPrefs(storage(), next);
    window.dispatchEvent(new Event(DIFF_PREFS_EVENT));
  }, []);
  return [prefs, update];
}
