import { useState } from 'react';
import { Check, X, Loader, Minus, ShieldAlert, ScrollText } from 'lucide-react';
import Button from '../../ui/Button.jsx';

function StepIcon({ status }) {
  if (status === 'passed') return <Check aria-label="passed" />;
  if (status === 'failed') return <X aria-label="failed" />;
  if (status === 'skipped') return <Minus aria-label="skipped" />;
  return <Loader className="spin" aria-label="running" />;
}

function StepRow({ step, open, onToggle }) {
  const hasOutput = Boolean(step.stdout || step.stderr);
  return <>
    <li className={`step-row ${step.status}`}>
      <span className="step-icon"><StepIcon status={step.status} /></span>
      <span className="step-name">
        {step.name}
        {step.command && <small title={step.command}>{step.command}</small>}
        {step.detail && step.status !== 'passed' && <span className="step-detail">{step.detail}</span>}
      </span>
      <span className="step-ms">
        {typeof step.ms === 'number' ? `${(step.ms / 1000).toFixed(1)}s` : ''}
        {hasOutput && <Button onClick={onToggle} aria-expanded={open} aria-label={`${open ? 'Hide' : 'View'} output for ${step.name}`}>{open ? 'Hide' : 'Output'}</Button>}
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
const BLOCK_NOUN = { 'pre-commit': 'Commit', 'commit-msg': 'Commit', 'prepare-commit-msg': 'Commit', 'pre-push': 'Push', 'pre-rebase': 'Rebase', 'pre-merge-commit': 'Merge' };

export default function ExecutionPanel({ event, label, steps, phase, result, blocked, bypassed,
  onRetry, onRunAgain, onBypass, onClose, embedded = false }) {
  const [openStep, setOpenStep] = useState(null);
  const noun = BLOCK_NOUN[event] || label;
  const passed = steps.filter(step => step.status === 'passed').length;
  const failed = steps.filter(step => step.status === 'failed').length;
  const done = result != null;
  const verdict = bypassed ? 'bypassed' : blocked ? 'blocked' : failed ? 'failed' : done ? 'passed' : 'running';

  const body = <>
    <div className={`execution-verdict ${verdict}`}>
      {verdict === 'passed' && <><Check aria-hidden="true" /> All checks passed</>}
      {verdict === 'failed' && <><X aria-hidden="true" /> {failed} check{failed === 1 ? '' : 's'} failed</>}
      {verdict === 'blocked' && <><ShieldAlert aria-hidden="true" /> {noun} blocked</>}
      {verdict === 'bypassed' && <><ShieldAlert aria-hidden="true" /> Checks skipped for this {noun.toLowerCase()}</>}
      {verdict === 'running' && <><Loader className="spin" aria-hidden="true" /> Running checks…</>}
      {steps.length > 0 && <span className="count">{passed} passed · {failed} failed</span>}
    </div>
    <ul className="step-list">
      {steps.map((step, index) => <StepRow key={index} step={step} open={openStep === index}
        onToggle={() => setOpenStep(current => (current === index ? null : index))} />)}
      {steps.length === 0 && done && <li className="step-row skipped"><span className="step-icon"><Minus /></span>
        <span className="step-name">No pipeline matched this event.</span><span /></li>}
    </ul>
  </>;

  if (embedded) return <div className="execution-inline">{body}</div>;

  return <div className="execution-overlay" role="dialog" aria-modal="true" aria-label={`${label} checks`}>
    <div className="execution-panel">
      <header><ScrollText aria-hidden="true" /><h3>{label} checks</h3>
        {done && <Button icon={X} aria-label="Close" onClick={onClose} />}</header>
      {body}
      <div className="dialog-actions">
        {!done && <Button onClick={onClose}>Run in background</Button>}
        {done && blocked && <>
          <Button className="primary" onClick={onRetry}>Fix and retry</Button>
          <Button className="secondary" onClick={onRunAgain}>Run again</Button>
          <Button className={phase === 'pre' ? 'danger quiet' : ''} onClick={onBypass}>{phase === 'pre' ? 'Bypass once' : 'Dismiss'}</Button>
        </>}
        {done && !blocked && <Button className="primary" onClick={onClose}>Close</Button>}
      </div>
    </div>
  </div>;
}
