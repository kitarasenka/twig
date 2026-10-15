import { useMemo, useState } from 'react';
import { Check, FilePenLine, FilePlus2, Minus, Plus, Trash2, Undo2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import FileTree, { FileListControls } from '../diff/FileTree.jsx';
import { ALL_TYPES, baseName, matchesFile, readFileView, writeFileView } from '../diff/file-filter.js';
import { SECTIONS, conflictCount, summaryLabel } from './worktree-summary.js';
import { isMenuKey } from '../../app/shortcuts.js';

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
      if (!isMenuKey(event)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onFileMenu(file, section, box.left + 24, box.bottom);
    }
  };
}

export default function WorktreePanel({ summary, branch, open, actions, error, onConsole, onDismissError, onFile, onFileMenu, onStaging, onClose }) {
  const [filter, setFilter] = useState('');
  const [extension, setExtension] = useState(ALL_TYPES);
  const [view, setView] = useState(readFileView);
  const chooseView = next => { setView(next); writeFileView(next); };
  const query = Boolean(filter.trim()) || extension !== ALL_TYPES;
  const sections = useMemo(() => SECTIONS.map(section => ({
    ...section,
    files: summary[section.key].filter(file => matchesFile(file.path, filter, extension))
  })), [summary, filter, extension]);
  const paths = useMemo(() => SECTIONS.flatMap(section => summary[section.key].map(file => file.path)), [summary]);
  const conflicts = conflictCount(summary);
  const matches = sections.reduce((count, section) => count + section.files.length, 0);
  const move = (section, file) => (section === 'staged' ? actions.unstage(file) : actions.stage(file));
  // With a filter on, the bulk buttons move only what is shown — the files the
  // person picked by name or type — and name how many. Unstaging named files
  // is a per-file restore, so it keeps working during a merge like the minus does.
  const shown = section => (query ? section.files.map(file => file.path) : null);
  const moveAll = section => (section.key === 'staged' ? actions.unstageAll(shown(section))
    : actions.stageAll(section.key === 'untracked' ? 'untracked' : 'tracked', shown(section)));
  const bulkReason = section => (query && !section.files.length ? 'No file here matches the filter'
    : section.key === 'staged' && !query ? actions.reasons.unstageAll : actions.reasons.stageAll);
  return <aside className="commit-detail worktree-panel" aria-label="Uncommitted changes">
    <header className="panel-heading">
      <span>UNCOMMITTED CHANGES</span>
      <Button icon={X} aria-label="Close uncommitted changes" onClick={onClose} />
    </header>
    <div className="detail-content">
      <p className="worktree-panel-summary">{summaryLabel(summary)}{branch ? <> on <strong>{branch}</strong></> : ''}</p>
      {conflicts > 0 && <p className="worktree-panel-conflicts" role="status">
        {conflicts === 1 ? '1 file has a conflict' : `${conflicts} files have conflicts`} to resolve before this can be committed.</p>}
      {error && <div className="history-error worktree-panel-error" role="alert">{error}
        <button onClick={onConsole}>Show output</button>
        <button onClick={onDismissError} aria-label="Dismiss">×</button></div>}
      <div className="worktree-panel-actions">
        <Button className="primary" onClick={onStaging}>Open staging</Button>
      </div>
      <FileListControls view={view} onView={chooseView} filter={filter} onFilter={setFilter}
        extension={extension} onExtension={setExtension} paths={paths} label="uncommitted files" />
      {sections.map(section => {
        const Icon = ICONS[section.key];
        const rule = MOVES[section.key];
        const discard = DISCARDS[section.key];
        const total = summary[section.key].length;
        const row = file => <div className="worktree-panel-file" key={`${section.key}:${file.path}`}>
          <button className="commit-file" aria-pressed={open?.file === file.path && open?.section === section.key}
            onClick={() => onFile(file, section.key)} title={file.originalPath ? `${file.originalPath} → ${file.path}` : file.path}
            {...fileMenuProps(file, section.key, onFileMenu)}>
            <FileStatus status={file.status} /><span>{view === 'tree' ? baseName(file.path) : file.path}</span></button>
          {discard && <Button className="discard" icon={discard.icon} aria-label={`${discard.label} ${file.path}`}
            reason={actions.reasons.discard(file, section.key)} onClick={() => actions.discard(file, section.key)} />}
          <Button className="move" icon={rule.icon} aria-label={`${rule.label} ${file.path}`} title={`${rule.label} ${file.path}`}
            reason={section.key === 'staged' ? actions.reasons.unstage : actions.reasons.stage}
            onClick={() => move(section.key, file)} /></div>;
        return <section className="worktree-panel-section" key={section.key} aria-label={`${section.title} files`}>
          <div className="files-heading"><Icon /><strong>{section.title}</strong><span className="count">{total}</span>
            {total > 0 && <Button className="bulk" icon={rule.icon} reason={bulkReason(section)}
              aria-label={query ? `${rule.label} the ${section.files.length} shown` : rule.bulkLabel}
              onClick={() => moveAll(section)}>{query ? `${rule.label} ${section.files.length} shown` : rule.bulk}</Button>}
            {total > 0 && discard && <Button className="bulk discard" icon={discard.icon}
              reason={query ? 'Clear the filter first: this acts on the whole list' : actions.reasons.discardAll}
              aria-label={discard.bulkLabel} title={discard.bulkLabel} onClick={() => actions.discardAll(section.key === 'untracked' ? 'untracked' : 'tracked')} />}</div>
          {view === 'tree' ? <FileTree files={section.files} renderFile={row} /> : section.files.map(row)}
          {!section.files.length && <p className="muted">{query ? 'No match here.' : section.empty}</p>}
        </section>;
      })}
      {query && !matches && <p className="muted">Nothing uncommitted matches {filter.trim() ? `“${filter.trim()}”` : 'this file type'}.</p>}
    </div>
  </aside>;
}
