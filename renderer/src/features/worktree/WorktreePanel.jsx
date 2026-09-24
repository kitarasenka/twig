import { useMemo, useState } from 'react';
import { Check, FilePenLine, FilePlus2, Minus, Plus, Trash2, Undo2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import { SECTIONS, conflictCount, summaryLabel } from './worktree-summary.js';

const ICONS = { staged: Check, unstaged: FilePenLine, untracked: FilePlus2 };

/**
 * What each list's buttons do. Staged work moves back out with a minus,
 * everything else moves in with a plus, which is the same direction the staging
 * screen gives them — so the two screens cannot teach opposite gestures.
 */
const MOVES = {
  staged: { icon: Minus, label: 'Unstage', bulk: 'Unstage all', bulkLabel: 'Unstage every staged file' },
  unstaged: { icon: Plus, label: 'Stage', bulk: 'Stage all', bulkLabel: 'Stage every changed file' },
  untracked: { icon: Plus, label: 'Stage', bulk: 'Stage all', bulkLabel: 'Stage every untracked file' }
};

/**
 * Throwing work away, per list: changes are discarded back to the staged or
 * committed version, untracked files are deleted. Staged work has no discard
 * here — it is unstaged first, so nothing staged disappears in one click.
 * Every one of these asks first (§6.5) and is backed up for Undo.
 */
const DISCARDS = {
  unstaged: { icon: Undo2, label: 'Discard changes to', bulkLabel: 'Discard all unstaged changes' },
  untracked: { icon: Trash2, label: 'Delete', bulkLabel: 'Delete every untracked file' }
};

/**
 * The details panel for the "Uncommitted changes" row: the same right-hand slot
 * a commit gets, filled with what is staged, what is only changed on disk and
 * what Git does not track yet. The lists come from the status the workspace
 * already holds, so nothing here reads Git; the plus and minus buttons run the
 * same channels the staging screen runs. Staging by line, and the commit box
 * itself, stay one click away on that screen.
 */
/**
 * Right-click, or Shift+F10 / the Menu key on a focused row, opens the file
 * menu — the same two ways the commit panel's file rows reach theirs.
 */
function fileMenuProps(file, section, onFileMenu) {
  if (!onFileMenu) return {};
  return {
    onContextMenu: event => { event.preventDefault(); onFileMenu(file, section, event.clientX, event.clientY); },
    onKeyDown: event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onFileMenu(file, section, box.left + 24, box.bottom);
    }
  };
}

export default function WorktreePanel({ summary, branch, open, actions, error, onConsole, onDismissError, onFile, onFileMenu, onStaging, onClose }) {
  const [filter, setFilter] = useState('');
  const query = filter.trim().toLowerCase();
  const sections = useMemo(() => SECTIONS.map(section => ({
    ...section,
    files: summary[section.key].filter(file => file.path.toLowerCase().includes(query))
  })), [summary, query]);
  const conflicts = conflictCount(summary);
  const matches = sections.reduce((count, section) => count + section.files.length, 0);
  const move = (section, file) => (section === 'staged' ? actions.unstage(file) : actions.stage(file));
  const moveAll = section => (section === 'staged' ? actions.unstageAll() : actions.stageAll(section === 'untracked' ? 'untracked' : 'tracked'));
  const bulkReason = section => (section === 'staged' ? actions.reasons.unstageAll : actions.reasons.stageAll);
  return <aside className="commit-detail worktree-panel" aria-label="Uncommitted changes">
    <header className="panel-heading">
      <span>UNCOMMITTED <code>{summary.paths} {summary.paths === 1 ? 'file' : 'files'}</code></span>
      <Button icon={X} aria-label="Close uncommitted changes" onClick={onClose} />
    </header>
    <div className="detail-content">
      <h2>Uncommitted changes</h2>
      <p className="muted">{summaryLabel(summary)}{branch ? ` on ${branch}` : ''}</p>
      {conflicts > 0 && <p className="worktree-panel-conflicts" role="status">
        {conflicts === 1 ? '1 file has a conflict' : `${conflicts} files have conflicts`} to resolve before this can be committed.</p>}
      {error && <div className="history-error worktree-panel-error" role="alert">{error}
        <button onClick={onConsole}>Show output</button>
        <button onClick={onDismissError} aria-label="Dismiss">×</button></div>}
      <div className="worktree-panel-actions">
        <Button className="primary" onClick={onStaging}>Open staging</Button>
      </div>
      <div className="file-controls">
        <input aria-label="Filter uncommitted files" placeholder="Filter files" value={filter} onChange={event => setFilter(event.target.value)} />
      </div>
      {sections.map(section => {
        const Icon = ICONS[section.key];
        const rule = MOVES[section.key];
        const discard = DISCARDS[section.key];
        const total = summary[section.key].length;
        return <section className="worktree-panel-section" key={section.key} aria-label={`${section.title} files`}>
          <div className="files-heading"><Icon /><strong>{section.title}</strong><span className="count">{total}</span>
            {total > 0 && <Button className="bulk" icon={rule.icon} reason={bulkReason(section.key)}
              aria-label={rule.bulkLabel} onClick={() => moveAll(section.key)}>{rule.bulk}</Button>}
            {total > 0 && discard && <Button className="bulk discard" icon={discard.icon} reason={actions.reasons.discardAll}
              aria-label={discard.bulkLabel} title={discard.bulkLabel} onClick={() => actions.discardAll(section.key === 'untracked' ? 'untracked' : 'tracked')} />}</div>
          {section.files.map(file => <div className="worktree-panel-file" key={`${section.key}:${file.path}`}>
            <button className="commit-file" aria-pressed={open?.file === file.path && open?.section === section.key}
              onClick={() => onFile(file, section.key)} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
              {...fileMenuProps(file, section.key, onFileMenu)}>
              <FileStatus status={file.status} /><span>{file.path}</span></button>
            {discard && <Button className="discard" icon={discard.icon} aria-label={`${discard.label} ${file.path}`}
              reason={actions.reasons.discard(file, section.key)} onClick={() => actions.discard(file, section.key)} />}
            <Button icon={rule.icon} aria-label={`${rule.label} ${file.path}`}
              reason={section.key === 'staged' ? actions.reasons.unstage : actions.reasons.stage}
              onClick={() => move(section.key, file)} /></div>)}
          {!section.files.length && <p className="muted">{query ? 'No match here.' : section.empty}</p>}
        </section>;
      })}
      {query && !matches && <p className="muted">Nothing uncommitted matches “{filter}”.</p>}
    </div>
  </aside>;
}
