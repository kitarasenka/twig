import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Gauge, RefreshCw, Sparkles, Wrench } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { formatBytes, maintenanceAdvice, maintenanceCommands, maintenanceText } from '../../../../main/git/maintenance-plan.js';

const count = value => value.toLocaleString('en');
const plural = (value, word) => `${count(value)} ${word}${value === 1 ? '' : 's'}`;

/** The object store in numbers, from `git count-objects -v`. */
function Stats({ stats }) {
  return <dl className="maintenance-stats">
    <div><dt>On disk</dt><dd>{formatBytes(stats.diskBytes)}</dd><small>objects in .git, packed and loose</small></div>
    <div><dt>Objects</dt><dd>{count(stats.objects)}</dd><small>{count(stats.packed)} packed · {count(stats.loose)} loose</small></div>
    <div><dt>Packs</dt><dd>{count(stats.packs)}</dd><small>{formatBytes(stats.packBytes)}</small></div>
    <div><dt>Loose objects</dt><dd>{count(stats.loose)}</dd><small>{formatBytes(stats.looseBytes)}{stats.prunable ? ` · ${count(stats.prunable)} already packed` : ''}</small></div>
    {stats.garbage > 0 && <div><dt>Garbage</dt><dd>{count(stats.garbage)}</dd><small>{formatBytes(stats.garbageBytes)}</small></div>}
  </dl>;
}

/** What a finished run changed, in words: sizes before → after. */
function outcomeText(task, result) {
  const name = task === 'gc' ? 'Clean up' : 'Optimize';
  const seconds = `${(result.ms / 1000).toFixed(1)} s`;
  if (!result.after) return `${name} finished in ${seconds}.`;
  const freed = result.before.diskBytes - result.after.diskBytes;
  return `${name} finished in ${seconds}. On disk: ${formatBytes(result.before.diskBytes)} → ${formatBytes(result.after.diskBytes)}`
    + `${freed > 0 ? ` (${formatBytes(freed)} freed)` : ''}; loose objects: ${count(result.before.loose)} → ${count(result.after.loose)}`
    + `; packs: ${result.before.packs} → ${result.after.packs}.`;
}

/**
 * Repository maintenance by button: how big the object store is, and the two
 * things Git can do about it. Optimize deletes nothing Git could still need
 * and runs straight away; Clean up (`git gc`) can finally drop long-lost
 * commits, so it confirms first (§6.5) with the exact command.
 */
export default function MaintenanceScreen({ repository, busy, onBack, onDialog, onConsole }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await window.twig.getRepositoryStats(repository.id);
      if (epoch === generation.current) { setStats(next); setError(''); }
    } catch (failure) { if (epoch === generation.current) setError(failure.message || 'Could not measure this repository.'); }
  }, [repository.id]);
  useEffect(() => { void refresh(); const token = generation; return () => { token.current++; }; }, [refresh]);

  async function run(task) {
    setRunning(task); setNote('');
    try {
      const result = await window.twig.runMaintenance(repository.id, task);
      if (result.after) setStats(result.after);
      if (result.ok) setNote(outcomeText(task, result));
      else { setNote(result.message); if (!result.cancelled) onConsole(); }
    } catch (failure) { setNote(failure.message || 'Maintenance did not run.'); onConsole(); }
    finally { setRunning(null); void refresh(); }
  }

  function confirmGc() {
    onDialog({
      type: 'confirm', danger: false, title: 'Clean up this repository', command: maintenanceCommands('gc')[0],
      consequence: 'Git repacks every object into one pack and removes what nothing points to any more. Reflog entries older than 90 days (30 for commits on no branch) expire, and unreachable objects older than two weeks are deleted for good — commits the Reflog screen could still recover may be gone afterwards. Branches, tags, stashes and your working tree are not touched.',
      confirmLabel: 'Clean up',
      onConfirm: () => void run('gc')
    });
  }

  const reason = running ? 'Maintenance is running' : busy ? 'Git is working' : undefined;
  const advice = maintenanceAdvice(stats);
  return <section className="tool-screen maintenance-screen" aria-label="Maintenance">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div><Wrench aria-hidden="true" /><strong>Maintenance</strong></div>
      <div className="tool-actions">
        <Button icon={RefreshCw} reason={running ? 'Maintenance is running' : undefined} onClick={() => void refresh()}>Refresh</Button>
      </div>
    </header>
    <p className="tool-intro muted">Git stores every version as objects under .git. Over time they pile up as loose files and many small packs; packing them keeps history fast and the folder small.</p>
    {note && <div className="operation-note" role="status"><span>{note}</span><button onClick={() => setNote('')} aria-label="Dismiss">×</button></div>}
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></p>}
    {!stats && !error && <div className="loading-shell" aria-label="Measuring repository"><div className="skeleton" /></div>}
    <div className="maintenance-body">
      {stats && <Stats stats={stats} />}
      {stats && <p className={`maintenance-advice ${advice ? '' : 'muted'}`} role="status">{advice || 'Nothing is due: Git would not tidy this repository up by itself yet.'}</p>}
      {running && <div className="git-drag-status" role="status">
        <span>Running <code>{maintenanceText(running).join(', then ')}</code>…</span>
        <Button onClick={() => void window.twig.cancelRepositoryTool(repository.id)}>Cancel</Button>
      </div>}
      <ul className="tool-list maintenance-tasks" aria-label="Maintenance tasks">
        <li>
          <div className="tool-item">
            <strong><Gauge aria-hidden="true" />Optimize</strong>
            <span>Writes a commit-graph so history and the graph load faster, packs loose objects and merges small packs, then removes the loose copies that are now in a pack. Deletes nothing Git could still need, so it runs straight away.</span>
            {maintenanceText('optimize').map(line => <code className="tool-path" key={line}>{line}</code>)}
          </div>
          <div className="tool-actions"><Button icon={Gauge} className="primary" reason={reason} onClick={() => void run('optimize')}>Optimize</Button></div>
        </li>
        <li>
          <div className="tool-item">
            <strong><Sparkles aria-hidden="true" />Clean up</strong>
            <span>Git’s full clean-up: repacks everything and removes objects nothing points to, once they are old enough. Frees the most space; asks first.</span>
            {maintenanceText('gc').map(line => <code className="tool-path" key={line}>{line}</code>)}
          </div>
          <div className="tool-actions"><Button icon={Sparkles} reason={reason} onClick={confirmGc}>Clean up…</Button></div>
        </li>
      </ul>
      {stats && <p className="muted maintenance-foot">{plural(stats.objects, 'object')} in {plural(stats.packs, 'pack')}. Sizes are Git’s own count of the object store, not of the whole .git folder.</p>}
    </div>
  </section>;
}
