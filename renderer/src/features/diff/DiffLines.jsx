import { useMemo } from 'react';
import { annotatePatch } from './intraline.js';

const SEGMENT_CLASS = { add: 'diff-seg-add', del: 'diff-seg-del' };

/** One patch line: plain text, or the leading marker plus per-character spans. */
export function DiffLineText({ text, segments }) {
  if (!segments) return <span>{text || ' '}</span>;
  return <span>{text[0]}{segments.map((seg, index) => seg.type === 'same'
    ? seg.text
    : <span key={index} className={SEGMENT_CLASS[seg.type]}>{seg.text}</span>)}</span>;
}

const digits = (rows, side) => String(rows.reduce((max, row) => Math.max(max, row[side] ?? 0), 0)).length;

/**
 * The scrollable body of a unified diff, with a gutter of old/new line numbers
 * and intra-line highlighting on lines a hunk both removes and adds back.
 * Shared by the commit panel, the stash view and the blame detail.
 */
export default function DiffLines({ patch, className = '', label = 'Diff lines' }) {
  const rows = useMemo(() => annotatePatch(patch), [patch]);
  // The gutter is as wide as the longest number on each side, so the code
  // starts at the same column on every line of this diff.
  const style = useMemo(() => ({
    '--diff-old-digits': digits(rows, 'oldLine'),
    '--diff-new-digits': digits(rows, 'newLine')
  }), [rows]);
  return <div className={`diff-lines${className ? ` ${className}` : ''}`} tabIndex={0} aria-label={label} style={style}>
    {rows.map((row, index) => <div key={index} className={row.cls}>
      <span className="diff-gutter" aria-hidden="true">
        <span className="diff-line-number diff-line-old">{row.oldLine ?? ''}</span>
        <span className="diff-line-number diff-line-new">{row.newLine ?? ''}</span>
      </span>
      <DiffLineText text={row.text} segments={row.segments} />
    </div>)}
  </div>;
}
