import { Bot, FolderGit2 } from 'lucide-react';
import { folderLabel } from '../tools/folder-label.js';
import { t } from '../../i18n/i18n.js';

/** Who holds this branch, in words: for the tooltip of a branch that is checked out in another worktree. */
export function worktreeRefTitle(card) {
  const where = t`Checked out in worktree ${folderLabel(card.path)}`;
  return card.connected ? `${where} · ${t('Agent connected')}` : where;
}

/** The icon of such a branch: a robot when an agent is connected there, so colour is not the only sign. */
export function WorktreeRefIcon({ card }) {
  const Icon = card.connected ? Bot : FolderGit2;
  return <Icon role="img" aria-label={worktreeRefTitle(card)} />;
}
