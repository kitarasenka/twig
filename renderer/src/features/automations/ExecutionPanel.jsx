import { useEffect, useRef, useState } from 'react';
import { Check, X, Loader, Minus, ShieldAlert } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { mark, t, tn, tr } from '../../i18n/i18n.js';

function StepIcon({ status }) {
  if (status === 'passed') return <Check aria-label={t('passed')} />;
  if (status === 'failed') return <X aria-label={t('failed')} />;
  if (status === 'skipped') return <Minus aria-label={t('skipped')} />;
  return <Loader className="spin" aria-label={t('running')} />;
}

function StepRow({ step, open, onToggle }) {
  const hasOutput = Boolean(step.stdout || step.stderr);
  // The action's name is the person's own words; only main's "Bypassed" row is a message.
  const name = step.type === 'bypass' ? tr(step.name) : step.name;
  return <>
    <li className={`step-row ${step.status}`}>
      <span className="step-icon"><StepIcon status={step.status} /></span>
      <span className="step-name">
        {name}
        {step.command && <small title={step.command}>{step.command}</small>}
        {step.detail && step.status !== 'passed' && <span className="step-detail">{tr(step.detail)}</span>}
      </span>
      <span className="step-ms">
        {typeof step.ms === 'number' ? t`${(step.ms / 1000).toFixed(1)}s` : ''}
        {hasOutput && <Button onClick={onToggle} aria-expanded={open} aria-label={open ? t`Hide output for ${name}` : t`View output for ${name}`}>{open ? t('Hide') : t('Output')}</Button>}
      </span>
    </li>
    {open && hasOutput && <li><pre className="step-output">{[step.stdout, step.stderr].filter(Boolean).join('\n').trim()}</pre></li>}
  </>;
}

/**
 * The run of a pipeline: every step with its status, timing and output, and —
 * when a pre-* pipeline blocked the Git operation — the reason and what to do
 * next. Shown as an overlay while a Git action is gated, and reused as the
 * expanded body of a log entry.
 */
const COMMIT = { blocked: mark('Commit blocked'), bypassed: mark('Checks skipped for this commit') };
const BLOCKED = {
  'pre-commit': COMMIT, 'commit-msg': COMMIT, 'prepare-commit-msg': COMMIT,
  'pre-push': { blocked: mark('Push blocked'), bypassed: mark('Checks skipped for this push') },
  'pre-rebase': { blocked: mark('Rebase blocked'), bypassed: mark('Checks skipped for this rebase') },
  'pre-merge-commit': { blocked: mark('Merge blocked'), bypassed: mark('Checks skipped for this merge') }
};

/** Most Git actions have no pipeline: a dialog that would flash and take the focus for nothing waits a moment. */
const SHOW_AFTER_MS = 150;

export default function ExecutionPanel({ event, label, steps, phase, result, blocked, bypassed,
  onRetry, onRunAgain, onBypass, onClose, embedded = false }) {
  const [openStep, setOpenStep] = useState(null);
  const [waited, setWaited] = useState(false);
  const actions = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  // A block is what the person has to answer, so that is where the focus goes.
  useEffect(() => { if (blocked) actions.current?.querySelector('button.primary')?.focus(); }, [blocked, waited]);
  const words = BLOCKED[event];
  const passed = steps.filter(step => step.status === 'passed').length;
  const failed = steps.filter(step => step.status === 'failed').length;
  const done = result != null;
  const verdict = bypassed ? 'bypassed' : blocked ? 'blocked' : failed ? 'failed' : done ? 'passed' : 'running';

  const body = <>
    <div className={`execution-verdict ${verdict}`} role={embedded ? undefined : 'status'}>
      {verdict === 'passed' && <><Check aria-hidden="true" /> {t('All checks passed')}</>}
      {verdict === 'failed' && <><X aria-hidden="true" /> {tn(failed, '{n} check failed', '{n} checks failed')}</>}
      {verdict === 'blocked' && <><ShieldAlert aria-hidden="true" /> {words ? t(words.blocked) : t`${label} blocked`}</>}
      {verdict === 'bypassed' && <><ShieldAlert aria-hidden="true" /> {words ? t(words.bypassed) : t`Checks skipped: ${label}`}</>}
      {verdict === 'running' && <><Loader className="spin" aria-hidden="true" /> {t('Running checks…')}</>}
      {steps.length > 0 && <span className="count">{t`${passed} passed · ${failed} failed`}</span>}
    </div>
    <ul className="step-list">
      {steps.map((step, index) => <StepRow key={index} step={step} open={openStep === index}
        onToggle={() => setOpenStep(current => (current === index ? null : index))} />)}
      {steps.length === 0 && done && <li className="step-row skipped"><span className="step-icon"><Minus /></span>
        <span className="step-name">{t('No pipeline matched this event.')}</span><span /></li>}
    </ul>
  </>;

  if (embedded) return <div className="execution-inline">{body}</div>;

  if (!waited && !done) return null;
  return <Dialog title={t`${label} checks`} onClose={blocked ? onRetry : onClose}>
    <div className="execution-panel">
      {body}
      <div className="dialog-actions" ref={actions}>
        {!done && <Button onClick={onClose}>{t('Cancel')}</Button>}
        {done && blocked && <>
          <Button className="primary" onClick={onRetry}>{t('Back to fix it')}</Button>
          <Button className="secondary" onClick={onRunAgain}>{t('Run again')}</Button>
          <Button className={phase === 'pre' ? 'danger quiet' : ''} onClick={onBypass}>{phase === 'pre' ? t('Bypass once') : t('Dismiss')}</Button>
        </>}
        {done && !blocked && <Button className="primary" onClick={onClose}>{t('Close')}</Button>}
      </div>
    </div>
  </Dialog>;
}
