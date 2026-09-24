import { AlignLeft, ClipboardCopy, FilePenLine, FolderOpen, History, Minus, Plus, Trash2, Undo2 } from 'lucide-react';

/** What the file manager is called here, for menu text. */
export function fileManagerName(platform) {
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'Explorer' : 'file manager';
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
 * The context menu of a file row — in a commit's file list and in the
 * uncommitted panel. Opening and revealing act on the working-tree copy, which
 * is the only copy an editor can change; that is why a file shown in an old
 * commit may answer "not in the working tree" instead of opening.
 *
 * `blameOid` is the committed version Blame would read, or null when there is
 * none (an uncommitted list); `tracked: false` drops the history items, which
 * mean nothing for a file Git has never recorded. `move` adds the staging
 * direction of an uncommitted row, and `discard` ('changes' | 'untracked')
 * its destructive counterpart, which always confirms before it runs.
 */
export function buildFileMenu({ path, platform, editor = 'System default', blameOid = null, tracked = true, move = null, discard = null, handlers }) {
  const editorText = !editor || editor === 'System default' ? 'Open in default editor' : `Open in ${editor}`;
  const items = [
    { key: 'open-editor', icon: FilePenLine, text: editorText, run: () => handlers.openInEditor(path) },
    { key: 'reveal', icon: FolderOpen, text: platform === 'darwin' ? 'Reveal in Finder' : `Show in ${fileManagerName(platform)}`, run: () => handlers.reveal(path) },
    { separator: true },
    { key: 'copy-path', icon: ClipboardCopy, text: 'Copy path', hint: 'relative', run: () => handlers.copyPath(path) },
    { key: 'copy-full-path', icon: ClipboardCopy, text: 'Copy full path', run: () => handlers.copyFullPath(path) }
  ];
  if (move) {
    items.push({ separator: true }, move === 'unstage'
      ? { key: 'unstage', icon: Minus, text: 'Unstage', reason: handlers.moveReason, run: () => handlers.move(path) }
      : { key: 'stage', icon: Plus, text: 'Stage', reason: handlers.moveReason, run: () => handlers.move(path) });
  }
  if (discard) {
    items.push(discard === 'untracked'
      ? { key: 'discard', icon: Trash2, danger: true, text: path.endsWith('/') ? 'Delete folder…' : 'Delete file…', reason: handlers.discardReason, run: () => handlers.discard(path) }
      : { key: 'discard', icon: Undo2, danger: true, text: 'Discard changes…', reason: handlers.discardReason, run: () => handlers.discard(path) });
  }
  if (tracked) {
    items.push(
      { separator: true },
      { key: 'file-history', icon: History, text: 'File history', hint: 'Every commit that changed this file', run: () => handlers.fileHistory(path) },
      { key: 'blame', icon: AlignLeft, text: 'Blame history', hint: 'Who changed each line',
        reason: blameOid ? undefined : 'Select a committed version first', run: () => handlers.blame(path, blameOid) }
    );
  }
  return items;
}
