import { CheckCircle2, Target } from 'lucide-react';
import Button from '../../ui/Button.jsx';

/**
 * The bisect banner. Bisect is not an interrupted operation the way a merge is
 * — nothing is conflicted and every other command still works — so it gets its
 * own banner rather than a branch inside the one for stopped operations.
 *
 * What it shows comes from the marks Git left in `refs/bisect/*` and from
 * `git rev-list --bisect-vars`, never from the sentence Git printed.
 */
export default function BisectBanner({ state, busy, onStep, onOpenCommit }) {
  if (!state || !state.active) return null;
  const terms = state.terms || { bad: 'bad', good: 'good' };
  const reason = busy ? 'Git is working' : undefined;
  const short = oid => (oid ? oid.slice(0, 7) : '');

  if (state.done && state.firstBad) {
    return <section className="operation-banner bisect-banner done" role="status" aria-live="polite" aria-label="Bisect finished">
      <div className="operation-headline">
        <CheckCircle2 aria-hidden="true" />
        <strong>First {terms.bad} commit: {short(state.firstBad)}</strong>
        <span className="muted">Every earlier commit tested {terms.good}. Ending the bisect returns to {state.start || 'the previous revision'}.</span>
        <div className="operation-actions">
          <Button onClick={() => onOpenCommit(state.firstBad)}>Show the commit</Button>
          <Button className="primary" reason={reason} onClick={() => onStep('reset')}>End bisect</Button>
        </div>
      </div>
    </section>;
  }

  const waiting = !state.bad ? `Mark the broken commit as ${terms.bad} from its context menu.`
    : state.goods.length === 0 ? `${short(state.bad)} is ${terms.bad}. Now mark an older, working commit as ${terms.good}.`
      : null;

  return <section className="operation-banner bisect-banner" role="status" aria-live="polite" aria-label="Bisect in progress">
    <div className="operation-headline">
      <Target aria-hidden="true" />
      <strong>Bisect in progress{state.expected && !waiting ? ` · testing ${short(state.expected)}` : ''}</strong>
      <span className="muted">{waiting || `${state.remaining ?? 0} revision${state.remaining === 1 ? '' : 's'} left, about ${state.steps ?? 0} more test${state.steps === 1 ? '' : 's'}. Does this revision work?`}</span>
      <div className="operation-actions">
        {!waiting && <>
          <Button reason={reason} onClick={() => onStep('good')}>It works ({terms.good})</Button>
          <Button reason={reason} onClick={() => onStep('bad')}>It is broken ({terms.bad})</Button>
          <Button reason={reason} onClick={() => onStep('skip')}>Cannot tell — skip</Button>
        </>}
        <Button className="danger" reason={reason} onClick={() => onStep('reset')}>Abort</Button>
      </div>
    </div>
    {state.skipped.length > 0 && <p className="bisect-note">{state.skipped.length} revision{state.skipped.length === 1 ? '' : 's'} skipped; Git works around them.</p>}
  </section>;
}
