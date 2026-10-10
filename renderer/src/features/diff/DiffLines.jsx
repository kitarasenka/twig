import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { annotatePatch } from './intraline.js';
import { displayRows, patchSourceLines, sideSyntax } from './diff-view.js';
import { languageFor, languageLabel } from './languages.js';
import useHighlighter from './useHighlighter.js';
import useDiffPrefs from './useDiffPrefs.js';
import { formatSize, lfsChangeLabel, lfsPointerDiff } from './lfs-pointer.js';
import { VIRTUAL_FROM, visibleRange, widestRow } from './virtual-rows.js';

/** A row's text: the marker, then pieces carrying syntax and change classes. */
export function DiffPieces({ marker, pieces }) {
  return <span>{marker && <span className="diff-marker">{marker}</span>}
    {pieces.length === 0 || (pieces.length === 1 && !pieces[0].text) ? (marker ? '' : ' ')
      : pieces.map((piece, index) => (piece.cls ? <span key={index} className={piece.cls}>{piece.text}</span> : piece.text))}</span>;
}

const digits = (rows, side) => String(rows.reduce((max, row) => Math.max(max, row[side] ?? 0), 0)).length;

/**
 * Lines / Words and the detected language, above a diff. Shared by every diff
 * view so the switch reads the same everywhere; `words` is left out where a
 * view cannot merge lines (staging picks whole lines).
 */
export function DiffToolbar({ language, words = true }) {
  const [prefs, update] = useDiffPrefs();
  return <div className="diff-toolbar">
    <span className="diff-language" title={prefs.syntax ? undefined : 'Syntax highlighting is off in Settings'}>
      {languageLabel(language)}{language && !prefs.syntax ? ' · no highlighting' : ''}</span>
    {words && <div className="segmented" role="group" aria-label="Diff view">
      <button type="button" aria-pressed={prefs.mode === 'lines'} onClick={() => update({ mode: 'lines' })}>Lines</button>
      <button type="button" aria-pressed={prefs.mode === 'words'} onClick={() => update({ mode: 'words' })}
        title="Show a changed line once, with removed and added words inline">Words</button>
    </div>}
  </div>;
}

/**
 * A change to a Git LFS pointer, read as what it is: a large file whose
 * content lives on the LFS server, with its size on each side. The pointer
 * text itself is one click away.
 */
export function LfsPointerCard({ diff, onRaw }) {
  const side = (label, pointer) => pointer && <><dt>{label}</dt><dd>{formatSize(pointer.size)} · <code title={`sha256:${pointer.oid}`}>sha256:{pointer.oid.slice(0, 12)}…</code></dd></>;
  return <div className="lfs-card" role="group" aria-label="Git LFS file">
    <p className="lfs-title"><HardDrive aria-hidden="true" /><strong>{lfsChangeLabel(diff)}</strong></p>
    <p className="muted">Git keeps a small pointer for this file; its content is stored in Git LFS, not in the commit. This is not a broken binary.</p>
    <dl className="metadata">{side('Before', diff.before)}{side('After', diff.after)}</dl>
    <button type="button" className="text-button" onClick={onRaw}>Show pointer text</button>
  </div>;
}

/**
 * The scrollable body of a unified diff, with a gutter of old/new line numbers,
 * syntax colours by file type, and intra-line highlighting on lines a hunk both
 * removes and adds back — or, in word mode, those pairs folded into one line.
 * Shared by the commit panel, the stash view and the blame detail.
 */
export default function DiffLines({ patch, path = null, className = '', label = 'Diff lines' }) {
  const [prefs] = useDiffPrefs();
  const lfs = useMemo(() => lfsPointerDiff(patch), [patch]);
  const [rawPointer, setRawPointer] = useState(false);
  useEffect(() => { setRawPointer(false); }, [patch]);
  const language = languageFor(path);
  const rows = useMemo(() => annotatePatch(patch), [patch]);
  const highlight = useHighlighter(prefs.syntax && Boolean(language));
  const syntax = useMemo(
    () => (highlight ? sideSyntax(patchSourceLines(rows), lines => highlight(lines, language)) : null),
    [rows, language, highlight]);
  const shown = useMemo(() => displayRows(rows, { syntax, words: prefs.mode === 'words' }), [rows, syntax, prefs.mode]);
  // The gutter is as wide as the longest number on each side, so the code
  // starts at the same column on every line of this diff.
  const style = useMemo(() => ({
    '--diff-old-digits': digits(rows, 'oldLine'),
    '--diff-new-digits': digits(rows, 'newLine')
  }), [rows]);
  // A long diff draws only the rows in view (see virtual-rows.js); the row
  // height is read from a drawn row once, the view from the scroller.
  const big = shown.length > VIRTUAL_FROM;
  const scroller = useRef(null);
  const [view, setView] = useState({ top: 0, height: 800 });
  const [rowHeight, setRowHeight] = useState(18);
  useLayoutEffect(() => {
    const node = scroller.current;
    if (!big || !node) return;
    const drawn = node.querySelector('[data-diff-row]');
    if (drawn?.offsetHeight) setRowHeight(drawn.offsetHeight);
    setView({ top: node.scrollTop, height: node.clientHeight || 800 });
  }, [big, shown]);
  useEffect(() => {
    const node = scroller.current;
    if (!big || !node) return undefined;
    const observer = new ResizeObserver(() => setView(current => ({ ...current, height: node.clientHeight || current.height })));
    observer.observe(node);
    return () => observer.disconnect();
  }, [big]);
  const widest = useMemo(() => (big ? widestRow(shown) : -1), [big, shown]);
  const { start, end } = big ? visibleRange({ count: shown.length, rowHeight, scrollTop: view.top, viewHeight: view.height }) : { start: 0, end: shown.length };
  if (lfs && !rawPointer) return <LfsPointerCard diff={lfs} onRaw={() => setRawPointer(true)} />;
  return <>
    <DiffToolbar language={language} />
    <div ref={scroller} className={`diff-lines${syntax ? ' diff-syntax' : ''}${className ? ` ${className}` : ''}`} tabIndex={0} aria-label={label} style={style}
      onScroll={big ? event => setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight }) : undefined}>
      {big && <div className="diff-spacer" style={{ height: start * rowHeight }} aria-hidden="true" />}
      {big && widest >= 0 && <DiffRow row={shown[widest]} probe />}
      {shown.slice(start, end).map((row, offset) => <DiffRow key={start + offset} row={row} />)}
      {big && <div className="diff-spacer" style={{ height: (shown.length - end) * rowHeight }} aria-hidden="true" />}
    </div>
  </>;
}

/** One line of a diff: the gutter of line numbers, then the text. `probe` is the invisible width keeper. */
function DiffRow({ row, probe = false }) {
  return <div className={probe ? `${row.cls} diff-width-probe` : row.cls} data-diff-row={probe ? undefined : ''} aria-hidden={probe || undefined}>
    <span className="diff-gutter" aria-hidden="true">
      <span className="diff-line-number diff-line-old">{row.oldLine ?? ''}</span>
      <span className="diff-line-number diff-line-new">{row.newLine ?? ''}</span>
    </span>
    <DiffPieces marker={row.marker} pieces={row.pieces} />
  </div>;
}
