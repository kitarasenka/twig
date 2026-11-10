import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import { t, tr } from '../i18n/i18n.js';

/**
 * Asks before deleting a lock Git left in `.git`. Nothing here can see another
 * program holding it — a terminal, an editor opened by `git commit`, another
 * client — so the person is told to check first; main still refuses a path
 * that is not a lock of this repository, and refuses while 🌱 Twig itself is
 * running Git there. Loaded the first time it is needed (main bundle budget).
 */
export default function RemoveLockDialog({ request, onDone, onClose }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function remove() {
    setBusy(true);
    try {
      const result = await window.twig.removeGitLock(request.repositoryId, request.lock);
      if (!result.ok) { setProblem(tr(result.message)); return; }
      onClose();
      onDone(result.message ? tr(result.message) : t('Lock removed. Try the action again.'));
    } catch {
      setProblem(t('Could not remove the lock.'));
    } finally { setBusy(false); }
  }
  return <Dialog title={t('Remove the Git lock?')} onClose={onClose} closeReason={busy ? t('Wait for the action to finish or cancel it first') : undefined}>
    <div className="confirm-dialog">
      <p className="confirm-consequence"><AlertTriangle aria-hidden="true" />
        {t('Git keeps this file while it changes the repository. Remove it only if no other Git program is working here: close any terminal, editor or Git client that may still be running a Git command in this repository.')}</p>
      <code className="confirm-command">{request.lock}</code>
      {problem && <p className="warn" role="alert">{problem}</p>}
      <div className="dialog-actions">
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button className="danger" reason={busy ? t('Git is working') : undefined} onClick={() => void remove()}>{t('Remove the lock')}</Button>
      </div>
    </div>
  </Dialog>;
}
