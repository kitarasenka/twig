// Words and commands of the commit-proposal dialog. Only pure sibling
// modules and i18n are imported: Vite and the Node check both load it.
// The commit message and the tag name go back to main as they are — only the
// dialog's own words are translated.
import { t, tn, tr } from '../../i18n/i18n.js';
import { releaseMessage, releaseTagName, releaseVersion, tagArgv, tagNameProblem, tagPushArgv } from '../automations/release-tag.js';
import { nextVersion } from '../automations/version-bump.js';

/** An argument with a space or a quote is shown quoted, as the one word Git receives. */
const shown = argv => argv.map(arg => (/[\s"'`$\\]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ');

/**
 * The exact commands Commit (and Commit & Push) will run, in order, as the
 * console will log them. `commit: false` is a release on a clean tree with no
 * bump — only the tag is made; `tag` is the tag name, or null for none.
 */
export function proposalCommands(view, withPush, { commit = true, tag = null } = {}) {
  const lines = commit ? view.commands.map(argv => `git ${shown(argv)}`) : [];
  if (tag) lines.push(`git ${shown(tagArgv(tag))}`);
  if (withPush && view.pushTarget?.argv) {
    lines.push(`git ${shown(view.pushTarget.argv)}`);
    if (tag && view.pushTarget.remote) lines.push(`git ${shown(tagPushArgv(view.pushTarget.remote, tag))}`);
  }
  return lines;
}

/**
 * What the version and tag switches add up to. `choice` is the bump step
 * ('none' when the switch is off). Returns the version the release gets,
 * the tag name (the person's, or the one following the previous tag),
 * whether there is a commit at all, the message to show while untouched,
 * and why the tag cannot be made.
 * @param {object} view
 * @param {{ choice: string, tagOn: boolean, tagName: ?string, message: ?string }} input
 */
export function releaseState(view, { choice, tagOn, tagName = null, message = null }) {
  const version = releaseVersion(view.versioning, choice);
  const tag = tagOn ? (tagName ?? releaseTagName(view.versioning?.tag, version)) : null;
  const commit = view.files.length > 0 || Boolean(view.bump && choice !== 'none');
  return {
    version, tag, commit,
    message: message ?? view.message ?? releaseMessage(version),
    tagProblem: tagOn ? tagNameProblem(tag, view.versioning?.tag?.name ?? null) : null
  };
}

/** `Patch — package.json 1.2.3 → 1.2.4`, or for a version kept only in tags, `Patch — 1.2.3 → 1.2.4`. */
export function stepLabel(view, choice) {
  const from = view.versioning?.tag?.version;
  const versions = view.bump
    ? view.bump.targets.map(target => `${target.path} ${target.current} → ${target.next[choice]}`).join(', ')
    : `${from} → ${nextVersion(from, choice)}`;
  if (choice === 'major') return t`Major — ${versions}`;
  if (choice === 'minor') return t`Minor — ${versions}`;
  return t`Patch — ${versions}`;
}

/** Where Commit & Push goes, or why it cannot. */
export function pushLine(view) {
  if (view.pushTarget?.mode) return t`Push goes to ${view.pushTarget.label}.`;
  return t`Commit & Push is not available: ${view.pushTarget?.reason ? tr(view.pushTarget.reason) : t('there is nowhere to push.')}`;
}

/** `3 files, +12 −4` */
export function totalsLine(view) {
  return tn(view.files.length, '{n} file, +{insertions} −{deletions}', '{n} files, +{insertions} −{deletions}',
    { insertions: view.totals.insertions, deletions: view.totals.deletions });
}

/** The two buttons: Commit / Commit & Push, or Create tag / Tag & Push when only a tag is made. */
export function actionLabels(commit) {
  return commit ? { commit: t('Commit'), push: t('Commit & Push') } : { commit: t('Create tag'), push: t('Tag & Push') };
}

/** The button the agent asked for is the primary one. */
export function primaryAction(view) {
  return view.push && view.pushTarget?.mode ? 'commit-push' : 'commit';
}

/** The first line of an outcome, for the note after the dialog closes. */
export function outcomeNote(outcome) {
  return tr(String(outcome || '').split('\n')[0]);
}

/** Proposals from other worktrees waiting behind this one, in words. */
export function waitingLine(count) {
  if (!(count > 0)) return '';
  return tn(count, '{n} more proposal is waiting from other worktrees. The next one opens when you answer this one.',
    '{n} more proposals are waiting from other worktrees. The next one opens when you answer this one.');
}
