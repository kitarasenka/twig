import { AlertTriangle, CheckCircle2, FileCheck2, FileWarning } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { mark, t, tn } from '../../i18n/i18n.js';

// Whole phrases per operation, so each language words them its own way.
const IN_PROGRESS = { merge: mark('Merge in progress'), 'cherry-pick': mark('Cherry-pick in progress'), revert: mark('Revert in progress'),
  rebase: mark('Rebase in progress'), am: mark('Applying patches in progress'), conflict: mark('Conflict in the working tree') };
const RUNNING = { merge: mark('Merge is running'), 'cherry-pick': mark('Cherry-pick is running'), revert: mark('Revert is running'),
  rebase: mark('Rebase is running'), am: mark('Applying patches is running') };
const STEPS = {
  merge: [['continue', mark('Continue')], ['abort', mark('Abort')]],
  'cherry-pick': [['continue', mark('Continue')], ['skip', mark('Skip this commit')], ['abort', mark('Abort')]],
  revert: [['continue', mark('Continue')], ['skip', mark('Skip this commit')], ['abort', mark('Abort')]],
  rebase: [['continue', mark('Continue')], ['skip', mark('Skip this commit')], ['abort', mark('Abort')]],
  am: [['continue', mark('Continue')], ['skip', mark('Skip this patch')], ['abort', mark('Abort')]]
};

const NOTHING_UNSAVED = new Set();

/**
 * The banner for an operation Git stopped in the middle of. It stays above the
 * history for as long as the repository is in that state, because every other
 * action in the window will be refused until it is finished or abandoned, and
 * a user who does not know why deserves to be told rather than to guess.
 *
 * `conflict` is the same picture with no operation behind it: a stash that did
 * not apply cleanly leaves conflicted files and no marker file for Git to name.
 * There is nothing to continue or abort, only files to resolve. `unsaved` names
 * the files with edits in the conflict editor that are not saved yet.
 */
export default function OperationBanner({ state, busy, unsaved = NOTHING_UNSAVED, onStep, onOpenConflict, onRestoreConflict }) {
  if (!state || state.kind === 'none') return null;
  const inProgress = IN_PROGRESS[state.kind] ? t(IN_PROGRESS[state.kind]) : t`${state.kind} in progress`;
  const running = RUNNING[state.kind] ? t(RUNNING[state.kind]) : t`${state.kind} is running`;
  const progress = state.step && state.total ? ` · ${t`step ${state.step} of ${state.total}`}` : '';
  const branch = state.branch ? ` · ${state.branch}` : '';
  return <section className="operation-banner" role="status" aria-live="polite" aria-label={inProgress}>
    <div className="operation-headline">
      {state.resolved ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <strong>{inProgress}{progress}{branch}</strong>
      <span className="muted">{state.kind === 'conflict'
        ? tn(state.conflicts.length, '{n} file still conflicted. Nothing has to be continued: resolve it. A stash that left this stays in the list until you drop it.',
          '{n} files still conflicted. Nothing has to be continued: resolve them. A stash that left this stays in the list until you drop it.')
        : state.resolved
          ? t('Nothing is conflicted any more. Continue to finish it.')
          : tn(state.conflicts.length, '{n} file still conflicted.', '{n} files still conflicted.')}</span>
      <div className="operation-actions">
        {(STEPS[state.kind] || []).map(([step, text]) => <Button key={step} className={step === 'abort' ? 'danger quiet operation-abort' : step === 'continue' ? 'primary' : 'secondary'}
          reason={busy ? running : step === 'continue' && !state.resolved ? t('Resolve every conflict first') : undefined}
          onClick={() => onStep(step)}>{t(text)}</Button>)}
      </div>
    </div>
    {(state.conflicts.length > 0 || state.resolvedFiles?.length > 0) && <ul className="conflict-list">
      {state.conflicts.map(file => <li key={file}>
        <button type="button" onClick={() => onOpenConflict(file)}><FileWarning aria-hidden="true" /><span>{file}</span><small>{unsaved.has(file) ? t('Unsaved edits') : t('Resolve')}</small></button>
      </li>)}
      {/* Resolved during this operation: Git still keeps the stages, so the conflict can come back. */}
      {(state.resolvedFiles || []).map(file => <li key={`resolved:${file}`}>
        <button type="button" className="resolved-file" disabled={busy} onClick={() => onRestoreConflict?.(file)}
          title={t('Git still remembers this conflict. Put the markers back to resolve it again.')}>
          <FileCheck2 aria-hidden="true" /><span>{file}</span><small>{t('Resolved · Put the conflict back')}</small></button>
      </li>)}
    </ul>}
  </section>;
}
