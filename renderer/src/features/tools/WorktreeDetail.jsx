import { useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderGit2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { relativeTime } from '../../ui/relative-time.js';
import ReviewFiles from './ReviewFiles.jsx';
import { changesLine, connectedLine, folderLabel, graphBadges, progressLine, worktreeLine } from './tools-view.js';
import { failureText, t } from '../../i18n/i18n.js';

/**
 * A worktree chosen in the graph, in the details panel: where it stands and
 * everything it changed since its branch left the base. Reading only: squash,
 * compare and remove are on the Worktrees screen, one click away.
 */
export default function WorktreeDetail({ repositoryId, card, base, openPath, onFile, onOpen, onBoard, onClose }) {
  const [review, setReview] = useState(null);
  const request = useRef(0);
  const reviewable = !card.main;
  // Read again whenever the card's numbers move: the agent committed or edited something.
  const key = `${card.path}:${card.head}:${card.changes?.files}:${card.changes?.insertions}:${card.changes?.deletions}:${card.lastActivity}`;
  useEffect(() => {
    const epoch = ++request.current;
    if (!reviewable) { setReview(null); return; }
    window.twig.getWorktreeReview(repositoryId, card.path)
      .then(next => { if (epoch === request.current) setReview(next); })
      .catch(failure => { if (epoch === request.current) setReview({ folder: card.path, error: failureText(failure, t('Could not read what this worktree changed.')) }); });
  }, [repositoryId, key, reviewable]); // eslint-disable-line react-hooks/exhaustive-deps

  const folder = folderLabel(card.path);
  const shown = review?.folder === card.path ? review : null;
  const badges = graphBadges(card);
  return <aside className="commit-detail worktree-detail" aria-label={t`Worktree ${folder}`}>
    <header className="panel-heading">
      <span>{t('WORKTREE')} <code>{folder}</code></span>
      <Button icon={X} aria-label={t('Close worktree details')} onClick={onClose} />
    </header>
    <div className="detail-content">
      <h2 className="commit-subject-heading">{worktreeLine(card)}</h2>
      <code className="tool-path" title={card.path}>{card.path}</code>
      {badges.length > 0 && <p className="worktree-detail-badges">{badges.map(badge => <span key={badge} className="tool-badge">{t(badge)}</span>)}</p>}
      {progressLine(card, base) && <p>{progressLine(card, base)}</p>}
      {card.changes && <p>{changesLine(card.changes)}</p>}
      {card.connected && <p className="board-connected">{connectedLine(card.connected, relativeTime)}</p>}
      {card.lastActivity && <p className="muted">{t`Changed ${relativeTime(card.lastActivity / 1000)}`}</p>}
      <div className="tool-actions">
        <Button icon={ExternalLink} onClick={() => onOpen(card.path)}>{t('Open as tab')}</Button>
        <Button icon={FolderGit2} onClick={() => onBoard(card.path)}>{t('All worktrees')}</Button>
      </div>
      {reviewable && (!shown ? <div className="loading-shell" aria-label={t('Reading what this worktree changed')}><div className="skeleton" /></div>
        : shown.error ? <p role="alert" className="empty-inline">{shown.error}</p>
          : <>
            {shown.commits.length > 0 && <ul className="board-commits" aria-label={t('Commits in this worktree')}>
              {shown.commits.map(commit => <li key={commit.oid}><code>{commit.oid.slice(0, 7)}</code><span>{commit.subject}</span></li>)}
            </ul>}
            <ReviewFiles files={shown.files} openPath={openPath} onFile={onFile} />
          </>)}
    </div>
  </aside>;
}
