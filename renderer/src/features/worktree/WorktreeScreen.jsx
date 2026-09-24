import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FilePenLine, FilePlus2, Minus, Plus, Trash2, Undo2, Users } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Menu from '../../ui/Menu.jsx';
import { ignoreMenuItems } from '../diff/file-menu.js';
import FileStatus from '../diff/FileStatus.jsx';
import StageDiff from './StageDiff.jsx';
import CoAuthors from './CoAuthors.jsx';
import { ConfirmDialog } from '../ops/dialogs.jsx';
import { discardDialog } from './discard-dialog.js';

const EMPTY = { staged: [], unstaged: [], untracked: [], branch: null };

/** Right-click, Shift+F10 or the Menu key on a row, opening at the pointer or under the row. */
function menuProps(onMenu) {
  if (!onMenu) return {};
  return {
    onContextMenu: event => { event.preventDefault(); onMenu(event.clientX, event.clientY); },
    onKeyDown: event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onMenu(box.left + 24, box.bottom);
    }
  };
}

function FileRow({ entry, active, onOpen, onPrimary, primaryIcon: Icon, primaryLabel, busy, discard = null, onMenu = null }) {
  return <div className={`worktree-file ${active ? 'selected' : ''}`}>
    <button className="worktree-open" onClick={onOpen} title={onMenu ? `${entry.path} · Right-click or Shift+F10 to ignore it` : entry.path} {...menuProps(onMenu)}>
      <FileStatus status={entry.status} /><span>{entry.path}</span>
    </button>
    {discard && <Button className="discard" icon={discard.icon} aria-label={`${discard.label} ${entry.path}`} reason={discard.reason} onClick={discard.run} />}
    <Button icon={Icon} aria-label={`${primaryLabel} ${entry.path}`} reason={busy ? 'Git is working' : undefined} onClick={onPrimary} />
  </div>;
}

export default function WorktreeScreen({ repository, operation = null, runAutomation = null, onConsole, onChanged, onBack }) {
  const [tree, setTree] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [diff, setDiff] = useState(null);
  const [selection, setSelection] = useState({});
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
  const [amend, setAmend] = useState(false);
  const [coAuthors, setCoAuthors] = useState([]);
  // The picker costs a row of height, so it opens on request; chosen people keep it open.
  const [coAuthorsOpen, setCoAuthorsOpen] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const [rowMenu, setRowMenu] = useState(null);
  const amendBase = useRef(null);
  const generation = useRef(0);
  const diffRequest = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const next = await window.twig.readWorktree(repository.id);
      if (epoch === generation.current) { setTree(next); setError(''); }
    } catch (failure) {
      if (epoch === generation.current) setError(failure.message || 'Could not read the working tree.');
    }
  }, [repository.id]);

  useEffect(() => {
    void refresh();
    const tokens = [generation, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [refresh]);

  const openDiff = useCallback(async (path, staged) => {
    const request = ++diffRequest.current;
    setOpen({ path, staged });
    setDiff(null);
    setSelection({});
    try {
      const next = await window.twig.getWorktreeDiff(repository.id, path, staged);
      if (request === diffRequest.current) setDiff(next);
    } catch (failure) {
      if (request === diffRequest.current) { setDiff(null); setError(failure.message || 'Could not read this diff.'); }
    }
  }, [repository.id]);

  async function guard(action, after, reopen = true) {
    setBusy(true);
    setNotice('');
    try {
      await action();
      await refresh();
      if (reopen && open) await openDiff(open.path, open.staged);
      onChanged?.();
      if (after) setNotice(after);
      setError('');
    } catch (failure) {
      setError(failure.message || 'Git refused this operation.');
    } finally { setBusy(false); }
  }

  /** An untracked file has no diff until Git tracks it, so opening one records it first. */
  async function trackAndOpen(path) {
    setBusy(true);
    try {
      await window.twig.trackFile(repository.id, path);
      await refresh();
      await openDiff(path, false);
      onChanged?.();
      setError('');
    } catch (failure) {
      setError(failure.message || 'Could not track this file.');
    } finally { setBusy(false); }
  }

  const unborn = Boolean(tree.branch?.unborn);
  const conflicts = tree.unstaged.filter(entry => entry.status === 'U').length;
  /**
   * A bulk action is refused where the per-file buttons still work: `git add`
   * on a conflicted file would mark it resolved unseen, and unstaging
   * everything is a mixed reset, which deletes the marker of a merge, rebase,
   * cherry-pick or revert and so cancels it. Main refuses these too; the
   * disabled button says why before the click.
   */
  const bulkReason = busy ? 'Git is working'
    : conflicts ? `Resolve the ${conflicts === 1 ? 'conflict' : 'conflicts'} first` : undefined;
  const unstageAllReason = bulkReason
    || (operation && operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined);
  const bulk = (run, describe) => guard(async () => setNotice(describe(await run())));
  const apply = selected => guard(async () => {
    const payload = Object.entries(selected)
      .filter(([, lines]) => lines.length > 0)
      .map(([index, lines]) => ({ index: Number(index), lines }));
    if (payload.length === 0) return;
    await window.twig.applySelection(repository.id, open.path, open.staged, diff.digest, payload);
  }, open?.staged ? 'Unstaged the selected lines.' : 'Staged the selected lines.');

  /**
   * Discarding always asks first (§6.5) with the exact command, then runs like
   * any other action here. Main backs the files up before touching them, so
   * the notice can promise that Undo brings them back.
   */
  const askDiscard = (request, run, after) => setConfirm({ ...discardDialog(request), onConfirm: () => guard(run, after) });
  const discardReason = (entry, section) => (busy ? 'Git is working'
    : entry.status === 'U' ? 'Resolve the conflict first'
      : section === 'unstaged' && entry.status === 'A' ? 'Only marked for tracking (git add -N): unstage it first' : undefined);
  const discardRow = (entry, section) => ({
    icon: section === 'untracked' ? Trash2 : Undo2,
    label: section === 'untracked' ? 'Delete' : 'Discard changes to',
    reason: discardReason(entry, section),
    run: () => askDiscard({ kind: section === 'untracked' ? 'untracked' : 'file', path: entry.path },
      () => window.twig.discardFile(repository.id, entry.path, section),
      `${section === 'untracked' ? `Deleted ${entry.path}` : `Discarded changes to ${entry.path}`}. Undo brings ${section === 'untracked' ? 'it' : 'them'} back.`)
  });
  const discardAllAction = scope => askDiscard(
    { kind: scope === 'untracked' ? 'untracked-all' : 'tracked', paths: (scope === 'untracked' ? tree.untracked : tree.unstaged).map(entry => entry.path) },
    () => window.twig.discardAll(repository.id, scope),
    `${scope === 'untracked' ? 'Deleted the untracked files' : 'Discarded every unstaged change'}. Undo brings them back.`);
  const discardSelected = selected => {
    const payload = Object.entries(selected).filter(([, lines]) => lines.length > 0).map(([index, lines]) => ({ index: Number(index), lines }));
    const lines = payload.reduce((total, entry) => total + entry.lines.length, 0);
    if (!lines) return;
    askDiscard({ kind: 'lines', path: open.path, lines },
      () => window.twig.discardSelection(repository.id, open.path, diff.digest, payload),
      `Discarded ${lines} line${lines === 1 ? '' : 's'} of ${open.path}. Undo brings them back.`);
  };

  /** A rule in .gitignore for an untracked path; Undo takes it back out. */
  const ignore = (file, choice) => guard(async () => {
    const outcome = await window.twig.addIgnoreRule(repository.id, file, choice.kind);
    if (!outcome.ok) throw new Error(outcome.message);
    if (open?.path === file) { setOpen(null); setDiff(null); }
    setNotice(outcome.stillShown ? `Added ${outcome.pattern} to .gitignore, but a later rule still shows ${file}.`
      : `Added ${outcome.pattern} to .gitignore. Undo takes it back out.`);
  }, null, false);

  const busyOp = operation && operation.kind !== 'none' ? operation.kind : null;
  const amendToggleReason = busy ? 'Git is working'
    : unborn ? 'There is no commit to amend yet'
      : busyOp ? `Finish or abort the ${busyOp} first` : undefined;

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
      setError(failure.message || 'Could not read the last commit.');
    }
  }

  async function submitCommit(amendMode) {
    if (runAutomation) {
      if (!await runAutomation('pre-commit', {})) return;
      if (!await runAutomation('commit-msg', { message })) return;
    }
    const head = amendMode ? amendBase.current?.oid ?? tree.branch?.oid ?? null : null;
    await guard(async () => {
      const warnings = await window.twig.createCommit(repository.id, message, amendMode, head, coAuthors);
      setMessage('');
      setCoAuthors([]);
      setCoAuthorsOpen(false);
      setAmend(false);
      amendBase.current = null;
      setOpen(null);
      setDiff(null);
      if (warnings.length) setNotice(warnings.join(' '));
      if (runAutomation) {
        void runAutomation('post-commit', {});
        if (amendMode) void runAutomation('post-rewrite', {});
      }
    }, amendMode ? 'Amended the last commit.' : 'Commit created.', false);
  }

  const subject = message.split('\n')[0];
  const amendUntouched = amend && amendBase.current
    && tree.staged.length === 0 && message === amendBase.current.message;
  const commitReason = busy ? 'Git is working'
    : amend
      ? (amendToggleReason
        || (message.trim().length === 0 ? 'Write a commit message'
          : amendUntouched ? 'Stage a file or edit the message to amend' : undefined))
      : tree.staged.length === 0 ? 'Stage something to commit'
        : message.trim().length === 0 ? 'Write a commit message' : undefined;
  const amendSharedWarning = amend && tree.branch?.upstream && (tree.branch.ahead || 0) === 0
    ? `The last commit is already on ${tree.branch.upstream}. Amending rewrites shared history and needs a force push.`
    : '';

  return <div className="worktree-screen">
    <header className="panel-heading worktree-heading">
      <strong>Working tree · {tree.staged.length} staged, {tree.unstaged.length + tree.untracked.length} not staged</strong>
      <span className="diff-actions">
        {unborn && <span className="pill">First commit</span>}
        <Button onClick={onBack}>Back to history</Button>
      </span>
    </header>
    {error && <div className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></div>}
    {notice && <p className="worktree-notice" role="status">{notice}</p>}
    <div className="worktree-body">
      <div className="worktree-lists">
        <section aria-label="Staged changes">
          <h3><Check /> Staged <span className="count">{tree.staged.length}</span>
            {tree.staged.length > 0 && <Button className="bulk" icon={Minus} reason={unstageAllReason}
              onClick={() => bulk(() => window.twig.unstageAll(repository.id), count => `Unstaged ${count} file${count === 1 ? '' : 's'}.`)}>Unstage all</Button>}</h3>
          {tree.staged.map(entry => <FileRow key={`s-${entry.path}`} entry={entry} busy={busy}
            active={open?.path === entry.path && open?.staged}
            onOpen={() => openDiff(entry.path, true)} primaryIcon={Minus} primaryLabel="Unstage"
            onPrimary={() => guard(() => window.twig.unstageFile(repository.id, entry.path, unborn), 'Unstaged.')} />)}
          {!tree.staged.length && <p className="muted">Nothing staged yet.</p>}
        </section>
        <section aria-label="Unstaged changes">
          <h3><FilePenLine /> Changes <span className="count">{tree.unstaged.length}</span>
            {tree.unstaged.length > 0 && <Button className="bulk" icon={Plus} reason={bulkReason}
              onClick={() => bulk(() => window.twig.stageAll(repository.id, 'tracked'), count => `Staged ${count} file${count === 1 ? '' : 's'}.`)}>Stage all</Button>}
            {tree.unstaged.length > 0 && <Button className="bulk discard" icon={Undo2} reason={bulkReason}
              onClick={() => discardAllAction('tracked')}>Discard all</Button>}</h3>
          {tree.unstaged.map(entry => <FileRow key={`u-${entry.path}`} entry={entry} busy={busy} discard={discardRow(entry, 'unstaged')}
            active={open?.path === entry.path && !open?.staged}
            onOpen={() => openDiff(entry.path, false)} primaryIcon={Plus} primaryLabel="Stage"
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), 'Staged.')} />)}
          {!tree.unstaged.length && <p className="muted">No unstaged changes.</p>}
        </section>
        <section aria-label="Untracked files">
          <h3><FilePlus2 /> Untracked <span className="count">{tree.untracked.length}</span>
            {tree.untracked.length > 0 && <Button className="bulk" icon={Plus} reason={bulkReason}
              onClick={() => bulk(() => window.twig.stageAll(repository.id, 'untracked'), count => `Staged ${count} new path${count === 1 ? '' : 's'}.`)}>Stage all</Button>}
            {tree.untracked.length > 0 && <Button className="bulk discard" icon={Trash2} reason={bulkReason}
              onClick={() => discardAllAction('untracked')}>Delete all</Button>}</h3>
          {tree.untracked.map(entry => <FileRow key={`n-${entry.path}`} entry={entry} busy={busy} discard={discardRow(entry, 'untracked')}
            onMenu={(x, y) => setRowMenu({ path: entry.path, x, y })}
            active={open?.path === entry.path}
            onOpen={() => trackAndOpen(entry.path)}
            primaryIcon={Plus} primaryLabel="Stage"
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), 'Staged.')} />)}
          {!tree.untracked.length && <p className="muted">No untracked files.</p>}
        </section>
      </div>
      <div className="worktree-detail">
        {open && diff && <StageDiff file={open.path} diff={diff} staged={open.staged} selection={selection}
          onSelection={setSelection} onApply={apply} busy={busy} onClose={() => { setOpen(null); setDiff(null); }}
          onDiscard={open.staged || diff.added || diff.deleted ? null : discardSelected} />}
        {open && !diff && <div className="loading-shell" aria-label="Loading diff"><div className="skeleton" /></div>}
        {!open && <p className="muted stage-empty">Pick a file to stage or unstage individual lines. Selecting an untracked file starts tracking it so its lines can be picked.</p>}
      </div>
    </div>
    <form className="commit-box" onSubmit={event => { event.preventDefault(); void submitCommit(amend); }}>
      <label htmlFor="commit-message">{amend ? 'Amend message' : 'Commit message'}</label>
      <textarea id="commit-message" rows={3} value={message} placeholder="Subject line, blank line, then the details"
        onChange={event => setMessage(event.target.value)} />
      {(coAuthorsOpen || coAuthors.length > 0) && <CoAuthors repositoryId={repository.id} chosen={coAuthors} onChange={setCoAuthors}
        disabled={busy} autoFocus={coAuthorsOpen && coAuthors.length === 0} onDone={() => setCoAuthorsOpen(false)} />}
      {amendSharedWarning && <p className="worktree-notice amend-warn" role="alert">{amendSharedWarning}</p>}
      <div className="commit-options">
        <label className="amend-toggle" title={amendToggleReason || undefined}>
          <input type="checkbox" checked={amend} disabled={Boolean(amendToggleReason)}
            onChange={event => void toggleAmend(event.target.checked)} />
          <span>Amend last commit — add every staged file to it{amendToggleReason ? ` (${amendToggleReason})` : ''}</span>
        </label>
        {!coAuthorsOpen && coAuthors.length === 0 && <button type="button" className="text-button co-author-open"
          title="Credit people from this history with Co-authored-by: trailers" onClick={() => setCoAuthorsOpen(true)}>
          <Users aria-hidden="true" />Add co-authors</button>}
      </div>
      <div className="commit-actions">
        <span className={subject.length > 72 ? 'warn' : 'muted'}>{subject.length}/72 in the subject</span>
        <Button className="primary" type="submit" reason={commitReason}>
          {amend ? 'Amend last commit' : `Commit ${tree.staged.length} file${tree.staged.length === 1 ? '' : 's'}`}</Button>
      </div>
    </form>
    {confirm && <ConfirmDialog {...confirm} onClose={() => setConfirm(null)} />}
    {rowMenu && <Menu x={rowMenu.x} y={rowMenu.y} label={`Actions for ${rowMenu.path}`} onClose={() => setRowMenu(null)}
      items={ignoreMenuItems({ path: rowMenu.path, reason: busy ? 'Git is working' : undefined, run: choice => void ignore(rowMenu.path, choice) })} />}
  </div>;
}
