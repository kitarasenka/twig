// A git name-status letter → a labelled, coloured badge. Imports only the
// import-free i18n module: Vite and the Node check both load this. Labels stay
// English here (marked); the badge translates them where it is shown. Each entry's `className` has a matching rule in
// `history.css`, and the check asserts that parity.
import { mark } from '../../i18n/i18n.js';

export const FILE_STATUS = {
  A: { label: mark('Added'), className: 'file-status-add' },
  M: { label: mark('Modified'), className: 'file-status-mod' },
  D: { label: mark('Deleted'), className: 'file-status-del' },
  R: { label: mark('Renamed'), className: 'file-status-ren' },
  C: { label: mark('Copied'), className: 'file-status-ren' },
  T: { label: mark('Type changed'), className: 'file-status-typ' },
  U: { label: mark('Unmerged'), className: 'file-status-conflict' },
  '?': { label: mark('Untracked'), className: 'file-status-new' }
};

const OTHER = { label: mark('Changed'), className: 'file-status-other' };

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
