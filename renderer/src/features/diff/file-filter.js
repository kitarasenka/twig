// No imports: Vite and the Node check both load this file.

/** The select value that keeps every file. */
export const ALL_TYPES = '';
/** The select value for files whose name has no extension (`Makefile`, `.gitignore`). */
export const NO_EXTENSION = '(none)';

/**
 * A file's extension, lower-cased and with its dot: `src/App.JSX` → `.jsx`.
 * Only the last name counts, so `v1.2/readme` has none; a leading dot names
 * the file rather than its type, so `.gitignore` and `.env` have none either.
 */
export function extensionOf(path) {
  const name = String(path).split('/').at(-1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : NO_EXTENSION;
}

/**
 * The choices for the "file type" select: every extension among `paths` with
 * how many files have it, most common first, "no extension" last. A chosen
 * extension that no file has any more stays in the list with 0, so the select
 * never shows a value it does not list and the empty lists explain themselves.
 */
export function extensionOptions(paths, current = ALL_TYPES) {
  const counts = new Map();
  for (const path of paths) {
    const extension = extensionOf(path);
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  if (current !== ALL_TYPES && !counts.has(current)) counts.set(current, 0);
  return [...counts]
    .map(([value, count]) => ({ value, count, label: `${value === NO_EXTENSION ? 'No extension' : value} (${count})` }))
    .sort((a, b) => (a.value === NO_EXTENSION) - (b.value === NO_EXTENSION) || b.count - a.count || a.value.localeCompare(b.value));
}

/** Whether a path passes the text filter (any part of the path, any case) and the type filter. */
export function matchesFile(path, query = '', extension = ALL_TYPES) {
  const needle = query.trim().toLowerCase();
  return (!needle || path.toLowerCase().includes(needle))
    && (extension === ALL_TYPES || extensionOf(path) === extension);
}

/**
 * Files grouped into nested folders: `{ folders: Map<name, node>, files }`,
 * with `files` keeping the order they came in. Folders come in first-seen order.
 */
export function buildFileTree(files) {
  const root = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push(file);
  }
  return root;
}

/** The last part of a path: what a file row in a tree shows. */
export function baseName(path) {
  return String(path).split('/').at(-1);
}

export const FILE_VIEWS = ['path', 'tree'];
const VIEW_KEY = 'twig:worktree-files-view';

/** Path or tree for the uncommitted lists, shared by the panel and the staging screen. */
export function readFileView(storage = globalThis.localStorage) {
  try { return storage?.getItem(VIEW_KEY) === 'tree' ? 'tree' : 'path'; } catch { return 'path'; }
}

export function writeFileView(view, storage = globalThis.localStorage) {
  try { storage?.setItem(VIEW_KEY, view === 'tree' ? 'tree' : 'path'); } catch { /* the choice just is not remembered */ }
}
