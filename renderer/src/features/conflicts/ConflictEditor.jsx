import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Info, Redo2, Save, Undo2, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { hasConflictMarkers, parseConflictFile, resolveRegion } from './conflict-parser.js';

const SIDES = [['ours', 'Ours'], ['base', 'Base'], ['theirs', 'Theirs']];

function emptyPicks(count) {
  return Array.from({ length: count }, () => ({ ours: new Set(), base: new Set(), theirs: new Set(), order: 'ours' }));
}

function chosenLines(region, pick) {
  const take = side => [...pick[side]].sort((a, b) => a - b).map(index => region[side][index]);
  const first = pick.order === 'ours' ? 'ours' : 'theirs';
  const second = first === 'ours' ? 'theirs' : 'ours';
  return [...take(first), ...take('base'), ...take(second)];
}

function SideColumn({ name, title, lines, picked, onToggle }) {
  // Git only writes the base into the markers under merge.conflictStyle=diff3
  // or zdiff3. Saying so beats an unexplained empty column, and the whole file
  // is still one click away below.
  if (!lines) return <div className="conflict-column"><h5>{title}</h5>
    <p className="muted conflict-base-missing" title="Git writes the base into the markers only with merge.conflictStyle=zdiff3 (or diff3). The whole base file is below.">
      Not in the markers <Info aria-label="Why the base is missing" /></p></div>;
  return <div className={`conflict-column side-${name}`}>
    <h5>{title}<small>{lines.length} line{lines.length === 1 ? '' : 's'}</small></h5>
    {lines.length === 0 && <p className="muted">Empty on this side.</p>}
    {lines.map((line, index) => <label key={index} className="conflict-line">
      <input type="checkbox" checked={picked.has(index)} onChange={() => onToggle(index)}
        aria-label={`Take ${title.toLowerCase()} line ${index + 1}`} />
      <code>{line || ' '}</code>
    </label>)}
  </div>;
}

/**
 * The three-way conflict editor of §8.5: ours, base and theirs beside an
 * editable result.
 *
 * The result is the real file text, not a model of it, and every control here
 * rewrites exactly one marked region of that text. That is why free typing and
 * the take-a-line buttons can coexist without fighting: after any change the
 * text is re-parsed, and whatever regions remain are what is still conflicted.
 * Undo and redo are local to this editor, as the brief requires — they are not
 * the application-wide history.
 */
export default function ConflictEditor({ repositoryId, file, onClose, onResolved, onConsole }) {
  const [data, setData] = useState(null);
  const [text, setText] = useState('');
  const [picks, setPicks] = useState([]);
  const [past, setPast] = useState([]);
  const [future, setFuture] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmMarkers, setConfirmMarkers] = useState(false);
  const request = useRef(0);

  useEffect(() => {
    const epoch = ++request.current;
    setData(null); setError(''); setPast([]); setFuture([]); setConfirmMarkers(false);
    window.twig.readConflict(repositoryId, file)
      .then(result => {
        if (epoch !== request.current) return;
        setData(result);
        setText(result.merged || '');
        setPicks(emptyPicks(result.merged ? parseConflictFile(result.merged).conflicts : 0));
      })
      .catch(failure => { if (epoch === request.current) setError(failure.message || 'Could not read this conflict.'); });
  }, [repositoryId, file]);

  const parsed = useMemo(() => {
    if (!data || data.binary) return { regions: [], conflicts: 0 };
    try {
      return parseConflictFile(text);
    } catch {
      // Free editing can leave a half-written marker; that is the user's file,
      // not a crash, so the region controls simply stand down until it parses.
      return { regions: [], conflicts: 0, broken: true };
    }
  }, [text, data]);

  // Picks are positional, and applying one conflict renumbers the rest, so
  // they are dropped the moment the count changes rather than silently
  // pointing at the wrong region.
  useEffect(() => {
    setPicks(current => (current.length === parsed.conflicts ? current : emptyPicks(parsed.conflicts)));
  }, [parsed.conflicts]);

  const commit = useCallback(next => {
    setPast(stack => [...stack.slice(-99), text]);
    setFuture([]);
    setText(next);
  }, [text]);

  function undo() {
    setPast(stack => {
      if (stack.length === 0) return stack;
      setFuture(forward => [text, ...forward]);
      setText(stack.at(-1));
      return stack.slice(0, -1);
    });
  }
  function redo() {
    setFuture(stack => {
      if (stack.length === 0) return stack;
      setPast(back => [...back, text]);
      setText(stack[0]);
      return stack.slice(1);
    });
  }

  function apply(index, lines) {
    try {
      commit(resolveRegion(text, index, lines));
    } catch (failure) {
      setError(failure.message || 'Could not apply this choice.');
    }
  }
  const togglePick = (index, side, line) => setPicks(current => current.map((pick, i) => {
    if (i !== index) return pick;
    const next = new Set(pick[side]);
    if (next.has(line)) next.delete(line); else next.add(line);
    return { ...pick, [side]: next };
  }));

  async function save({ force = false } = {}) {
    if (!force && hasConflictMarkers(text)) { setConfirmMarkers(true); return; }
    setBusy(true); setError(''); setConfirmMarkers(false);
    try {
      const result = await window.twig.saveConflict(repositoryId, file, text, data.mtimeMs, data.size);
      if (!result.ok) { setError(result.message || 'Could not save this file.'); onConsole(); return; }
      onResolved(result.state);
    } catch (failure) {
      setError(failure.message || 'Could not save this file.');
    } finally { setBusy(false); }
  }
  async function whole(side) {
    setBusy(true); setError('');
    try {
      const result = await window.twig.takeConflictSide(repositoryId, file, side);
      if (!result.ok) { setError(result.message || 'Could not take that side.'); onConsole(); return; }
      onResolved(result.state);
    } catch (failure) {
      setError(failure.message || 'Could not take that side.');
    } finally { setBusy(false); }
  }

  function keydown(event) {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
    event.preventDefault();
    event.stopPropagation();
    if (event.shiftKey) redo(); else undo();
  }

  return <section className="conflict-editor" aria-label={`Resolve conflict in ${file}`} onKeyDown={keydown}>
    <header className="panel-heading">
      <code>{file}</code>
      <span className="pill">{parsed.broken ? 'markers are incomplete' : `${parsed.conflicts} conflict${parsed.conflicts === 1 ? '' : 's'} left`}</span>
      <div className="diff-actions">
        <Button icon={Undo2} aria-label="Undo in the conflict editor" reason={past.length === 0 ? 'Nothing to undo here' : undefined} onClick={undo} />
        <Button icon={Redo2} aria-label="Redo in the conflict editor" reason={future.length === 0 ? 'Nothing to redo here' : undefined} onClick={redo} />
        <Button onClick={() => whole('ours')} reason={busy ? 'Working' : undefined} title="Take our side in every conflict of this file">Take all ours</Button>
        <Button onClick={() => whole('theirs')} reason={busy ? 'Working' : undefined} title="Take their side in every conflict of this file">Take all theirs</Button>
        <Button icon={Save} className="primary" onClick={() => save()} reason={busy || !data || data.binary ? busy ? 'Saving' : 'This file has no text to save' : undefined}>Save and mark resolved</Button>
        <Button icon={X} aria-label="Close the conflict editor" onClick={onClose} />
      </div>
    </header>
    {error && <p role="alert" className="empty-inline">{error}<button onClick={onConsole}>Show output</button></p>}
    {confirmMarkers && <p role="alert" className="conflict-warning">
      Conflict markers are still in the text. Saving now keeps them in the file.
      <Button onClick={() => save({ force: true })}>Save anyway</Button>
      <Button onClick={() => setConfirmMarkers(false)}>Keep editing</Button>
    </p>}
    {!data && !error && <div className="loading-shell" aria-label="Loading conflict"><div className="skeleton" /><div className="skeleton" /></div>}
    {data?.binary && <p className="stage-empty">This is a binary file. Choose one side whole — there is no meaningful line-by-line merge for it.</p>}
    {data && !data.binary && <div className="conflict-body">
      <div className="conflict-regions">
        {parsed.regions.filter(region => region.kind === 'conflict').map(region => {
          const pick = picks[region.index] || { ours: new Set(), base: new Set(), theirs: new Set(), order: 'ours' };
          return <article key={region.index} className="conflict-region" aria-label={`Conflict ${region.index + 1}`}>
            <h4>Conflict {region.index + 1}<small>{region.oursLabel} vs {region.theirsLabel}</small></h4>
            <div className="conflict-quick">
              <Button onClick={() => apply(region.index, region.ours)}>Take ours</Button>
              <Button onClick={() => apply(region.index, region.theirs)}>Take theirs</Button>
              <Button onClick={() => apply(region.index, [...region.ours, ...region.theirs])}>Take both</Button>
              <Button onClick={() => apply(region.index, [])}>Take neither</Button>
            </div>
            <div className="conflict-columns">
              {SIDES.map(([name, title]) => <SideColumn key={name} name={name} title={title} lines={region[name]}
                picked={pick[name]} onToggle={line => togglePick(region.index, name, line)} />)}
            </div>
            <div className="conflict-apply">
              <label htmlFor={`order-${region.index}`}>Order</label>
              <select id={`order-${region.index}`} value={pick.order}
                onChange={event => setPicks(current => current.map((item, i) => (i === region.index ? { ...item, order: event.target.value } : item)))}>
                <option value="ours">Ours first</option>
                <option value="theirs">Theirs first</option>
              </select>
              <Button icon={Check} onClick={() => apply(region.index, chosenLines(region, pick))}
                reason={pick.ours.size + pick.base.size + pick.theirs.size === 0 ? 'Tick the lines to keep first' : undefined}>
                Apply {pick.ours.size + pick.base.size + pick.theirs.size} selected lines
              </Button>
            </div>
          </article>;
        })}
        {parsed.conflicts === 0 && <p className="stage-empty">No conflict markers are left in this file. Save it to mark it resolved.</p>}
        {SIDES.map(([name, title]) => data[name] !== null && <details key={name} className="conflict-full">
          <summary>{title} — the whole file</summary>
          <pre>{data[name]}</pre>
        </details>)}
      </div>
      <div className="conflict-result">
        <label htmlFor="conflict-result">Result — this is what will be written to disk</label>
        <textarea id="conflict-result" value={text} spellCheck={false} onChange={event => commit(event.target.value)} />
      </div>
    </div>}
  </section>;
}
