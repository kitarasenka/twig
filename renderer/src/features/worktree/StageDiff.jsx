import { useMemo } from 'react';
import Button from '../../ui/Button.jsx';
import { segmentHunkLines } from '../diff/intraline.js';
import { lineSpans, sideSyntax } from '../diff/diff-view.js';
import { languageFor } from '../diff/languages.js';
import useHighlighter from '../diff/useHighlighter.js';
import { DiffPieces, DiffToolbar } from '../diff/DiffLines.jsx';
import useDiffPrefs from '../diff/useDiffPrefs.js';

const changeable = line => line.kind !== 'context';
const MARKER = { add: '+', delete: '-' };

/**
 * Syntax ranges for every line of every hunk, each side of a hunk highlighted
 * as one block (see `sideSyntax`), returned as `[hunk][line]`.
 */
function hunkSyntax(hunks, highlight, language) {
  const flat = [];
  for (const hunk of hunks) {
    flat.push({ kind: 'hunk', text: '' });
    for (const line of hunk.lines) flat.push({ kind: line.kind, text: line.text });
  }
  const ranges = sideSyntax(flat, lines => highlight(lines, language));
  let at = 0;
  return hunks.map(hunk => { at++; return hunk.lines.map(() => ranges[at++]); });
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

export default function StageDiff({ file, diff, staged, selection, onSelection, onApply, onDiscard = null, busy, onClose }) {
  const [prefs] = useDiffPrefs();
  const language = languageFor(file);
  const gutters = useMemo(() => diff.hunks.map(numbering), [diff.hunks]);
  const segments = useMemo(() => diff.hunks.map(hunk => segmentHunkLines(hunk.lines)), [diff.hunks]);
  const highlight = useHighlighter(prefs.syntax && Boolean(language));
  const syntax = useMemo(() => (highlight ? hunkSyntax(diff.hunks, highlight, language) : null), [diff.hunks, language, highlight]);
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
        {onDiscard && <Button className="discard" reason={selectedCount === 0 ? 'Select lines to discard' : busy ? 'Git is working' : undefined}
          onClick={() => onDiscard(selection)}>{`Discard ${selectedCount} selected`}</Button>}
        <Button className="primary" reason={selectedCount === 0 ? `Select lines to ${verb.toLowerCase()}` : busy ? 'Git is working' : undefined}
          onClick={() => onApply(selection)}>{`${verb} ${selectedCount} selected`}</Button>
        <Button onClick={onClose} aria-label="Close diff">Close</Button>
      </span>
    </header>
    {diff.binary && <p className="empty-inline">Binary file changed. Stage it whole; there is no text diff to pick from.</p>}
    {!diff.binary && diff.hunks.length === 0 && <p className="empty-inline">No textual changes in this file.</p>}
    {!diff.binary && diff.hunks.length > 0 && <DiffToolbar language={language} words={false} />}
    <div className={`diff-scroll${syntax ? ' diff-syntax' : ''}`}>
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
              <span className="line-text"><DiffPieces marker={MARKER[line.kind] ?? ' '}
                pieces={lineSpans(line.text, syntax?.[hunkIndex][lineIndex] ?? null, segments[hunkIndex][lineIndex])} /></span>
            </div>;
          })}
          {hunk.lines.some(line => line.noNewline) && <div className="stage-line no-newline"><span className="stage-line-spacer" /><span className="line-number" /><span className="line-number" /><span className="line-text">\ No newline at end of file</span></div>}
        </div>;
      })}
    </div>
  </section>;
}
