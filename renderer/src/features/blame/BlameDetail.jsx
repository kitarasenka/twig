import { useEffect, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import Button from '../../ui/Button.jsx';

/**
 * The right-hand panel for the blame screen: the commit a selected line (or
 * block) is attributed to, plus that file's diff in the commit. Self-fetching
 * and request-guarded so a fast click-through never shows a stale commit.
 */
export default function BlameDetail({ repositoryId, sel, onJump, onConsole }) {
  const [commit, setCommit] = useState(null);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const oid = sel?.oid;
  const path = sel?.path;

  useEffect(() => {
    if (!oid) { setCommit(null); setDiff(null); setError(''); return; }
    const id = ++request.current;
    setError(''); setCommit(null); setDiff({ loading: true });
    Promise.all([
      window.twig.getCommit(repositoryId, oid),
      window.twig.getFileDiff(repositoryId, oid, path, null).catch(() => null)
    ]).then(([info, patch]) => {
      if (id !== request.current) return;
      setCommit(info);
      setDiff(patch ? { ...patch, loading: false } : { patch: '', loading: false });
    }).catch(() => { if (id === request.current) { setError('Could not read this commit.'); setDiff(null); } });
  }, [repositoryId, oid, path]);

  if (!sel) return <aside className="commit-detail blame-detail" aria-label="Blame details"><p className="empty-inline">Select a line to see the commit that last changed it.</p></aside>;

  return <aside className="commit-detail blame-detail" aria-label="Blame details">
    <header className="panel-heading">
      <span>{sel.mode === 'reverse' ? 'LINE' : 'COMMIT'} <code>{sel.oid.slice(0, 8)}</code></span>
      <Button icon={GitBranch} onClick={() => onJump(sel.oid)}>Go to commit</Button>
    </header>
    <div className="detail-content">
      {sel.mode === 'reverse' && <p className={`blame-reverse-tag ${sel.presentAtEnd ? 'at-end' : 'last-seen'}`}>
        {sel.presentAtEnd ? 'This line is present at End.' : `Last present in ${sel.oid.slice(0, 8)}. Git does not name the commit that removed it.`}</p>}
      {sel.multiple > 1 && <p className="muted">{sel.multiple} commits in the selected block; showing the active line’s commit.</p>}
      {error && <p role="alert">{error} <button onClick={onConsole}>Show output</button></p>}
      {commit && <>
        <h2>{commit.subject || '(no subject)'}</h2>
        {commit.body && <pre className="commit-body">{commit.body}</pre>}
        <div className="author-card"><span className="avatar">{commit.author.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div>
          <strong>{commit.author.name}</strong><span>{commit.author.email}</span></div></div>
        <dl className="metadata">
          <dt>Authored</dt><dd>{new Date(commit.author.date).toLocaleString('en-GB')}</dd>
          <dt>Line</dt><dd>{sel.line} in <code>{sel.path}</code></dd>
          <dt>Parents</dt><dd>{commit.parents.length ? commit.parents.map(oid => <button key={oid} className="text-button" onClick={() => onJump(oid)}>{oid.slice(0, 8)}</button>) : 'Root commit'}</dd>
        </dl>
        <div className="files-heading"><strong>Diff of {sel.path.split('/').at(-1)}</strong></div>
        {diff?.loading ? <div className="skeleton" aria-label="Loading diff" />
          : diff?.binary ? <p className="muted">Binary file — no text diff.</p>
          : diff?.patch ? <div className="diff-lines" tabIndex={0} aria-label="Diff lines">
            {diff.patch.split('\n').map((row, index) => <div key={index} className={row.startsWith('+') ? 'diff-added' : row.startsWith('-') ? 'diff-deleted' : row.startsWith('@@') ? 'diff-hunk' : ''}><span>{row || ' '}</span></div>)}
          </div>
          : <p className="muted">This commit did not change {sel.path.split('/').at(-1)} against its first parent.</p>}
      </>}
    </div>
  </aside>;
}
