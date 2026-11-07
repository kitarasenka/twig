// Asks the highlighting worker for colours and answers from what it has. The
// diff views read colours synchronously, while rendering: a block not read yet
// shows plain, is sent to the worker, and `onReady` says when to read again.
//
// One block at a time, each with a deadline. A block past it ends the worker —
// a regular expression cannot be stopped any other way — and stays plain, and
// so does what was waiting in the same language: whatever made that grammar
// spin is likely in the next hunk too. Without workers `fallback` gives the
// highlighter itself, which runs here under its own, smaller limits.
// No imports: Vite and the Node check both load it.

export const HIGHLIGHT_DEADLINE_MS = 1500;
const CACHE_BLOCKS = 256;
const READY_DELAY_MS = 16;

/**
 * @param {{ spawn: () => { postMessage: Function, terminate: Function, onmessage: ?Function, onerror: ?Function },
 *   fallback: () => Promise<(lines: string[], language: string) => Array>, onReady: () => void,
 *   deadlineMs?: number, schedule?: Function, cancel?: Function }} options
 */
export function createHighlightClient({ spawn, fallback, onReady, deadlineMs = HIGHLIGHT_DEADLINE_MS, schedule = setTimeout, cancel = clearTimeout }) {
  const cache = new Map();
  const asked = new Set();
  let queue = [];
  let current = null;
  let worker = null;
  let deadline = null;
  let announcing = null;
  let local = null;
  let sequence = 0;

  function announce() {
    announcing ??= schedule(() => { announcing = null; onReady(); }, READY_DELAY_MS);
  }
  function remember(block, ranges) {
    asked.delete(block.key);
    cache.delete(block.key);
    cache.set(block.key, ranges);
    if (cache.size > CACHE_BLOCKS) cache.delete(cache.keys().next().value);
    announce();
  }
  function open() {
    const next = spawn();
    next.onmessage = ({ data }) => {
      if (!current || data.id !== current.id) return;
      cancel(deadline);
      const block = current;
      current = null;
      remember(block, data.ranges);
      pump();
    };
    next.onerror = () => { void fallBack(); };
    return next;
  }
  async function fallBack() {
    cancel(deadline);
    worker?.terminate();
    worker = null;
    const block = current;
    current = null;
    if (block) queue.unshift(block);
    try { local ??= await fallback(); } catch { local = () => null; }
    pump();
  }
  function expire() {
    const block = current;
    current = null;
    worker?.terminate();
    worker = null;
    remember(block, null);
    for (const other of queue) if (other.language === block.language) remember(other, null);
    queue = queue.filter(other => other.language !== block.language);
    pump();
  }
  function pump() {
    if (current || !queue.length) return;
    if (local) {
      for (const block of queue.splice(0)) remember(block, local(block.lines, block.language));
      return;
    }
    current = queue.shift();
    try { worker ??= open(); }
    catch { void fallBack(); return; }
    worker.postMessage({ id: current.id, lines: current.lines, language: current.language });
    deadline = schedule(expire, deadlineMs);
  }

  return {
    /** The ranges of this block as `highlightLines` gives them, or plain lines while they are not known. */
    highlight(lines, language) {
      const key = `${language}\0${lines.join('\n')}`;
      if (cache.has(key)) {
        const ranges = cache.get(key);
        cache.delete(key);
        cache.set(key, ranges);
        return ranges ?? lines.map(() => null);
      }
      if (!asked.has(key)) {
        asked.add(key);
        queue.push({ id: ++sequence, key, lines, language });
        pump();
      }
      return lines.map(() => null);
    }
  };
}
