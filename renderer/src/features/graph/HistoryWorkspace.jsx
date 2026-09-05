import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, PanelLeftClose, PanelLeftOpen, PanelRightOpen, RefreshCw, Search, X, Globe, Tag } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import CommitPanel from '../commit/CommitPanel.jsx';
import CommitGraph from './CommitGraph.jsx';
import { createLaneLayout } from './layout.js';

function BranchTree({ refs, onSelect }) {
  const folders = new Map();
  const leaves = [];
  for (const ref of refs) {
    const slash = ref.label.indexOf('/');
    if (slash < 0) leaves.push(ref);
    else {
      const folder = ref.label.slice(0, slash);
      if (!folders.has(folder)) folders.set(folder, []);
      folders.get(folder).push({ ...ref, label: ref.label.slice(slash + 1) });
    }
  }
  return <>{[...folders].map(([name, children]) => <details className="branch-folder" key={name} open><summary>{name}</summary><BranchTree refs={children} onSelect={onSelect} /></details>)}
    {leaves.map(ref => <button className="real-branch" key={ref.fullName} title={ref.fullName} onClick={() => onSelect(ref.target)}>
      {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.label}</span>{(ref.ahead > 0 || ref.behind > 0) && <small>↑{ref.ahead} ↓{ref.behind}</small>}</button>)}</>;
}

function Diff({ diff, onClose }) {
  return <section className="diff-view" aria-label="File diff"><header className="panel-heading"><code>{diff.file}</code><Button icon={X} aria-label="Close diff" onClick={onClose} /></header>
    {diff.loading ? <div className="loading-shell" aria-label="Loading diff"><div className="skeleton" /></div> : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p> : diff.binary ? <p className="empty-inline">Binary file changed. A text diff is unavailable.</p> : <div className="diff-lines" tabIndex={0} aria-label="Diff lines">
      {diff.patch ? diff.patch.split('\n').map((line, index) => <div key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-deleted' : line.startsWith('@@') ? 'diff-hunk' : ''}><span>{line || ' '}</span></div>) : <p className="empty-inline">No changes for this file in this comparison.</p>}
    </div>}
  </section>;
}

export default function HistoryWorkspace({ repository, active, mod, filterRef, onConsole }) {
  const [data, setData] = useState({ commits: [], lanes: [], refs: [], nextSkip: 0, width: 1 });
  const dataRef = useRef(data);
  const layout = useRef(createLaneLayout());
  const generation = useRef(0);
  const busy = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [range, setRange] = useState(null);
  const [commitState, setCommitState] = useState({ commit: null, loading: false, error: '' });
  const [detail, setDetail] = useState(true);
  const [width, setWidth] = useState(306);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [diff, setDiff] = useState(null);
  const diffRequest = useRef(0);
  const jumpRequest = useRef(0);
  const selectionAnchor = useRef(null);
  const indexMap = useMemo(() => new Map(data.commits.map((commit, index) => [commit.oid, index])), [data.commits]);
  const refMap = useMemo(() => {
    const result = new Map();
    for (const ref of data.refs) result.set(ref.target, [...result.get(ref.target) || [], ref]);
    return result;
  }, [data.refs]);

  const loadMore = useCallback(async () => {
    if (busy.current || dataRef.current.nextSkip === null) return false;
    busy.current = true; setLoading(true);
    const epoch = generation.current;
    try {
      const page = await window.twig.getHistoryPage(repository.id, dataRef.current.nextSkip, 250);
      if (epoch !== generation.current) return false;
      const previous = dataRef.current;
      const known = new Set(previous.commits.map(commit => commit.oid));
      if (page.commits.some(commit => known.has(commit.oid))) throw new Error('History changed while loading. Refresh to reload it.');
      const lanes = layout.current.append(page.commits);
      dataRef.current = { ...previous, commits: [...previous.commits, ...page.commits], lanes: [...previous.lanes, ...lanes], nextSkip: page.nextSkip, width: layout.current.width };
      setData(dataRef.current);
      setSelected(value => value || page.commits[0]?.oid || null);
      return true;
    } catch (failure) {
      if (epoch === generation.current) setError(failure.message || 'Could not load history.');
      return false;
    } finally { if (epoch === generation.current) { busy.current = false; setLoading(false); } }
  }, [repository.id]);

  const reload = useCallback(async () => {
    const epoch = ++generation.current;
    busy.current = true; setLoading(true); setError(''); setSelected(null); setRange(null); setDiff(null); diffRequest.current++;
    try {
      const refs = await window.twig.getRefs(repository.id);
      if (generation.current !== epoch) return;
      layout.current = createLaneLayout(refs);
      dataRef.current = { commits: [], lanes: [], refs, nextSkip: 0, width: 1 };
      setData(dataRef.current);
      busy.current = false;
      await loadMore();
    } catch {
      if (generation.current === epoch) { setError('Could not load repository references.'); busy.current = false; setLoading(false); }
    }
  }, [repository.id, loadMore]);
  useEffect(() => {
    void reload();
    const tokens = [generation, jumpRequest, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [reload]);

  useEffect(() => {
    let alive = true;
    if (!selected || selected === 'worktree') { setCommitState({ commit: null, loading: false, error: '' }); return; }
    setCommitState({ commit: null, loading: true, error: '' });
    const timer = setTimeout(() => {
      Promise.all([window.twig.getCommit(repository.id, selected), range ? window.twig.compareCommits(repository.id, range.base, range.oid) : Promise.resolve(null)])
        .then(([commit, files]) => { if (alive) setCommitState({ commit: files ? { ...commit, files } : commit, loading: false, error: '' }); })
        .catch(() => { if (alive) setCommitState({ commit: null, loading: false, error: 'Could not read this commit.' }); });
    }, 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [selected, repository.id, range]);

  const choose = useCallback((oid, shift = false) => {
    jumpRequest.current++;
    const anchor = selectionAnchor.current || selected;
    setRange(shift && anchor && anchor !== 'worktree' && oid !== anchor ? { base: anchor, oid } : null);
    if (!shift) selectionAnchor.current = oid;
    setSelected(oid);
    setDetail(true); setDiff(null); diffRequest.current++;
  }, [selected]);

  async function jump(oid) {
    const request = ++jumpRequest.current;
    setError('');
    while (!dataRef.current.commits.some(commit => commit.oid === oid) && dataRef.current.nextSkip !== null) {
      if (!await loadMore() || jumpRequest.current !== request) return;
    }
    if (jumpRequest.current !== request) return;
    if (dataRef.current.commits.some(commit => commit.oid === oid)) choose(oid);
    else setError('This commit is not in the loaded repository history. Refresh to update it.');
  }
  async function openFile(file) {
    const request = ++diffRequest.current;
    setDiff({ file, loading: true });
    try {
      const result = await window.twig.getFileDiff(repository.id, selected, file, range?.base || null);
      if (request === diffRequest.current) setDiff({ file, ...result, loading: false });
    } catch { if (request === diffRequest.current) setDiff({ file, error: 'Could not read the diff. Show output in the console.', loading: false }); }
  }
  const changes = repository.status?.entries || [];
  const visibleRefs = data.refs.filter(ref => ref.name.toLowerCase().includes(filter.toLowerCase()));
  return <div className={`workspace real-workspace ${collapsed ? 'sidebar-small' : ''} ${detail && selected !== 'worktree' ? '' : 'no-detail'}`} style={{ '--detail-width': `${width}px` }}>
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Repository navigation">
      {collapsed ? <Button icon={PanelLeftOpen} aria-label="Expand repository sidebar" onClick={() => setCollapsed(false)} /> : <>
        <div className="sidebar-filter"><Search /><input ref={filterRef} aria-label="Filter repository references" placeholder={`Filter refs · ${mod}+F`} value={filter} onChange={event => setFilter(event.target.value)} /></div>
        <div className="sidebar-sections">{[['LOCAL', 'local'], ['REMOTE', 'remote'], ['TAGS', 'tag']].map(([label, type]) => <details key={type} open><summary>{label}<span>{data.refs.filter(ref => ref.type === type).length}</span></summary>
          <BranchTree refs={visibleRefs.filter(ref => ref.type === type).map(ref => ({ ...ref, label: ref.name }))} onSelect={jump} />
          {!visibleRefs.some(ref => ref.type === type) && <p className="section-empty">No matching {label.toLowerCase()} refs</p>}
        </details>)}</div><div className="sidebar-footer"><span>{repository.status?.branch?.name || 'Detached HEAD'}</span><Button icon={PanelLeftClose} aria-label="Collapse repository sidebar" onClick={() => setCollapsed(true)} /></div>
      </>}
    </aside>
    <main className="graph-panel" aria-label="Repository history">
      <header className="graph-heading"><div><GitBranch /><strong>History</strong><span className="count">{data.commits.length} loaded</span></div><div>{!detail && <Button icon={PanelRightOpen} aria-label="Show commit details" onClick={() => setDetail(true)} />}<Button icon={RefreshCw} reason={loading ? 'History is loading' : undefined} onClick={reload}>Refresh</Button></div></header>
      {error && <div className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></div>}
      <div hidden={Boolean(diff) || selected === 'worktree'} className="history-slot">
        {loading && !data.commits.length ? <div className="loading-shell" aria-label="Loading history">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>
          : <CommitGraph commits={data.commits} lanes={data.lanes} laneCount={data.width} refMap={refMap} indexMap={indexMap} selected={selected} head={repository.status?.branch?.oid}
            onSelect={choose} loadMore={loadMore} hasMore={data.nextSkip !== null} loading={loading} changes={changes.length} onWorktree={() => choose('worktree')} active={active} />}
      </div>
      {selected === 'worktree' && <div className="worktree-summary"><header className="panel-heading"><strong>Uncommitted changes · {changes.length} files</strong><button onClick={() => choose(data.commits[0]?.oid || null)}>Back to history</button></header><p className="muted">Working tree changes. Staging and committing will be available in the next release.</p>{changes.map(file => <div className="worktree-file" key={file.path}><code>{file.kind === 'untracked' ? '?' : file.indexStatus + file.worktreeStatus}</code><span>{file.path}</span></div>)}</div>}
      {diff && <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }} />}
    </main>
    {detail && selected !== 'worktree' && <CommitPanel repositoryId={repository.id} {...commitState} width={width} onWidth={setWidth} onClose={() => setDetail(false)} onParent={jump} onFile={openFile} onConsole={onConsole} range={range} />}
  </div>;
}
