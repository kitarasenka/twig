import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import DiffLines, { FileViewSwitch } from '../diff/DiffLines.jsx';
import FileView from '../diff/FileView.jsx';
import { formatDateTime, t, tn } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';
import { revealInvisible } from '../../ui/invisible.js';

/**
 * The right-hand panel for the blame screen: the commit a selected line (or
 * block) is attributed to, plus that file's diff in the commit — or the whole
 * file as that commit left it, or as it was just before. Self-fetching and
 * request-guarded so a fast click-through never shows a stale commit.
 */
export default function BlameDetail({ repositoryId, sel, view, onJump, onConsole }) {
  const [commit, setCommit] = useState(null);
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const oid = sel?.oid;
  const path = sel?.path;
  const source = useMemo(() => (oid ? { kind: 'commit', oid, base: null } : null), [oid]);

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
    }).catch(() => { if (id === request.current) { setError(t('Could not read this commit.')); setDiff(null); } });
  }, [repositoryId, oid, path]);

  if (!sel) return <aside className="commit-detail blame-detail" aria-label={t('Blame details')}><p className="empty-inline">{t('Select a line to see the commit that last changed it.')}</p></aside>;

  return <aside className="commit-detail blame-detail" aria-label={t('Blame details')}>
    <header className="panel-heading">
      <span>{sel.mode === 'reverse' ? t('LINE') : t('COMMIT')} <code>{sel.oid.slice(0, 8)}</code></span>
      <Button icon={GitBranch} onClick={() => onJump(sel.oid)}>{t('Go to commit')}</Button>
    </header>
    <div className="detail-content">
      {sel.mode === 'reverse' && <p className={`blame-reverse-tag ${sel.presentAtEnd ? 'at-end' : 'last-seen'}`}>
        {sel.presentAtEnd ? t('This line is present at End.') : t`Last present in ${sel.oid.slice(0, 8)}. Git does not name the commit that removed it.`}</p>}
      {sel.multiple > 1 && <p className="muted">{tn(sel.multiple, '{n} commit in the selected block; showing the active line’s commit.', '{n} commits in the selected block; showing the active line’s commit.')}</p>}
      {error && <p role="alert">{error} <button onClick={onConsole}>{t('Show output')}</button></p>}
      {commit && <>
        <h2>{revealInvisible(commit.subject) || t('(no subject)')}</h2>
        {commit.body && <pre className="commit-body">{revealInvisible(commit.body)}</pre>}
        <div className="author-card"><span className="avatar">{commit.author.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div>
          <strong>{revealInvisible(commit.author.name)}</strong><span>{revealInvisible(commit.author.email)}</span></div></div>
        <dl className="metadata">
          <dt>{t('Authored')}</dt><dd>{formatDateTime(commit.author.date, { dateStyle: 'short', timeStyle: 'medium' })}</dd>
          <dt>{t('Line')}</dt><dd>{tx('{line} in {path}', { line: sel.line, path: <code>{sel.path}</code> })}</dd>
          <dt>{t('Parents')}</dt><dd>{commit.parents.length ? commit.parents.map(oid => <button key={oid} className="text-button" onClick={() => onJump(oid)}>{oid.slice(0, 8)}</button>) : t('Root commit')}</dd>
        </dl>
        <div className="files-heading"><strong>{view.full ? sel.path.split('/').at(-1) : t`Diff of ${sel.path.split('/').at(-1)}`}</strong>
          {!diff?.binary && <FileViewSwitch full={view.full} onFull={view.setFull} />}</div>
        {diff?.loading ? <div className="skeleton" aria-label={t('Loading diff')} />
          : diff?.binary ? <p className="muted">{t('Binary file — no text diff.')}</p>
          : view.full ? <FileView repositoryId={repositoryId} file={path} source={source} patch={diff?.patch || ''}
            withChanges={view.withChanges} onWithChanges={view.setWithChanges} onConsole={onConsole} />
          : diff?.patch ? <DiffLines patch={diff.patch} path={path} />
          : <p className="muted">{t`This commit did not change ${sel.path.split('/').at(-1)} against its first parent.`}</p>}
      </>}
    </div>
  </aside>;
}
