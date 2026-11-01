/**
 * The interactive-rebase plan that changes the message of one commit and
 * replays everything after it untouched.
 *
 * Only the tip commit can be rewritten by `commit --amend`; an older one is
 * rewritten the way Git rewrites history — by replaying the range, with a
 * single `reword` line in the plan. Building that plan is a pure function of
 * the commits Git listed, so "does the plan touch anything but the message?"
 * is a question the self-check answers without running a rebase.
 *
 * Only the import-free i18n module is imported: both Vite and the Node
 * self-check load this file.
 */
import { t } from '../../i18n/i18n.js';

export function buildRewordPlan(commits, oid, message) {
  if (!Array.isArray(commits) || commits.length === 0) throw new Error(t('There are no commits to replay.'));
  if (typeof message !== 'string' || message.trim().length === 0) throw new Error(t('A commit needs a message.'));
  if (!commits.some(commit => commit.oid === oid)) {
    throw new Error(t('This commit is not among the ones being replayed. Refresh the history and try again.'));
  }
  return commits.map(commit => commit.oid === oid
    ? { action: 'reword', oid: commit.oid, message }
    : { action: 'pick', oid: commit.oid });
}
