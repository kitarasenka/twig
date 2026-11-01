import { CheckCircle2, CircleHelp, SkipForward, XCircle } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { t, tn } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

const short = oid => oid?.slice(0, 7) || '';

export default function BisectBanner({ state, busy, blockedReason, selectedCommit, onStep, onOpenCommit }) {
  if (!state?.active) return null;
  const terms = state.terms || { bad: 'bad', good: 'good' };
  const reason = busy ? t('Git is working') : blockedReason;
  const done = state.done && state.firstBad;
  const waiting = !state.bad || state.goods.length === 0;
  const nextMark = !state.bad ? 'bad' : 'good';
  const selectedReason = reason || (!selectedCommit ? t('Select a commit in the history first')
    : selectedCommit.oid === state.bad ? t('Choose an older commit without the bug') : undefined);
  const returnTo = state.start || t('the previous revision');

  return <section className={`operation-banner bisect-banner${done ? ' done' : ''}`}
    aria-label="🌱 BugHunter (bisect)" aria-busy={busy}>
    <div className="operation-headline">
      <strong>🌱 BugHunter (bisect)</strong>
      <span className="bisect-phase" role="status">{done ? t('3 · Result') : waiting ? t('1 · Choose the range') : t('2 · Test this version')}</span>
      <div className="operation-actions">
        <Button reason={busy ? t('Git is working') : undefined} title={t`Return to ${returnTo}`}
          onClick={() => onStep('reset')}>{done ? t('Finish and return') : t('Stop and return')}</Button>
      </div>
    </div>
    <div className="bisect-body">
      {done ? <>
        <p className="bisect-result"><CheckCircle2 aria-hidden="true" /><strong>{t`First ${terms.bad} commit: ${short(state.firstBad)}`}</strong></p>
        <p>{t('Git narrowed the bug down to this commit using your answers. Review its changes to find the cause.')}</p>
        <Button onClick={() => onOpenCommit(state.firstBad)}>{t('Show the commit')}</Button>
      </> : waiting ? <>
        <p>{!state.bad ? t('Select a commit where you have reproduced the bug.')
          : tx('{commit} has the bug. Select an older commit where the same bug is absent.', { commit: <code>{short(state.bad)}</code> })}</p>
        <p className="muted">{t('Click a commit in the history, then mark it below. Git needs both ends before it can estimate the steps.')}</p>
        <div className="bisect-controls">
          <Button className="primary" reason={selectedReason} onClick={() => onStep(nextMark, selectedCommit.oid)}>
            {nextMark === 'bad'
              ? (selectedCommit ? t`Bug present at ${short(selectedCommit.oid)}` : t('Bug present in selected commit'))
              : (selectedCommit ? t`Bug absent at ${short(selectedCommit.oid)}` : t('Bug absent in selected commit'))}
          </Button>
          {selectedCommit && <span className="bisect-selection" title={selectedCommit.subject}>{selectedCommit.subject}</span>}
        </div>
      </> : <>
        <div className="bisect-test-heading" role="status" aria-live="polite">
          <strong>{state.expected ? tx('Testing {commit}', { commit: <code>{short(state.expected)}</code> }) : t('Waiting for a test revision')}</strong>
          <span className="bisect-estimate">{state.steps === null || state.steps === undefined ? t('Step estimate unavailable')
            : tn(state.steps, 'About {n} more test after this one', 'About {n} more tests after this one')}</span>
        </div>
        <p>{t('Run your app or tests from this repository and try to reproduce the same bug. Then record what happened; Git opens the next version automatically.')}</p>
        <div className="bisect-controls">
          <Button icon={CheckCircle2} className="primary" reason={reason || (!state.expected ? t('Refresh to read the revision to test') : undefined)}
            title={t`The bug is absent in this version (${terms.good})`} onClick={() => onStep('good', state.expected)}>{t('Bug absent')}</Button>
          <Button icon={XCircle} reason={reason || (!state.expected ? t('Refresh to read the revision to test') : undefined)}
            title={t`The same bug is present in this version (${terms.bad})`} onClick={() => onStep('bad', state.expected)}>{t('Bug present')}</Button>
          <Button icon={SkipForward} reason={reason || (!state.expected ? t('Refresh to read the revision to test') : undefined)}
            title={t('Skip if this version will not build or you cannot reproduce the test')} onClick={() => onStep('skip', state.expected)}>{t('Cannot test · Skip')}</Button>
          {state.expected && <Button onClick={() => onOpenCommit(state.expected)}>{t('Show test commit')}</Button>}
        </div>
        {reason && <p className="muted">{reason}</p>}
      </>}
      {state.skipped.length > 0 && <p className="muted">{tn(state.skipped.length, '{n} skipped. Skipping can add tests or leave several possible causes; the step count is an estimate.',
        '{n} skipped. Skipping can add tests or leave several possible causes; the step count is an estimate.')}</p>}
      <details className="bisect-help">
        <summary><CircleHelp aria-hidden="true" />{t('How to use BugHunter')}</summary>
        <ol>
          <li>{t('Start from a commit with the bug, then mark an older commit without it.')}</li>
          <li>{t('Git uses bisect (binary search) to narrow the range. For example, 16 candidate commits usually need about 4 tests.')}</li>
          <li>{t('Rebuild or restart your app for each version. Test the same bug, then choose Bug absent, Bug present, or Skip if you cannot tell.')}</li>
        </ol>
        <p>{t('Commit or stash edits before moving to the next version. Your answers apply to the test commit above, even when you browse another commit.')}</p>
      </details>
      <p className="bisect-return">{done ? tx('Finish and return restores {target}.', { target: <strong>{returnTo}</strong> })
        : <>{tx('Stop and return restores {target}.', { target: <strong>{returnTo}</strong> })} {t('Git temporarily switches the files in your working folder during the search.')}</>}</p>
    </div>
  </section>;
}
