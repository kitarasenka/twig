// Order of the changed files in the commit panel. No imports: Vite and the
// Node check load it alike.

export const FILE_SORTS = [
  { value: 'path', label: 'Sort by path' },
  { value: 'status', label: 'Sort by status' },
  { value: 'extension', label: 'Sort by extension' }
];

/**
 * "js" for `src/app.test.js`, "" for `Makefile` and for dotfiles like
 * `.gitignore` — a leading dot names the file, it does not start a type.
 * Lower case, so `README.MD` sits with `notes.md`.
 */
export function fileExtension(path) {
  const name = String(path).split('/').at(-1);
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

const byPath = (a, b) => a.path.localeCompare(b.path, 'en');

/** Files without an extension go after every type; ties fall back to the path. */
export function compareFiles(sort) {
  if (sort === 'status') return (a, b) => a.status.localeCompare(b.status) || byPath(a, b);
  if (sort === 'extension') return (a, b) => {
    const left = fileExtension(a.path), right = fileExtension(b.path);
    return (!left - !right) || left.localeCompare(right, 'en') || byPath(a, b);
  };
  return byPath;
}
