import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch, Globe, Tag, FilePenLine, Archive, Bookmark } from 'lucide-react';
import { LANE_WIDTH, ROW_HEIGHT, authorInitials, segmentPath, visibleRange } from './layout.js';
import { ageStop, ageStrokeClass, ageTextClass } from './age-color.js';
import { markClass } from './mark-color.js';
import { HISTORY_COLUMNS, dragColumnWidth, nudgeColumnWidth, readColumnWidths, writeColumnWidths } from './column-widths.js';
import { refEndpoint, rowEndpoint } from './useGitDrag.js';

const EMPTY_SELECTION = new Set();

export function relativeDate(value) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return 'just now';
  if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

const CommitRow = memo(function CommitRow({ commit, layout, index, total, selected, member, head, stashes, stashX, onStashes, refs, mark, onSelect, onMenu, dayStart, age, drag, headBranch }) {
  // In age mode a row paints its own age onto every lane crossing it, so the
  // graph reads as one gradient down the page instead of per-branch colours.
  const stroke = age === null ? null : ageStrokeClass(age);
  const laneX = 12 + layout.lane * LANE_WIDTH;
  const endpoint = rowEndpoint(commit, refs, headBranch);
  return <div role="option" id={`commit-${commit.oid}`} aria-selected={selected || member} aria-posinset={index + 1} aria-setsize={total}
    {...drag?.bind(endpoint)}
    className={`real-commit-row ${selected ? 'selected' : member ? 'multi-selected' : ''} ${dayStart ? 'new-day' : ''} ${mark ? `marked ${markClass(mark.color)}` : ''} ${drag?.className(endpoint) || ''} ${drag?.state?.source.oid === commit.oid ? 'drag-source-row' : ''} ${drag?.state?.target?.oid === commit.oid ? 'drag-target-row' : ''}`}
    style={{ top: index * ROW_HEIGHT }} onClick={event => onSelect(commit.oid, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
    onContextMenu={event => { event.preventDefault(); onMenu(commit.oid, event.clientX, event.clientY); }}>
    <span className="ref-cell">
      {mark && <span className="mark-chip" title={mark.note || 'Marked'}><Bookmark aria-label={mark.note ? `Marked: ${mark.note}` : 'Marked'} /></span>}
      {head && <Check aria-label="HEAD" />}{refs?.slice(0, 2).map(ref => <span key={ref.fullName} title={`${ref.fullName} · Drag or Alt+D, then Alt+Enter on a target`} tabIndex={0}
        {...drag?.bind(refEndpoint(ref))} className={`ref-badge ${ref.type === 'remote' ? 'remote-ref' : ''} ${drag?.className(refEndpoint(ref)) || ''}`}>
      {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.name}</span></span>)}
    {refs?.length > 2 && <span className="ref-badge ref-more" title={refs.slice(2).map(ref => ref.fullName).join('\n')}>+{refs.length - 2}</span>}</span>
    <span className="lane-cell">
      <svg className="real-lane" aria-hidden="true" height={ROW_HEIGHT}>
        {stashes && <path className="stash-link" d={`M${laneX} 15H${stashX}`} />}
        {layout.segments.map((segment, i) => <path key={i} className={stroke || `graph-color-${segment.color}`} d={segmentPath(segment)} />)}
        <circle className={stroke || `graph-color-${layout.color}`} cx={laneX} cy={15} r={8} />
        {mark && <circle className="mark-node" cx={laneX} cy={15} r={8} />}
        <text className="commit-initials" x={laneX} y={15}>{authorInitials(commit.author.name)}</text>
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

export default function CommitGraph({ commits, lanes, laneCount, refMap, indexMap, selected, selection, head, onSelect, onMenu, loadMore, hasMore, loading, changes, stashes = [], marks = {}, onWorktree, onStashes, active, commitColors = 'lanes', drag, headBranch }) {
  const selectionSet = selection || EMPTY_SELECTION;
  const scroller = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focusIndex, setFocusIndex] = useState(0);
  const [columns, setColumns] = useState(() => readColumnWidths(window.localStorage));
  const [resizing, setResizing] = useState(null);
  const colResize = useRef(null);
  const columnsRef = useRef(null);
  const KEY_STEP = 12;
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
  // The graph column fits the lanes by default; a drag pins it to a fixed width.
  const autoGraphWidth = Math.max(72, (laneCount + stashLane) * LANE_WIDTH + 24);
  const graphWidth = Number.isFinite(columns.graph) ? columns.graph : autoGraphWidth;
  const columnWidth = key => (key === 'graph' ? graphWidth : columns[key]);
  function beginColResize(key, event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    colResize.current = { key, x: event.clientX, width: columnWidth(key), id: event.pointerId };
    setResizing(key);
  }
  function moveColResize(event) {
    const drag = colResize.current;
    if (!drag || event.pointerId !== drag.id) return;
    const width = dragColumnWidth(drag.key, drag.width, event.clientX - drag.x);
    setColumns(prev => (prev[drag.key] === width ? prev : { ...prev, [drag.key]: width }));
  }
  function endColResize() {
    if (!colResize.current) return;
    colResize.current = null;
    setResizing(null);
    setColumns(prev => { writeColumnWidths(window.localStorage, prev); return prev; });
  }
  function keyColResize(key, event) {
    let next;
    if (event.key === 'ArrowLeft') next = nudgeColumnWidth(key, columnWidth(key), -KEY_STEP);
    else if (event.key === 'ArrowRight') next = nudgeColumnWidth(key, columnWidth(key), KEY_STEP);
    else if (event.key === 'Home' || event.key === 'Enter') next = HISTORY_COLUMNS[key].defaultWidth;
    else return;
    event.preventDefault();
    setColumns(prev => { const merged = { ...prev, [key]: next }; writeColumnWidths(window.localStorage, merged); return merged; });
  }
  function resetColResize(key) {
    setColumns(prev => { const merged = { ...prev, [key]: HISTORY_COLUMNS[key].defaultWidth }; writeColumnWidths(window.localStorage, merged); return merged; });
  }
  const columnHandle = key => <span role="separator" tabIndex={0} aria-orientation="vertical"
    className={`col-resize ${resizing === key ? 'active' : ''}`}
    aria-label={`Resize ${HISTORY_COLUMNS[key].label} column`} title="Drag to resize · double-click to reset"
    aria-valuenow={columnWidth(key)} aria-valuemin={HISTORY_COLUMNS[key].min} aria-valuemax={HISTORY_COLUMNS[key].max}
    onPointerDown={event => beginColResize(key, event)} onPointerMove={moveColResize} onPointerUp={endColResize}
    onPointerCancel={endColResize} onLostPointerCapture={endColResize}
    onDoubleClick={() => resetColResize(key)} onKeyDown={event => keyColResize(key, event)} />;
  const previousSelection = useRef(null);
  const dragY = useRef(null);
  const dragging = drag?.state?.phase === 'drag' && !drag.state.keyboard;
  useEffect(() => {
    if (!dragging) { dragY.current = null; return; }
    let frame;
    let previous = 0;
    const scroll = time => {
      const node = scroller.current;
      const bounds = node.getBoundingClientRect();
      const y = dragY.current;
      const elapsed = Math.min(32, time - (previous || time));
      previous = time;
      if (y !== null && y >= bounds.top && y <= bounds.bottom) {
        const speed = y < bounds.top + 40 ? -1 : y > bounds.bottom - 40 ? 1 : 0;
        node.scrollTop += speed * elapsed * 0.45;
      }
      frame = requestAnimationFrame(scroll);
    };
    frame = requestAnimationFrame(scroll);
    return () => cancelAnimationFrame(frame);
  }, [dragging]);
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
    if (event.altKey && (event.code === 'KeyD' || event.key === 'Enter')) {
      const commit = commits[focusIndex];
      if (commit) drag?.keydown(rowEndpoint(commit, refMap.get(commit.oid), headBranch), event);
      return;
    }
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
  return <div className={`history real-history ${resizing ? 'col-resizing' : ''}`} data-colors={commitColors} style={{
    '--graph-width': `${graphWidth}px`,
    '--col-branch': `${columns.branch}px`, '--col-message': `${columns.message}px`,
    '--col-author': `${columns.author}px`, '--col-date': `${columns.date}px`,
  }}>
    <div className="real-history-columns" ref={columnsRef}>
      <span>Branch / tag{columnHandle('branch')}</span><span>Graph{columnHandle('graph')}</span>
      <span>Commit message{columnHandle('message')}</span>
      <span className="author-col">Author{columnHandle('author')}</span><span>Date{columnHandle('date')}</span>
    </div>
    {changes > 0 && <button className={`worktree-row ${selected === 'worktree' ? 'selected' : ''}`} onClick={onWorktree}><FilePenLine />Uncommitted changes, {changes} files</button>}
    <div className="real-history-scroll" ref={scroller} role="listbox" aria-label="Commit history" aria-multiselectable="true" tabIndex={0}
      onDragOverCapture={event => { if (dragging) dragY.current = event.clientY; }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget)) dragY.current = null; }}
      aria-busy={loading} aria-activedescendant={focused && active ? `commit-${focused}` : undefined}
      onKeyDown={keyboard} onScroll={event => {
        const node = event.currentTarget;
        setViewport({ top: node.scrollTop, height: node.clientHeight });
        // The header is a sibling of the scroller, so it has to be shifted by hand
        // to stay aligned once resized columns push the table wider than the pane.
        if (columnsRef.current) columnsRef.current.style.transform = `translateX(${-node.scrollLeft}px)`;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < ROW_HEIGHT * 15 && hasMore && !loading) loadMore();
      }}>
      <div className="virtual-commits" style={{ height: commits.length * ROW_HEIGHT }}>
        {commits.slice(start, end).map((commit, offset) => <CommitRow key={commit.oid} commit={commit} layout={lanes[start + offset]} index={start + offset} total={commits.length}
          selected={selected === commit.oid} member={selectionSet.has(commit.oid)} head={head === commit.oid} refs={refMap.get(commit.oid)} onSelect={onSelect} onMenu={onMenu} age={now === null ? null : ageStop(commit.committedAt, now)}
          mark={marks[commit.oid] || null} stashes={stashesByBase.get(commit.oid)} stashX={stashX} onStashes={onStashes} drag={drag} headBranch={headBranch}
          dayStart={start + offset > 0 && commit.committedAt.slice(0, 10) !== commits[start + offset - 1].committedAt.slice(0, 10)} />)}
      </div>
    </div>
    <div className="history-pagination">{loading ? <span role="status">Loading history…</span> : hasMore
      ? <button onClick={loadMore}>Load older commits</button>
      : <span>{commits.length ? 'Beginning of history' : 'No commits yet. Create your first commit to start this history.'}</span>}</div>
  </div>;
}
