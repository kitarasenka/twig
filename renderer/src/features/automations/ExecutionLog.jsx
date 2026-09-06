import { useEffect, useState } from 'react';
import { Check, X, ShieldAlert, ChevronRight } from 'lucide-react';
import { eventLabel } from './event-labels.js';
import ExecutionPanel from './ExecutionPanel.jsx';

function when(iso) {
  const date = new Date(iso);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  return sameDay ? date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) + ' ' + date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Past pipeline runs for this repository, newest first, each expandable. */
export default function ExecutionLog({ repositoryId, refreshKey, onConsole }) {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  useEffect(() => {
    let alive = true;
    window.twig.getAutomationRuns(repositoryId)
      .then(list => { if (alive) { setRuns(list); setError(''); } })
      .catch(() => { if (alive) setError('Could not read the run history.'); });
    return () => { alive = false; };
  }, [repositoryId, refreshKey]);

  if (error) return <p className="empty-inline" role="alert">{error} <button onClick={onConsole}>Show output</button></p>;
  if (!runs) return <div className="loading-shell" aria-label="Loading run history"><div className="skeleton" /></div>;
  if (runs.length === 0) return <p className="automations-empty">No pipeline has run yet. Runs appear here after a commit, push or a manual run.</p>;

  return <div className="run-log">
    {runs.map(run => {
      const passed = run.steps.filter(step => step.status === 'passed').length;
      const isOpen = open === run.id;
      return <div key={run.id}>
        <button className={`run-entry ${run.result}`} aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : run.id)}>
          <span className="step-icon">
            {run.result === 'passed' ? <Check aria-hidden="true" /> : run.result === 'bypassed' ? <ShieldAlert aria-hidden="true" /> : <X aria-hidden="true" />}
          </span>
          <span>
            <strong>{eventLabel(run.event)}</strong>
            <span className="run-when"> · {run.steps.length} step{run.steps.length === 1 ? '' : 's'} · {passed} passed · {(run.ms / 1000).toFixed(1)}s</span>
          </span>
          <span className="run-when">{when(run.startedAt)} <ChevronRight aria-hidden="true" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }} /></span>
        </button>
        {isOpen && <div className="run-detail">
          <ExecutionPanel event={run.event} label={eventLabel(run.event)} steps={run.steps} phase="pre"
            result={run.result} blocked={run.result === 'blocked'} bypassed={run.bypassed} embedded />
        </div>}
      </div>;
    })}
  </div>;
}
