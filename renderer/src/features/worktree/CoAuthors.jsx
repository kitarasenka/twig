import { useEffect, useId, useRef, useState } from 'react';
import { UserPlus, Users, X } from 'lucide-react';
import { CO_AUTHOR_LIMIT, coAuthorTrailer, filterCoAuthors } from '../../../../main/git/co-author-trailer.js';

/**
 * Credit the people a commit was written with. The list is who already
 * authored commits here — read once from this repository's history when the
 * field is first used, never typed free-hand — and each chosen person becomes
 * a `Co-authored-by:` trailer, shown below exactly as Git will write it.
 */
export default function CoAuthors({ repositoryId, chosen, onChange, disabled = false, autoFocus = false, onDone = null }) {
  const [people, setPeople] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef(null);
  const listId = useId();

  // A new repository has other people; the list is read again on next use.
  useEffect(() => { setPeople(null); setError(''); }, [repositoryId]);
  // Opened by its button: the caret goes straight into the field.
  useEffect(() => { if (autoFocus) input.current?.focus(); }, [autoFocus]);

  async function load() {
    if (people !== null || loading) return;
    setLoading(true); setError('');
    try {
      const result = await window.twig.getCoAuthors(repositoryId);
      setPeople(result.people);
    } catch {
      setError('Could not read the authors in this history.');
    } finally { setLoading(false); }
  }

  const matches = open ? filterCoAuthors(people || [], query, chosen) : [];
  const full = chosen.length >= CO_AUTHOR_LIMIT;
  function pick(person) {
    if (!person || full) return;
    onChange([...chosen, { name: person.name, email: person.email }]);
    setQuery(''); setActive(0);
    input.current?.focus();
  }
  function keydown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      if (matches.length) setActive(index => (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (event.key === 'Enter' && open && matches[active]) {
      event.preventDefault();
      pick(matches[active]);
    } else if (event.key === 'Escape' && (open || (!chosen.length && onDone))) {
      event.preventDefault();
      event.stopPropagation();
      // Escape closes the list, and then an empty picker folds back into its button.
      if (open && matches.length) setOpen(false); else if (!chosen.length) onDone?.();
    } else if (event.key === 'Backspace' && !query && chosen.length) {
      onChange(chosen.slice(0, -1));
    }
  }

  const empty = people !== null && people.length === 0;
  return <div className="co-authors">
    <div className="co-authors-row">
      <span className="co-authors-label"><Users aria-hidden="true" />Co-authors</span>
      {chosen.map(person => <span className="co-author-chip" key={person.email} title={coAuthorTrailer(person)}>
        {person.name}
        <button type="button" aria-label={`Remove co-author ${person.name}`} onClick={() => onChange(chosen.filter(item => item !== person))}><X aria-hidden="true" /></button>
      </span>)}
      <span className="co-author-picker">
        <UserPlus aria-hidden="true" />
        <input ref={input} value={query} disabled={disabled || full} autoComplete="off" spellCheck={false}
          placeholder={full ? `Up to ${CO_AUTHOR_LIMIT} co-authors` : 'Add someone from this history'}
          role="combobox" aria-label="Add a co-author" aria-expanded={open && matches.length > 0} aria-controls={listId}
          aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
          onFocus={() => { setOpen(true); void load(); }} onBlur={() => setOpen(false)}
          onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} onKeyDown={keydown} />
        {open && matches.length > 0 && <ul className="co-author-options" role="listbox" id={listId} aria-label="Authors in this history">
          {matches.map((person, index) => <li key={person.email} id={`${listId}-${index}`} role="option" aria-selected={index === active}
            className={index === active ? 'active' : ''}
            // mousedown, not click: the input's blur would close the list first.
            onMouseDown={event => { event.preventDefault(); pick(person); }} onMouseEnter={() => setActive(index)}>
            <strong>{person.name}</strong><span>{person.email}</span>
            <small>{person.commits} commit{person.commits === 1 ? '' : 's'}</small>
          </li>)}
        </ul>}
      </span>
    </div>
    {open && loading && <p className="muted co-author-hint" role="status">Reading the authors in this history…</p>}
    {open && people !== null && !matches.length && (query || empty) && <p className="muted co-author-hint">
      {empty ? 'Nobody else has authored a commit in this history yet.' : 'No author in this history matches.'}</p>}
    {error && <p className="warn co-author-hint" role="alert">{error}</p>}
    {chosen.length > 0 && <div className="co-author-preview" aria-label="Trailers added to the message">
      <span className="muted">Added to the end of the message:</span>
      {chosen.map(person => <code key={person.email}>{coAuthorTrailer(person)}</code>)}
    </div>}
  </div>;
}
