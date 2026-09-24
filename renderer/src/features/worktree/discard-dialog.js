import { discardCommand } from '../../../../main/git/discard-plan.js';

/**
 * The §6.5 confirmation for every kind of discard: the exact command (from
 * the same module main runs it from) and, in words, what is thrown away and
 * how to get it back. Pure data for ConfirmDialog; Vite and the Node check
 * both load it.
 */
const UNDO = '🌱 Twig keeps a copy first, so Undo in the toolbar brings it back.';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
const preview = paths => (paths.length <= 5 ? paths.join(', ') : `${paths.slice(0, 5).join(', ')} and ${paths.length - 5} more`);

/**
 * @param {{ kind: 'file' | 'untracked' | 'tracked' | 'untracked-all' | 'lines', path?: string, paths?: string[], lines?: number }} request
 * @returns {{ title: string, command: string[], consequence: string, confirmLabel: string }}
 */
export function discardDialog({ kind, path = '', paths = [], lines = 0 }) {
  if (kind === 'file') {
    return { title: `Discard changes to ${path}`, command: discardCommand('file', [path]), confirmLabel: 'Discard changes',
      consequence: `Your unstaged changes to ${path} are replaced by its staged version, or the last commit if nothing is staged. What is already staged stays. ${UNDO}` };
  }
  if (kind === 'untracked') {
    const folder = path.endsWith('/');
    return { title: folder ? `Delete the folder ${path}` : `Delete ${path}`, command: discardCommand('untracked', [path]), confirmLabel: 'Delete',
      consequence: `${folder ? 'Everything in this folder is' : 'This file is'} not tracked by Git, so Git alone could not bring it back. Ignored files are left alone. ${UNDO}` };
  }
  if (kind === 'tracked') {
    return { title: 'Discard all unstaged changes', command: discardCommand('tracked'), confirmLabel: `Discard ${plural(paths.length, 'file')}`,
      consequence: `Unstaged changes in ${plural(paths.length, 'file')} (${preview(paths)}) are replaced by their staged or committed versions; the paths reach Git on stdin. Staged work stays. ${UNDO}` };
  }
  if (kind === 'untracked-all') {
    return { title: `Delete ${plural(paths.length, 'untracked path')}`, command: discardCommand('untracked-all', paths), confirmLabel: `Delete ${plural(paths.length, 'path')}`,
      consequence: `${preview(paths)} ${paths.length === 1 ? 'is' : 'are'} not tracked by Git. Ignored files are left alone. ${UNDO}` };
  }
  if (kind === 'lines') {
    return { title: `Discard ${plural(lines, 'selected line')} of ${path}`, command: discardCommand('lines'), confirmLabel: 'Discard lines',
      consequence: `The selected changes are removed from ${path} in the working tree; every other change in the file stays. The patch reaches Git on stdin. ${UNDO}` };
  }
  throw new TypeError('Unknown discard');
}
