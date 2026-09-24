import { AlertTriangle, CheckCircle2, FileWarning } from 'lucide-react';
import Button from '../../ui/Button.jsx';

const LABELS = { merge: 'Merge', 'cherry-pick': 'Cherry-pick', revert: 'Revert', rebase: 'Rebase', am: 'Applying patches' };
const STEPS = {
  merge: [['continue', 'Continue'], ['abort', 'Abort']],
  'cherry-pick': [['continue', 'Continue'], ['skip', 'Skip this commit'], ['abort', 'Abort']],
  revert: [['continue', 'Continue'], ['skip', 'Skip this commit'], ['abort', 'Abort']],
  rebase: [['continue', 'Continue'], ['skip', 'Skip this commit'], ['abort', 'Abort']],
  am: [['continue', 'Continue'], ['skip', 'Skip this patch'], ['abort', 'Abort']]
};

/**
 * The banner for an operation Git stopped in the middle of. It stays above the
 * history for as long as the repository is in that state, because every other
 * action in the window will be refused until it is finished or abandoned, and
 * a user who does not know why deserves to be told rather than to guess.
 */
export default function OperationBanner({ state, busy, onStep, onOpenConflict }) {
  if (!state || state.kind === 'none') return null;
  const label = LABELS[state.kind] || state.kind;
  const progress = state.step && state.total ? ` · step ${state.step} of ${state.total}` : '';
  const branch = state.branch ? ` · ${state.branch}` : '';
  return <section className="operation-banner" role="status" aria-live="polite" aria-label={`${label} in progress`}>
    <div className="operation-headline">
      {state.resolved ? <CheckCircle2 aria-hidden="true" /> : <AlertTriangle aria-hidden="true" />}
      <strong>{label} in progress{progress}{branch}</strong>
      <span className="muted">{state.resolved
        ? 'Nothing is conflicted any more. Continue to finish it.'
        : `${state.conflicts.length} file${state.conflicts.length === 1 ? '' : 's'} still conflicted.`}</span>
      <div className="operation-actions">
        {(STEPS[state.kind] || []).map(([step, text]) => <Button key={step} className={step === 'abort' ? 'danger' : step === 'continue' ? 'primary' : ''}
          reason={busy ? `${label} is running` : step === 'continue' && !state.resolved ? 'Resolve every conflict first' : undefined}
          onClick={() => onStep(step)}>{text}</Button>)}
      </div>
    </div>
    {state.conflicts.length > 0 && <ul className="conflict-list">
      {state.conflicts.map(file => <li key={file}>
        <button type="button" onClick={() => onOpenConflict(file)}><FileWarning aria-hidden="true" /><span>{file}</span><small>Resolve</small></button>
      </li>)}
    </ul>}
  </section>;
}
