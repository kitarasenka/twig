import { AlertTriangle, GitBranch } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { t, tn } from '../../i18n/i18n.js';

/**
 * Asked before a checkout leaves a detached HEAD whose commits no branch, tag
 * or remote branch holds: after it they show nowhere but in the reflog, and Git
 * only says so in stderr nobody reads. Main counted them (`git rev-list
 * --count HEAD --not --branches --tags --remotes`). Loaded when first needed.
 */
export default function LeaveDetachedDialog({ count, oid, onBranch, onLeave, onClose }) {
  return <Dialog title={t('Leave commits on no branch?')} onClose={onClose}>
    <div className="confirm-dialog">
      <p className="confirm-consequence"><AlertTriangle aria-hidden="true" />
        {tn(count, 'HEAD is detached at {oid}, and {n} commit here is on no branch. After this checkout it shows only in the reflog, until Git deletes it.',
          'HEAD is detached at {oid}, and {n} commits here are on no branch. After this checkout they show only in the reflog, until Git deletes them.', { oid: oid.slice(0, 7) })}</p>
      <p className="muted">{tn(count, 'Create a branch to keep it, or check out anyway: Reflog in the sidebar can still bring it back for a while.',
        'Create a branch to keep them, or check out anyway: Reflog in the sidebar can still bring them back for a while.')}</p>
      <div className="dialog-actions">
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button onClick={() => { onClose(); onLeave(); }}>{t('Check out anyway')}</Button>
        <Button className="primary" icon={GitBranch} data-autofocus onClick={() => { onClose(); onBranch(); }}>{t('Create branch first…')}</Button>
      </div>
    </div>
  </Dialog>;
}
