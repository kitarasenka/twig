/**
 * What the history search looks in, as the results bar offers it. The ids are
 * `SEARCH_MODES` in main/git/history.js (the self-check keeps the two lists
 * equal); the words are here. Only the i18n module is imported: Vite and the
 * Node check load it.
 */
import { mark, t, tn, tr } from '../../i18n/i18n.js';

export const SEARCH_MODE_OPTIONS = Object.freeze([
  { id: 'message', label: mark('Messages and hashes') },
  { id: 'author', label: mark('Author name or email') },
  { id: 'file', label: mark('Changed file path') },
  { id: 'content', label: mark('Code added or removed (-S)') },
  { id: 'regex', label: mark('Code matching a regex (-G)') }
]);

const byId = Object.fromEntries(SEARCH_MODE_OPTIONS.map(option => [option.id, option]));

export function searchModeOption(mode) {
  return byId[mode] || byId.message;
}

function searching(id, query) {
  if (id === 'author') return t`Searching authors for “${query}”…`;
  if (id === 'file') return t`Searching changed file paths for “${query}”…`;
  if (id === 'content') return t`Searching every change (-S) for “${query}”…`;
  if (id === 'regex') return t`Searching every changed line (-G) for “${query}”…`;
  return t`Searching messages and hashes for “${query}”…`;
}

function capped(id, count, query) {
  if (id === 'author') return t`${count}+ commits match “${query}” in the author`;
  if (id === 'file') return t`${count}+ commits match “${query}” in the changed file path`;
  if (id === 'content') return t`${count}+ commits match “${query}” in the added or removed code`;
  if (id === 'regex') return t`${count}+ commits match “${query}” in the changed lines`;
  return t`${count}+ commits match “${query}” in the message or hash`;
}

function matched(id, count, query) {
  if (id === 'author') return tn(count, '{n} commit matches “{query}” in the author', '{n} commits match “{query}” in the author', { query });
  if (id === 'file') return tn(count, '{n} commit matches “{query}” in the changed file path', '{n} commits match “{query}” in the changed file path', { query });
  if (id === 'content') return tn(count, '{n} commit matches “{query}” in the added or removed code', '{n} commits match “{query}” in the added or removed code', { query });
  if (id === 'regex') return tn(count, '{n} commit matches “{query}” in the changed lines', '{n} commits match “{query}” in the changed lines', { query });
  return tn(count, '{n} commit matches “{query}” in the message or hash', '{n} commits match “{query}” in the message or hash', { query });
}

/**
 * The results bar: "12 commits match “fix” in the author", "200+ …" when the
 * search stopped at its cap, the pattern error for a broken regex.
 * @param {{ query: string, mode: string, count: number, truncated: boolean, loading?: boolean, invalid?: string, error?: string }} state
 */
export function searchSummary({ query, mode, count, truncated, loading = false, invalid = '', error = '' }) {
  const { id } = searchModeOption(mode);
  if (loading) return searching(id, query);
  if (invalid) return tr(invalid);
  if (error) return tr(error);
  return truncated ? capped(id, count, query) : matched(id, count, query);
}

/** The empty state under the bar, saying where the search looked. */
export function searchEmpty(query, mode) {
  if (mode === 'message') return t`No commit message or hash matches “${query}”. The sidebar still shows matching branches and tags.`;
  if (mode === 'author') return t`No commit was written by an author whose name or email contains “${query}”.`;
  if (mode === 'file') return t`No commit changed a path containing “${query}”.`;
  if (mode === 'content') return t`No commit added or removed “${query}”. -S matches exact case and counts occurrences per file: a line that only moved within a file does not count.`;
  return t`No commit added or removed a line matching /${query}/.`;
}
