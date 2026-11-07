import { useDeferredValue, useMemo, useState } from 'react';
import { Check, FilePenLine, FilePlus2, Minus, Plus, Trash2, Undo2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import FileStatus from '../diff/FileStatus.jsx';
import FileList from '../diff/FileList.jsx';
import { FileListControls } from '../diff/FileTree.jsx';
import { ALL_TYPES, baseName, matchesFile, readFileView, writeFileView } from '../diff/file-filter.js';
import { SECTIONS, conflictCount, summaryLabel } from './worktree-summary.js';
import { isMenuKey } from '../../app/shortcuts.js';
import { mark, t, tn } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

const ICONS = { staged: Check, unstaged: FilePenLine, untracked: FilePlus2 };
const SECTION_LABELS = { staged: mark('Staged files'), unstaged: mark('Changed files'), untracked: mark('Untracked files') };

/**
 * What each list's buttons do. Staged work moves back out with a minus,
 * everything else moves in with a plus, which is the same direction the staging
 * screen gives them — so the two screens cannot teach opposite gestures.
 */
const MOVES = {
  staged: { icon: Minus, file: path => t`Unstage ${path}`, bulk: mark('Unstage all'), bulkLabel: mark('Unstage every staged file'),
    shown: count => tn(count, 'Unstage {n} shown', 'Unstage {n} shown'), shownLabel: count => tn(count, 'Unstage the {n} shown', 'Unstage the {n} shown') },
  unstaged: { icon: Plus, file: path => t`Stage ${path}`, bulk: mark('Stage all'), bulkLabel: mark('Stage every changed file'),
    shown: count => tn(count, 'Stage {n} shown', 'Stage {n} shown'), shownLabel: count => tn(count, 'Stage the {n} shown', 'Stage the {n} shown') },
  untracked: { icon: Plus, file: path => t`Stage ${path}`, bulk: mark('Stage all'), bulkLabel: mark('Stage every untracked file'),
    shown: count => tn(count, 'Stage {n} shown', 'Stage {n} shown'), shownLabel: count => tn(count, 'Stage the {n} shown', 'Stage the {n} shown') }
};

/**
 * Throwing work away, per list: changes are discarded back to the staged or
 * committed version, untracked files are deleted. Staged work has no discard
 * here — it is unstaged first, so nothing staged disappears in one click.
 * Every one of these asks first (§6.5) and is backed up for Undo.
 */
const DISCARDS = {
  unstaged: { icon: Undo2, file: path => t`Discard changes to ${path}`, bulkLabel: mark('Discard all unstaged changes') },
  untracked: { icon: Trash2, file: path => t`Delete ${path}`, bulkLabel: mark('Delete every untracked file') }
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

export default function WorktreePanel({ summary, branch, unborn = false, open, actions, error, onConsole, onDismissError, onFile, onFileMenu, onStaging, onClose }) {
  const [filter, setFilter] = useState('');
  const [extension, setExtension] = useState(ALL_TYPES);
  const [view, setView] = useState(readFileView);
  const chooseView = next => { setView(next); writeFileView(next); };
  const query = Boolean(filter.trim()) || extension !== ALL_TYPES;
  const typed = useDeferredValue(filter);
  const sections = useMemo(() => SECTIONS.map(section => ({
    ...section,
    files: summary[section.key].filter(file => matchesFile(file.path, typed, extension))
  })), [summary, typed, extension]);
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
  const bulkReason = section => (query && !section.files.length ? t('No file here matches the filter')
    : section.key === 'staged' && !query ? actions.reasons.unstageAll : actions.reasons.stageAll);
  return <aside className="commit-detail worktree-panel" aria-label={t('Uncommitted changes')}>
    <header className="panel-heading">
      <span>{t('UNCOMMITTED CHANGES')}</span>
      <Button icon={X} aria-label={t('Close uncommitted changes')} onClick={onClose} />
    </header>
    <div className="detail-content">
      {unborn && !summary.paths && <p className="worktree-panel-conflicts">{t('No commits yet. Put your files in this folder, then open staging to make the first commit.')}</p>}
      <p className="worktree-panel-summary">{branch
        ? tx('{summary} on {branch}', { summary: summaryLabel(summary), branch: <strong>{branch}</strong> })
        : summaryLabel(summary)}</p>
      {conflicts > 0 && <p className="worktree-panel-conflicts" role="status">
        {tn(conflicts, '{n} file has a conflict to resolve before this can be committed.', '{n} files have conflicts to resolve before this can be committed.')}</p>}
      {error && <div className="history-error worktree-panel-error" role="alert">{error}
        <button onClick={onConsole}>{t('Show output')}</button>
        <button onClick={onDismissError} aria-label={t('Dismiss')}>×</button></div>}
      <div className="worktree-panel-actions">
        <Button className="primary" onClick={onStaging}>{t('Open staging')}</Button>
      </div>
      <FileListControls view={view} onView={chooseView} filter={filter} onFilter={setFilter}
        extension={extension} onExtension={setExtension} paths={paths} label={t('uncommitted files')} />
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
          {section.key === 'unstaged' && file.status === 'A'
            ? <Button className="discard" icon={X} aria-label={t`Stop tracking ${file.path}`} title={t`Stop tracking ${file.path}`}
              reason={actions.reasons.unstage} onClick={() => actions.unstage(file)} />
            : discard && <Button className="discard" icon={discard.icon} aria-label={discard.file(file.path)}
              reason={actions.reasons.discard(file, section.key)} onClick={() => actions.discard(file, section.key)} />}
          <Button className="move" icon={rule.icon} aria-label={rule.file(file.path)} title={rule.file(file.path)}
            reason={file.status === 'U' ? t('Open it to resolve the conflict') : section.key === 'staged' ? actions.reasons.unstage : actions.reasons.stage}
            onClick={() => move(section.key, file)} /></div>;
        return <section className="worktree-panel-section" key={section.key} aria-label={t(SECTION_LABELS[section.key])}>
          <div className="files-heading"><Icon /><strong>{t(section.title)}</strong><span className="count">{total}</span>
            {total > 0 && <Button className="bulk" icon={rule.icon} reason={bulkReason(section)}
              aria-label={query ? rule.shownLabel(section.files.length) : t(rule.bulkLabel)}
              onClick={() => moveAll(section)}>{query ? rule.shown(section.files.length) : t(rule.bulk)}</Button>}
            {total > 0 && discard && <Button className="bulk discard" icon={discard.icon}
              reason={query ? t('Clear the filter first: this acts on the whole list') : actions.reasons.discardAll}
              aria-label={t(discard.bulkLabel)} title={t(discard.bulkLabel)} onClick={() => actions.discardAll(section.key === 'untracked' ? 'untracked' : 'tracked')} />}</div>
          <FileList files={section.files} view={view} renderFile={row} />
          {!section.files.length && <p className="muted">{query ? t('No match here.') : t(section.empty)}</p>}
        </section>;
      })}
      {query && !matches && <p className="muted">{filter.trim() ? t`Nothing uncommitted matches “${filter.trim()}”.` : t('Nothing uncommitted matches this file type.')}</p>}
    </div>
  </aside>;
}
