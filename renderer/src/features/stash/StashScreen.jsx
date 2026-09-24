import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Archive, FilePlus2, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import DiffLines from '../diff/DiffLines.jsx';
import FileStatus from '../diff/FileStatus.jsx';

function when(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * The stash list with the contents of one stash — §8.6 asks for both, and a
 * stash whose contents cannot be read is a box nobody dares open.
 *
 * A stash is addressed to Git by its index (`stash@{n}`), which moves as soon
 * as any other stash is dropped, so every action also carries the object id the
 * row was showing and main refuses the action when the two no longer agree.
 */
export default function StashScreen({ repository, busy, onBack, onPerform, onDialog, onConsole }) {
  const [stashes, setStashes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [files, setFiles] = useState([]);
  const [diff, setDiff] = useState(null);
  const generation = useRef(0);
  const diffRequest = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const list = await window.twig.stashList(repository.id);
      if (epoch !== generation.current) return;
      setStashes(list); setError('');
      setSelected(current => list.find(item => item.oid === current)?.oid || list[0]?.oid || null);
    } catch (failure) {
      if (epoch === generation.current) setError(failure.message || 'Could not read the stash list.');
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }, [repository.id]);

  useEffect(() => {
    void refresh();
    const tokens = [generation, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    setFiles([]); setDiff(null);
    if (!selected) return undefined;
    window.twig.stashFiles(repository.id, selected)
      .then(list => { if (alive) setFiles(list); })
      .catch(failure => { if (alive) setError(failure.message || 'Could not read this stash.'); });
    return () => { alive = false; };
  }, [selected, repository.id]);

  async function openDiff(file) {
    const request = ++diffRequest.current;
    setDiff({ path: file.path, loading: true });
    try {
      const result = await window.twig.stashDiff(repository.id, selected, file.path, file.untracked);
      if (request === diffRequest.current) setDiff({ path: file.path, ...result, loading: false });
    } catch {
      if (request === diffRequest.current) setDiff({ path: file.path, error: 'Could not read this diff.', loading: false });
    }
  }

  async function act(entry, action, name = null) {
    const label = { apply: 'applied', pop: 'popped', drop: 'dropped', branch: 'restored on a new branch' }[action];
    await onPerform(() => window.twig.stashAction(repository.id, action, entry.index, entry.oid, name),
      `${entry.ref} ${label}.`);
    await refresh();
  }

  function drop(entry) {
    onDialog({
      type: 'confirm', title: `Drop ${entry.ref}`, command: ['stash', 'drop', entry.ref],
      consequence: 'The stashed changes are deleted. Git keeps the stash commit reachable through the reflog for a while, but nothing in this window can bring it back.',
      confirmLabel: 'Drop the stash', onConfirm: () => void act(entry, 'drop')
    });
  }

  function toBranch(entry) {
    onDialog({
      type: 'name', title: `Restore ${entry.ref} on a new branch`, label: 'Branch name', placeholder: 'fix/stashed-work',
      confirmLabel: 'Create branch from stash',
      onConfirm: ({ name }) => void act(entry, 'branch', name)
    });
  }

  const current = stashes.find(item => item.oid === selected) || null;
  const reason = busy ? 'Git is working' : undefined;
  return <section className="stash-screen" aria-label="Stashes">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div><Archive aria-hidden="true" /><strong>Stashes</strong><span className="count">{stashes.length}</span></div>
      <Button icon={RefreshCw} reason={reason} onClick={() => void refresh()}>Refresh</Button>
    </header>
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></p>}
    {loading && <div className="loading-shell" aria-label="Loading stashes">{Array.from({ length: 4 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
    {!loading && stashes.length === 0 && !error && <p className="empty-inline">No stashes. Stash from the toolbar to put unfinished work aside.</p>}
    <div className="stash-body">
      {stashes.length > 0 && <ul className="stash-list" aria-label="Stash list">
        {stashes.map(entry => <li key={entry.oid}>
          <button type="button" className={entry.oid === selected ? 'selected' : ''} onClick={() => setSelected(entry.oid)}>
            <code>{entry.ref}</code>
            <span>{entry.message}</span>
            <small>{entry.branch ? `on ${entry.branch} · ` : ''}{when(entry.date)}</small>
          </button>
        </li>)}
      </ul>}
      {current && <div className="stash-detail">
        <div className="stash-actions">
          <Button reason={reason} onClick={() => void act(current, 'apply')}>Apply</Button>
          <Button className="primary" reason={reason} onClick={() => void act(current, 'pop')}>Pop</Button>
          <Button icon={GitBranch} reason={reason} onClick={() => toBranch(current)}>Branch…</Button>
          <Button icon={Trash2} className="danger" reason={reason} onClick={() => drop(current)}>Drop</Button>
        </div>
        <ul className="stash-files" aria-label={`Files in ${current.ref}`}>
          {files.length === 0 && <li className="empty-inline">This stash changes no tracked file.</li>}
          {files.map(file => <li key={`${file.path}:${file.untracked}`}>
            <button type="button" className={diff?.path === file.path ? 'selected' : ''} onClick={() => void openDiff(file)}>
              <FileStatus status={file.status} />
              <span>{file.path}</span>
              {file.untracked && <small><FilePlus2 aria-hidden="true" />untracked</small>}
            </button>
          </li>)}
        </ul>
        {diff && <div className="diff-view" aria-label={`Diff of ${diff.path}`}>
          <header className="panel-heading"><code>{diff.path}</code>
            <Button onClick={() => { diffRequest.current++; setDiff(null); }}>Close diff</Button></header>
          {diff.loading ? <div className="loading-shell"><div className="skeleton" /></div>
            : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p>
              : diff.binary ? <p className="empty-inline">Binary file. A text diff is unavailable.</p>
                : <DiffLines patch={diff.patch} path={diff.path} label={`Diff of ${diff.path}`} />}
        </div>}
      </div>}
    </div>
  </section>;
}
