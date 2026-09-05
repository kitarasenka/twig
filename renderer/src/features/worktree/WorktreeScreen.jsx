import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, FilePenLine, FilePlus2, Minus, Plus } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import StageDiff from './StageDiff.jsx';

const EMPTY = { staged: [], unstaged: [], untracked: [], branch: null };

function FileRow({ entry, active, onOpen, onPrimary, primaryIcon: Icon, primaryLabel, busy }) {
  return <div className={`worktree-file ${active ? 'selected' : ''}`}>
    <button className="worktree-open" onClick={onOpen} title={entry.path}>
      <span className="file-status">{entry.status}</span><span>{entry.path}</span>
    </button>
    <Button icon={Icon} aria-label={`${primaryLabel} ${entry.path}`} reason={busy ? 'Git is working' : undefined} onClick={onPrimary} />
  </div>;
}

export default function WorktreeScreen({ repository, onConsole, onChanged, onBack }) {
  const [tree, setTree] = useState(EMPTY);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);
  const [diff, setDiff] = useState(null);
  const [selection, setSelection] = useState({});
  const [message, setMessage] = useState('');
  const [notice, setNotice] = useState('');
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
  const apply = selected => guard(async () => {
    const payload = Object.entries(selected)
      .filter(([, lines]) => lines.length > 0)
      .map(([index, lines]) => ({ index: Number(index), lines }));
    if (payload.length === 0) return;
    await window.twig.applySelection(repository.id, open.path, open.staged, diff.digest, payload);
  }, open?.staged ? 'Unstaged the selected lines.' : 'Staged the selected lines.');

  async function commit() {
    await guard(async () => {
      const warnings = await window.twig.createCommit(repository.id, message, false);
      setMessage('');
      setOpen(null);
      setDiff(null);
      if (warnings.length) setNotice(warnings.join(' '));
    }, 'Commit created.', false);
  }

  const subject = message.split('\n')[0];
  const commitReason = busy ? 'Git is working'
    : tree.staged.length === 0 ? 'Stage something to commit'
      : message.trim().length === 0 ? 'Write a commit message' : undefined;

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
          <h3><Check /> Staged <span className="count">{tree.staged.length}</span></h3>
          {tree.staged.map(entry => <FileRow key={`s-${entry.path}`} entry={entry} busy={busy}
            active={open?.path === entry.path && open?.staged}
            onOpen={() => openDiff(entry.path, true)} primaryIcon={Minus} primaryLabel="Unstage"
            onPrimary={() => guard(() => window.twig.unstageFile(repository.id, entry.path, unborn), 'Unstaged.')} />)}
          {!tree.staged.length && <p className="muted">Nothing staged yet.</p>}
        </section>
        <section aria-label="Unstaged changes">
          <h3><FilePenLine /> Changes <span className="count">{tree.unstaged.length}</span></h3>
          {tree.unstaged.map(entry => <FileRow key={`u-${entry.path}`} entry={entry} busy={busy}
            active={open?.path === entry.path && !open?.staged}
            onOpen={() => openDiff(entry.path, false)} primaryIcon={Plus} primaryLabel="Stage"
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), 'Staged.')} />)}
          {!tree.unstaged.length && <p className="muted">No unstaged changes.</p>}
        </section>
        <section aria-label="Untracked files">
          <h3><FilePlus2 /> Untracked <span className="count">{tree.untracked.length}</span></h3>
          {tree.untracked.map(entry => <FileRow key={`n-${entry.path}`} entry={entry} busy={busy}
            active={open?.path === entry.path}
            onOpen={() => trackAndOpen(entry.path)}
            primaryIcon={Plus} primaryLabel="Stage"
            onPrimary={() => guard(() => window.twig.stageFile(repository.id, entry.path), 'Staged.')} />)}
          {!tree.untracked.length && <p className="muted">No untracked files.</p>}
        </section>
      </div>
      <div className="worktree-detail">
        {open && diff && <StageDiff file={open.path} diff={diff} staged={open.staged} selection={selection}
          onSelection={setSelection} onApply={apply} busy={busy} onClose={() => { setOpen(null); setDiff(null); }} />}
        {open && !diff && <div className="loading-shell" aria-label="Loading diff"><div className="skeleton" /></div>}
        {!open && <p className="muted stage-empty">Pick a file to stage or unstage individual lines. Selecting an untracked file starts tracking it so its lines can be picked.</p>}
      </div>
    </div>
    <form className="commit-box" onSubmit={event => { event.preventDefault(); void commit(); }}>
      <label htmlFor="commit-message">Commit message</label>
      <textarea id="commit-message" rows={3} value={message} placeholder="Subject line, blank line, then the details"
        onChange={event => setMessage(event.target.value)} />
      <div className="commit-actions">
        <span className={subject.length > 72 ? 'warn' : 'muted'}>{subject.length}/72 in the subject</span>
        <Button className="primary" type="submit" reason={commitReason}>{`Commit ${tree.staged.length} file${tree.staged.length === 1 ? '' : 's'}`}</Button>
      </div>
    </form>
  </div>;
}
