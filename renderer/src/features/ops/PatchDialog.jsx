import { useState } from 'react';
import { CheckCircle2, FileInput, AlertTriangle } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { patchCommandText, patchConsequence } from './patch-view.js';
import { t, tn } from '../../i18n/i18n.js';

/**
 * What a chosen patch file holds and what applying it will run (§6.5: the
 * exact command, and what it changes). An mbox becomes commits through
 * `git am`; a plain diff changes files through `git apply`, optionally staged.
 */
export default function PatchDialog({ patch, branch, onApply, onClose }) {
  const [index, setIndex] = useState(false);
  const listed = patch.kind === 'mbox' ? patch.commits : patch.files;
  return <Dialog title={t`Apply ${patch.name}`} onClose={onClose}>
    <div className="confirm-dialog patch-dialog">
      <p className="confirm-consequence"><FileInput aria-hidden="true" /><span>{patchConsequence(patch, branch, index)}</span></p>
      <p className="muted">{patch.kind === 'mbox'
        ? tn(patch.commits.length, '{n} commit, touching {files}:', '{n} commits, touching {files}:',
          { files: tn(patch.files.length, '{n} file', '{n} files') })
        : tn(patch.files.length, '{n} file:', '{n} files:')}</p>
      <ul className="patch-list">{listed.slice(0, 12).map(item => <li key={item}>{item}</li>)}
        {listed.length > 12 && <li className="muted">{t`and ${listed.length - 12} more`}</li>}</ul>
      <p className={`patch-check ${patch.check.applies ? 'applies' : 'conflicts'}`} role="status">
        {patch.check.applies ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
        <span>{patch.check.applies ? t('Applies cleanly to the current files.')
          : patch.kind === 'mbox' ? t`Does not apply as is (${patch.check.reason.replace(/^error: /, '')}). git am will try a three-way merge and stop on a conflict you can resolve or abort.`
            : t`Does not apply (${patch.check.reason.replace(/^error: /, '')}). git apply changes nothing when any part fails.`}</span></p>
      {patch.kind === 'diff' && <label className="checkbox-row"><input type="checkbox" checked={index} onChange={event => setIndex(event.target.checked)} />{t('Also stage the changes (--index)')}</label>}
      <p className="muted">{t('This command will run:')}</p>
      <code className="confirm-command">$ git {patchCommandText(patch, index)}</code>
      <div className="dialog-actions">
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button className="primary" reason={patch.kind === 'diff' && !patch.check.applies ? t('This patch does not apply to the current files') : undefined}
          onClick={() => { onClose(); onApply(index); }}>{patch.kind === 'mbox' ? (patch.commits.length === 1 ? t('Apply commit') : tn(patch.commits.length, 'Apply {n} commit', 'Apply {n} commits')) : t('Apply to files')}</Button>
      </div>
    </div>
  </Dialog>;
}
