import { useState } from 'react';
import { ChevronDown, ChevronRight, FilePenLine, Folder, GitBranch, Globe, PanelLeftClose, PanelLeftOpen, Search, Tag, Terminal, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { commits, sections } from './demo.js';

export function Sidebar({ collapsed, onCollapse, filter, onFilter, filterRef, mod }) {
  if (collapsed) return <aside className="sidebar collapsed"><Button icon={PanelLeftOpen} aria-label="Expand sidebar" title={`${mod}+B`} onClick={onCollapse} /></aside>;
  return <aside className="sidebar" aria-label="Repository navigation">
    <div className="sidebar-filter"><Search /><input ref={filterRef} aria-label="Filter branches and history" placeholder={`Filter · ${mod}+F`} value={filter} onChange={(e) => onFilter(e.target.value)} /></div>
    <div className="sidebar-sections">{sections.map(([name, items]) => <details key={name} open>
      <summary>{name}<span>{items.length}</span></summary>
      {items.length === 0 ? <p className="section-empty">No stashes in this demo</p> : items.filter(item => item.toLowerCase().includes(filter.toLowerCase())).map(item =>
        <div className={`branch-item ${item === 'main' ? 'current' : ''}`} key={item} title={item}>
          {name === 'TAGS' ? <Tag /> : name === 'REMOTES' || name === 'REMOTE' ? <Globe /> : item.includes('/') && name === 'LOCAL' ? <Folder /> : <GitBranch />}
          <span>{item}</span>{item === 'main' && <small>HEAD</small>}
        </div>)}
    </details>)}</div>
    <div className="sidebar-footer"><span>Demo workspace</span><Button icon={PanelLeftClose} aria-label="Collapse sidebar" title={`${mod}+B`} onClick={onCollapse} /></div>
  </aside>;
}

export function CommitDetails({ selected, onSelect, onClose, mode, setMode }) {
  const commit = commits.find(c => c.id === selected) || commits[0];
  const [tree, setTree] = useState(false);
  return <aside className="commit-detail" aria-label="Commit details">
    <header className="panel-heading"><span>COMMIT <code>{commit.id}</code></span><Button icon={X} aria-label="Close commit details" onClick={onClose} /></header>
    <div className="detail-content"><span className="eyebrow">DEMO COMMIT</span><h2>{commit.subject}</h2>
      <pre className="commit-body">{commit.body}{'\n\n'}This is sample content for the Git Desk workspace preview.</pre>
      <div className="author-card"><span className="avatar">{commit.author.split(' ').map(n => n[0]).join('')}</span><div><strong>{commit.author}</strong><span>Sample author</span></div></div>
      <dl className="metadata"><dt>Authored</dt><dd>{commit.authored}</dd><dt>Committed</dt><dd>{commit.authored}</dd><dt>Parent</dt><dd>{commit.parentIndex !== null
        ? <button className="text-button" onClick={() => onSelect(commits[commit.parentIndex].id)}>{commits[commit.parentIndex].id}</button> : 'Root commit'}</dd></dl>
      <div className="files-heading"><FilePenLine /><strong>{commit.files.length} modified</strong></div>
      <div className="file-controls"><div className="segmented" aria-label="File list view"><button aria-pressed={!tree} onClick={() => setTree(false)}>Path</button><button aria-pressed={tree} onClick={() => setTree(true)}>Tree</button></div><span>Sample files</span></div>
      <ul className="file-list">{commit.files.map(file => <li key={file} title={`${file} — Diff available in M2`}><FilePenLine /><span>{tree ? file.split('/').map((part, i) => <span className="file-part" key={i}>{i > 0 && <ChevronRight />}{part}</span>) : file}</span><small>M</small></li>)}</ul>
    </div>
    <div className="detail-resize"><label htmlFor="detail-size">Panel width</label><input id="detail-size" aria-label="Commit panel width" type="range" min="260" max="420" step="10" value={mode} onChange={(e) => setMode(Number(e.target.value))} /></div>
  </aside>;
}

export function Console({ expanded, onToggle, mod }) {
  return <section className={`console ${expanded ? 'expanded' : ''}`} aria-label="Command console">
    <button className="console-status" onClick={onToggle} aria-expanded={expanded} title={`Terminal · ${mod}+J`}>
      <Terminal /><strong>CONSOLE</strong><ChevronDown className={expanded ? '' : 'rotate'} /><span>No commands run yet</span><span className="console-tail">Git Desk · Preview</span>
    </button>
    {expanded && <div className="console-empty"><Terminal /><div><strong>Your commands, in plain sight.</strong><p>Every Git command and its output will appear here when a repository is connected.</p><p>This preview does not execute commands.</p></div><kbd>{mod}+J</kbd></div>}
  </section>;
}
