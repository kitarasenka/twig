import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, FolderGit2, Plus, RefreshCw, Scissors, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { folderLabel, worktreeBadges, worktreeLine, worktreeRemoveCommand, worktreeRemoveReason } from './tools-view.js';

/**
 * Every worktree of this repository: the main one, this tab's, and the
 * others, each openable as a tab of its own. Removing one deletes its folder
 * (Git refuses while it has uncommitted work, unless forced through a second
 * confirmation); its branch and commits stay.
 */
export default function WorktreesScreen({ repository, busy, refreshKey = 0, onBack, onNew, onOpen, onDialog, onWorkspace, onConsole }) {
  const [worktrees, setWorktrees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const list = await window.twig.getWorktrees(repository.id);
      if (epoch === generation.current) { setWorktrees(list); setError(''); }
    } catch (failure) { if (epoch === generation.current) setError(failure.message || 'Could not read the worktrees.'); }
    finally { if (epoch === generation.current) setLoading(false); }
  }, [repository.id]);
  useEffect(() => { void refresh(); const token = generation; return () => { token.current++; }; }, [refresh, refreshKey]);

  async function remove(entry, force) {
    setWorking(true); setNote('');
    try {
      const result = await window.twig.removeWorktree(repository.id, entry.path, force);
      if (result.ok) { setNote(`Worktree ${folderLabel(entry.path)} removed.`); onWorkspace(result.workspace); }
      else if (result.dirty && !force) confirmRemove(entry, true);
      else { setNote(result.message); onConsole(); }
    } catch (failure) { setNote(failure.message || 'Could not remove the worktree.'); onConsole(); }
    finally { setWorking(false); void refresh(); }
  }
  function confirmRemove(entry, force = false) {
    onDialog({
      type: 'confirm', title: `Remove worktree ${folderLabel(entry.path)}`, command: worktreeRemoveCommand(entry.path, force),
      consequence: force
        ? `${entry.path} has uncommitted or untracked files. Removing it anyway deletes them for good. ${entry.branch ? `The branch ${entry.branch} and its commits stay.` : ''}`
        : `The folder ${entry.path} is deleted. ${entry.branch ? `The branch ${entry.branch} and its commits stay in the repository.` : 'Its commits stay in the repository.'} Git refuses if it has uncommitted work.`,
      confirmLabel: force ? 'Remove and discard its changes' : 'Remove worktree',
      onConfirm: () => void remove(entry, force)
    });
  }
  async function prune() {
    setWorking(true); setNote('');
    try {
      const result = await window.twig.pruneWorktrees(repository.id);
      setNote(result.ok ? 'Worktrees with missing folders forgotten.' : result.message);
      if (!result.ok) onConsole();
    } catch (failure) { setNote(failure.message || 'Could not prune.'); onConsole(); }
    finally { setWorking(false); void refresh(); }
  }

  const reason = busy || working ? 'Git is working' : undefined;
  return <section className="tool-screen" aria-label="Worktrees">
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>Back to history</Button>
      <div><FolderGit2 aria-hidden="true" /><strong>Worktrees</strong><span className="count">{worktrees.length}</span></div>
      <div className="tool-actions">
        {worktrees.some(entry => entry.prunable) && <Button icon={Scissors} reason={reason} onClick={() => void prune()}
          title="git worktree prune: forget worktrees whose folders are gone">Prune missing</Button>}
        <Button icon={Plus} className="primary" reason={reason} onClick={() => onNew(null)}>New worktree…</Button>
        <Button icon={RefreshCw} reason={reason} onClick={() => void refresh()}>Refresh</Button>
      </div>
    </header>
    <p className="tool-intro muted">Each worktree is a checkout of this repository in its own folder, on its own branch. Fix something on another branch without stashing what you are doing here.</p>
    {note && <div className="operation-note" role="status"><span>{note}</span><button onClick={() => setNote('')} aria-label="Dismiss">×</button></div>}
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></p>}
    {loading && <div className="loading-shell" aria-label="Loading worktrees">{Array.from({ length: 3 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
    <ul className="tool-list" aria-label="Worktrees">
      {worktrees.map(entry => <li key={entry.path}>
        <div className="tool-item">
          <strong>{folderLabel(entry.path)}{worktreeBadges(entry).map(badge => <span key={badge} className="tool-badge">{badge}</span>)}</strong>
          <span>{worktreeLine(entry)}{entry.head && entry.branch ? <code> · {entry.head.slice(0, 7)}</code> : null}</span>
          <code className="tool-path" title={entry.path}>{entry.path}</code>
          {entry.prunable && <small className="warn">Folder missing: {entry.prunable}</small>}
        </div>
        <div className="tool-actions">
          <Button icon={ExternalLink} reason={entry.current ? 'This worktree is open in this tab' : entry.prunable ? 'Its folder is gone' : entry.bare ? 'A bare repository has no files to show' : undefined}
            onClick={() => void onOpen(entry.path)}>Open as tab</Button>
          <Button icon={Trash2} className="danger" reason={worktreeRemoveReason(entry, busy || working)} onClick={() => confirmRemove(entry)}>Remove…</Button>
        </div>
      </li>)}
    </ul>
  </section>;
}
