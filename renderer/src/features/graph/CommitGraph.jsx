import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch, Globe, Tag, FilePenLine, Archive, Bookmark } from 'lucide-react';
import { LANE_WIDTH, ROW_HEIGHT, segmentPath, visibleRange } from './layout.js';
import { ageStop, ageStrokeClass, ageTextClass } from './age-color.js';
import { markClass } from './mark-color.js';

export function relativeDate(value) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return 'just now';
  if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

const CommitRow = memo(function CommitRow({ commit, layout, index, total, selected, head, stashes, stashX, onStashes, refs, mark, onSelect, onMenu, dayStart, age }) {
  // In age mode a row paints its own age onto every lane crossing it, so the
  // graph reads as one gradient down the page instead of per-branch colours.
  const stroke = age === null ? null : ageStrokeClass(age);
  const laneX = 12 + layout.lane * LANE_WIDTH;
  return <div role="option" id={`commit-${commit.oid}`} aria-selected={selected} aria-posinset={index + 1} aria-setsize={total}
    className={`real-commit-row ${selected ? 'selected' : ''} ${dayStart ? 'new-day' : ''} ${mark ? `marked ${markClass(mark.color)}` : ''}`}
    style={{ top: index * ROW_HEIGHT }} onClick={event => onSelect(commit.oid, event.shiftKey)}
    onContextMenu={event => { event.preventDefault(); onSelect(commit.oid); onMenu(commit.oid, event.clientX, event.clientY); }}>
    <span className="ref-cell">
      {mark && <span className="mark-chip" title={mark.note || 'Marked'}><Bookmark aria-label={mark.note ? `Marked: ${mark.note}` : 'Marked'} /></span>}
      {head && <Check aria-label="HEAD" />}{refs?.slice(0, 2).map(ref => <span key={ref.fullName} title={ref.fullName} className={`ref-badge ${ref.type === 'remote' ? 'remote-ref' : ''}`}>
      {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.name}</span></span>)}
    {refs?.length > 2 && <span className="ref-badge ref-more" title={refs.slice(2).map(ref => ref.fullName).join('\n')}>+{refs.length - 2}</span>}</span>
    <span className="lane-cell">
      <svg className="real-lane" aria-hidden="true" height={ROW_HEIGHT}>
        {stashes && <path className="stash-link" d={`M${laneX} 15H${stashX}`} />}
        {layout.segments.map((segment, i) => <path key={i} className={stroke || `graph-color-${segment.color}`} d={segmentPath(segment)} />)}
        <circle className={stroke || `graph-color-${layout.color}`} cx={laneX} cy={15} r={4} />
        {mark && <circle className="mark-node" cx={laneX} cy={15} r={5} />}
      </svg>
      {stashes && <button className="stash-node" style={{ '--stash-x': `${stashX}px` }}
        title={`${stashes.length === 1 ? 'Stash' : `${stashes.length} stashes`} on this commit:\n${stashes.map(item => item.message).join('\n')}`}
        aria-label={`Open ${stashes.length === 1 ? 'the stash' : 'stashes'} based on this commit`}
        onClick={event => { event.stopPropagation(); onStashes(); }}>
        <Archive />{stashes.length > 1 && <span>{stashes.length}</span>}</button>}
    </span>
    <span className="commit-subject" title={`${commit.subject}\n${commit.body}`}><span>{commit.subject || '(no subject)'}</span><span className="commit-preview">{commit.body.replace(/\s+/g, ' ')}</span></span>
    <span className="author-col" title={commit.author.email}>{commit.author.name}</span>
    <span className={`date-cell ${age === null ? '' : ageTextClass(age)}`} title={commit.committedAt}>{relativeDate(commit.committedAt)}</span>
  </div>;
});

export default function CommitGraph({ commits, lanes, laneCount, refMap, indexMap, selected, head, onSelect, onMenu, loadMore, hasMore, loading, changes, stashes = [], marks = {}, onWorktree, onStashes, active, commitColors = 'lanes' }) {
  const scroller = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focusIndex, setFocusIndex] = useState(0);
  const previousSelection = useRef(null);
  useLayoutEffect(() => {
    const node = scroller.current;
    const observer = new ResizeObserver(() => {
      if (node.clientHeight) setViewport({ top: node.scrollTop, height: node.clientHeight });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const index = indexMap.get(selected);
    if (index === undefined || previousSelection.current === selected) return;
    previousSelection.current = selected;
    setFocusIndex(index);
    const node = scroller.current;
    if (index * ROW_HEIGHT < node.scrollTop) node.scrollTop = index * ROW_HEIGHT;
    else if ((index + 1) * ROW_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTop = (index + 1) * ROW_HEIGHT - node.clientHeight;
    setViewport({ top: node.scrollTop, height: node.clientHeight || 600 });
  }, [selected, indexMap]);
  const { start, end } = visibleRange(commits.length, viewport.top, viewport.height);
  const focused = focusIndex >= start && focusIndex < end ? commits[focusIndex]?.oid : null;
  function keyboard(event) {
    // Shift+F10 and the Menu key are how a keyboard reaches a context menu;
    // the menu opens over the focused row rather than at the pointer.
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const commit = commits[focusIndex];
      if (!commit) return;
      event.preventDefault();
      const row = scroller.current.querySelector(`#commit-${CSS.escape(commit.oid)}`)?.getBoundingClientRect();
      onMenu(commit.oid, row ? row.left + 24 : 24, row ? row.bottom : 24);
      return;
    }
    let index = focusIndex;
    if (event.key === 'ArrowDown') index++;
    else if (event.key === 'ArrowUp') index--;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = commits.length - 1;
    else if (event.key === 'PageDown') index += Math.floor(viewport.height / ROW_HEIGHT);
    else if (event.key === 'PageUp') index -= Math.floor(viewport.height / ROW_HEIGHT);
    else return;
    event.preventDefault();
    index = Math.max(0, Math.min(index, commits.length - 1));
    if (commits[index]) onSelect(commits[index].oid, event.shiftKey);
    if (index >= commits.length - 2 && hasMore && !loading) loadMore();
  }
  // One clock reading per render, shared by every visible row: age is a property
  // of the moment the graph is drawn, not of each row on its own.
  const now = commitColors === 'age' ? Date.now() : null;
  // A stash is parked work, not a commit: it hangs off the commit it was based
  // on by a dashed link into an extra lane on the right, keyed by that base oid.
  const stashesByBase = useMemo(() => {
    const map = new Map();
    for (const stash of stashes) {
      if (!stash.base) continue;
      const list = map.get(stash.base);
      if (list) list.push(stash); else map.set(stash.base, [stash]);
    }
    return map;
  }, [stashes]);
  const stashLane = stashesByBase.size ? 1 : 0;
  const stashX = 12 + laneCount * LANE_WIDTH;
  return <div className="history real-history" data-colors={commitColors} style={{ '--graph-width': `${Math.max(72, (laneCount + stashLane) * LANE_WIDTH + 24)}px` }}>
    <div className="real-history-columns"><span>Branch / tag</span><span>Graph</span><span>Commit message</span><span className="author-col">Author</span><span>Date</span></div>
    {changes > 0 && <button className={`worktree-row ${selected === 'worktree' ? 'selected' : ''}`} onClick={onWorktree}><FilePenLine />Uncommitted changes, {changes} files</button>}
    <div className="real-history-scroll" ref={scroller} role="listbox" aria-label="Commit history" tabIndex={0}
      aria-busy={loading} aria-activedescendant={focused && active ? `commit-${focused}` : undefined}
      onKeyDown={keyboard} onScroll={event => {
        const node = event.currentTarget;
        setViewport({ top: node.scrollTop, height: node.clientHeight });
        if (node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT * 15 && hasMore && !loading) loadMore();
      }}>
      <div className="virtual-commits" style={{ height: commits.length * ROW_HEIGHT }}>
        {commits.slice(start, end).map((commit, offset) => <CommitRow key={commit.oid} commit={commit} layout={lanes[start + offset]} index={start + offset} total={commits.length}
          selected={selected === commit.oid} head={head === commit.oid} refs={refMap.get(commit.oid)} onSelect={onSelect} onMenu={onMenu} age={now === null ? null : ageStop(commit.committedAt, now)}
          mark={marks[commit.oid] || null} stashes={stashesByBase.get(commit.oid)} stashX={stashX} onStashes={onStashes}
          dayStart={start + offset > 0 && commit.committedAt.slice(0, 10) !== commits[start + offset - 1].committedAt.slice(0, 10)} />)}
      </div>
    </div>
    <div className="history-pagination">{loading ? <span role="status">Loading history…</span> : hasMore
      ? <button onClick={loadMore}>Load older commits</button>
      : <span>{commits.length ? 'Beginning of history' : 'No commits yet. Create your first commit to start this history.'}</span>}</div>
  </div>;
}
