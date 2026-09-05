import { useRef, useState } from 'react';
import { ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';

const ACTIONS = [
  ['pick', 'Pick — keep the commit as it is'],
  ['reword', 'Reword — keep the changes, change the message'],
  ['edit', 'Edit — stop here so the commit can be amended'],
  ['squash', 'Squash — melt into the commit above, keep both messages'],
  ['fixup', 'Fixup — melt into the commit above, drop this message'],
  ['drop', 'Drop — remove the commit entirely']
];
const MELDING = new Set(['squash', 'fixup']);

function move(entries, from, to) {
  if (to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  const [entry] = next.splice(from, 1);
  next.splice(to, 0, entry);
  return next;
}

/**
 * The plan for `git rebase --interactive`. Twig does not replay the rebase
 * itself: this list becomes the todo file Git asks its sequence editor for, so
 * what is on screen is literally what Git will execute, oldest commit first.
 *
 * Rows can be dragged, but never only dragged — every reorder is also on the
 * Move up / Move down buttons and on Alt+Arrow, because a drag is unusable
 * with a keyboard and awkward with a trackpad.
 */
export default function RebaseDialog({ commits, onRun, onClose }) {
  const [entries, setEntries] = useState(() => commits.map(commit => ({
    oid: commit.oid, subject: commit.subject, author: commit.author.name,
    action: 'pick', message: commit.subject
  })));
  const dragging = useRef(null);
  const rows = useRef(null);

  const update = (index, patch) => setEntries(current => current.map((entry, i) => (i === index ? { ...entry, ...patch } : entry)));
  function reorder(from, to) {
    setEntries(current => move(current, from, to));
    // Keep the moved row under the same finger or focus it followed.
    requestAnimationFrame(() => rows.current?.querySelectorAll('.rebase-row')[to]?.querySelector('select')?.focus());
  }

  const kept = entries.filter(entry => entry.action !== 'drop');
  const missingMessage = entries.some(entry => entry.action === 'reword' && entry.message.trim().length === 0);
  const problem = kept.length === 0 ? 'A rebase has to keep at least one commit'
    : MELDING.has(kept[0].action) ? 'The oldest kept commit has nothing above it to melt into'
      : missingMessage ? 'A reworded commit needs a message' : null;
  const summary = `${kept.filter(entry => !MELDING.has(entry.action)).length} kept · `
    + `${entries.filter(entry => MELDING.has(entry.action)).length} melted · `
    + `${entries.filter(entry => entry.action === 'drop').length} dropped`;

  return <Dialog title="Interactive rebase" wide onClose={onClose}>
    <div className="rebase-dialog">
      <p className="muted">Oldest first — the order Git will replay them in. {commits.length} commit{commits.length === 1 ? '' : 's'} will be rewritten.</p>
      <ol className="rebase-rows" ref={rows}>
        {entries.map((entry, index) => <li key={entry.oid} className={`rebase-row ${entry.action}`} draggable
          onDragStart={event => { dragging.current = index; event.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); if (dragging.current !== null) reorder(dragging.current, index); dragging.current = null; }}
          onKeyDown={event => {
            if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            reorder(index, index + (event.key === 'ArrowUp' ? -1 : 1));
          }}>
          <GripVertical aria-hidden="true" className="rebase-grip" />
          <div className="rebase-move">
            <Button icon={ChevronUp} aria-label={`Move ${entry.subject} earlier`} reason={index === 0 ? 'Already the oldest' : undefined} onClick={() => reorder(index, index - 1)} />
            <Button icon={ChevronDown} aria-label={`Move ${entry.subject} later`} reason={index === entries.length - 1 ? 'Already the newest' : undefined} onClick={() => reorder(index, index + 1)} />
          </div>
          <code className="rebase-oid">{entry.oid.slice(0, 7)}</code>
          <span className="rebase-subject" title={entry.subject}>{entry.subject || '(no subject)'}<small>{entry.author}</small></span>
          <select aria-label={`Action for ${entry.subject}`} value={entry.action} onChange={event => update(index, { action: event.target.value })}>
            {ACTIONS.map(([value, text]) => <option key={value} value={value}>{text}</option>)}
          </select>
          {entry.action === 'reword' && <label className="rebase-message">
            <span>New message</span>
            <textarea rows={2} value={entry.message} aria-label={`New message for ${entry.oid.slice(0, 7)}`}
              onChange={event => update(index, { message: event.target.value })} />
          </label>}
        </li>)}
      </ol>
      <div className="dialog-actions">
        <span className="muted" role="status">{problem || summary}</span>
        <Button onClick={onClose}>Cancel</Button>
        <Button className="primary" reason={problem || undefined}
          onClick={() => { onClose(); onRun(entries.map(({ oid, action, message }) => ({ oid, action, message }))); }}>Start rebase</Button>
      </div>
    </div>
  </Dialog>;
}
