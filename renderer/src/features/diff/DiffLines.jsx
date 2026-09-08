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

/**
 * The scrollable body of a unified diff, with intra-line highlighting on lines
 * a hunk both removes and adds back. Shared by the commit panel, the stash view
 * and the blame detail.
 */
export default function DiffLines({ patch, className = '', label = 'Diff lines' }) {
  const rows = useMemo(() => annotatePatch(patch), [patch]);
  return <div className={`diff-lines${className ? ` ${className}` : ''}`} tabIndex={0} aria-label={label}>
    {rows.map((row, index) => <div key={index} className={row.cls}>
      <DiffLineText text={row.text} segments={row.segments} />
    </div>)}
  </div>;
}
