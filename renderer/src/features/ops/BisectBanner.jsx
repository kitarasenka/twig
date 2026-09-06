import { CheckCircle2, CircleHelp, SkipForward, XCircle } from 'lucide-react';
import Button from '../../ui/Button.jsx';

const short = oid => oid?.slice(0, 7) || '';

export default function BisectBanner({ state, busy, blockedReason, selectedCommit, onStep, onOpenCommit }) {
  if (!state?.active) return null;
  const terms = state.terms || { bad: 'bad', good: 'good' };
  const reason = busy ? 'Git is working' : blockedReason;
  const done = state.done && state.firstBad;
  const waiting = !state.bad || state.goods.length === 0;
  const mark = !state.bad ? 'bad' : 'good';
  const selectedReason = reason || (!selectedCommit ? 'Select a commit in the history first'
    : selectedCommit.oid === state.bad ? 'Choose an older commit without the bug' : undefined);
  const returnTo = state.start || 'the previous revision';

  return <section className={`operation-banner bisect-banner${done ? ' done' : ''}`}
    aria-label="🌱 BugHunter (bisect)" aria-busy={busy}>
    <div className="operation-headline">
      <strong>🌱 BugHunter (bisect)</strong>
      <span className="bisect-phase" role="status">{done ? '3 · Result' : waiting ? '1 · Choose the range' : '2 · Test this version'}</span>
      <div className="operation-actions">
        <Button reason={busy ? 'Git is working' : undefined} title={`Return to ${returnTo}`}
          onClick={() => onStep('reset')}>{done ? 'Finish and return' : 'Stop and return'}</Button>
      </div>
    </div>
    <div className="bisect-body">
      {done ? <>
        <p className="bisect-result"><CheckCircle2 aria-hidden="true" /><strong>First {terms.bad} commit: {short(state.firstBad)}</strong></p>
        <p>Git narrowed the bug down to this commit using your answers. Review its changes to find the cause.</p>
        <Button onClick={() => onOpenCommit(state.firstBad)}>Show the commit</Button>
      </> : waiting ? <>
        <p>{!state.bad ? 'Select a commit where you have reproduced the bug.'
          : <><code>{short(state.bad)}</code> has the bug. Select an older commit where the same bug is absent.</>}</p>
        <p className="muted">Click a commit in the history, then mark it below. Git needs both ends before it can estimate the steps.</p>
        <div className="bisect-controls">
          <Button className="primary" reason={selectedReason} onClick={() => onStep(mark, selectedCommit.oid)}>
            {mark === 'bad' ? 'Bug present' : 'Bug absent'}{selectedCommit ? ` at ${short(selectedCommit.oid)}` : ' in selected commit'}
          </Button>
          {selectedCommit && <span className="bisect-selection" title={selectedCommit.subject}>{selectedCommit.subject}</span>}
        </div>
      </> : <>
        <div className="bisect-test-heading" role="status" aria-live="polite">
          <strong>{state.expected ? <>Testing <code>{short(state.expected)}</code></> : 'Waiting for a test revision'}</strong>
          <span className="bisect-estimate">{state.steps === null || state.steps === undefined ? 'Step estimate unavailable'
            : `About ${state.steps} more test${state.steps === 1 ? '' : 's'} after this one`}</span>
        </div>
        <p>Run your app or tests from this repository and try to reproduce the same bug. Then record what happened; Git opens the next version automatically.</p>
        <div className="bisect-controls">
          <Button icon={CheckCircle2} className="primary" reason={reason || (!state.expected ? 'Refresh to read the revision to test' : undefined)}
            title={`The bug is absent in this version (${terms.good})`} onClick={() => onStep('good', state.expected)}>Bug absent</Button>
          <Button icon={XCircle} reason={reason || (!state.expected ? 'Refresh to read the revision to test' : undefined)}
            title={`The same bug is present in this version (${terms.bad})`} onClick={() => onStep('bad', state.expected)}>Bug present</Button>
          <Button icon={SkipForward} reason={reason || (!state.expected ? 'Refresh to read the revision to test' : undefined)}
            title='Skip if this version will not build or you cannot reproduce the test' onClick={() => onStep('skip', state.expected)}>Cannot test · Skip</Button>
          {state.expected && <Button onClick={() => onOpenCommit(state.expected)}>Show test commit</Button>}
        </div>
        {reason && <p className="muted">{reason}</p>}
      </>}
      {state.skipped.length > 0 && <p className="muted">{state.skipped.length} skipped. Skipping can add tests or leave several possible causes; the step count is an estimate.</p>}
      <details className="bisect-help">
        <summary><CircleHelp aria-hidden="true" />How to use BugHunter</summary>
        <ol>
          <li>Start from a commit with the bug, then mark an older commit without it.</li>
          <li>Git uses bisect (binary search) to narrow the range. For example, 16 candidate commits usually need about 4 tests.</li>
          <li>Rebuild or restart your app for each version. Test the same bug, then choose Bug absent, Bug present, or Skip if you cannot tell.</li>
        </ol>
        <p>Commit or stash edits before moving to the next version. Your answers apply to the test commit above, even when you browse another commit.</p>
      </details>
      <p className="bisect-return">{done ? 'Finish' : 'Stop'} and return restores <strong>{returnTo}</strong>.{!done && ' Git temporarily switches the files in your working folder during the search.'}</p>
    </div>
  </section>;
}
