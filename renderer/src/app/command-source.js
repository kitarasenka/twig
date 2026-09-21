// Which journal entries the "My" filter keeps.
//
// The journal records every git process the app starts, and most of them are
// the app reading state for itself: one graph refresh alone runs the history,
// the refs, the stashes and a status. Those answer "what did 🌱 Twig do", which
// is what Full History is for. "My" answers "what did I just do", so it keeps
// only the commands a person asked for — commit, checkout, merge, push,
// staging, stash, blame, automations, anything typed into the console.
//
// The split is by operation label because that is the only thing the journal
// records about intent; the labels are written next to each runGit call.
// No imports: Vite and the Node check both load this module directly.

// Every automatic read is named by its verb. "Check out …" is a real action,
// so "Check …" cannot be a prefix — those two reads are named in full below.
export const AUTOMATIC_PREFIXES = ['Background:', 'Read ', 'Resolve ', 'Verify '];
export const AUTOMATIC_LABELS = [
  'Check file at start',
  'Check reverse-blame range',
  'Search commit history',
  'Seed demo workspace'
];

export function isUserCommand(operation) {
  const label = typeof operation === 'string' ? operation : '';
  if (AUTOMATIC_LABELS.includes(label)) return false;
  return !AUTOMATIC_PREFIXES.some(prefix => label.startsWith(prefix));
}
