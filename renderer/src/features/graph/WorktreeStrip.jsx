import { relativeTime } from '../../ui/relative-time.js';
import { changesLine, folderLabel, graphBadges, progressLine, worktreeLine } from '../tools/tools-view.js';
import { LANE_ORIGIN, ROW_HEIGHT } from './layout.js';
import { stripPaths } from './worktree-lanes.js';
import { WorktreeRefIcon } from './worktree-ref.jsx';
import { t, tn } from '../../i18n/i18n.js';

const strongBadge = badge => badge === 'Commit proposed' || badge === 'Done' || badge === '.git leads elsewhere';

/** The lanes through one row of the strip, on the columns the commits below use. */
function StripLanes({ lanes, index, headLane, node = null }) {
  return <span className="lane-cell"><span className="lane-track">
    <svg className="real-lane" aria-hidden="true" height={ROW_HEIGHT}>
      {headLane && <path className="head-link" d={`M${LANE_ORIGIN} 0V${ROW_HEIGHT}`} />}
      {stripPaths(lanes, index, ROW_HEIGHT).map(line => <path key={line.path} className="worktree-link" d={line.d} />)}
      {node}
    </svg>
  </span></span>;
}

/**
 * The other worktrees, one row each, above the commits. Laid out on the same
 * columns as a commit, so a worktree reads as one more line of work next to the
 * others: its branch, a node in its lane with a dashed line down to the commit
 * it stands on, what it has not committed, when it last changed.
 */
export default function WorktreeStrip({ rows, hidden, lanes, headLane, base, selected, visibility, onSelect, onBoard, stripRef }) {
  return <div className="worktree-strip" ref={stripRef} role="group" aria-label={t('Worktrees')}>
    {rows.map((row, index) => {
      const words = [changesLine(row.changes), progressLine(row, base)].filter(Boolean).join(' · ');
      const folder = folderLabel(row.path);
      return <button type="button" key={row.path} className={`worktree-lane-row ${selected === row.path ? 'selected' : ''}`} style={{ height: ROW_HEIGHT }}
        aria-pressed={selected === row.path} title={`${row.path}\n${words ? `${words}\n` : ''}${t('Show what this worktree changed')}`} onClick={() => onSelect(row.path)}>
        <span className="ref-cell">{visibility.branch && <span className="ref-line"><span className="ref-badge worktree-ref"><WorktreeRefIcon card={row} /><span>{worktreeLine(row)}</span></span></span>}</span>
        <StripLanes lanes={lanes} index={index} headLane={headLane}
          node={<circle className={`worktree-node ${row.connected ? 'connected' : ''}`} cx={lanes[index].x} cy={ROW_HEIGHT / 2} r={5} />} />
        <span className="commit-subject"><strong>{folder}</strong><span className="worktree-lane-words">{words}</span>
          {graphBadges(row).map(badge => <span key={badge} className={`tool-badge${strongBadge(badge) ? ' strong' : ''}`}>{t(badge)}</span>)}</span>
        <span className="author-col" />
        <span className="date-cell">{visibility.date && row.lastActivity ? relativeTime(row.lastActivity / 1000) : ''}</span>
      </button>;
    })}
    {hidden > 0 && <button type="button" className="worktree-lane-row worktree-lane-more" style={{ height: ROW_HEIGHT }} onClick={() => onBoard(null)}>
      <span className="ref-cell" />
      <StripLanes lanes={lanes} index={rows.length} headLane={headLane} />
      <span className="commit-subject">{tn(hidden, '{n} more worktree', '{n} more worktrees')}</span>
      <span className="author-col" /><span className="date-cell" />
    </button>}
  </div>;
}
