import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, FilePenLine, FilePlus2, GitBranch, Minus, Plus, Trash2, Undo2, Users, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import ScreenTitle from '../../ui/ScreenTitle.jsx';
import Menu from '../../ui/Menu.jsx';
import { ignoreMenuItems } from '../diff/file-menu.js';
import FileStatus from '../diff/FileStatus.jsx';
import FileList from '../diff/FileList.jsx';
import { FileListControls } from '../diff/FileTree.jsx';
import { ALL_TYPES, baseName, matchesFile, readFileView, writeFileView } from '../diff/file-filter.js';
import StageDiff from './StageDiff.jsx';
import CoAuthors from './CoAuthors.jsx';
import { BUMP_CHOICES, bumpLabel } from '../automations/version-bump.js';
import { ConfirmDialog, NameDialog } from '../ops/dialogs.jsx';
import { discardDialog } from './discard-dialog.js';
import { readCommitDraft, writeCommitDraft } from './commit-draft.js';
import { isMenuKey } from '../../app/shortcuts.js';
import { finishFirst } from '../../../../main/git/operation-words.js';
import { failureText, t, tn, tr } from '../../i18n/i18n.js';
import { failureNote } from '../../app/failure-note.js';

const EMPTY = { staged: [], unstaged: [], untracked: [], branch: null };
function draftStorage() { try { return localStorage; } catch { return null; } }

/** Right-click, Shift+F10 or the Menu key on a row, opening at the pointer or under the row. */
function menuProps(onMenu) {
  if (!onMenu) return {};
  return {
    onContextMenu: event => { event.preventDefault(); onMenu(event.clientX, event.clientY); },
    onKeyDown: event => {
      if (!isMenuKey(event)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onMenu(box.left + 24, box.bottom);
    }
  };
}

function FileRow({ entry, name = entry.path, active, onOpen, onPrimary, primaryIcon: Icon, primaryLabel, primaryReason, busy, discard = null, onMenu = null }) {
  return <div className={`worktree-file ${active ? 'selected' : ''}`}>
    <button className="worktree-open" onClick={onOpen} title={onMenu ? `${entry.path} · ${t('Right-click to ignore it')}` : entry.path} {...menuProps(onMenu)}>
      <FileStatus status={entry.status} /><span>{name}</span>
    </button>
    {discard && <Button className="discard" icon={discard.icon} aria-label={discard.label} reason={discard.reason} onClick={discard.run} />}
    <Button icon={Icon} aria-label={primaryLabel} reason={primaryReason || (busy ? t('Git is working') : undefined)} onClick={onPrimary} />
  </div>;
}

export default function WorktreeScreen({ repository, operation = null, runAutomation = null, refreshKey = 0, onConsole, onChanged, onBack, onResolveConflict = null }) {
  // What was being written here last time: leaving this screen, a redraw of the
  // window or a restart cost nothing, and only a finished commit clears it.
  const [draft] = useState(() => readCommitDraft(draftStorage(), repository.id));
  const [tree, setTree] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [diff, setDiff] = useState(null);
  const [selection, setSelection] = useState({});
  const [message, setMessage] = useState(draft.message);
  const [notice, setNotice] = useState('');
  const [amend, setAmend] = useState(Boolean(draft.amendOid));
  // Path or tree, a text filter and a file type: the same controls as the
  // panel. With a filter on, the bulk buttons move only the files shown.
  const [view, setView] = useState(readFileView);
  const [filter, setFilter] = useState('');
  const [extension, setExtension] = useState(ALL_TYPES);
  const filtered = Boolean(filter.trim()) || extension !== ALL_TYPES;
  const typed = useDeferredValue(filter);
  const shown = useMemo(() => {
    const keep = list => list.filter(entry => matchesFile(entry.path, typed, extension));
    return { staged: keep(tree.staged), unstaged: keep(tree.unstaged), untracked: keep(tree.untracked) };
  }, [tree, typed, extension]);
  const allPaths = useMemo(() => [...tree.staged, ...tree.unstaged, ...tree.untracked].map(entry => entry.path), [tree]);
  // The "Bump version" automation: what the staged files would bump, and the choice for this commit.
  const [bumpPlan, setBumpPlan] = useState(null);
  const [bumpChoice, setBumpChoice] = useState(draft.bump);
  const stagedKey = tree.staged.map(entry => entry.path).join('\0');
  useEffect(() => {
    let alive = true;
    if (!stagedKey) { setBumpPlan(null); return () => { alive = false; }; }
    window.twig.getBumpPlan(repository.id).then(plan => {
      if (!alive) return;
      setBumpPlan(plan);
      setBumpChoice(current => (plan ? current ?? plan.choice : null));
    }).catch(() => { if (alive) setBumpPlan(null); });
    return () => { alive = false; };
  }, [repository.id, stagedKey]);
  const [coAuthors, setCoAuthors] = useState(draft.coAuthors);
  // The picker costs a row of height, so it opens on request; chosen people keep it open.
  const [coAuthorsOpen, setCoAuthorsOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [rowMenu, setRowMenu] = useState(null);
  const amendBase = useRef(draft.amendOid ? { oid: draft.amendOid, message: draft.amendMessage ?? '' } : null);
  const generation = useRef(0);
  const diffRequest = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await window.twig.readWorktree(repository.id);
      if (epoch === generation.current) { setTree(next); setError(''); }
      return next;
    } catch (failure) {
      if (epoch === generation.current) setError(failureText(failure, t('Could not read the working tree.')));
      return null;
    }
  }, [repository.id]);

  useEffect(() => {
    void refresh();
    const tokens = [generation, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [refresh, refreshKey]);

  const openDiff = useCallback(async (path, staged) => {
    const request = ++diffRequest.current;
    setOpen({ path, staged });
    setDiff(null);
    setSelection({});
    try {
      const next = await window.twig.getWorktreeDiff(repository.id, path, staged);
      if (request === diffRequest.current) setDiff(next);
    } catch (failure) {
      if (request === diffRequest.current) { setDiff(null); setError(failureText(failure, t('Could not read this diff.'))); }
    }
  }, [repository.id]);

  /**
   * An untracked file is read as it is, with nothing recorded in the index:
   * `git add -N` here turned a look at a file into a change of the staging list
   * and made `git stash` refuse the tree. Picking lines is what tracks it.
   */
  const openUntracked = useCallback(async path => {
    const request = ++diffRequest.current;
    setOpen({ path, staged: false, untracked: true });
    setDiff(null);
    setSelection({});
    try {
      const next = await window.twig.getUntrackedDiff(repository.id, path);
      if (request === diffRequest.current) setDiff(next);
    } catch (failure) {
      if (request === diffRequest.current) { setDiff(null); setError(failureText(failure, t('Could not read this diff.'))); }
    }
  }, [repository.id]);

  // The commit an amend was started on is gone: what was written for it stays
  // only if it was more than the old message.
  useEffect(() => {
    const oid = tree.branch?.oid;
    if (!oid || !amendBase.current || amendBase.current.oid === oid) return;
    setMessage(current => (current === amendBase.current?.message ? '' : current));
    amendBase.current = null;
    setAmend(false);
  }, [tree.branch?.oid]);
  useEffect(() => {
    const base = amend ? amendBase.current : null;
    writeCommitDraft(draftStorage(), repository.id, { message, coAuthors, bump: bumpChoice, amendOid: base?.oid ?? null, amendMessage: base?.message ?? null });
  }, [repository.id, message, coAuthors, bumpChoice, amend]);

  // `history`: the action made a commit. Everything else here changes only the
  // index or the files, which no commit or ref shows, so the graph behind this
  // screen is not re-read for it (one staged line used to run some forty git
  // processes, most of them to read the same history again).
  async function guard(action, after, reopen = true, history = false) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      const next = await refresh();
      if (reopen && open) {
        if (open.untracked && next?.untracked.some(entry => entry.path === open.path)) await openUntracked(open.path);
        else await openDiff(open.path, open.staged);
      }
      onChanged?.({ history });
      if (after) setNotice(after);
      setError('');
    } catch (failure) {
      // What Git said, in words where the case is known: a lock, who you are, a hook, a signature.
      setError(failureNote(failure, t('Git refused this operation.'), { repositoryId: repository.id }));
    } finally { setBusy(false); }
  }

  const unborn = Boolean(tree.branch?.unborn);
  // A commit made here belongs to no branch: said before it is made, with the way to give it one.
  const detached = Boolean(tree.branch?.detached && tree.branch?.oid);
  const [naming, setNaming] = useState(false);
  const conflicts = tree.unstaged.filter(entry => entry.status === 'U').length;
  /**
   * A bulk action is refused where the per-file buttons still work: `git add`
   * on a conflicted file would mark it resolved unseen, and unstaging
   * everything is a mixed reset, which deletes the marker of a merge, rebase,
   * cherry-pick or revert and so cancels it. Main refuses these too; the
   * disabled button says why before the click.
   */
  const bulkReason = busy ? t('Git is working')
    : conflicts ? tn(conflicts, 'Resolve the conflict first', 'Resolve the conflicts first') : undefined;
  const unstageAllReason = bulkReason
    || (operation && operation.kind !== 'none' ? tr(finishFirst(operation.kind)) : undefined);
  const bulk = (run, describe) => guard(async () => setNotice(describe(await run())));
  /** What a bulk button acts on: the whole section, or with a filter on, the files shown (`only`). */
  const only = key => (filtered ? shown[key].map(entry => entry.path) : null);
  const bulkLabel = key => (key === 'staged'
    ? (filtered ? tn(shown[key].length, 'Unstage {n} shown', 'Unstage {n} shown') : t('Unstage all'))
    : (filtered ? tn(shown[key].length, 'Stage {n} shown', 'Stage {n} shown') : t('Stage all')));
  const filteredReason = key => (filtered && !shown[key].length ? t('No file here matches the filter') : undefined);
  const discardAllReason = filtered ? t('Clear the filter first: this acts on the whole list') : bulkReason;
  const list = (key, row) => <FileList files={shown[key]} view={view} renderFile={entry => row(entry, view === 'tree' ? baseName(entry.path) : entry.path)} />;
  const emptyText = (key, text) => (filtered && tree[key].length ? t('No match here.') : text);
  const apply = selected => guard(async () => {
    const payload = Object.entries(selected)
      .filter(([, lines]) => lines.length > 0)
      .map(([index, lines]) => ({ index: Number(index), lines }));
    if (payload.length === 0) return;
    if (open.untracked) await window.twig.applyUntrackedSelection(repository.id, open.path, diff.digest, payload);
    else await window.twig.applySelection(repository.id, open.path, open.staged, diff.digest, payload);
  }, open?.staged ? t('Unstaged the selected lines.') : t('Staged the selected lines.'));

  /**
   * Discarding always asks first (§6.5) with the exact command, then runs like
   * any other action here. Main backs the files up before touching them, so
   * the notice can promise that Undo brings them back.
   */
  const askDiscard = (request, run, after) => setConfirm({ ...discardDialog(request), onConfirm: () => guard(run, after) });
  const discardReason = entry => (busy ? t('Git is working') : entry.status === 'U' ? t('Resolve the conflict first') : undefined);
  // Marked for tracking with `git add -N`: there is nothing to discard, only the mark to take off.
  const discardRow = (entry, section) => (section === 'unstaged' && entry.status === 'A' ? {
    icon: X, label: t`Stop tracking ${entry.path}`, reason: discardReason(entry),
    run: () => guard(() => window.twig.unstageFile(repository.id, entry.path, unborn), t('No longer tracked.'))
  } : {
    icon: section === 'untracked' ? Trash2 : Undo2,
    label: section === 'untracked' ? t`Delete ${entry.path}` : t`Discard changes to ${entry.path}`,
    reason: discardReason(entry),
    run: () => askDiscard({ kind: section === 'untracked' ? 'untracked' : 'file', path: entry.path },
      () => window.twig.discardFile(repository.id, entry.path, section),
      section === 'untracked' ? t`Deleted ${entry.path}. Undo brings it back.` : t`Discarded changes to ${entry.path}. Undo brings them back.`)
  });
  const discardAllAction = scope => askDiscard(
    { kind: scope === 'untracked' ? 'untracked-all' : 'tracked', paths: (scope === 'untracked' ? tree.untracked : tree.unstaged).map(entry => entry.path) },
    () => window.twig.discardAll(repository.id, scope),
    scope === 'untracked' ? t('Deleted the untracked files. Undo brings them back.') : t('Discarded every unstaged change. Undo brings them back.'));
  const discardSelected = selected => {
    const payload = Object.entries(selected).filter(([, lines]) => lines.length > 0).map(([index, lines]) => ({ index: Number(index), lines }));
    const lines = payload.reduce((total, entry) => total + entry.lines.length, 0);
    if (!lines) return;
    askDiscard({ kind: 'lines', path: open.path, lines },
      () => window.twig.discardSelection(repository.id, open.path, diff.digest, payload),
      tn(lines, 'Discarded {n} line of {path}. Undo brings them back.', 'Discarded {n} lines of {path}. Undo brings them back.', { path: open.path }));
  };

  /** A rule in .gitignore for an untracked path; Undo takes it back out. */
  const ignore = (file, choice) => guard(async () => {
    const outcome = await window.twig.addIgnoreRule(repository.id, file, choice.kind);
    if (!outcome.ok) throw new Error(outcome.message);
    if (open?.path === file) { setOpen(null); setDiff(null); }
    setNotice(outcome.stillShown ? t`Added ${outcome.pattern} to .gitignore, but a later rule still shows ${file}.`
      : t`Added ${outcome.pattern} to .gitignore. Undo takes it back out.`);
  }, null, false);

  const busyOp = operation && operation.kind !== 'none' ? operation.kind : null;
  const amendToggleReason = busy ? t('Git is working')
    : unborn ? t('There is no commit to amend yet')
      : busyOp ? tr(finishFirst(busyOp)) : undefined;

  /** Turning amend on prefills the message from the last commit so it can be kept or tweaked. */
  async function toggleAmend(next) {
    setAmend(next);
    if (!next) {
      if (amendBase.current && message === amendBase.current.message) setMessage('');
      amendBase.current = null;
      return;
    }
    const oid = tree.branch?.oid;
    if (!oid) { setAmend(false); return; }
    try {
      const head = await window.twig.getCommit(repository.id, oid);
      const full = head.body ? `${head.subject}\n${head.body}` : head.subject;
      amendBase.current = { oid, message: full };
      setMessage(current => (current.trim().length === 0 ? full : current));
      setError('');
    } catch (failure) {
      setAmend(false);
      setError(failureText(failure, t('Could not read the last commit.')));
    }
  }

  async function submitCommit(amendMode) {
    if (runAutomation) {
      if (!await runAutomation('pre-commit', {})) return;
      if (!await runAutomation('commit-msg', { message })) return;
    }
    const head = amendMode ? amendBase.current?.oid ?? tree.branch?.oid ?? null : null;
    await guard(async () => {
      const warnings = await window.twig.createCommit(repository.id, message, amendMode, head, coAuthors, !amendMode && bumpPlan ? bumpChoice : null);
      setMessage('');
      setCoAuthors([]);
      setCoAuthorsOpen(false);
      setAmend(false);
      setBumpChoice(null);
      amendBase.current = null;
      setOpen(null);
      setDiff(null);
      if (warnings.length) setNotice(warnings.map(tr).join(' '));
      if (runAutomation) {
        void runAutomation('post-commit', {});
        if (amendMode) void runAutomation('post-rewrite', {});
      }
    }, amendMode ? t('Amended the last commit.') : t('Commit created.'), false, true);
  }

  const subject = message.split('\n')[0];
  const amendUntouched = amend && amendBase.current
    && tree.staged.length === 0 && message === amendBase.current.message;
  const commitReason = busy ? t('Git is working')
    : conflicts ? tn(conflicts, 'Resolve the conflict first', 'Resolve the conflicts first')
    : amend
      ? (amendToggleReason
        || (message.trim().length === 0 ? t('Write a commit message')
          : amendUntouched ? t('Stage a file or edit the message to amend') : undefined))
      : tree.staged.length === 0 ? t('Stage something to commit')
        : message.trim().length === 0 ? t('Write a commit message') : undefined;
  const amendSharedWarning = amend && tree.branch?.upstream && (tree.branch.ahead || 0) === 0
    ? t`The last commit is already on ${tree.branch.upstream}. Amending rewrites shared history and needs a force push.`
    : '';

  return <div className="worktree-screen">
    <header className="panel-heading worktree-heading">
      <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button>
      <ScreenTitle title={t`Working tree · ${tree.staged.length} staged, ${tree.unstaged.length + tree.untracked.length} not staged`} />
      {unborn && <span className="pill">{t('First commit')}</span>}
    </header>
    {error && <div className="history-error" role="alert">
      <span>{typeof error === 'string' ? error : error.text}
        {typeof error === 'object' && error.detail && <small className="note-detail">{error.detail}</small>}</span>
      {typeof error === 'object' && error.actions?.map(action => <button key={action.label} onClick={action.run}>{action.label}</button>)}
      <button onClick={onConsole}>{t('Show output')}</button></div>}
    {detached && <div className="detached-strip" role="status">
      <AlertTriangle aria-hidden="true" />
      <span>{t('HEAD is detached: a new commit will not be on any branch. Checking out a branch later leaves it to the reflog.')}</span>
      <Button icon={GitBranch} reason={busy ? t('Git is working') : undefined} onClick={() => setNaming(true)}>{t('Create branch here…')}</Button>
    </div>}
    {notice && <p className="worktree-notice" role="status">{notice}</p>}
    <div className="worktree-body">
      <div className="worktree-lists">
        <div className="worktree-list-controls">
          <FileListControls view={view} onView={next => { setView(next); writeFileView(next); }} filter={filter} onFilter={setFilter}
            extension={extension} onExtension={setExtension} paths={allPaths} label={t('working tree files')} />
        </div>
        <section aria-label={t('Staged changes')}>
          <h3><Check /> {t('Staged')} <span className="count">{tree.staged.length}</span>
            {tree.staged.length > 0 && <Button className="bulk" icon={Minus}
              reason={filteredReason('staged') || (filtered ? bulkReason : unstageAllReason)}
              onClick={() => bulk(() => window.twig.unstageAll(repository.id, only('staged')), count => tn(count, 'Unstaged {n} file.', 'Unstaged {n} files.'))}>{bulkLabel('staged')}</Button>}</h3>
          {list('staged', (entry, name) => <FileRow key={`s-${entry.path}`} entry={entry} name={name} busy={busy}
            active={open?.path === entry.path && open?.staged}
            onOpen={() => openDiff(entry.path, true)} primaryIcon={Minus} primaryLabel={t`Unstage ${entry.path}`}
            onPrimary={() => guard(() => window.twig.unstageFile(repository.id, entry.path, unborn), t('Unstaged.'))} />)}
          {!shown.staged.length && <p className="muted">{emptyText('staged', t('Nothing staged yet.'))}</p>}
        </section>
        <section aria-label={t('Unstaged changes')}>
          <h3><FilePenLine /> {t('Changes')} <span className="count">{tree.unstaged.length}</span>
            {tree.unstaged.length > 0 && <Button className="bulk" icon={Plus} reason={filteredReason('unstaged') || bulkReason}
              onClick={() => bulk(() => window.twig.stageAll(repository.id, 'tracked', only('unstaged')), count => tn(count, 'Staged {n} file.', 'Staged {n} files.'))}>{bulkLabel('unstaged')}</Button>}
            {tree.unstaged.length > 0 && <Button className="bulk discard" icon={Undo2} reason={discardAllReason}
              onClick={() => discardAllAction('tracked')}>{t('Discard all')}</Button>}</h3>
          {list('unstaged', (entry, name) => <FileRow key={`u-${entry.path}`} entry={entry} name={name} busy={busy} discard={discardRow(entry, 'unstaged')}
            active={open?.path === entry.path && !open?.staged}
            onOpen={() => (entry.status === 'U' && onResolveConflict ? onResolveConflict(entry.path) : openDiff(entry.path, false))} primaryIcon={Plus} primaryLabel={t`Stage ${entry.path}`}
            primaryReason={entry.status === 'U' ? t('Open it to resolve the conflict') : undefined}
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), t('Staged.'))} />)}
          {!shown.unstaged.length && <p className="muted">{emptyText('unstaged', t('No unstaged changes.'))}</p>}
        </section>
        <section aria-label={t('Untracked files')}>
          <h3><FilePlus2 /> {t('Untracked')} <span className="count">{tree.untracked.length}</span>
            {tree.untracked.length > 0 && <Button className="bulk" icon={Plus} reason={filteredReason('untracked') || bulkReason}
              onClick={() => bulk(() => window.twig.stageAll(repository.id, 'untracked', only('untracked')), count => tn(count, 'Staged {n} new path.', 'Staged {n} new paths.'))}>{bulkLabel('untracked')}</Button>}
            {tree.untracked.length > 0 && <Button className="bulk discard" icon={Trash2} reason={discardAllReason}
              onClick={() => discardAllAction('untracked')}>{t('Delete all')}</Button>}</h3>
          {list('untracked', (entry, name) => <FileRow key={`n-${entry.path}`} entry={entry} name={name} busy={busy} discard={discardRow(entry, 'untracked')}
            onMenu={(x, y) => setRowMenu({ path: entry.path, x, y })}
            active={open?.path === entry.path}
            onOpen={() => openUntracked(entry.path)}
            primaryIcon={Plus} primaryLabel={t`Stage ${entry.path}`}
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), t('Staged.'))} />)}
          {!shown.untracked.length && <p className="muted">{emptyText('untracked', t('No untracked files.'))}</p>}
        </section>
      </div>
      <div className="worktree-detail">
        {open && diff?.directory && <p className="muted stage-empty">{t('This is a new folder. Stage it to see its files one by one.')}</p>}
        {open && diff?.tooLarge && <p className="muted stage-empty">{t`This file is ${Math.round(diff.size / 1024)} KB, too large to show here. Stage it whole.`}</p>}
        {open && diff?.hunks && <StageDiff repositoryId={repository.id} file={open.path} diff={diff} staged={open.staged} untracked={Boolean(open.untracked)} selection={selection}
          onSelection={setSelection} onApply={apply} busy={busy} onClose={() => { setOpen(null); setDiff(null); }}
          onDiscard={open.staged || diff.added || diff.deleted ? null : discardSelected} />}
        {open && !diff && <div className="loading-shell" aria-label={t('Loading diff')}><div className="skeleton" /></div>}
        {!open && <p className="muted stage-empty">{t('Pick a file to see its changes and to stage or unstage individual lines. Looking at an untracked file changes nothing.')}</p>}
      </div>
    </div>
    <form className="commit-box" onSubmit={event => { event.preventDefault(); void submitCommit(amend); }}>
      <label className="visually-hidden" htmlFor="commit-message">{amend ? t('Amend message') : t('Commit message')}</label>
      <textarea id="commit-message" rows={3} value={message} placeholder={t('Subject line, blank line, then the details')}
        onChange={event => setMessage(event.target.value)} />
      {(coAuthorsOpen || coAuthors.length > 0) && <CoAuthors repositoryId={repository.id} chosen={coAuthors} onChange={setCoAuthors}
        disabled={busy} autoFocus={coAuthorsOpen && coAuthors.length === 0} onDone={() => setCoAuthorsOpen(false)} />}
      {amendSharedWarning && <p className="worktree-notice amend-warn" role="alert">{amendSharedWarning}</p>}
      <div className="commit-options">
        <label className="amend-toggle" title={amendToggleReason || undefined}>
          <input type="checkbox" checked={amend} disabled={Boolean(amendToggleReason)}
            onChange={event => void toggleAmend(event.target.checked)} />
          <span>{amendToggleReason ? t`Amend last commit — add every staged file to it (${amendToggleReason})` : t('Amend last commit — add every staged file to it')}</span>
        </label>
        {!coAuthorsOpen && coAuthors.length === 0 && <button type="button" className="text-button co-author-open"
          title={t('Credit people from this history with Co-authored-by: trailers')} onClick={() => setCoAuthorsOpen(true)}>
          <Users aria-hidden="true" />{t('Add co-authors')}</button>}
      </div>
      {bumpPlan && !amend && <label className="commit-bump" htmlFor="commit-bump"><span>{t('Version')}</span>
        <select id="commit-bump" value={bumpChoice ?? 'none'} disabled={busy} onChange={event => setBumpChoice(event.target.value)}>
          {BUMP_CHOICES.map(choice => <option key={choice} value={choice}>{bumpLabel(bumpPlan, choice)}</option>)}
        </select></label>}
      <div className="commit-actions">
        <span className={subject.length > 72 ? 'warn' : 'muted'}>{t`${subject.length}/72 in the subject`}</span>
        <Button className="primary" type="submit" reason={commitReason}>
          {amend ? t('Amend last commit') : tn(tree.staged.length, 'Commit {n} file', 'Commit {n} files')}</Button>
      </div>
    </form>
    {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    {naming && <NameDialog title={t`Create a branch at ${(tree.branch?.oid || '').slice(0, 7)}`} label={t('Branch name')} placeholder="feature/short-description"
      confirmLabel={t('Create branch')} onClose={() => setNaming(false)}
      onConfirm={({ name }) => guard(async () => {
        const result = await window.twig.createBranch(repository.id, name, tree.branch.oid, true);
        if (!result.ok) throw result;
      }, t`Branch ${name} created and checked out.`, false, true)} />}
    {rowMenu && <Menu x={rowMenu.x} y={rowMenu.y} label={t`Actions for ${rowMenu.path}`} onClose={() => setRowMenu(null)}
      items={ignoreMenuItems({ path: rowMenu.path, reason: busy ? t('Git is working') : undefined, run: choice => void ignore(rowMenu.path, choice) })} />}
  </div>;
}
