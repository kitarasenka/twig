import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { RowScroller } from './DiffLines.jsx';
import { annotatePatch } from './intraline.js';
import { splitByRanges } from './diff-view.js';
import { languageFor, languageLabel } from './languages.js';
import useHighlighter from './useHighlighter.js';
import useDiffPrefs from './useDiffPrefs.js';
import { changeStarts, changeSummary, changedLines, fileLines, stepChange, versionLabels, versionProblem } from './file-view.js';

/** Where a change the arrows go to lands: a third of the way down, with what came before it in view. */
const READING_POSITION = 1 / 3;

/**
 * The whole file behind a diff: the version after the change, or — with the
 * switch off — the version before it, every line of it, with the lines the
 * change touches tinted and marked so it reads without colour too. Both
 * versions come from one read (`history:file-text`), so the switch is
 * instant; which lines to tint comes from `patch`, the diff already on screen.
 */
export default function FileView({ repositoryId, file, source, patch = '', withChanges, onWithChanges, onConsole, className = '' }) {
  const [data, setData] = useState(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    window.twig.getFileText(repositoryId, file, source)
      .then(result => { if (alive) setData(result); })
      .catch(() => { if (alive) setData({ error: 'Could not read this file. Show output in the console.' }); });
    return () => { alive = false; };
  }, [repositoryId, file, source]);

  const labels = versionLabels(source);
  // An untracked file has one version, so the switch does not apply to it.
  const after = withChanges || !labels.toggle;
  const side = data && !data.error ? data[after ? 'new' : 'old'] : null;
  const other = data && !data.error ? data[after ? 'old' : 'new'] : null;
  const lines = useMemo(() => (side?.state === 'ok' ? fileLines(side.text) : []), [side]);
  const patchRows = useMemo(() => annotatePatch(patch || ''), [patch]);
  const changed = useMemo(() => changedLines(patchRows, after ? 'new' : 'old'), [patchRows, after]);
  const starts = useMemo(() => changeStarts(changed), [changed]);

  const [prefs] = useDiffPrefs();
  const language = languageFor(file);
  const highlight = useHighlighter(prefs.syntax && Boolean(language));
  const syntax = useMemo(() => (highlight && lines.length ? highlight(lines, language) : null), [highlight, lines, language]);
  const rows = useMemo(() => {
    const cls = after ? 'diff-added' : 'diff-deleted';
    const marker = after ? '+' : '-';
    return lines.map((text, index) => {
      const touched = changed.has(index + 1);
      return { cls: touched ? cls : '', marker: touched ? marker : ' ', newLine: index + 1, pieces: splitByRanges(text, 0, syntax?.[index] ?? null) };
    });
  }, [lines, changed, after, syntax]);
  const style = useMemo(() => ({ '--diff-new-digits': String(lines.length || 1).length }), [lines.length]);

  // The arrows go from the line at the reading position, so they follow a
  // scroll made by hand as well as their own steps.
  const scroller = useRef(null);
  const go = direction => {
    const node = scroller.current;
    const row = node?.querySelector('[data-diff-row]');
    const height = row?.offsetHeight || 18;
    if (!node) return;
    const reading = Math.floor((node.scrollTop + node.clientHeight * READING_POSITION) / height) + 1;
    const line = stepChange(starts, reading, direction);
    if (line !== null) node.scrollTop = Math.max(0, (line - 1) * height - node.clientHeight * READING_POSITION);
  };

  const problem = side ? versionProblem(side, { source, withChanges: after }) : null;
  const version = after ? labels.after : labels.before;
  return <>
    <div className="diff-toolbar file-toolbar">
      <span className="diff-language" title={prefs.syntax ? undefined : 'Syntax highlighting is off in Settings'}>
        {languageLabel(language)}{side?.state === 'ok' ? ` · ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''} · {version}</span>
      <div className="file-toolbar-actions">
        {side?.state === 'ok' && <>
          <span className="file-changes" title={after ? 'Highlighted: the lines this change adds or rewrites' : 'Highlighted: the lines this change removes or rewrites'}>
            {changeSummary({ starts, withChanges: after, patched: Boolean(patch) })}</span>
          {starts.length > 0 && <>
            <Button icon={ChevronUp} aria-label="Previous change" title="Previous change" onClick={() => go(-1)} />
            <Button icon={ChevronDown} aria-label="Next change" title="Next change" onClick={() => go(1)} />
          </>}
        </>}
        {labels.toggle && <label className="switch" title={`On: the file ${labels.after}. Off: the file ${labels.before}.`}>
          <input type="checkbox" checked={withChanges} onChange={event => onWithChanges(event.target.checked)} /><span className="track" />{labels.toggle}</label>}
      </div>
    </div>
    {!data ? <div className="loading-shell" aria-label="Loading file"><div className="skeleton" /><div className="skeleton" /></div>
      : data.error ? <p role="alert" className="empty-inline">{data.error} <button onClick={onConsole}>Show output</button></p>
      : problem ? <p className="empty-inline">{problem}
        {other?.state === 'ok' && labels.toggle && <> <button type="button" className="text-button" onClick={() => onWithChanges(!withChanges)}>
          Show it {after ? labels.before : labels.after}</button></>}</p>
      : !lines.length ? <p className="empty-inline">The file is empty {version}.</p>
      : <RowScroller ref={scroller} rows={rows} gutter="file" style={style} label={`${file} ${version}`}
        className={`diff-lines file-lines${syntax ? ' diff-syntax' : ''}${className ? ` ${className}` : ''}`} />}
  </>;
}
