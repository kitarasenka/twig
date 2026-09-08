import { useMemo } from 'react';
import Button from '../../ui/Button.jsx';
import { segmentHunkLines } from '../diff/intraline.js';

const changeable = line => line.kind !== 'context';
const MARKER = { add: '+', delete: '-' };
const SEGMENT_CLASS = { add: 'diff-seg-add', del: 'diff-seg-del' };

/** A hunk line's text: whole, or per-character spans when only part changed. */
function LineText({ line, segments }) {
  const marker = MARKER[line.kind] ?? ' ';
  if (!segments) return <>{marker}{line.text || ' '}</>;
  return <>{marker}{segments.map((seg, index) => seg.type === 'same'
    ? seg.text
    : <span key={index} className={SEGMENT_CLASS[seg.type]}>{seg.text}</span>)}</>;
}

/** Old/new line numbers for the gutter, derived from the hunk header. */
function numbering(hunk) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return hunk.lines.map(line => {
    const pair = {
      old: line.kind === 'add' ? null : oldLine,
      next: line.kind === 'delete' ? null : newLine
    };
    if (line.kind !== 'add') oldLine++;
    if (line.kind !== 'delete') newLine++;
    return pair;
  });
}

export default function StageDiff({ file, diff, staged, selection, onSelection, onApply, busy, onClose }) {
  const gutters = useMemo(() => diff.hunks.map(numbering), [diff.hunks]);
  const segments = useMemo(() => diff.hunks.map(hunk => segmentHunkLines(hunk.lines)), [diff.hunks]);
  const selectedCount = Object.values(selection).reduce((total, lines) => total + lines.length, 0);
  const verb = staged ? 'Unstage' : 'Stage';

  function toggleLine(hunkIndex, lineIndex, checked) {
    const current = new Set(selection[hunkIndex] || []);
    if (checked) current.add(lineIndex); else current.delete(lineIndex);
    onSelection({ ...selection, [hunkIndex]: [...current].sort((a, b) => a - b) });
  }
  function toggleHunk(hunkIndex, checked) {
    const lines = diff.hunks[hunkIndex].lines
      .map((line, index) => (changeable(line) ? index : -1)).filter(index => index >= 0);
    onSelection({ ...selection, [hunkIndex]: checked ? lines : [] });
  }

  return <section className="stage-diff" aria-label={`${staged ? 'Staged' : 'Working tree'} diff for ${file}`}>
    <header className="panel-heading">
      <code title={file}>{file}</code>
      <span className="diff-actions">
        <Button className="primary" reason={selectedCount === 0 ? `Select lines to ${verb.toLowerCase()}` : busy ? 'Git is working' : undefined}
          onClick={() => onApply(selection)}>{`${verb} ${selectedCount} selected`}</Button>
        <Button onClick={onClose} aria-label="Close diff">Close</Button>
      </span>
    </header>
    {diff.binary && <p className="empty-inline">Binary file changed. Stage it whole; there is no text diff to pick from.</p>}
    {!diff.binary && diff.hunks.length === 0 && <p className="empty-inline">No textual changes in this file.</p>}
    <div className="diff-scroll">
      {diff.hunks.map((hunk, hunkIndex) => {
        const lines = hunk.lines.map((line, index) => (changeable(line) ? index : -1)).filter(index => index >= 0);
        const chosen = selection[hunkIndex] || [];
        return <div className="stage-hunk" key={hunkIndex}>
          <div className="stage-hunk-head">
            <label><input type="checkbox" checked={lines.length > 0 && chosen.length === lines.length}
              ref={node => { if (node) node.indeterminate = chosen.length > 0 && chosen.length < lines.length; }}
              onChange={event => toggleHunk(hunkIndex, event.target.checked)} />
            <span>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</span></label>
            {hunk.heading && <em>{hunk.heading}</em>}
          </div>
          {hunk.lines.map((line, lineIndex) => {
            const gutter = gutters[hunkIndex][lineIndex];
            const kind = line.kind === 'add' ? 'diff-added' : line.kind === 'delete' ? 'diff-deleted' : '';
            return <div className={`stage-line ${kind}`} key={lineIndex}>
              {changeable(line)
                ? <input type="checkbox" checked={chosen.includes(lineIndex)}
                  aria-label={`${verb} line ${gutter.next ?? gutter.old}`}
                  onChange={event => toggleLine(hunkIndex, lineIndex, event.target.checked)} />
                : <span className="stage-line-spacer" />}
              <span className="line-number">{gutter.old ?? ''}</span>
              <span className="line-number">{gutter.next ?? ''}</span>
              <span className="line-text"><LineText line={line} segments={segments[hunkIndex][lineIndex]} /></span>
            </div>;
          })}
          {hunk.lines.some(line => line.noNewline) && <div className="stage-line no-newline"><span className="stage-line-spacer" /><span className="line-number" /><span className="line-number" /><span className="line-text">\ No newline at end of file</span></div>}
        </div>;
      })}
    </div>
  </section>;
}
