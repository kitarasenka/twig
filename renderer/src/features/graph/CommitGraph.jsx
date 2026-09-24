import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, GitBranch, Globe, Tag, FilePenLine, Archive, Bookmark, Bug, CheckCircle2, FlaskConical, SkipForward, XCircle } from 'lucide-react';
import { LANE_WIDTH, ROW_HEIGHT, authorInitials, createRowMetrics, segmentPath } from './layout.js';
import { HEAD_WIDTH, MARK_WIDTH, badgeWidth, extraHeight, packRefLines } from './ref-lines.js';
import { ageStop, ageStrokeClass, ageTextClass } from './age-color.js';
import { markClass } from './mark-color.js';
import { bisectClass } from './bisect-marks.js';
import { HISTORY_COLUMNS, TOGGLABLE_COLUMNS, dragColumnWidth, nudgeColumnWidth, readColumnWidths, writeColumnWidths, readColumnVisibility, writeColumnVisibility } from './column-widths.js';
import { refEndpoint, rowEndpoint } from './useGitDrag.js';
import { summaryChips } from '../worktree/worktree-summary.js';
import Menu from '../../ui/Menu.jsx';

const EMPTY_SELECTION = new Set();
const NO_BISECT_MARKS = new Map();
const BISECT_ICONS = { culprit: Bug, bad: XCircle, good: CheckCircle2, skip: SkipForward, testing: FlaskConical };

/** A BugHunter answer on the commit it was given for: an icon and the word, never colour alone. */
function BisectChip({ mark }) {
  const Icon = BISECT_ICONS[mark.kind] || SkipForward;
  return <span className={bisectClass(mark.kind)} title={mark.title}><Icon aria-hidden="true" /><span>{mark.word}</span></span>;
}
/** What `selected` holds while the uncommitted row, not a commit, is chosen. */
export const UNCOMMITTED = 'uncommitted';
const EMPTY_LINES = [[]];
/** The Branch / tag cell keeps a gap to the graph column (`padding-right`). */
const REF_CELL_PADDING = 8;

/** Measures ref names in the badge font (10px of --font-ui) on an offscreen
 * canvas: no layout, no reflow, one measurement per distinct name. Without a
 * canvas (an old engine, a headless stub) it falls back to a per-character
 * estimate, which only costs a slightly loose line break. */
function makeTextMeasure() {
  const cache = new Map();
  let context = null;
  try {
    context = document.createElement('canvas').getContext('2d');
    const family = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
    context.font = `10px ${family || 'sans-serif'}`;
  } catch {
    context = null;
  }
  return text => {
    let width = cache.get(text);
    if (width === undefined) {
      width = context ? context.measureText(text).width : text.length * 5.6;
      cache.set(text, width);
    }
    return width;
  };
}

export function relativeDate(value) {
  const seconds = Math.round((Date.parse(value) - Date.now()) / 1000);
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return 'just now';
  if (Math.abs(seconds) < 3600) return format.format(Math.round(seconds / 60), 'minute');
  if (Math.abs(seconds) < 86400) return format.format(Math.round(seconds / 3600), 'hour');
  return format.format(Math.round(seconds / 86400), 'day');
}

const CommitRow = memo(function CommitRow({ commit, layout, top, height, total, index, selected, member, head, stashes, stashX, onStashes, refs, refLines, mark, bisect, onSelect, onMenu, dayStart, age, drag, headBranch, visibility }) {
  // In age mode a row paints its own age onto every lane crossing it, so the
  // graph reads as one gradient down the page instead of per-branch colours.
  const stroke = age === null ? null : ageStrokeClass(age);
  const laneX = 12 + layout.lane * LANE_WIDTH;
  const endpoint = rowEndpoint(commit, refs, headBranch);
  return <div role="option" id={`commit-${commit.oid}`} aria-selected={selected || member} aria-posinset={index + 1} aria-setsize={total}
    {...drag?.bind(endpoint)}
    className={`real-commit-row ${selected ? 'selected' : member ? 'multi-selected' : ''} ${dayStart ? 'new-day' : ''} ${mark ? `marked ${markClass(mark.color)}` : ''} ${drag?.className(endpoint) || ''} ${drag?.state?.source.oid === commit.oid ? 'drag-source-row' : ''} ${drag?.state?.target?.oid === commit.oid ? 'drag-target-row' : ''}`}
    style={{ top, height }} onClick={event => onSelect(commit.oid, { shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
    onContextMenu={event => { event.preventDefault(); onMenu(commit.oid, event.clientX, event.clientY); }}>
    <span className="ref-cell">
      {visibility.branch && refLines.map((line, lineIndex) => <span className="ref-line" key={lineIndex}>
        {lineIndex === 0 && mark && <span className="mark-chip" title={mark.note || 'Marked'}><Bookmark aria-label={mark.note ? `Marked: ${mark.note}` : 'Marked'} /></span>}
        {lineIndex === 0 && head && <Check aria-label="HEAD" />}
        {line.map(refIndex => refs[refIndex]).map(ref => <span key={ref.fullName} title={`${ref.fullName} · Drag or Alt+D, then Alt+Enter on a target`} tabIndex={0}
          {...drag?.bind(refEndpoint(ref))} className={`ref-badge ${ref.type === 'remote' ? 'remote-ref' : ''} ${drag?.className(refEndpoint(ref)) || ''}`}>
          {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.name}</span></span>)}
      </span>)}</span>
    <span className="lane-cell">
      <svg className="real-lane" aria-hidden="true" height={height}>
        {stashes && <path className="stash-link" d={`M${laneX} ${height / 2}H${stashX}`} />}
        {layout.segments.map((segment, i) => <path key={i} className={stroke || `graph-color-${segment.color}`} d={segmentPath(segment, height)} />)}
        <circle className={stroke || `graph-color-${layout.color}`} cx={laneX} cy={height / 2} r={8} />
        {mark && <circle className="mark-node" cx={laneX} cy={height / 2} r={8} />}
        <text className="commit-initials" x={laneX} y={height / 2}>{authorInitials(commit.author.name)}</text>
      </svg>
      {stashes && <button className="stash-node" style={{ '--stash-x': `${stashX}px` }}
        title={`${stashes.length === 1 ? 'Stash' : `${stashes.length} stashes`} on this commit:\n${stashes.map(item => item.message).join('\n')}`}
        aria-label={`Open ${stashes.length === 1 ? 'the stash' : 'stashes'} based on this commit`}
        onClick={event => { event.stopPropagation(); onStashes(); }}>
        <Archive />{stashes.length > 1 && <span>{stashes.length}</span>}</button>}
    </span>
    <span className="commit-subject" title={`${bisect ? `${bisect.title}\n` : ''}${commit.subject}\n${commit.body}`}>{bisect && <BisectChip mark={bisect} />}<span>{commit.subject || '(no subject)'}</span><span className="commit-preview">{commit.body.replace(/\s+/g, ' ')}</span></span>
    <span className="author-col" title={visibility.author ? commit.author.email : undefined}>{visibility.author && commit.author.name}</span>
    <span className={`date-cell ${age === null ? '' : ageTextClass(age)}`} title={visibility.date ? commit.committedAt : undefined}>{visibility.date && relativeDate(commit.committedAt)}</span>
  </div>;
});

export default function CommitGraph({ commits, lanes, laneCount, refMap, indexMap, selected, selection, head, onSelect, onMenu, loadMore, hasMore, loading, summary = null, stashes = [], marks = {}, bisectMarks = NO_BISECT_MARKS, onUncommitted, onStashes, active, commitColors = 'lanes', drag, headBranch }) {
  const selectionSet = selection || EMPTY_SELECTION;
  const scroller = useRef(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const [focusIndex, setFocusIndex] = useState(0);
  const [columns, setColumns] = useState(() => readColumnWidths(window.localStorage));
  const [visibility, setVisibility] = useState(() => readColumnVisibility(window.localStorage));
  const [columnMenu, setColumnMenu] = useState(null);
  const [resizing, setResizing] = useState(null);
  const colResize = useRef(null);
  const columnsRef = useRef(null);
  const [fontsReady, setFontsReady] = useState(false);
  const KEY_STEP = 12;
  // Badge widths are measured with the very font the badges are drawn in, so
  // the lines we lay out are the lines the browser paints. One canvas, one
  // measurement per distinct ref name; no DOM is touched per row.
  const measure = useMemo(() => {
    void fontsReady; // re-measure once the web font has replaced the fallback
    return makeTextMeasure();
  }, [fontsReady]);
  useEffect(() => {
    // Fira Sans arrives after the first paint; re-measure once it has.
    let live = true;
    document.fonts?.ready.then(() => { if (live) setFontsReady(true); });
    return () => { live = false; };
  }, []);
  // A hidden column keeps its grid track but shrinks to nothing, rather than
  // dropping the track: that would shift every later column into the wrong slot.
  const visibleWidth = key => (visibility[key] ? columns[key] : 0);
  // Badges wrap instead of collapsing into `+N`, so a row with many refs is
  // taller than the rest. The wrapping is computed here, ahead of the render,
  // because virtualization needs every row's height before it draws any row.
  const { refLines, metrics } = useMemo(() => {
    const available = (visibility.branch ? columns.branch : 0) - REF_CELL_PADDING;
    const lines = new Map();
    const extras = [];
    if (available > 0) {
      for (let index = 0; index < commits.length; index += 1) {
        const oid = commits[index].oid;
        const refs = refMap.get(oid);
        if (!refs?.length) continue;
        const lead = (marks[oid] ? MARK_WIDTH : 0) + (head === oid ? HEAD_WIDTH : 0);
        const packed = packRefLines(refs.map(ref => badgeWidth(ref.name, measure)), available, lead);
        lines.set(oid, packed);
        const extra = extraHeight(packed.length);
        if (extra) extras.push([index, extra]);
      }
    }
    return { refLines: lines, metrics: createRowMetrics(extras) };
  }, [commits, refMap, marks, head, visibility.branch, columns.branch, measure]);
  function toggleColumn(key) {
    setVisibility(prev => {
      const next = { ...prev, [key]: !prev[key] };
      writeColumnVisibility(window.localStorage, next);
      return next;
    });
  }
  function openColumnMenu(event) {
    event.preventDefault();
    setColumnMenu({ x: event.clientX, y: event.clientY });
  }
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
    const top = metrics.top(index);
    const bottom = top + metrics.height(index);
    if (top < node.scrollTop) node.scrollTop = top;
    else if (bottom > node.scrollTop + node.clientHeight) node.scrollTop = bottom - node.clientHeight;
    setViewport({ top: node.scrollTop, height: node.clientHeight || 600 });
  }, [selected, indexMap, metrics]);
  const { start, end } = metrics.range(commits.length, viewport.top, viewport.height);
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
    '--col-branch': `${visibleWidth('branch')}px`, '--col-message': `${columns.message}px`,
    '--col-author': `${visibleWidth('author')}px`, '--col-date': `${visibleWidth('date')}px`,
  }}>
    <div className="real-history-columns" ref={columnsRef} onContextMenu={openColumnMenu}>
      <span>{visibility.branch && <>Branch / tag{columnHandle('branch')}</>}</span><span>Graph{columnHandle('graph')}</span>
      <span>Commit message{columnHandle('message')}</span>
      <span className="author-col">{visibility.author && <>Author{columnHandle('author')}</>}</span>
      <span>{visibility.date && <>Date{columnHandle('date')}</>}</span>
    </div>
    {columnMenu && <Menu x={columnMenu.x} y={columnMenu.y} label="Show columns" onClose={() => setColumnMenu(null)}
      items={TOGGLABLE_COLUMNS.map(key => ({
        key, text: HISTORY_COLUMNS[key].label, checked: visibility[key], stayOpen: true, run: () => toggleColumn(key),
      }))} />}
    {summary && summary.paths > 0 && <button className={`worktree-row ${selected === UNCOMMITTED ? 'selected' : ''}`}
      aria-pressed={selected === UNCOMMITTED} title="Show the uncommitted files in the details panel"
      onClick={onUncommitted}>
      <span className="worktree-row-icon"><FilePenLine aria-hidden="true" /></span>
      <span className="worktree-row-text">Uncommitted changes, {summary.paths} file{summary.paths === 1 ? '' : 's'}</span>
      <span className="worktree-row-chips">{summaryChips(summary).map(chip =>
        <span className={`worktree-chip chip-${chip.key}`} key={chip.key}>{chip.text}</span>)}</span>
    </button>}
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
      <div className="virtual-commits" style={{ height: metrics.totalHeight(commits.length) }}>
        {commits.slice(start, end).map((commit, offset) => <CommitRow key={commit.oid} commit={commit} layout={lanes[start + offset]} index={start + offset} total={commits.length}
          top={metrics.top(start + offset)} height={metrics.height(start + offset)} refLines={refLines.get(commit.oid) || EMPTY_LINES}
          selected={selected === commit.oid} member={selectionSet.has(commit.oid)} head={head === commit.oid} refs={refMap.get(commit.oid)} onSelect={onSelect} onMenu={onMenu} age={now === null ? null : ageStop(commit.committedAt, now)}
          mark={marks[commit.oid] || null} bisect={bisectMarks.get(commit.oid.toLowerCase()) || null} stashes={stashesByBase.get(commit.oid)} stashX={stashX} onStashes={onStashes} drag={drag} headBranch={headBranch} visibility={visibility}
          dayStart={start + offset > 0 && commit.committedAt.slice(0, 10) !== commits[start + offset - 1].committedAt.slice(0, 10)} />)}
      </div>
    </div>
    <div className="history-pagination">{loading ? <span role="status">Loading history…</span> : hasMore
      ? <button onClick={loadMore}>Load older commits</button>
      : <span>{commits.length ? 'Beginning of history' : 'No commits yet. Create your first commit to start this history.'}</span>}</div>
  </div>;
}
