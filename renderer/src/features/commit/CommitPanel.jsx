import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, FilePenLine, Github, Gitlab, X } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { AGE_STOPS, ageStop, ageTextClass } from '../graph/age-color.js';
import { MARK_COLORS, MARK_LABELS } from '../graph/mark-color.js';
import { forgeLabel, forgeLinks } from './forge-url.js';

function ForgeIcon({ forge, ...props }) {
  if (forge === 'github') return <Github {...props} />;
  if (forge === 'gitlab') return <Gitlab {...props} />;
  return <ExternalLink {...props} />;
}

/**
 * Right-click, or Shift+F10 / the Menu key on a focused row, opens the file
 * context menu — the same two ways the commit graph reaches its own menu.
 */
function fileMenuProps(path, onFileMenu) {
  if (!onFileMenu) return {};
  return {
    onContextMenu: event => { event.preventDefault(); onFileMenu(path, event.clientX, event.clientY); },
    onKeyDown: event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      onFileMenu(path, box.left + 24, box.bottom);
    }
  };
}

function FileTree({ files, onFile, onFileMenu }) {
  const tree = useMemo(() => {
    const root = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
        node = node.folders.get(part);
      }
      node.files.push(file);
    }
    return root;
  }, [files]);
  function render(node) {
    return <>{[...node.folders].map(([name, child]) => <details className="file-folder" key={name} open><summary>{name}</summary>{render(child)}</details>)}
      {node.files.map(file => <button className="commit-file" key={file.path} onClick={() => onFile(file.path)} title={file.path} {...fileMenuProps(file.path, onFileMenu)}><span className="file-status">{file.status}</span><span>{file.path.split('/').at(-1)}</span></button>)}</>;
  }
  return render(tree);
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CommitPanel({ repositoryId, commit, loading, error, onClose, onParent, onFile, onFileMenu, onConsole, range, commitColors = 'lanes', remotes = [], mark = null, onSetMark, onClearMark }) {
  const [tree, setTree] = useState(false);
  const [all, setAll] = useState(false);
  const [sort, setSort] = useState('path');
  const [allFiles, setAllFiles] = useState(null);
  const [fileError, setFileError] = useState('');
  const [filter, setFilter] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  useEffect(() => { setNoteDraft(mark?.note || ''); }, [mark, commit?.oid]);
  useEffect(() => {
    let alive = true;
    setAllFiles(null); setFileError('');
    if (all && commit?.oid && !range) window.twig.getCommitFiles(repositoryId, commit.oid)
      .then(files => { if (alive) setAllFiles(files); }).catch(() => { if (alive) setFileError('Could not load the file tree.'); });
    return () => { alive = false; };
  }, [repositoryId, commit?.oid, all, range]);
  const files = useMemo(() => (all && !range ? allFiles || [] : commit?.files || [])
    .filter(file => file.path.toLowerCase().includes(filter.toLowerCase()))
    .slice().sort((a, b) => (sort === 'status' ? a.status.localeCompare(b.status) : 0) || a.path.localeCompare(b.path, 'en')),
  [all, range, allFiles, commit, filter, sort]);
  // The committed date carries the same age colour as its row in the graph.
  const age = commitColors === 'age' && commit ? ageStop(commit.committedAt) : null;
  const links = useMemo(
    () => forgeLinks(remotes, { oid: commit?.oid, email: commit?.author?.email }),
    [remotes, commit?.oid, commit?.author?.email]
  );
  const email = commit?.author?.email || '';
  return <aside className="commit-detail" aria-label="Commit details">
    <header className="panel-heading">
      <span>{range ? 'COMPARE' : 'COMMIT'} <code>{commit?.oid.slice(0, 8) || '…'}</code></span>
      {links?.commit && <a className="forge-link" href={links.commit} rel="noreferrer" title={`Open this commit on ${forgeLabel(links.forge)}`}>
        <ForgeIcon forge={links.forge} aria-hidden="true" /><span>{forgeLabel(links.forge)}</span>
      </a>}
      <Button icon={X} aria-label="Close commit details" onClick={onClose} />
    </header>
    <div className="detail-content">
      {loading && <div aria-busy="true" aria-label="Loading commit">{Array.from({ length: 8 }, (_, i) => <div className="skeleton detail-skeleton" key={i} />)}</div>}
      {error && <p role="alert">{error} <button onClick={onConsole}>Show output</button></p>}
      {!loading && !error && commit && <>
        {range && <p className="muted">Changes from {range.base.slice(0, 8)} to {range.oid.slice(0, 8)}</p>}
        {!range && onSetMark && <div className="mark-editor">
          <p className="mark-label">{mark ? 'Mark' : 'Mark this commit'}</p>
          <div className="mark-swatches" role="group" aria-label="Commit mark colour">
            {MARK_COLORS.map(color => <button key={color} type="button"
              className={`mark-swatch mark-${color} ${mark?.color === color ? 'active' : ''}`}
              aria-pressed={mark?.color === color} aria-label={MARK_LABELS[color]} title={MARK_LABELS[color]}
              onClick={() => onSetMark(commit.oid, color, noteDraft)} />)}
            {mark && <button type="button" className="text-button" onClick={() => onClearMark(commit.oid)}>Remove mark</button>}
          </div>
          {mark && <div className="mark-note">
            <textarea aria-label="Mark note" placeholder="Note (optional)" rows={2} maxLength={2000}
              value={noteDraft} onChange={e => setNoteDraft(e.target.value)} />
            <Button onClick={() => onSetMark(commit.oid, mark.color, noteDraft)}
              reason={noteDraft === (mark.note || '') ? 'The note is unchanged' : undefined}>Save note</Button>
          </div>}
        </div>}
        <h2>{commit.subject || '(no subject)'}</h2><pre className="commit-body">{commit.body}</pre>
        <div className="author-card"><span className="avatar">{commit.author.name.split(/\s+/).slice(0, 2).map(part => part[0]).join('')}</span><div>
          <strong>{commit.author.name}{links?.authorCommits && <a className="forge-link" href={links.authorCommits} rel="noreferrer" title={`Commits by ${commit.author.name} on ${forgeLabel(links.forge)}`}><ForgeIcon forge={links.forge} aria-hidden="true" /></a>}</strong>
          <span>{EMAIL.test(email) ? <a className="text-link" href={`mailto:${email}`}>{email}</a> : email}</span>
        </div></div>
        <dl className="metadata"><dt>Authored</dt><dd>{new Date(commit.author.date).toLocaleString('en-GB')}</dd><dt>Committed</dt><dd className={ageTextClass(age)} title={age === null ? undefined : AGE_STOPS[age].label}>{new Date(commit.committedAt).toLocaleString('en-GB')}</dd><dt>Parents</dt><dd>{commit.parents.length ? commit.parents.map(oid => <button key={oid} className="text-button" onClick={() => onParent(oid)}>{oid.slice(0, 8)}</button>) : 'Root commit'}</dd></dl>
        <div className="files-heading"><FilePenLine /><strong>{commit.files.length} changed files</strong></div>
        {commit.parents.length > 1 && !range && <p className="muted">Compared with first parent</p>}
        <div className="file-controls"><div className="segmented"><button aria-pressed={!tree} onClick={() => setTree(false)}>Path</button><button aria-pressed={tree} onClick={() => setTree(true)}>Tree</button></div><label><input type="checkbox" checked={all && !range} disabled={Boolean(range)} onChange={e => setAll(e.target.checked)} /> All files</label></div>
        <div className="file-controls"><input aria-label="Filter commit files" placeholder="Filter files" value={filter} onChange={e => setFilter(e.target.value)} /><select aria-label="Sort commit files" value={sort} onChange={e => setSort(e.target.value)}><option value="path">Path</option><option value="status">Status</option></select></div>
        {fileError && <p role="alert">{fileError}<button onClick={onConsole}>Show output</button></p>}
        {all && !allFiles && !range ? <div className="skeleton" aria-label="Loading files" /> : tree ? <FileTree files={files} onFile={onFile} onFileMenu={onFileMenu} /> : files.map(file => <button className="commit-file" key={file.path} onClick={() => onFile(file.path)} title={file.path} {...fileMenuProps(file.path, onFileMenu)}><span className="file-status">{file.status}</span><span>{file.path}</span></button>)}
        {!files.length && (!all || allFiles) && <p className="muted">No matching files.</p>}
      </>}
    </div>
  </aside>;
}
