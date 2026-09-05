import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Archive, GitBranch, PanelLeftClose, PanelLeftOpen, PanelRightOpen, RefreshCw, Search, X, Globe, Tag } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Menu from '../../ui/Menu.jsx';
import CommitPanel from '../commit/CommitPanel.jsx';
import Splitter from '../../ui/Splitter.jsx';
import { PANEL_DEFAULT } from '../../ui/panel-width.js';
import CommitGraph from './CommitGraph.jsx';
import WorktreeScreen from '../worktree/WorktreeScreen.jsx';
import ConflictEditor from '../conflicts/ConflictEditor.jsx';
import OperationBanner from '../ops/OperationBanner.jsx';
import BisectBanner from '../ops/BisectBanner.jsx';
import RefsScreen from '../refs/RefsScreen.jsx';
import StashScreen from '../stash/StashScreen.jsx';
import RebaseDialog from '../rebase/RebaseDialog.jsx';
import { ConfirmDialog, NameDialog } from '../ops/dialogs.jsx';
import { buildCommitMenu } from '../ops/commit-menu.js';
import { createLaneLayout } from './layout.js';

const IDLE = { kind: 'none', step: null, total: null, branch: null, conflicts: [], resolved: false };
const NO_BISECT = { active: false, terms: { bad: 'bad', good: 'good' }, start: null, bad: null, goods: [],
  skipped: [], expected: null, remaining: null, steps: null, done: false, firstBad: null };
/** The three centre-pane screens that replace the graph instead of selecting a commit. */
const SCREENS = ['worktree', 'branches', 'stashes'];

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

export default function HistoryWorkspace({ repository, active, mod, filterRef, onConsole, onRepositoryChanged, referencesRevision = 0 }) {
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
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [diff, setDiff] = useState(null);
  const [operation, setOperation] = useState(IDLE);
  const [bisect, setBisect] = useState(NO_BISECT);
  const [stashCount, setStashCount] = useState(0);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
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
    // Reloading history must not throw the user out of the working tree
    // screen: staging refreshes history, and the screen lives in `selected`.
    busy.current = true; setLoading(true); setError('');
    setSelected(current => (SCREENS.includes(current) ? current : null));
    setRange(null); setDiff(null); diffRequest.current++;
    try {
      const [refs, stashes] = await Promise.all([
        window.twig.getRefs(repository.id),
        window.twig.stashList(repository.id).catch(() => [])
      ]);
      if (generation.current !== epoch) return;
      setStashCount(stashes.length);
      layout.current = createLaneLayout(refs);
      dataRef.current = { commits: [], lanes: [], refs, nextSkip: 0, width: 1 };
      setData(dataRef.current);
      busy.current = false;
      await loadMore();
    } catch {
      if (generation.current === epoch) { setError('Could not load repository references.'); busy.current = false; setLoading(false); }
    }
  }, [repository.id, loadMore]);
  const refreshOperation = useCallback(async () => {
    try {
      setOperation(await window.twig.getOperationState(repository.id));
    } catch { setOperation(IDLE); }
    try {
      setBisect(await window.twig.getBisectState(repository.id));
    } catch { setBisect(NO_BISECT); }
  }, [repository.id]);
  useEffect(() => {
    void reload();
    void refreshOperation();
    const tokens = [generation, jumpRequest, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [reload, refreshOperation, referencesRevision]);

  /**
   * Runs one history-mutating command. A non-zero exit is not assumed to be a
   * failure: main answers with the operation state that followed, and a merge
   * that stopped on a conflict is reported as a conflict, not as an error.
   */
  const perform = useCallback(async (run, success) => {
    setWorking(true); setNote('');
    try {
      const result = await run();
      // Not every command reports an operation state: a stash action or a push
      // of one ref cannot start a merge, so they leave the banner alone rather
      // than claiming the repository is now idle.
      const state = result.state || null;
      if (state) setOperation(state);
      // A command that stopped mid-operation did not fail — it did exactly what
      // Git does with divergent work. The banner below says so in full, so
      // there is no note to add and no reason to throw the console open; that
      // is reserved for a command that genuinely could not run.
      if (result.ok) setNote(success);
      else if (!state || state.kind === 'none') { setNote(result.message || 'The operation did not finish.'); onConsole(); }
      else setNote('');
      if (state && state.conflicts.length === 0) setConflict(null);
      await reload();
      onRepositoryChanged?.();
      return result;
    } catch (failure) {
      setNote(failure.message || 'The operation failed.');
      onConsole();
      await refreshOperation();
      return null;
    } finally { setWorking(false); }
  }, [reload, refreshOperation, onConsole, onRepositoryChanged]);

  /**
   * Bisect answers with the marks Git left behind, not with an operation state,
   * so it refreshes its own banner. Every step moves HEAD, which is why the
   * history is reloaded with it.
   */
  const performBisect = useCallback(async (step, oid = null) => {
    setWorking(true); setNote('');
    try {
      const result = await window.twig.runBisect(repository.id, step, oid);
      setBisect(result.bisect);
      if (result.ok) setNote(step === 'start' ? 'Bisect started.' : step === 'reset' ? 'Bisect ended.' : `Revision marked ${step}.`);
      else { setNote(result.message || 'Bisect did not finish.'); onConsole(); }
      await reload();
      onRepositoryChanged?.();
    } catch (failure) {
      setNote(failure.message || 'Bisect failed.');
      onConsole();
      await refreshOperation();
    } finally { setWorking(false); }
  }, [repository.id, reload, refreshOperation, onConsole, onRepositoryChanged]);

  const headBranch = repository.status?.branch?.name || null;
  const headOid = repository.status?.branch?.oid || null;
  const dirty = (repository.status?.entries || []).some(entry => entry.kind === 'ordinary' || entry.kind === 'renamed');

  function openMenu(oid, x, y) {
    const commit = dataRef.current.commits.find(item => item.oid === oid);
    if (commit) setMenu({ commit, x, y });
  }

  function commitHandlers(commit) {
    const short = commit.oid.slice(0, 7);
    const target = headBranch || 'HEAD';
    return {
      createBranch: () => setDialog({
        type: 'name', title: `Create a branch at ${short}`, label: 'Branch name', placeholder: 'feature/short-description',
        confirmLabel: 'Create branch', extra: 'Check it out straight away',
        onConfirm: ({ name, checked }) => perform(() => window.twig.createBranch(repository.id, name, commit.oid, checked), `Branch ${name} created.`)
      }),
      createTag: () => setDialog({
        type: 'name', title: `Create a tag at ${short}`, label: 'Tag name', placeholder: 'v1.0.0',
        confirmLabel: 'Create tag', withMessage: true,
        onConfirm: ({ name, message }) => perform(() => window.twig.createTag(repository.id, name, commit.oid, message), `Tag ${name} created.`)
      }),
      checkoutBranch: name => confirmIfDirty({
        title: `Check out ${name}`, command: ['checkout', name, '--'],
        consequence: 'Your uncommitted changes stay in the working tree, and Git will refuse the checkout if they conflict with that branch.',
        confirmLabel: 'Check out',
        run: () => perform(() => window.twig.checkoutRef(repository.id, name, false), `Checked out ${name}.`)
      }),
      checkoutCommit: () => confirmIfDirty({
        title: `Check out ${short}`, command: ['checkout', '--detach', commit.oid, '--'],
        consequence: 'HEAD will be detached: new commits will belong to no branch until you create one.',
        confirmLabel: 'Check out',
        run: () => perform(() => window.twig.checkoutRef(repository.id, commit.oid, true), `Checked out ${short} with a detached HEAD.`)
      }),
      merge: (name, noFf) => perform(() => window.twig.mergeRevision(repository.id, name, noFf), `Merged ${name} into ${target}.`),
      cherryPick: () => perform(() => window.twig.cherryPick(repository.id, commit.oid), `Cherry-picked ${short}.`),
      revert: () => perform(() => window.twig.revertCommit(repository.id, commit.oid, commit.parents.length > 1 ? 1 : null), `Reverted ${short}.`),
      rebase: () => perform(() => window.twig.rebaseOnto(repository.id, commit.oid, null), `Rebased ${target} onto ${short}.`),
      interactiveRebase: () => void openRebase(commit.oid),
      reset: mode => {
        const run = () => perform(() => window.twig.resetTo(repository.id, mode, commit.oid), `Reset ${target} to ${short}.`);
        if (mode !== 'hard') { run(); return; }
        setDialog({
          type: 'confirm', title: `Reset ${target} to ${short}`, command: ['reset', '--hard', commit.oid],
          consequence: `Every uncommitted change in the working tree and the index is destroyed, and ${target} moves to ${short}. Commits left behind stay in the reflog for a while; uncommitted work does not.`,
          confirmLabel: 'Reset and discard changes', onConfirm: run
        });
      },
      bisect: step => void performBisect(step, ['start', 'bad', 'good'].includes(step) ? commit.oid : null),
      copy: (text, what) => {
        void window.twig.copyText(text).then(() => setNote(`${what} copied.`)).catch(() => setNote('Could not copy that.'));
      }
    };
  }

  function confirmIfDirty({ title, command, consequence, confirmLabel, run }) {
    if (!dirty) { run(); return; }
    setDialog({ type: 'confirm', title, command, consequence, confirmLabel, onConfirm: run });
  }

  async function openRebase(oid) {
    setWorking(true); setNote('');
    try {
      const commits = await window.twig.getRebaseCandidates(repository.id, oid);
      setDialog({ type: 'rebase', oid, commits });
    } catch (failure) {
      setNote(failure.message || 'Could not read the commits to rebase.');
      onConsole();
    } finally { setWorking(false); }
  }

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
  const screen = SCREENS.includes(selected) ? selected : null;
  const visibleRefs = data.refs.filter(ref => ref.name.toLowerCase().includes(filter.toLowerCase()));
  const showDetail = detail && !conflict && !screen;
  return <div className={`workspace real-workspace ${collapsed ? 'sidebar-small' : ''} ${showDetail ? '' : 'no-detail'}`} style={{ '--detail-width': `${width}px` }}>
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Repository navigation">
      {collapsed ? <Button icon={PanelLeftOpen} aria-label="Expand repository sidebar" onClick={() => setCollapsed(false)} /> : <>
        <div className="sidebar-filter"><Search /><input ref={filterRef} aria-label="Filter repository references" placeholder={`Filter refs · ${mod}+F`} value={filter} onChange={event => setFilter(event.target.value)} /></div>
        <nav className="sidebar-nav" aria-label="Repository screens">
          <button className={`real-branch ${screen === 'branches' ? 'selected' : ''}`} onClick={() => choose('branches')}>
            <GitBranch /><span>Branches and tags</span><small>{data.refs.length}</small></button>
          <button className={`real-branch ${screen === 'stashes' ? 'selected' : ''}`} onClick={() => choose('stashes')}>
            <Archive /><span>Stashes</span><small>{stashCount}</small></button>
        </nav>
        <div className="sidebar-sections">{[['LOCAL', 'local'], ['REMOTE', 'remote'], ['TAGS', 'tag']].map(([label, type]) => <details key={type} open><summary>{label}<span>{data.refs.filter(ref => ref.type === type).length}</span></summary>
          <BranchTree refs={visibleRefs.filter(ref => ref.type === type).map(ref => ({ ...ref, label: ref.name }))} onSelect={jump} />
          {!visibleRefs.some(ref => ref.type === type) && <p className="section-empty">No matching {label.toLowerCase()} refs</p>}
        </details>)}</div><div className="sidebar-footer"><span>{repository.status?.branch?.name || 'Detached HEAD'}</span><Button icon={PanelLeftClose} aria-label="Collapse repository sidebar" onClick={() => setCollapsed(true)} /></div>
      </>}
    </aside>
    <main className="graph-panel" aria-label="Repository history">
      <header className="graph-heading"><div><GitBranch /><strong>History</strong><span className="count">{data.commits.length} loaded</span></div><div>{!detail && <Button icon={PanelRightOpen} aria-label="Show commit details" onClick={() => setDetail(true)} />}<Button icon={RefreshCw} reason={loading ? 'History is loading' : undefined}
        onClick={() => { void reload(); void refreshOperation(); onRepositoryChanged?.(); }}>Refresh</Button></div></header>
      {error && <div className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></div>}
      {note && <div className="operation-note" role="status"><span>{note}</span><button onClick={() => setNote('')} aria-label="Dismiss">×</button></div>}
      <OperationBanner state={operation} busy={working} onOpenConflict={setConflict}
        onStep={step => perform(() => window.twig.runSequencer(repository.id, operation.kind, step), `${operation.kind} ${step === 'abort' ? 'aborted' : step === 'skip' ? 'skipped a commit' : 'finished'}.`)} />
      <BisectBanner state={bisect} busy={working} onStep={step => void performBisect(step, null)} onOpenCommit={jump} />
      <div hidden={Boolean(diff) || Boolean(conflict) || Boolean(screen)} className="history-slot">
        {loading && !data.commits.length ? <div className="loading-shell" aria-label="Loading history">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>
          : <CommitGraph commits={data.commits} lanes={data.lanes} laneCount={data.width} refMap={refMap} indexMap={indexMap} selected={selected} head={repository.status?.branch?.oid}
            onSelect={choose} onMenu={openMenu} loadMore={loadMore} hasMore={data.nextSkip !== null} loading={loading} changes={changes.length} onWorktree={() => choose('worktree')} active={active} />}
      </div>
      {conflict && <ConflictEditor repositoryId={repository.id} file={conflict} onConsole={onConsole} onClose={() => setConflict(null)}
        onResolved={state => { setConflict(null); setOperation(state); setNote(`${conflict} marked resolved.`); void reload(); onRepositoryChanged?.(); }} />}
      {!conflict && screen === 'branches' && <RefsScreen repository={repository} refs={data.refs} headBranch={headBranch} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'stashes' && <StashScreen repository={repository} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'worktree' && <WorktreeScreen repository={repository} onConsole={onConsole} onChanged={() => { void reload(); void refreshOperation(); onRepositoryChanged?.(); }}
        onBack={() => choose(data.commits[0]?.oid || null)} />}
      {!conflict && diff && <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }} />}
    </main>
    {showDetail && <Splitter width={width} onWidth={setWidth} />}
    {showDetail && <CommitPanel repositoryId={repository.id} {...commitState} onClose={() => setDetail(false)} onParent={jump} onFile={openFile} onConsole={onConsole} range={range} />}
    {menu && <Menu x={menu.x} y={menu.y} label={`Actions for commit ${menu.commit.oid.slice(0, 7)}`} onClose={() => setMenu(null)}
      items={buildCommitMenu({
        commit: menu.commit, refs: refMap.get(menu.commit.oid) || [], operation, bisect, dirty,
        head: { branch: headBranch, oid: headOid, detached: Boolean(repository.status?.branch?.detached) },
        handlers: commitHandlers(menu.commit)
      })} />}
    {dialog?.type === 'confirm' && <ConfirmDialog {...dialog} onClose={() => setDialog(null)} />}
    {dialog?.type === 'name' && <NameDialog {...dialog} onClose={() => setDialog(null)} />}
    {dialog?.type === 'rebase' && <RebaseDialog commits={dialog.commits} onClose={() => setDialog(null)}
      onRun={entries => perform(() => window.twig.rebaseOnto(repository.id, dialog.oid, entries), 'Rebase finished.')} />}
  </div>;
}
