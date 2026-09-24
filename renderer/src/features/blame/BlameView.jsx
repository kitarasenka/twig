import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ChevronsLeft, GitBranch, History, RotateCcw, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Menu from '../../ui/Menu.jsx';
import { cacheKey, readCache, writeCache } from './blame-cache.js';
import { languageFor } from '../diff/languages.js';
import useHighlighter from '../diff/useHighlighter.js';
import { splitByRanges } from '../diff/diff-view.js';
import useDiffPrefs from '../diff/useDiffPrefs.js';

const ROW = 22;
const OVERSCAN = 8;

function shortDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-GB');
}

/** Stable colour index per commit, assigned in first-seen order and cycled. */
function colourMap(lines) {
  const map = new Map();
  for (const line of lines) if (!map.has(line.oid)) map.set(line.oid, map.size % 6);
  return map;
}

/**
 * Blame, Blame History and Reverse Blame for one committed version of a file.
 *
 * The version shown is exactly the blamed commit — local uncommitted changes
 * never leak in, because every read is `git blame <oid>` / `--reverse
 * <start>..<end>`, never the working tree. Back/Forward walk a local chain of
 * steps; that chain is independent of Git Undo/Redo (nothing here mutates).
 */
export default function BlameView({ repository, seed, onClose, onJump, onConsole, onSelect }) {
  const [chain, setChain] = useState(() => [{ mode: 'blame', oid: seed.oid, path: seed.path, endRef: null, mapping: null }]);
  const [pos, setPos] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState(seed.line || 1);
  const [anchor, setAnchor] = useState(seed.line || 1);
  const [hoverOid, setHoverOid] = useState(null);
  const [notice, setNotice] = useState(null);
  const [parentPick, setParentPick] = useState(null);
  const [reverseForm, setReverseForm] = useState(null);
  const [rowMenu, setRowMenu] = useState(null);
  const [viewport, setViewport] = useState({ top: 0, height: 600 });
  const scroller = useRef(null);
  const request = useRef(0);
  const scrollMemo = useRef(new Map());
  const entry = chain[pos];
  const mode = entry.mode;

  const load = useCallback(async (target, restoreScroll) => {
    const id = ++request.current;
    setLoading(true); setNotice(null);
    const key = cacheKey({ repositoryId: repository.id, mode: target.mode, oid: target.oid,
      path: target.path, endOid: target.mode === 'reverse' ? target.endRef || 'HEAD' : '' });
    const cached = readCache(key);
    const finish = result => {
      if (id !== request.current) return;
      setData(result);
      setLoading(false);
      if (result && !result.error && result.lines?.length) {
        const line = target.mapping?.range ? target.mapping.range[0] : 1;
        setActive(line); setAnchor(target.mapping?.range ? target.mapping.range[1] : line);
        if (target.mapping?.note) setNotice({ kind: target.mapping.exact ? 'info' : 'warn', text: target.mapping.note });
        requestAnimationFrame(() => {
          const node = scroller.current;
          if (!node) return;
          if (typeof restoreScroll === 'number') node.scrollTop = restoreScroll;
          else node.scrollTop = Math.max(0, (line - 4) * ROW);
        });
      }
    };
    if (cached) { finish(cached); return; }
    try {
      let result;
      if (target.mode === 'reverse') {
        result = await window.twig.getReverseBlame(repository.id, target.oid, target.endRef || 'HEAD', target.path);
      } else {
        result = await window.twig.getBlame(repository.id, target.oid, target.path);
      }
      if (id !== request.current) return;
      if (result.kind === 'error') { setData({ error: result.message, code: result.code }); setLoading(false); return; }
      writeCache(key, result);
      finish(result);
    } catch {
      if (id === request.current) { setData({ error: 'Could not blame this file. Show output in the console.' }); setLoading(false); }
    }
  }, [repository.id]);

  useEffect(() => { void load(chain[pos], scrollMemo.current.get(pos)); }, [load, chain, pos]);
  useEffect(() => () => { void window.twig.cancelBlame(repository.id); }, [repository.id]);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const observer = new ResizeObserver(() => { if (node.clientHeight) setViewport({ top: node.scrollTop, height: node.clientHeight }); });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const lines = useMemo(() => (data && !data.error ? data.lines : []), [data]);
  const commits = data && !data.error ? data.commits : {};
  const colours = useMemo(() => colourMap(lines), [lines]);
  // The whole version is highlighted once, as one block, so a comment that
  // spans lines is coloured on each of them; only the visible rows render.
  const [diffPrefs] = useDiffPrefs();
  const language = diffPrefs.syntax ? languageFor(entry.path) : null;
  const highlight = useHighlighter(Boolean(language));
  const syntax = useMemo(() => (highlight ? highlight(lines.map(line => line.content), language) : null), [lines, language, highlight]);
  const total = lines.length;
  const start = Math.max(0, Math.floor(viewport.top / ROW) - OVERSCAN);
  const end = Math.min(total, Math.ceil((viewport.top + viewport.height) / ROW) + OVERSCAN);
  const selLo = Math.min(active, anchor);
  const selHi = Math.max(active, anchor);
  const activeLine = lines.find(line => line.line === active) || null;
  const selectionCommits = useMemo(() => {
    const seen = new Set();
    for (const line of lines) if (line.line >= selLo && line.line <= selHi) seen.add(line.oid);
    return [...seen];
  }, [lines, selLo, selHi]);

  useEffect(() => {
    if (!activeLine) { onSelect(null); return; }
    onSelect({
      oid: activeLine.oid, path: activeLine.filename || entry.path, line: activeLine.line, mode,
      presentAtEnd: mode === 'reverse' && (data?.endAtStart || activeLine.oid === data?.endOid),
      multiple: selectionCommits.length > 1 ? selectionCommits.length : 0
    });
  }, [activeLine, mode, data, selectionCommits, onSelect, entry.path]);

  const rememberScroll = () => { if (scroller.current) scrollMemo.current.set(pos, scroller.current.scrollTop); };
  const go = delta => { rememberScroll(); setPos(value => Math.max(0, Math.min(chain.length - 1, value + delta))); };
  const push = target => {
    rememberScroll();
    setChain(current => [...current.slice(0, pos + 1), target]);
    setPos(pos + 1);
  };

  const blameBefore = async (line, parentIndex = null) => {
    setNotice(null); setParentPick(null);
    try {
      const result = await window.twig.getBlameBefore(repository.id, entry.oid, entry.path, line, parentIndex);
      if (result.kind === 'need-parent') { setParentPick({ line, message: result.message, parents: result.parents }); return; }
      if (result.kind !== 'ok') { setNotice({ kind: 'warn', text: result.message }); return; }
      const key = cacheKey({ repositoryId: repository.id, mode: 'blame', oid: result.oid, path: result.path, endOid: '' });
      writeCache(key, result);
      push({ mode: 'blame', oid: result.oid, path: result.path, mapping: result.mapping, via: result.via });
    } catch { setNotice({ kind: 'warn', text: 'Could not step back from this line. Show output in the console.' }); onConsole(); }
  };

  const toReverse = () => {
    setReverseForm({ start: entry.oid, end: 'HEAD' });
  };
  const applyReverse = () => {
    if (!reverseForm) return;
    push({ mode: 'reverse', oid: reverseForm.start.trim(), path: entry.path, endRef: reverseForm.end.trim() || 'HEAD', mapping: null });
    setReverseForm(null);
  };
  const toForward = () => {
    push({ mode: 'blame', oid: mode === 'reverse' ? data?.startOid || entry.oid : entry.oid, path: entry.path, mapping: null });
  };

  function pickLine(line, shift) {
    setActive(line);
    if (!shift) setAnchor(line);
  }

  function keydown(event) {
    if (event.key === 'Escape') { onClose(); return; }
    let line = active;
    const page = Math.max(1, Math.floor(viewport.height / ROW) - 1);
    if (event.key === 'ArrowDown') line = Math.min(total, active + 1);
    else if (event.key === 'ArrowUp') line = Math.max(1, active - 1);
    else if (event.key === 'Home') line = 1;
    else if (event.key === 'End') line = total;
    else if (event.key === 'PageDown') line = Math.min(total, active + page);
    else if (event.key === 'PageUp') line = Math.max(1, active - page);
    else if ((event.key === '[' || event.key === 'b') && mode === 'blame') { event.preventDefault(); void blameBefore(active); return; }
    else if (event.key === 'Enter' && activeLine) { event.preventDefault(); onJump(activeLine.oid); return; }
    else return;
    event.preventDefault();
    pickLine(line, event.shiftKey);
    const node = scroller.current;
    if (node) {
      const y = (line - 1) * ROW;
      if (y < node.scrollTop) node.scrollTop = y;
      else if (y + ROW > node.scrollTop + node.clientHeight) node.scrollTop = y + ROW - node.clientHeight;
    }
  }

  const headerOid = mode === 'reverse' ? data?.startOid || entry.oid : entry.oid;
  const rangeChanged = mode === 'reverse' && data && !data.error;

  return <section className="diff-view blame-view" aria-label="Blame">
    <header className="panel-heading blame-heading">
      <span className="blame-title">
        <History aria-hidden="true" />
        <code title={entry.path}>{entry.path}</code>
        <span className="blame-at">at <code>{(headerOid || '').slice(0, 8)}</code>{entry.via && <em> · via {entry.via}</em>}</span>
      </span>
      <div className="blame-actions">
        <div className="segmented blame-mode" role="group" aria-label="Blame direction">
          <button aria-pressed={mode === 'blame'} onClick={toForward}
            disabled={mode === 'blame' || !(data?.startOid || /^[0-9a-f]{40,64}$/i.test(entry.oid))}>Blame</button>
          <button aria-pressed={mode === 'reverse'} onClick={toReverse} disabled={mode === 'reverse'}>Reverse blame</button>
        </div>
        <Button icon={ArrowLeft} aria-label="Back" reason={pos === 0 ? 'No earlier step' : undefined} onClick={() => go(-1)} />
        <Button icon={ArrowRight} aria-label="Forward" reason={pos === chain.length - 1 ? 'No later step' : undefined} onClick={() => go(1)} />
        {chain.length > 1 && <span className="blame-step" aria-label={`Step ${pos + 1} of ${chain.length}`}>{pos + 1}/{chain.length}</span>}
        <Button icon={X} aria-label="Close blame" onClick={onClose} />
      </div>
    </header>

    {reverseForm && <form className="blame-reverse-form" onSubmit={event => { event.preventDefault(); applyReverse(); }}>
      <label>Start<input aria-label="Reverse blame start" value={reverseForm.start} onChange={e => setReverseForm(f => ({ ...f, start: e.target.value }))} /></label>
      <label>End<input aria-label="Reverse blame end" value={reverseForm.end} placeholder="HEAD" onChange={e => setReverseForm(f => ({ ...f, end: e.target.value }))} /></label>
      <Button type="submit">Apply</Button>
      <Button type="button" onClick={() => setReverseForm(null)}>Cancel</Button>
      <p className="blame-hint">Start must be an ancestor of End and the file must exist in Start. Start = End shows every line as present at end.</p>
    </form>}

    {mode === 'reverse' && rangeChanged && !reverseForm && <p className="blame-range-note">
      Forward view · <code>{(data.startOid || '').slice(0, 8)}</code> → <code>{(data.endOid || '').slice(0, 8)}</code>
      {data.endRef && data.endRef !== data.endOid ? ` (${data.endRef})` : ''}
      {data.endAtStart ? ' · Start = End' : ''}
      <button type="button" className="text-button" onClick={toReverse}>Change range</button>
    </p>}

    {mode === 'reverse' && data?.error && !reverseForm && <p className="blame-range-note">
      <button type="button" className="text-button" onClick={toReverse}>Change range</button></p>}

    {notice && <p className={`blame-notice ${notice.kind}`} role="status">{notice.text}
      {notice.kind === 'warn' && <button type="button" onClick={onConsole}>Show output</button>}</p>}

    {parentPick && <div className="blame-parent-pick" role="group" aria-label="Choose a parent">
      <p>{parentPick.message}</p>
      {parentPick.parents.map((parent, index) => <button key={parent.oid} type="button" onClick={() => blameBefore(parentPick.line, index)}>
        <code>{parent.short}</code> <span>{parent.subject || '(no subject)'}</span></button>)}
      <button type="button" className="text-button" onClick={() => setParentPick(null)}>Cancel</button>
    </div>}

    {loading && !lines.length ? <div className="loading-shell" aria-label="Loading blame"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
      : data?.error ? <p className="empty-inline" role="alert">{data.error} <button onClick={onConsole}>Show output</button></p>
      : !lines.length ? <p className="empty-inline">{mode === 'reverse' ? 'No lines to trace forward.' : 'This file is empty in that version.'}</p>
      : <div className="blame-scroll" ref={scroller} tabIndex={0} role="grid" aria-label="Blame lines" aria-rowcount={total}
          onKeyDown={keydown}
          onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
        <div className="blame-rows" style={{ height: total * ROW }}>
          {lines.slice(start, end).map((line, offset) => {
            const index = start + offset;
            const previous = lines[index - 1];
            const firstOfRun = !previous || previous.oid !== line.oid;
            const commit = commits[line.oid] || {};
            const selected = line.line >= selLo && line.line <= selHi;
            const presentAtEnd = mode === 'reverse' && (data.endAtStart || line.oid === data.endOid);
            return <div key={line.line} role="row" aria-rowindex={line.line} aria-selected={selected}
              className={`blame-row c${colours.get(line.oid)} ${selected ? 'selected' : ''} ${line.line === active ? 'active' : ''} ${hoverOid === line.oid ? 'run-hover' : ''} ${firstOfRun ? 'run-start' : 'run-cont'}`}
              style={{ top: index * ROW }}
              onMouseEnter={() => setHoverOid(line.oid)} onMouseLeave={() => setHoverOid(null)}
              onClick={event => pickLine(line.line, event.shiftKey)}
              onContextMenu={event => { event.preventDefault(); pickLine(line.line, false); setRowMenu({ x: event.clientX, y: event.clientY, line }); }}>
              <span className="blame-gutter">
                {firstOfRun && <>
                  <code className="blame-hash">{line.oid.slice(0, 7)}</code>
                  {mode === 'reverse'
                    ? <span className={`blame-reverse-tag ${presentAtEnd ? 'at-end' : 'last-seen'}`}>{presentAtEnd ? '→ present at end' : `× last in ${line.oid.slice(0, 7)}`}</span>
                    : <span className="blame-who">{commit.author?.name || 'Unknown'} · {shortDate(commit.author?.date)}</span>}
                  <span className="blame-summary" title={commit.summary}>{commit.summary || ''}</span>
                </>}
              </span>
              <span className="blame-lineno">{line.line}</span>
              <span className="blame-code">{line.content === '' ? ' ' : syntax?.[index]
                ? splitByRanges(line.content, 0, syntax[index]).map((piece, n) => (piece.cls ? <span key={n} className={piece.cls}>{piece.text}</span> : piece.text))
                : line.content}</span>
            </div>;
          })}
        </div>
      </div>}

    <footer className="blame-footer">
      <span>{total ? `${total} lines` : ''}{selHi > selLo ? ` · ${selHi - selLo + 1} selected` : ''}</span>
      {mode === 'blame' && activeLine && <Button icon={ChevronsLeft} onClick={() => void blameBefore(active)}>Blame before this change</Button>}
      {activeLine && <Button icon={GitBranch} onClick={() => onJump(activeLine.oid)}>Go to commit</Button>}
      {selectionCommits.length > 1 && <span className="blame-multi">{selectionCommits.length} commits in selection</span>}
    </footer>

    {rowMenu && <Menu x={rowMenu.x} y={rowMenu.y} label={`Line ${rowMenu.line.line}`} onClose={() => setRowMenu(null)}
      items={[
        mode === 'blame' && { key: 'before', text: 'Blame before this change', icon: RotateCcw, hint: 'The version before this line’s commit', run: () => void blameBefore(rowMenu.line.line) },
        { key: 'jump', text: 'Go to commit', icon: GitBranch, run: () => onJump(rowMenu.line.oid) },
        { key: 'copy', text: 'Copy commit SHA', run: () => void window.twig.copyText(rowMenu.line.oid) }
      ].filter(Boolean)} />}
  </section>;
}
