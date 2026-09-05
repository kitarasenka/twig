import { useLayoutEffect, useRef } from 'react';
import { Check, GitBranch, Globe, Tag } from 'lucide-react';
import { commits } from '../../app/demo.js';

function Lane({ commit, index, filtered }) {
  return <svg className="lane" viewBox="0 0 88 30" aria-hidden="true">
    {!filtered && <>
      {index > 0 && <path className="lane-0" d="M18 0 V15" />}
      {index < commits.length - 1 && <path className="lane-0" d="M18 15 V30" />}
      {index >= 2 && index <= 6 && <path className="lane-1" d="M42 0 V30" />}
      {index === 1 && <path className="lane-1" d="M18 15 C18 25 42 20 42 30" />}
      {index === 7 && <path className="lane-1" d="M42 0 C42 10 18 5 18 15" />}
      {index >= 8 && index <= 12 && <path className="lane-2" d="M66 0 V30" />}
      {index === 7 && <path className="lane-2" d="M18 15 C18 25 66 20 66 30" />}
      {index === 13 && <path className="lane-2" d="M66 0 C66 10 18 5 18 15" />}
    </>}
    <circle className={`node lane-${commit.lane}`} cx={18 + commit.lane * 24} cy="15" r="4" />
  </svg>;
}

export default function DemoGraph({ selected, onSelect, filter, scroll, onScroll }) {
  const list = useRef(null);
  const initialScroll = useRef(scroll);
  useLayoutEffect(() => { list.current.scrollTop = initialScroll.current; }, []);
  const rows = commits.filter((c) => `${c.subject} ${c.body} ${c.author} ${c.ref}`.toLowerCase().includes(filter.toLowerCase()));
  function move(event, index) {
    let next;
    if (event.key === 'ArrowDown') next = Math.min(index + 1, rows.length - 1);
    if (event.key === 'ArrowUp') next = Math.max(index - 1, 0);
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = rows.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    onSelect(rows[next].id);
    list.current.querySelectorAll('[role="option"]')[next]?.focus();
  }
  return <div className="history">
    <div className="history-columns"><span>Branch / tag</span><span>Graph</span><span>Commit message</span><span className="author-col">Author</span><span>Date</span></div>
    <div className="history-scroll" ref={list}
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}>
      <div className="day-label">SEPTEMBER 5, 2026 <span>Illustrative history</span></div>
      <div role="listbox" aria-label="Demo commit history" aria-describedby="demo-notice">
        {rows.map((commit, i) => <button role="option" aria-selected={selected === commit.id}
          tabIndex={selected === commit.id || (!rows.some(c => c.id === selected) && i === 0) ? 0 : -1}
          className={`commit-row ${selected === commit.id ? 'selected' : ''}`} key={commit.id}
          onClick={() => onSelect(commit.id)} onKeyDown={(e) => move(e, i)}>
          <span className="ref-cell">{commit.ref && <span className={`ref-badge ${commit.ref.startsWith('origin') ? 'remote-ref' : ''}`}>
            {i === 0 && commit.ref === 'main' ? <Check /> : commit.ref.startsWith('v') ? <Tag /> : commit.ref.startsWith('origin') ? <Globe /> : <GitBranch />}
            {commit.ref}</span>}</span>
          <Lane commit={commit} index={commits.indexOf(commit)} filtered={Boolean(filter)} />
          <span className="commit-subject">{commit.subject}<span className="commit-preview">{commit.body}</span></span>
          <span className="author-col">{commit.author.split(' ')[0]}</span><span className="date-cell">{commit.date}</span>
        </button>)}
      </div>
      {rows.length === 0 && <div className="empty-inline">No matching commits. Try a different filter.</div>}
      <div className="history-end"><GitBranch /><span>Beginning of demo history</span><span>Connect a repository in the next milestone.</span></div>
    </div>
  </div>;
}
