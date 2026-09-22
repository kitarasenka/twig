/**
 * Splits a porcelain-v2 status into the three lists the staging screen works
 * with, without asking Git for anything: `repository.status` is already read on
 * every refresh, and both the uncommitted row in the graph and its details
 * panel need exactly that data.
 *
 * The rule is the one `loadWorktree` in `main/git/worktree.js` applies, and
 * `scripts/checks/worktree-summary.mjs` holds the two against each other. A
 * path with both an index change and a worktree change belongs to *both*
 * lists, because that is how Git models it — so `paths` counts distinct paths,
 * not the sum of the three lists.
 *
 * No imports: Vite and the Node self-check both load this file directly.
 */

/** The three lists, in the order the staging screen and the panel show them. */
export const SECTIONS = [
  { key: 'staged', title: 'Staged', word: 'staged', empty: 'Nothing staged yet.' },
  { key: 'unstaged', title: 'Changed', word: 'changed', empty: 'No unstaged changes.' },
  { key: 'untracked', title: 'Untracked', word: 'untracked', empty: 'No untracked files.' }
];

function change(entry, status) {
  return { path: entry.path, originalPath: entry.originalPath ?? null, status };
}

/**
 * @param {Array<object>} entries porcelain-v2 entries from `repository.status`
 * @returns {{ staged: object[], unstaged: object[], untracked: object[], paths: number }}
 */
export function summarizeStatus(entries) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const paths = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    if (entry.kind === 'ignored') continue;
    if (entry.kind === 'untracked') { untracked.push(change(entry, '?')); paths.add(entry.path); continue; }
    if (entry.kind === 'unmerged') { unstaged.push(change(entry, 'U')); paths.add(entry.path); continue; }
    let touched = false;
    if (entry.indexStatus && entry.indexStatus !== '.') { staged.push(change(entry, entry.indexStatus)); touched = true; }
    if (entry.worktreeStatus && entry.worktreeStatus !== '.') { unstaged.push(change(entry, entry.worktreeStatus)); touched = true; }
    if (touched) paths.add(entry.path);
  }
  const byPath = (a, b) => a.path.localeCompare(b.path, 'en');
  return { staged: staged.sort(byPath), unstaged: unstaged.sort(byPath), untracked: untracked.sort(byPath), paths: paths.size };
}

/**
 * The breakdown behind the count, as chips: "2 staged · 1 changed". A list with
 * nothing in it is left out rather than shown as a zero — a row of zeroes reads
 * as noise, and the panel still names every section.
 * @returns {{ key: string, count: number, text: string }[]}
 */
export function summaryChips(summary) {
  if (!summary) return [];
  return SECTIONS
    .filter(section => summary[section.key]?.length)
    .map(section => ({ key: section.key, count: summary[section.key].length, text: `${summary[section.key].length} ${section.word}` }));
}

/** The same breakdown as one string, for a title or an accessible name. */
export function summaryLabel(summary) {
  const chips = summaryChips(summary);
  return chips.length ? chips.map(chip => chip.text).join(' · ') : 'no changes';
}

/** Conflicted paths block a commit; the row says so instead of only counting. */
export function conflictCount(summary) {
  return summary ? summary.unstaged.filter(file => file.status === 'U').length : 0;
}
