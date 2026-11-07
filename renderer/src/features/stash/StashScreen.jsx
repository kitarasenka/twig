import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FilePlus2, GitBranch, RefreshCw, Trash2 } from 'lucide-react';
import { StashBox, StashPop } from '../../ui/stash-icons.js';
import Button from '../../ui/Button.jsx';
import ScreenTitle from '../../ui/ScreenTitle.jsx';
import DiffLines from '../diff/DiffLines.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import ImageDiff from '../diff/ImageDiff.jsx';
import { imageType } from '../../../../main/git/image-types.js';
import { failureText, formatDateTime, t } from '../../i18n/i18n.js';

function when(value) {
  return formatDateTime(value);
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
      if (epoch === generation.current) setError(failureText(failure, t('Could not read the stash list.')));
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
      .catch(failure => { if (alive) setError(failureText(failure, t('Could not read this stash.'))); });
    return () => { alive = false; };
  }, [selected, repository.id]);

  async function openDiff(file) {
    const request = ++diffRequest.current;
    setDiff({ path: file.path, loading: true });
    try {
      const result = await window.twig.stashDiff(repository.id, selected, file.path, file.untracked);
      if (request === diffRequest.current) setDiff({ path: file.path, stash: selected, untracked: file.untracked, ...result, loading: false });
    } catch {
      if (request === diffRequest.current) setDiff({ path: file.path, error: t('Could not read this diff.'), loading: false });
    }
  }

  async function act(entry, action, name = null) {
    const done = { apply: t`${entry.ref} applied.`, pop: t`${entry.ref} popped.`, drop: t`${entry.ref} dropped.`,
      branch: t`${entry.ref} restored on a new branch.` }[action];
    await onPerform(() => window.twig.stashAction(repository.id, action, entry.index, entry.oid, name), done);
    await refresh();
  }

  function drop(entry) {
    onDialog({
      type: 'confirm', title: t`Drop ${entry.ref}`, command: ['stash', 'drop', entry.ref],
      consequence: t('The stashed changes are deleted. Git keeps the stash commit reachable through the reflog for a while, but nothing in this window can bring it back.'),
      confirmLabel: t('Drop the stash'), onConfirm: () => void act(entry, 'drop')
    });
  }

  function toBranch(entry) {
    onDialog({
      type: 'name', title: t`Restore ${entry.ref} on a new branch`, label: t('Branch name'), placeholder: 'fix/stashed-work',
      confirmLabel: t('Create branch from stash'),
      onConfirm: ({ name }) => void act(entry, 'branch', name)
    });
  }

  const current = stashes.find(item => item.oid === selected) || null;
  const reason = busy ? t('Git is working') : undefined;
  return <section className="stash-screen" aria-label={t('Stashes')}>
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button>
      <ScreenTitle icon={StashBox} title={t('Stashes')}><span className="count">{stashes.length}</span></ScreenTitle>
      <Button icon={RefreshCw} reason={reason} onClick={() => void refresh()}>{t('Refresh')}</Button>
    </header>
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>{t('Show output')}</button></p>}
    {loading && <div className="loading-shell" aria-label={t('Loading stashes')}>{Array.from({ length: 4 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
    {!loading && stashes.length === 0 && !error && <p className="empty-inline">{t('No stashes. Stash from the toolbar to put unfinished work aside.')}</p>}
    <div className="stash-body">
      {stashes.length > 0 && <ul className="stash-list" aria-label={t('Stash list')}>
        {stashes.map(entry => <li key={entry.oid}>
          <button type="button" className={entry.oid === selected ? 'selected' : ''} onClick={() => setSelected(entry.oid)}>
            <code>{entry.ref}</code>
            <span>{entry.message}</span>
            <small>{entry.branch ? `${t`on ${entry.branch}`} · ` : ''}{when(entry.date)}</small>
          </button>
        </li>)}
      </ul>}
      {current && <div className="stash-detail">
        <div className="stash-actions">
          <Button reason={reason} onClick={() => void act(current, 'apply')}>{t('Apply')}</Button>
          <Button className="primary" icon={StashPop} reason={reason} onClick={() => void act(current, 'pop')}>{t('Pop')}</Button>
          <Button icon={GitBranch} reason={reason} onClick={() => toBranch(current)}>{t('Branch…')}</Button>
          <Button icon={Trash2} className="danger quiet" reason={reason} onClick={() => drop(current)}>{t('Drop')}</Button>
        </div>
        <ul className="stash-files" aria-label={t`Files in ${current.ref}`}>
          {files.length === 0 && <li className="empty-inline">{t('This stash changes no tracked file.')}</li>}
          {files.map(file => <li key={`${file.path}:${file.untracked}`}>
            <button type="button" className={diff?.path === file.path ? 'selected' : ''} onClick={() => void openDiff(file)}>
              <FileStatus status={file.status} />
              <span>{file.path}</span>
              {file.untracked && <small><FilePlus2 aria-hidden="true" />{t('untracked')}</small>}
            </button>
          </li>)}
        </ul>
        {diff && <div className="diff-view" aria-label={t`Diff of ${diff.path}`}>
          <header className="panel-heading"><code>{diff.path}</code>
            <Button onClick={() => { diffRequest.current++; setDiff(null); }}>{t('Close diff')}</Button></header>
          {diff.loading ? <div className="loading-shell"><div className="skeleton" /></div>
            : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p>
              : diff.binary && imageType(diff.path) ? <ImageDiff repositoryId={repository.id} file={diff.path} source={{ kind: 'stash', oid: diff.stash, untracked: diff.untracked }} />
              : diff.binary ? <p className="empty-inline">{t('Binary file. A text diff is unavailable.')}</p>
                : <DiffLines patch={diff.patch} path={diff.path} label={t`Diff of ${diff.path}`} />}
        </div>}
      </div>}
    </div>
  </section>;
}
