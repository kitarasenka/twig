/**
 * BugHunter's answers drawn on the commits themselves: which commit was marked
 * bad, good or skipped, which one Git is waiting on, and — once the search is
 * over — which one introduced the bug. The words are the repository's own
 * bisect terms (a bisect started with `--term-old/--term-new` says "old"/"new"),
 * and every chip carries a word and an icon, so colour is never the only cue.
 *
 * No imports: Vite and the Node check both load this file.
 */

export const BISECT_KINDS = ['culprit', 'bad', 'good', 'skip', 'testing'];

const DEFAULT_TERMS = { bad: 'bad', good: 'good' };

/**
 * @param {{ active: boolean, terms?: { bad: string, good: string }, marked?: { oid: string, mark: string }[],
 *   bad?: ?string, goods?: string[], skipped?: string[], expected?: ?string, done?: boolean, firstBad?: ?string }} state
 * @returns {Map<string, { kind: string, word: string, title: string }>} keyed by lower-case oid
 */
export function bisectMarkMap(state) {
  const result = new Map();
  if (!state?.active) return result;
  const terms = state.terms?.bad && state.terms?.good ? state.terms : DEFAULT_TERMS;
  const describe = {
    bad: { word: terms.bad, title: `BugHunter: marked ${terms.bad} — the bug is present in this commit` },
    good: { word: terms.good, title: `BugHunter: marked ${terms.good} — the bug is absent in this commit` },
    skip: { word: 'skipped', title: 'BugHunter: skipped — this commit could not be tested' }
  };
  const put = (oid, kind, text) => {
    if (typeof oid === 'string' && /^(?:[a-f\d]{40}|[a-f\d]{64})$/i.test(oid)) result.set(oid.toLowerCase(), { kind, ...text });
  };
  // What main read from the log, or the refs alone from an older main.
  const marked = Array.isArray(state.marked) && state.marked.length ? state.marked
    : [...(state.skipped || []).map(oid => ({ oid, mark: 'skip' })), ...(state.goods || []).map(oid => ({ oid, mark: 'good' })),
      ...(state.bad ? [{ oid: state.bad, mark: 'bad' }] : [])];
  for (const { oid, mark } of marked) if (describe[mark]) put(oid, mark, describe[mark]);
  // The revision on test is by definition not answered yet; if it somehow is,
  // the answer is what the graph should keep showing.
  if (state.expected && !state.done && !result.has(state.expected.toLowerCase())) {
    put(state.expected, 'testing', { word: 'testing', title: 'BugHunter: the version checked out for the current test' });
  }
  if (state.done && state.firstBad) {
    put(state.firstBad, 'culprit', { word: `first ${terms.bad}`, title: `BugHunter: the first ${terms.bad} commit — the search ended here` });
  }
  return result;
}

/** CSS class of a chip. */
export const bisectClass = kind => `bisect-chip bisect-${BISECT_KINDS.includes(kind) ? kind : 'skip'}`;
