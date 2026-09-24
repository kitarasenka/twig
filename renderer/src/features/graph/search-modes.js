/**
 * What the history search looks in, as the results bar offers it. The ids are
 * `SEARCH_MODES` in main/git/history.js (the self-check keeps the two lists
 * equal); the words are here. No imports: Vite and the Node check load it.
 */
export const SEARCH_MODE_OPTIONS = Object.freeze([
  { id: 'message', label: 'Messages and hashes', noun: 'message or hash', searching: 'messages and hashes' },
  { id: 'author', label: 'Author name or email', noun: 'author', searching: 'authors' },
  { id: 'file', label: 'Changed file path', noun: 'changed file path', searching: 'changed file paths' },
  { id: 'content', label: 'Code added or removed (-S)', noun: 'added or removed code', searching: 'every change (-S)' },
  { id: 'regex', label: 'Code matching a regex (-G)', noun: 'changed lines', searching: 'every changed line (-G)' }
]);

const byId = Object.fromEntries(SEARCH_MODE_OPTIONS.map(option => [option.id, option]));

export function searchModeOption(mode) {
  return byId[mode] || byId.message;
}

/**
 * The results bar: "12 commits match “fix” in the author", "200+ …" when the
 * search stopped at its cap, the pattern error for a broken regex.
 * @param {{ query: string, mode: string, count: number, truncated: boolean, loading?: boolean, invalid?: string, error?: string }} state
 */
export function searchSummary({ query, mode, count, truncated, loading = false, invalid = '', error = '' }) {
  const option = searchModeOption(mode);
  if (loading) return `Searching ${option.searching} for “${query}”…`;
  if (invalid) return invalid;
  if (error) return error;
  const commits = `${count}${truncated ? '+' : ''} ${count === 1 && !truncated ? 'commit matches' : 'commits match'}`;
  return `${commits} “${query}” in the ${option.noun}`;
}

/** The empty state under the bar, saying where the search looked. */
export function searchEmpty(query, mode) {
  if (mode === 'message') return `No commit message or hash matches “${query}”. The sidebar still shows matching branches and tags.`;
  if (mode === 'author') return `No commit was written by an author whose name or email contains “${query}”.`;
  if (mode === 'file') return `No commit changed a path containing “${query}”.`;
  if (mode === 'content') return `No commit added or removed “${query}”. -S matches exact case and counts occurrences per file: a line that only moved within a file does not count.`;
  return `No commit added or removed a line matching /${query}/.`;
}
