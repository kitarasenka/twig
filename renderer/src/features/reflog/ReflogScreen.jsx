import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Copy, CornerUpLeft, GitBranchPlus, History, LocateFixed, RefreshCw } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import ScreenTitle from '../../ui/ScreenTitle.jsx';
import DiffLines from '../diff/DiffLines.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import ImageDiff from '../diff/ImageDiff.jsx';
import DiscardedChanges from './DiscardedChanges.jsx';
import { imageType } from '../../../../main/git/image-types.js';
import { failureText, formatDateTime, t } from '../../i18n/i18n.js';
import { actionLabel, moveBranchDialog, moveReason, relativeTime, shortenIds, suggestBranchName } from './reflog-view.js';

/**
 * The reflog: where HEAD and each branch have been, newest first, with what
 * it takes to get back — "move the branch here" and "create a branch from
 * this commit". It reaches what Undo cannot: a reset or rebase run in a
 * terminal, a deleted branch, anything after the Undo chain ended.
 *
 * An entry whose commit no branch, tag or remote reaches is marked "On no
 * branch" in words, not only in colour: those are the ones Git forgets when
 * the reflog expires. Its contents are shown here, because the history graph
 * cannot show a commit nothing points at.
 *
 * Its second view is the same promise for files: what Discard threw away,
 * which no reflog holds.
 */
export default function ReflogScreen({ repository, refs, headBranch, operation, busy, onBack, onPerform, onDialog, onJump, onConsole }) {
  const [branch, setBranch] = useState(null);
  const [page, setPage] = useState({ entries: [], nextSkip: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [onlyLost, setOnlyLost] = useState(false);
  const [selected, setSelected] = useState(null);
  const [commit, setCommit] = useState(null);
  const [diff, setDiff] = useState(null);
  const [view, setView] = useState('moves');
  const [discardsKey, setDiscardsKey] = useState(0);
  const generation = useRef(0);
  const diffRequest = useRef(0);
  const list = useRef(null);

  const locals = useMemo(() => refs.filter(ref => ref.type === 'local'), [refs]);
  const tips = useMemo(() => new Map(locals.map(ref => [ref.name, ref.target])), [locals]);

  const load = useCallback(async (skip = 0) => {
    const epoch = ++generation.current;
    setLoading(true);
    try {
      const result = await window.twig.getReflog(repository.id, branch, skip);
      if (epoch !== generation.current) return;
      setError('');
      setPage(current => ({ entries: skip ? [...current.entries, ...result.entries] : result.entries, nextSkip: result.nextSkip }));
      if (!skip) setSelected(current => result.entries.some(entry => entry.index === current) ? current : result.entries[0]?.index ?? null);
    } catch (failure) {
      if (epoch === generation.current) setError(failureText(failure, t('Could not read the reflog.')));
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }, [repository.id, branch]);

  useEffect(() => {
    void load(0);
    const tokens = [generation, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [load]);

  // A branch that disappears (deleted, renamed) takes its reflog with it.
  useEffect(() => { if (branch !== null && !tips.has(branch)) setBranch(null); }, [branch, tips]);

  const entries = page.entries;
  const visible = onlyLost ? entries.filter(entry => entry.lost) : entries;
  const position = entries.findIndex(entry => entry.index === selected);
  const entry = position >= 0 ? entries[position] : null;
  const entryOid = entry?.oid || null;

  useEffect(() => {
    let alive = true;
    diffRequest.current++;
    setCommit(null); setDiff(null);
    if (!entryOid) return undefined;
    window.twig.getCommit(repository.id, entryOid)
      .then(value => { if (alive) setCommit(value); })
      .catch(() => { if (alive) setCommit({ error: t('Could not read this commit.') }); });
    return () => { alive = false; };
  }, [entryOid, repository.id]);

  async function openDiff(file) {
    const request = ++diffRequest.current;
    setDiff({ path: file.path, loading: true });
    try {
      const result = await window.twig.getFileDiff(repository.id, entry.oid, file.path);
      if (request === diffRequest.current) setDiff({ path: file.path, oid: entry.oid, ...result, loading: false });
    } catch {
      if (request === diffRequest.current) setDiff({ path: file.path, error: t('Could not read this diff.'), loading: false });
    }
  }

  async function act(run, success) {
    await onPerform(run, success);
    await load(0);
  }

  // "Move here" moves the branch this reflog belongs to; in HEAD's reflog,
  // that is the checked-out branch.
  const target = branch ?? headBranch ?? null;
  const tip = target ? tips.get(target) || null : null;
  const reason = busy ? t('Git is working') : undefined;

  function createBranch() {
    const short = entry.oid.slice(0, 7);
    onDialog({
      type: 'name', title: t`Create a branch at ${short}`, label: t('Branch name'), placeholder: `recovered-${short}`,
      initialValue: suggestBranchName(entries, position, locals.map(ref => ref.name)), suggested: true,
      confirmLabel: t('Create branch'), extra: t('Check it out straight away'),
      onConfirm: ({ name, checked }) => void act(() => window.twig.createBranch(repository.id, name, entry.oid, checked), t`Branch ${name} now holds ${short}.`)
    });
  }

  function moveHere() {
    const current = target === headBranch;
    onDialog({
      type: 'confirm', ...moveBranchDialog({ branch: target, oid: entry.oid, expected: tip, current }),
      onConfirm: () => void act(() => window.twig.moveBranchTo(repository.id, target, entry.oid, tip),
        t`${target} moved to ${entry.oid.slice(0, 7)}. Undo moves it back.`)
    });
  }

  function keyDown(event) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !visible.length) return;
    event.preventDefault();
    const at = visible.findIndex(item => item.index === selected);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1
      : Math.min(visible.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
    setSelected(visible[next].index);
    list.current?.querySelectorAll('button')[next]?.focus();
  }

  const name = branch ?? 'HEAD';
  const lostCount = entries.filter(item => item.lost).length;
  return <section className="reflog-screen" aria-label={t('Reflog')}>
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button>
      <ScreenTitle icon={History} title={t('Reflog')}><span className="count">{entries.length}{page.nextSkip !== null ? '+' : ''}</span></ScreenTitle>
      <Button icon={RefreshCw} reason={loading ? t('Reading the reflog') : undefined} onClick={() => { if (view === 'moves') void load(0); else setDiscardsKey(key => key + 1); }}>{t('Refresh')}</Button>
    </header>
    <div className="refs-toolbar reflog-toolbar">
      <div className="segmented" role="group" aria-label={t('What this screen shows')}>
        <button aria-pressed={view === 'moves'} onClick={() => setView('moves')}>{t('Moves')}</button>
        <button aria-pressed={view === 'discards'} onClick={() => setView('discards')}>{t('Discarded changes')}</button>
      </div>
      {view === 'moves' && <><label className="refs-remote">{t('Where')}
        <select aria-label={t('Reflog of')} value={branch ?? ''} onChange={event => { setBranch(event.target.value || null); setSelected(null); }}>
          <option value="">{t('HEAD has been')}</option>
          {locals.map(ref => <option key={ref.name} value={ref.name}>{t`${ref.name} has been`}</option>)}
        </select></label>
      <label className="checkbox-row"><input type="checkbox" checked={onlyLost} onChange={event => setOnlyLost(event.target.checked)} />
        {t('Only commits on no branch')} <span className="count">{lostCount}</span></label></>}
    </div>
    {view === 'discards' && <DiscardedChanges repository={repository} busy={busy} refreshKey={discardsKey} onPerform={onPerform} onDialog={onDialog} onConsole={onConsole} />}
    {view === 'moves' && <><p className="reflog-intro muted">{t`Every move of ${name}, newest first — including ones made outside 🌱 Twig. Git keeps entries for 90 days, and commits on no branch for 30, so a reset, rebase, amend or deleted branch can be brought back from here.`}</p>
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>{t('Show output')}</button></p>}
    <div className="reflog-body">
      <div className="reflog-list" ref={list} role="list" aria-label={t`Reflog of ${name}`} onKeyDown={keyDown}>
        {loading && !entries.length && <div className="loading-shell" aria-label={t('Loading the reflog')}>{Array.from({ length: 6 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
        {!loading && !error && !entries.length && <p className="empty-inline">{branch
          ? t`${branch} has no reflog. Git keeps one for branches created or moved in this clone while core.logAllRefUpdates is on.`
          : t('HEAD has no reflog yet.')}</p>}
        {!loading && entries.length > 0 && !visible.length && <p className="empty-inline">{t('Every commit loaded here is still on a branch, tag or remote. Nothing on this page is at risk.')}</p>}
        {visible.map(item => <div role="listitem" key={item.index}>
          <button type="button" className={item.index === selected ? 'selected' : ''} aria-pressed={item.index === selected} onClick={() => setSelected(item.index)}>
            <span className="reflog-line">
              <code>{item.selector}</code>
              <strong className="reflog-action">{actionLabel(item.action)}</strong>
              <span className="reflog-detail" title={item.detail}>{shortenIds(item.detail)}</span>
              <small title={item.movedAt ? formatDateTime(item.movedAt * 1000) : undefined}>{relativeTime(item.movedAt)}</small>
            </span>
            <span className="reflog-line reflog-commit">
              <code>{item.oid.slice(0, 7)}</code>
              <span>{item.subject}</span>
              {item.lost && <span className="reflog-lost"><AlertTriangle aria-hidden="true" />{t('On no branch')}</span>}
            </span>
          </button>
        </div>)}
        {page.nextSkip !== null && <Button reason={loading ? t('Loading…') : undefined} onClick={() => void load(page.nextSkip)}>{t('Load older entries')}</Button>}
      </div>
      {entry && <div className="reflog-detail-pane" aria-label={t`${entry.selector} details`}>
        <div className="stash-actions">
          <Button icon={GitBranchPlus} className="primary" reason={reason} onClick={createBranch}>{t('Create branch here…')}</Button>
          <Button icon={CornerUpLeft} reason={moveReason({ branch: target, tip, oid: entry.oid, operation: operation.kind, busy })} onClick={moveHere}>
            {target ? t`Move ${target} here…` : t('Move branch here…')}</Button>
          <Button icon={LocateFixed} reason={entry.lost ? t('This commit is on no branch, so the history graph does not show it') : undefined}
            onClick={() => onJump(entry.oid)}>{t('Show in history')}</Button>
          <Button icon={Copy} onClick={() => void window.twig.copyText(entry.oid)}>{t('Copy SHA')}</Button>
        </div>
        <div className="reflog-summary">
          <p><code>{entry.selector}</code> · {entry.reflogSubject || t('no message')}{entry.mover ? ` · ${t`by ${entry.mover}`}` : ''}</p>
          {entry.lost && <p className="reflog-lost-note"><AlertTriangle aria-hidden="true" /><span>{t('No branch, tag or remote holds this commit. Git deletes it once this entry expires; create a branch to keep it.')}</span></p>}
          {commit?.error ? <p role="alert" className="empty-inline">{commit.error}</p>
            : commit ? <>
              <h3>{commit.subject}</h3>
              {commit.body && <pre className="reflog-body-text">{commit.body}</pre>}
              <p className="muted"><code>{commit.oid}</code> · {commit.author.name} · {formatDateTime(commit.author.date)}</p>
            </> : <div className="loading-shell"><div className="skeleton" /></div>}
        </div>
        {commit?.files && <ul className="stash-files" aria-label={t`Files changed in ${entry.oid.slice(0, 7)}`}>
          {commit.files.length === 0 && <li className="empty-inline">{t('This commit changes no file.')}</li>}
          {commit.files.map(file => <li key={file.path}>
            <button type="button" className={diff?.path === file.path ? 'selected' : ''} onClick={() => void openDiff(file)}>
              <FileStatus status={file.status} /><span>{file.path}</span>
            </button>
          </li>)}
        </ul>}
        {diff && <div className="diff-view" aria-label={t`Diff of ${diff.path}`}>
          <header className="panel-heading"><code>{diff.path}</code>
            <Button onClick={() => { diffRequest.current++; setDiff(null); }}>{t('Close diff')}</Button></header>
          {diff.loading ? <div className="loading-shell"><div className="skeleton" /></div>
            : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p>
              : diff.binary && imageType(diff.path) ? <ImageDiff repositoryId={repository.id} file={diff.path} source={{ kind: 'commit', oid: diff.oid, base: null }} />
              : diff.binary ? <p className="empty-inline">{t('Binary file. A text diff is unavailable.')}</p>
                : <DiffLines patch={diff.patch} path={diff.path} label={t`Diff of ${diff.path}`} />}
        </div>}
      </div>}
    </div></>}
  </section>;
}
