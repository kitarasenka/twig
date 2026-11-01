import { AlignLeft, ClipboardCopy, EyeOff, FilePenLine, FileText, FolderOpen, History, Minus, Plus, Trash2, Undo2 } from 'lucide-react';
import { ignoreChoices } from '../../../../main/git/ignore-plan.js';
import { t, tr } from '../../i18n/i18n.js';

/** What the file manager is called here, for menu text. */
export function fileManagerName(platform) {
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : t('file manager');
}

/**
 * The full path of a repository file, spelled the way the repository root is:
 * a Windows root gets backslashes, everything else keeps Git's forward slashes.
 * Only for copying — opening and revealing resolve the path in main.
 */
export function absolutePath(root, file) {
  if (typeof root !== 'string' || !root) return file;
  const windows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const base = root.replace(/[\\/]+$/, '');
  return `${base}${separator}${windows ? file.replaceAll('/', '\\') : file}`;
}

/**
 * "Ignore this file / all .ext files / this folder" for an untracked path. The
 * hint is the exact line main will append to the root .gitignore — main
 * computes it again from the same shared module rather than trusting it.
 * A path the module cannot express gets no items rather than a wrong rule.
 */
export function ignoreMenuItems({ path, run, reason }) {
  let choices;
  try { choices = ignoreChoices(path); } catch { return []; }
  return choices.map(choice => ({ key: `ignore-${choice.kind}`, icon: EyeOff, text: tr(choice.text), hint: choice.pattern, reason,
    run: () => run(choice) }));
}

/**
 * The context menu of a file row — in a commit's file list and in the
 * uncommitted panel. Opening and revealing act on the working-tree copy, which
 * is the only copy an editor can change; that is why a file shown in an old
 * commit may answer "not in the working tree" instead of opening.
 *
 * `blameOid` is the committed version Blame would read, or null when there is
 * none (an uncommitted list); `tracked: false` drops the history items, which
 * mean nothing for a file Git has never recorded. `move` adds the staging
 * direction of an uncommitted row, and `discard` ('changes' | 'untracked')
 * its destructive counterpart, which always confirms before it runs. An
 * untracked row (`discard: 'untracked'`) also offers the .gitignore rules when
 * `handlers.ignore` is given, and every row "View full file" when
 * `handlers.viewFile` is: the version this list shows — the commit's, or the
 * uncommitted one — whole, not as a diff.
 */
export function buildFileMenu({ path, platform, editor = 'System default', blameOid = null, tracked = true, move = null, discard = null, handlers }) {
  const editorText = !editor || editor === 'System default' ? t('Open in default editor') : t`Open in ${editor}`;
  const items = [
    { key: 'open-editor', icon: FilePenLine, text: editorText, run: () => handlers.openInEditor(path) },
    { key: 'reveal', icon: FolderOpen, text: platform === 'darwin' ? t('Reveal in Finder') : platform === 'win32' ? t('Show in Explorer') : t('Show in file manager'), run: () => handlers.reveal(path) },
    handlers.viewFile && { key: 'view-file', icon: FileText, text: t('View full file'), hint: move ? t('As it is now') : t('As of this commit'), run: () => handlers.viewFile(path) },
    { separator: true },
    { key: 'copy-path', icon: ClipboardCopy, text: t('Copy path'), hint: t('relative'), run: () => handlers.copyPath(path) },
    { key: 'copy-full-path', icon: ClipboardCopy, text: t('Copy full path'), run: () => handlers.copyFullPath(path) }
  ];
  if (move) {
    items.push({ separator: true }, move === 'unstage'
      ? { key: 'unstage', icon: Minus, text: t('Unstage'), reason: handlers.moveReason, run: () => handlers.move(path) }
      : { key: 'stage', icon: Plus, text: t('Stage'), reason: handlers.moveReason, run: () => handlers.move(path) });
  }
  if (discard === 'untracked' && handlers.ignore) {
    const ignore = ignoreMenuItems({ path, run: handlers.ignore, reason: handlers.ignoreReason });
    if (ignore.length) items.push({ separator: true }, ...ignore);
  }
  if (discard) {
    items.push(discard === 'untracked'
      ? { key: 'discard', icon: Trash2, danger: true, text: path.endsWith('/') ? t('Delete folder…') : t('Delete file…'), reason: handlers.discardReason, run: () => handlers.discard(path) }
      : { key: 'discard', icon: Undo2, danger: true, text: t('Discard changes…'), reason: handlers.discardReason, run: () => handlers.discard(path) });
  }
  if (tracked) {
    items.push(
      { separator: true },
      { key: 'file-history', icon: History, text: t('File history'), hint: t('Every commit that changed this file'), run: () => handlers.fileHistory(path) },
      { key: 'blame', icon: AlignLeft, text: t('Blame history'), hint: t('Who changed each line'),
        reason: blameOid ? undefined : t('Select a committed version first'), run: () => handlers.blame(path, blameOid) }
    );
  }
  return items.filter(Boolean);
}
