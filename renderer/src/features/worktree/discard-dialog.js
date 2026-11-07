import { discardCommand } from '../../../../main/git/discard-plan.js';
import { mark, t, tn } from '../../i18n/i18n.js';

/**
 * The §6.5 confirmation for every kind of discard: the exact command (from
 * the same module main runs it from) and, in words, what is thrown away and
 * how to get it back. Pure data for ConfirmDialog; Vite and the Node check
 * both load it.
 */
const UNDO = mark('🌱 Twig keeps a copy first: Undo in the toolbar brings it back, and if Undo has moved on, so does Reflog, under Discarded changes.');
const preview = paths => (paths.length <= 5 ? paths.join(', ')
  : tn(paths.length - 5, '{list} and {n} more', '{list} and {n} more', { list: paths.slice(0, 5).join(', ') }));

/**
 * @param {{ kind: 'file' | 'untracked' | 'tracked' | 'untracked-all' | 'lines', path?: string, paths?: string[], lines?: number }} request
 * @returns {{ title: string, command: string[], consequence: string, confirmLabel: string }}
 */
export function discardDialog({ kind, path = '', paths = [], lines = 0 }) {
  if (kind === 'file') {
    return { title: t`Discard changes to ${path}`, command: discardCommand('file', [path]), confirmLabel: t('Discard changes'),
      consequence: `${t`Your unstaged changes to ${path} are replaced by its staged version, or the last commit if nothing is staged. What is already staged stays.`} ${t(UNDO)}` };
  }
  if (kind === 'untracked') {
    const folder = path.endsWith('/');
    return { title: folder ? t`Delete the folder ${path}` : t`Delete ${path}`, command: discardCommand('untracked', [path]), confirmLabel: t('Delete'),
      consequence: `${folder ? t('Everything in this folder is not tracked by Git, so Git alone could not bring it back. Ignored files are left alone.')
        : t('This file is not tracked by Git, so Git alone could not bring it back. Ignored files are left alone.')} ${t(UNDO)}` };
  }
  if (kind === 'tracked') {
    return { title: t('Discard all unstaged changes'), command: discardCommand('tracked'), confirmLabel: tn(paths.length, 'Discard {n} file', 'Discard {n} files'),
      consequence: `${tn(paths.length,
        'Unstaged changes in {n} file ({list}) are replaced by their staged or committed versions; the paths reach Git on stdin. Staged work stays.',
        'Unstaged changes in {n} files ({list}) are replaced by their staged or committed versions; the paths reach Git on stdin. Staged work stays.',
        { list: preview(paths) })} ${t(UNDO)}` };
  }
  if (kind === 'untracked-all') {
    return { title: tn(paths.length, 'Delete {n} untracked path', 'Delete {n} untracked paths'), command: discardCommand('untracked-all', paths),
      confirmLabel: tn(paths.length, 'Delete {n} path', 'Delete {n} paths'),
      consequence: `${tn(paths.length, '{list} is not tracked by Git. Ignored files are left alone.', '{list} are not tracked by Git. Ignored files are left alone.',
        { list: preview(paths) })} ${t(UNDO)}` };
  }
  if (kind === 'lines') {
    return { title: tn(lines, 'Discard {n} selected line of {path}', 'Discard {n} selected lines of {path}', { path }), command: discardCommand('lines'),
      confirmLabel: t('Discard lines'),
      consequence: `${t`The selected changes are removed from ${path} in the working tree; every other change in the file stays. The patch reaches Git on stdin.`} ${t(UNDO)}` };
  }
  throw new TypeError('Unknown discard');
}
