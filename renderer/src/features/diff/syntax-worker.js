import { WORKER_BLOCK_CHARS, WORKER_LINE_CHARS, highlightLines } from './syntax.js';

// Prism off the main thread: a block one of its grammars cannot get through
// costs this worker its life (highlight-client.js), not the window.
self.onmessage = ({ data }) => {
  let ranges = null;
  try { ranges = highlightLines(data.lines, data.language, { maxBlock: WORKER_BLOCK_CHARS, maxLine: WORKER_LINE_CHARS }); } catch { /* stays plain text */ }
  self.postMessage({ id: data.id, ranges });
};
