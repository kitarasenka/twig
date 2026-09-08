// A git name-status letter → a labelled, coloured badge. No imports: Vite and
// the Node check both load this. Each entry's `className` has a matching rule in
// `history.css`, and the check asserts that parity.

export const FILE_STATUS = {
  A: { label: 'Added', className: 'file-status-add' },
  M: { label: 'Modified', className: 'file-status-mod' },
  D: { label: 'Deleted', className: 'file-status-del' },
  R: { label: 'Renamed', className: 'file-status-ren' },
  C: { label: 'Copied', className: 'file-status-ren' },
  T: { label: 'Type changed', className: 'file-status-typ' },
  U: { label: 'Unmerged', className: 'file-status-conflict' },
  '?': { label: 'Untracked', className: 'file-status-new' }
};

const OTHER = { label: 'Changed', className: 'file-status-other' };

/**
 * `raw` is whatever the git layer put on the entry: a single letter, a
 * similarity-scored `R100`, `?` for untracked, or a bare space from a tree
 * listing. Take the leading letter; anything unrecognised is a neutral badge.
 */
export function fileStatus(raw) {
  const text = String(raw ?? '').trim();
  const letter = text === '?' ? '?' : text.charAt(0).toUpperCase();
  const meta = FILE_STATUS[letter];
  if (meta) return { letter, ...meta };
  return { letter: letter || '·', ...OTHER };
}
