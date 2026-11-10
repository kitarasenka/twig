import { useRef, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronUp, GripVertical } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';
import { matchesShortcut } from '../../app/shortcuts.js';
import { mark, t, tn } from '../../i18n/i18n.js';

// The action words are Git's own and stay as they are; only what they do is translated.
const ACTIONS = [
  ['pick', 'Pick', mark('keep the commit as it is')],
  ['reword', 'Reword', mark('keep the changes, change the message')],
  ['edit', 'Edit', mark('stop here so the commit can be amended')],
  ['squash', 'Squash', mark('melt into the commit above, keep both messages')],
  ['fixup', 'Fixup', mark('melt into the commit above, drop this message')],
  ['drop', 'Drop', mark('remove the commit entirely')]
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
export default function RebaseDialog({ commits, base, onRun, onClose }) {
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
  const problem = kept.length === 0 ? t('A rebase has to keep at least one commit')
    : MELDING.has(kept[0].action) ? t('The oldest kept commit has nothing above it to melt into')
      : missingMessage ? t('A reworded commit needs a message') : null;
  const keptCount = kept.filter(entry => !MELDING.has(entry.action)).length;
  const melted = entries.filter(entry => MELDING.has(entry.action)).length;
  const dropped = entries.filter(entry => entry.action === 'drop').length;
  const summary = t`${keptCount} kept · ${melted} melted · ${dropped} dropped`;
  const published = commits.filter(commit => commit.published).length;
  const droppedPublished = entries.filter(entry => entry.action === 'drop' && commits.find(commit => commit.oid === entry.oid)?.published).length;

  return <Dialog title={t('Interactive rebase')} wide onClose={onClose}>
    <div className="rebase-dialog">
      <p className="muted">{tn(commits.length, 'Oldest first — the order Git will replay them in. {n} commit will be rewritten.',
        'Oldest first — the order Git will replay them in. {n} commits will be rewritten.')}</p>
      <ol className="rebase-rows" ref={rows}>
        {entries.map((entry, index) => <li key={entry.oid} className={`rebase-row ${entry.action}`} draggable
          onDragStart={event => { dragging.current = index; event.dataTransfer.effectAllowed = 'move'; }}
          onDragOver={event => event.preventDefault()}
          onDrop={event => { event.preventDefault(); if (dragging.current !== null) reorder(dragging.current, index); dragging.current = null; }}
          onKeyDown={event => {
            const step = matchesShortcut(event, 'moveUp') ? -1 : matchesShortcut(event, 'moveDown') ? 1 : 0;
            if (!step) return;
            event.preventDefault();
            reorder(index, index + step);
          }}>
          <GripVertical aria-hidden="true" className="rebase-grip" />
          <div className="rebase-move">
            <Button icon={ChevronUp} aria-label={t`Move ${entry.subject} earlier`} reason={index === 0 ? t('Already the oldest') : undefined} onClick={() => reorder(index, index - 1)} />
            <Button icon={ChevronDown} aria-label={t`Move ${entry.subject} later`} reason={index === entries.length - 1 ? t('Already the newest') : undefined} onClick={() => reorder(index, index + 1)} />
          </div>
          <code className="rebase-oid">{entry.oid.slice(0, 7)}</code>
          <span className="rebase-subject" title={entry.subject}>{entry.subject || t('(no subject)')}<small>{entry.author}</small></span>
          <select aria-label={t`Action for ${entry.subject}`} value={entry.action} onChange={event => update(index, { action: event.target.value })}>
            {ACTIONS.map(([value, word, text]) => <option key={value} value={value}>{`${word} — ${t(text)}`}</option>)}
          </select>
          {entry.action === 'reword' && <label className="rebase-message">
            <span>{t('New message')}</span>
            <textarea rows={2} value={entry.message} aria-label={t`New message for ${entry.oid.slice(0, 7)}`}
              onChange={event => update(index, { message: event.target.value })} />
          </label>}
        </li>)}
      </ol>
      {/* What this cannot take back, said before it starts rather than on the Undo button after. */}
      <div className="rebase-warnings">
        <p className="confirm-consequence"><AlertTriangle aria-hidden="true" />{[
          t('Undo cannot reverse a rebase. The old commits stay in Reflog for a while.'),
          dropped ? tn(dropped, 'The {n} dropped commit leaves the branch.', 'The {n} dropped commits leave the branch.') : null,
          droppedPublished ? tn(droppedPublished, '{n} of them is already on a remote and stays there until you force push.', '{n} of them are already on a remote and stay there until you force push.') : null,
          published ? tn(published, '{n} of these commits is already on a remote: after the rebase, the remote accepts the branch only with a force push.',
            '{n} of these commits are already on a remote: after the rebase, the remote accepts the branch only with a force push.') : null
        ].filter(Boolean).join(' ')}</p>
        {base && <code className="confirm-command">$ git rebase --interactive {base}</code>}
      </div>
      <div className="dialog-actions">
        <span className="muted" role="status">{problem || summary}</span>
        <Button onClick={onClose}>{t('Cancel')}</Button>
        <Button className="primary" reason={problem || undefined}
          onClick={() => { onClose(); onRun(entries.map(({ oid, action, message }) => ({ oid, action, message }))); }}>{t('Start rebase')}</Button>
      </div>
    </div>
  </Dialog>;
}
