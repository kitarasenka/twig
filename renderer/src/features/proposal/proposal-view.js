// Words and commands of the commit-proposal dialog. No imports: Vite and the
// Node check both load it.

/** An argument with a space or a quote is shown quoted, as the one word Git receives. */
const shown = argv => argv.map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

/** The exact commands Commit (and Commit & Push) will run, in order, as the console will log them. */
export function proposalCommands(view, withPush) {
  const lines = view.commands.map(argv => `git ${shown(argv)}`);
  if (withPush && view.pushTarget?.argv) lines.push(`git ${shown(view.pushTarget.argv)}`);
  return lines;
}

/** Where Commit & Push goes, or why it cannot. */
export function pushLine(view) {
  if (view.pushTarget?.mode) return `Push goes to ${view.pushTarget.label}.`;
  return `Commit & Push is not available: ${view.pushTarget?.reason || 'there is nowhere to push.'}`;
}

/** `3 files, +12 −4` */
export function totalsLine(view) {
  const count = view.files.length;
  return `${count} ${count === 1 ? 'file' : 'files'}, +${view.totals.insertions} −${view.totals.deletions}`;
}

/** The button the agent asked for is the primary one. */
export function primaryAction(view) {
  return view.push && view.pushTarget?.mode ? 'commit-push' : 'commit';
}

/** The first line of an outcome, for the note after the dialog closes. */
export function outcomeNote(outcome) {
  return String(outcome || '').split('\n')[0];
}
