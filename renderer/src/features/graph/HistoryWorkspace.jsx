import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlignLeft, Archive, Boxes, Bug, FileInput, FolderGit2, GitBranch, HardDrive, History, PanelLeftClose, PanelLeftOpen, PanelRightOpen, RefreshCw, Search, X, Globe, Tag, Workflow } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Menu from '../../ui/Menu.jsx';
import CommitPanel from '../commit/CommitPanel.jsx';
import Splitter from '../../ui/Splitter.jsx';
import { PANEL_DEFAULT, SIDEBAR_SIZE, FILE_HISTORY_PANEL_SIZE } from '../../ui/panel-width.js';
import CommitGraph, { UNCOMMITTED } from './CommitGraph.jsx';
import WorktreeScreen from '../worktree/WorktreeScreen.jsx';
import WorktreePanel from '../worktree/WorktreePanel.jsx';
import { conflictCount, summarizeStatus } from '../worktree/worktree-summary.js';
import { discardDialog } from '../worktree/discard-dialog.js';
import { SEARCH_MODE_OPTIONS, searchEmpty, searchSummary } from './search-modes.js';
import ConflictEditor from '../conflicts/ConflictEditor.jsx';
import OperationBanner from '../ops/OperationBanner.jsx';
import BisectBanner from '../ops/BisectBanner.jsx';
import RefsScreen, { UpstreamDialog } from '../refs/RefsScreen.jsx';
import { pushRefCommand, splitRemoteRef } from '../refs/remote-ref.js';
import StashScreen from '../stash/StashScreen.jsx';
import ReflogScreen from '../reflog/ReflogScreen.jsx';
import WorktreesScreen from '../tools/WorktreesScreen.jsx';
import SubmodulesScreen from '../tools/SubmodulesScreen.jsx';
import WorktreeDialog from '../tools/WorktreeDialog.jsx';
import AutomationsScreen from '../automations/AutomationsScreen.jsx';
import ExecutionPanel from '../automations/ExecutionPanel.jsx';
import { eventLabel, eventPhase } from '../automations/event-labels.js';
import RebaseDialog from '../rebase/RebaseDialog.jsx';
import PatchDialog from '../ops/PatchDialog.jsx';
import { exportOrder } from '../ops/patch-view.js';
import { ConfirmDialog, MessageDialog, NameDialog } from '../ops/dialogs.jsx';
import { buildCommitMenu, buildMultiCommitMenu } from '../ops/commit-menu.js';
import { buildRefMenu, buildSectionMenu } from '../refs/ref-menu.js';
import { absolutePath, buildFileMenu } from '../diff/file-menu.js';
import { buildRewordPlan } from '../ops/reword-plan.js';
import { buildSquashPlan } from '../ops/squash-plan.js';
import { createLaneLayout } from './layout.js';
import useGitDrag, { refEndpoint } from './useGitDrag.js';
import DropDialog from './DropDialog.jsx';
import BlameView from '../blame/BlameView.jsx';
import BlameDetail from '../blame/BlameDetail.jsx';
import DiffLines from '../diff/DiffLines.jsx';
import { dropActions, endpointLabel, sameEndpoint } from '../../../../main/git/drop-plan.js';

const NOOP = () => {};
const IDLE = { kind: 'none', step: null, total: null, branch: null, conflicts: [], resolved: false };
const NO_BISECT = { active: false, terms: { bad: 'bad', good: 'good' }, start: null, bad: null, goods: [],
  skipped: [], expected: null, remaining: null, steps: null, done: false, firstBad: null };
/** The four centre-pane screens that replace the graph instead of selecting a commit. */
const SCREENS = ['worktree', 'branches', 'stashes', 'reflog', 'worktrees', 'submodules', 'automations'];
/** Values of `selected` that are not a commit oid and so have no commit to read. */
const isCommitSelection = value => Boolean(value) && !SCREENS.includes(value) && value !== UNCOMMITTED;
/** Shift+F10 or the Menu key: the keyboard way to a context menu, as in the graph. */
const isMenuKey = event => event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
/** Right-click and the menu keys on one element, opening at the pointer or under the element. */
function contextMenuProps(open, keydown) {
  return {
    onContextMenu: event => { event.preventDefault(); event.stopPropagation(); open(event.clientX, event.clientY); },
    onKeyDown: event => {
      if (!isMenuKey(event)) { keydown?.(event); return; }
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      open(box.left + 24, box.bottom);
    }
  };
}

function BranchTree({ refs, onSelect, onMenu, onRename, drag, headBranch }) {
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
  return <>{[...folders].map(([name, children]) => <details className="branch-folder" key={name} open><summary>{name}</summary><BranchTree refs={children} onSelect={onSelect} onMenu={onMenu} onRename={onRename} drag={drag} headBranch={headBranch} /></details>)}
    {leaves.map(ref => {
      const bound = drag.bind(refEndpoint(ref));
      // F2 renames a local branch, the way it renames a file in a file manager.
      const keydown = event => {
        if (event.key === 'F2' && ref.type === 'local' && !event.altKey && !event.metaKey && !event.ctrlKey) { event.preventDefault(); onRename(ref); return; }
        bound.onKeyDown?.(event);
      };
      return <button {...bound} {...contextMenuProps((x, y) => onMenu(ref, x, y), keydown)} className={`real-branch ${ref.type === 'local' && ref.name === headBranch ? 'current-branch' : ''} ${drag.className(refEndpoint(ref))}`} key={ref.fullName}
      title={`${ref.fullName} · Drag or Alt+D, then Alt+Enter on a target · Right-click or Shift+F10 for actions${ref.type === 'local' ? ' · F2 to rename' : ''}`} onClick={() => onSelect(ref.target)}>
      {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.label}</span>{(ref.ahead > 0 || ref.behind > 0) && <small>↑{ref.ahead} ↓{ref.behind}</small>}</button>; })}</>;
}

function Diff({ diff, onClose, onCommit, onBlame }) {
  return <section className="diff-view" aria-label="File diff"><header className="panel-heading"><code>{diff.file}</code>
    {diff.section && <span className="pill">{diff.section === 'staged' ? 'Staged' : diff.section === 'untracked' ? 'Untracked' : 'Not staged'}</span>}
    {onBlame && <Button icon={AlignLeft} onClick={onBlame}>Blame</Button>}
    <Button icon={X} aria-label="Close diff" onClick={onClose} /></header>
    {onCommit && <div className="file-history-diff-heading"><code>{diff.oid.slice(0, 8)}</code><Button icon={GitBranch} onClick={onCommit}>Go to commit</Button></div>}
    {diff.loading ? <div className="loading-shell" aria-label="Loading diff"><div className="skeleton" /></div> : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p> : diff.note ? <p className="empty-inline">{diff.note}</p> : diff.binary ? <p className="empty-inline">Binary file changed. A text diff is unavailable.</p> : diff.patch ? <DiffLines patch={diff.patch} path={diff.file} /> : <p className="empty-inline">No changes for this file in this comparison.</p>}
  </section>;
}

function FileHistory({ data, selected, onSelect, onClose, onConsole }) {
  return <section className="diff-view file-history" aria-label="File history">
    <header className="panel-heading"><span>HISTORY <code>{data.path}</code>{data.commits ? <small> · {data.commits.length}</small> : null}</span>
      <Button icon={X} aria-label="Close file history" onClick={onClose} /></header>
    {data.loading ? <div className="loading-shell" aria-label="Loading file history"><div className="skeleton" /></div>
      : data.error ? <p role="alert" className="empty-inline">{data.error} <button onClick={onConsole}>Show output</button></p>
      : !data.commits.length ? <p className="empty-inline">Git has no recorded history for this file.</p>
        : <ul className="file-history-list">
          {data.commits.map(commit => <li key={commit.oid}>
            <button className="file-history-entry" aria-pressed={selected === commit.oid} onClick={() => onSelect(commit)} title={commit.subject}>
              <code>{commit.oid.slice(0, 8)}</code>
              <span className="file-history-subject">{commit.subject || '(no subject)'}</span>
              <span className="file-history-meta">{commit.author.name} · {new Date(commit.committedAt).toLocaleDateString('en-GB')}</span>
            </button>
          </li>)}
        </ul>}
  </section>;
}

export default function HistoryWorkspace({ repository, active, mod, platform, editor, filterRef, onConsole, onRepositoryChanged, onOpenWorkspace, onWorkspace, referencesRevision = 0, commitColors = 'lanes', toolbarSlot, toolbarBusyReason }) {
  const [data, setData] = useState({ commits: [], lanes: [], refs: [], nextSkip: 0, width: 1 });
  const dataRef = useRef(data);
  const layout = useRef(createLaneLayout());
  const generation = useRef(0);
  const busy = useRef(false);
  // When history last reloaded, so a disk change 🌱 Twig caused itself does not
  // bounce straight back as an "external change" reload.
  const lastReload = useRef(0);
  const reloading = useRef(null);
  const refreshBusy = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [selection, setSelection] = useState([]);
  const [range, setRange] = useState(null);
  const [commitState, setCommitState] = useState({ commit: null, loading: false, error: '' });
  const [detail, setDetail] = useState(true);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [fileHistoryWidth, setFileHistoryWidth] = useState(FILE_HISTORY_PANEL_SIZE.defaultWidth);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_SIZE.defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState(null);
  // Where the search looks: messages (and hashes) by default, or the author,
  // a changed path, or the code itself through Git's pickaxe (-S / -G).
  const [searchMode, setSearchMode] = useState('message');
  const [diff, setDiff] = useState(null);
  // The open diff, read by the staging handlers: they are asynchronous, so a
  // closure over `diff` would re-read whatever was open when the click landed.
  const diffRef = useRef(null);
  const [staging, setStaging] = useState(false);
  const [stagingError, setStagingError] = useState('');
  useEffect(() => { diffRef.current = diff; }, [diff]);
  const [fileHistory, setFileHistory] = useState(null);
  const [blame, setBlame] = useState(null);
  const [blameSel, setBlameSel] = useState(null);
  const [fileMenu, setFileMenu] = useState(null);
  const [refMenu, setRefMenu] = useState(null);
  const [operation, setOperation] = useState(IDLE);
  const [bisect, setBisect] = useState(NO_BISECT);
  const [operationReady, setOperationReady] = useState(false);
  const [stashes, setStashes] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [marks, setMarks] = useState({});
  // Git LFS, read with the refs: whether the repository uses it, and which of
  // its files are still pointers in the working tree.
  const [lfs, setLfs] = useState(null);
  const [lfsPulling, setLfsPulling] = useState(false);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [conflict, setConflict] = useState(null);
  const [note, setNote] = useState('');
  const [working, setWorking] = useState(false);
  const [execution, setExecution] = useState(null);
  const [automationRefresh, setAutomationRefresh] = useState(0);
  const gateResolver = useRef(null);
  const [dropMenu, setDropMenu] = useState(null);
  const [dropDialog, setDropDialog] = useState(null);
  const [dropRunning, setDropRunning] = useState(false);
  const drag = useGitDrag({ active: active && !working && !toolbarBusyReason && !dropDialog, revision: data.refs,
    onStart: () => {
      setMenu(null); setFileMenu(null); setRefMenu(null); setSelection([]);
      if (!conflict) {
        setDiff(null); setFileHistory(null); diffRequest.current++;
        setSelected(value => SCREENS.includes(value) || value === UNCOMMITTED ? data.commits[0]?.oid || null : value);
      }
    },
    onDrop: (source, target, x, y) => { setMenu(null); setDropMenu({ source, target, x, y }); } });
  useEffect(() => { if (!drag.state) setDropMenu(null); }, [drag.state]);
  const diffRequest = useRef(0);
  const jumpRequest = useRef(0);
  const selectionAnchor = useRef(null);
  const indexMap = useMemo(() => new Map(data.commits.map((commit, index) => [commit.oid, index])), [data.commits]);
  const selectionSet = useMemo(() => new Set(selection), [selection]);
  // Which loaded commits the current branch tip can reach: the cheap, in-memory
  // half of "are these commits on this branch?" that the Squash item needs
  // before it offers itself. The authoritative check is a `git log` run when
  // the item is chosen, exactly as rewording an older commit does.
  const headAncestors = useMemo(() => {
    const seen = new Set();
    const start = repository.status?.branch?.oid;
    if (!start || indexMap.get(start) === undefined) return seen;
    const stack = [start];
    while (stack.length) {
      const oid = stack.pop();
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = data.commits[indexMap.get(oid)];
      if (commit) for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
    }
    return seen;
  }, [repository.status?.branch?.oid, data.commits, indexMap]);
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

  // `keepView: true` is for refreshes the user did not ask for (the git-directory
  // watcher, regaining focus): they must not close what is open on screen. The
  // commit panel, diff and file history address their content by oid and path
  // and re-read it themselves, so leaving them mounted is safe even if the
  // commit they show has just been rewritten away — they report that, and the
  // graph simply stops highlighting a row. Our own actions still reload the
  // plain way, because after a checkout or a rebase the old selection is stale
  // on purpose.
  const reload = useCallback(({ keepView = false } = {}) => {
    // Kept so `jump` can wait for it: a click that lands mid-reload (the
    // BugHunter banner's "Show test commit" right after a step, a sidebar
    // branch right after a checkout) would otherwise find history empty and
    // busy, and silently do nothing.
    const run = (async () => {
      lastReload.current = Date.now();
      const epoch = ++generation.current;
      // Reloading history must not throw the user out of the working tree
      // screen: staging refreshes history, and the screen lives in `selected`.
      busy.current = true; setLoading(true); setError('');
      if (!keepView) {
        setSelected(current => (SCREENS.includes(current) || current === UNCOMMITTED ? current : null));
        setSelection([]); setRange(null); setDiff(null); setFileHistory(null); diffRequest.current++;
      }
      try {
        const [refs, stashList, remoteList, markMap, lfsStatus] = await Promise.all([
          window.twig.getRefs(repository.id),
          window.twig.stashList(repository.id).catch(() => []),
          window.twig.getRemotes(repository.id).catch(() => []),
          window.twig.listMarks(repository.id).catch(() => ({})),
          window.twig.getLfsStatus(repository.id).catch(() => null)
        ]);
        if (generation.current !== epoch) return;
        setLfs(lfsStatus);
        setStashes(stashList);
        setRemotes(remoteList);
        setMarks(markMap);
        layout.current = createLaneLayout(refs);
        dataRef.current = { commits: [], lanes: [], refs, nextSkip: 0, width: 1 };
        setData(dataRef.current);
        busy.current = false;
        await loadMore();
        if (generation.current === epoch) lastReload.current = Date.now();
      } catch {
        if (generation.current === epoch) { setError('Could not load repository references.'); busy.current = false; setLoading(false); }
      }
    })();
    reloading.current = run;
    void run.finally(() => { if (reloading.current === run) reloading.current = null; });
    return run;
  }, [repository.id, loadMore]);
  const refreshOperation = useCallback(async () => {
    setOperationReady(false);
    let verified = true;
    try {
      setOperation(await window.twig.getOperationState(repository.id));
    } catch { setOperation(IDLE); verified = false; }
    try {
      setBisect(await window.twig.getBisectState(repository.id));
    } catch { setBisect(NO_BISECT); verified = false; }
    setOperationReady(verified);
  }, [repository.id]);
  useEffect(() => {
    void reload();
    void refreshOperation();
    const tokens = [generation, jumpRequest, diffRequest];
    return () => { for (const token of tokens) token.current++; };
  }, [reload, refreshOperation, referencesRevision]);

  useEffect(() => { refreshBusy.current = working || dropRunning || Boolean(execution) || Boolean(conflict) || Boolean(drag.state); },
    [working, dropRunning, execution, conflict, drag.state]);
  // Pick up work done to this repository from outside 🌱 Twig — a commit,
  // checkout, fetch, merge or stash run in a terminal. `main` watches the git
  // directory and sends an event; regaining focus after a real absence is a
  // backstop for changes the watch cannot see (a bare `git add`, an unsupported
  // platform). Both just reload, debounced, and skipped while an operation of
  // ours is mid-flight or finished within the last second.
  useEffect(() => {
    if (!active) return undefined;
    let timer = null;
    let alive = true;
    let blurredAt = 0;
    const run = () => {
      timer = null;
      if (!alive || refreshBusy.current || Date.now() - lastReload.current < 1200) return;
      void reload({ keepView: true });
      void refreshOperation();
      onRepositoryChanged?.();
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(run, 350); };
    const onBlur = () => { blurredAt = Date.now(); };
    const onFocus = () => { if (Date.now() - blurredAt > 1500) schedule(); };
    const unsubscribe = window.twig.onRepositoryChange
      ? window.twig.onRepositoryChange(update => { if (update.cwd === repository.path || update.cwd === repository.id) schedule(); })
      : () => {};
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unsubscribe();
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [active, repository.path, repository.id, reload, refreshOperation, onRepositoryChanged]);

  // One search box drives both panes: the sidebar keeps filtering refs by name
  // (below), and a query of two or more characters also searches every commit
  // message and hash across all refs through `git log --grep`, collapsing the
  // graph to the matches. Debounced so a fast typist runs one search, not ten.
  const searchQuery = filter.trim();
  useEffect(() => {
    if (searchQuery.length < 2) { setSearch(null); return; }
    let alive = true;
    const same = current => current?.query === searchQuery && current?.mode === searchMode;
    setSearch(current => ({ query: searchQuery, mode: searchMode, commits: same(current) ? current.commits : [],
      lanes: same(current) ? current.lanes : [], truncated: false, loading: true, error: '', invalid: '' }));
    const timer = setTimeout(async () => {
      try {
        const result = await window.twig.searchHistory(repository.id, searchQuery, searchMode);
        // A newer keystroke cancelled this search in main; its own answer is on the way.
        if (!alive || result.cancelled) return;
        setSearch({ query: searchQuery, mode: searchMode, commits: result.commits, truncated: result.truncated, loading: false, error: '',
          invalid: result.invalid || '', lanes: result.commits.map(commit => ({ oid: commit.oid, lane: 0, color: 0, segments: [] })) });
      } catch {
        if (alive) setSearch({ query: searchQuery, mode: searchMode, commits: [], lanes: [], truncated: false, loading: false, invalid: '', error: 'Could not search this repository’s history.' });
      }
    }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [searchQuery, searchMode, repository.id, referencesRevision]);
  const searchIndexMap = useMemo(() => new Map((search?.commits || []).map((commit, index) => [commit.oid, index])), [search]);

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
   * `git lfs pull`: downloads the LFS content of checked-out files in place of
   * their pointers. No ref moves, so nothing enters the Undo chain; it reaches
   * the network, so it can be cancelled.
   */
  const pullLfs = useCallback(async () => {
    setLfsPulling(true); setNote('');
    try {
      const result = await window.twig.pullLfs(repository.id);
      if (result.ok) setNote('Git LFS files downloaded.');
      else { setNote(result.message); if (!result.cancelled) onConsole(); }
    } catch (failure) { setNote(failure.message || 'git lfs pull failed.'); onConsole(); }
    finally {
      setLfsPulling(false);
      setLfs(await window.twig.getLfsStatus(repository.id).catch(() => null));
      onRepositoryChanged?.();
    }
  }, [repository.id, onConsole, onRepositoryChanged]);

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
      if (result.ok) setNote(step === 'start' ? '🌱 BugHunter (bisect) started.' : step === 'reset' ? 'BugHunter ended.' : `Revision marked ${step}.`);
      else { setNote(result.message || 'BugHunter did not finish.'); onConsole(); }
      await reload();
      onRepositoryChanged?.();
    } catch (failure) {
      setNote(failure.message || 'BugHunter failed.');
      onConsole();
      await refreshOperation();
    } finally { setWorking(false); }
  }, [repository.id, reload, refreshOperation, onConsole, onRepositoryChanged]);

  /**
   * Runs the automation pipelines bound to a Git event. For a `pre-*` event the
   * caller awaits this before touching Git: it resolves `true` when the
   * operation may proceed (nothing matched, everything passed, or the user chose
   * to bypass) and `false` when a pipeline blocked it. A `post-*` event is fired
   * and forgotten. An engine error never hard-blocks Git — it is surfaced in the
   * console and the operation continues.
   */
  const fireAutomation = useCallback(async (event, options, onDone) => {
    const phase = eventPhase(event);
    setExecution({ event, label: eventLabel(event), phase, steps: [], result: null, blocked: false, bypassed: false, options });
    try {
      const result = await window.twig.runAutomation(repository.id, event, options);
      setAutomationRefresh(value => value + 1);
      if (phase === 'post' || result.ran === false) { setExecution(null); onDone(true); return; }
      setExecution(current => current && { ...current, steps: result.steps, result: result.blocked ? 'blocked' : result.ok ? 'passed' : 'failed', blocked: result.blocked });
      if (result.blocked) return; // wait for a button
      setTimeout(() => { setExecution(null); onDone(true); }, result.ok ? 900 : 1600);
    } catch { setExecution(null); onConsole(); onDone(true); }
  }, [repository.id, onConsole]);

  const runAutomation = useCallback((event, options = {}) => new Promise(resolve => {
    gateResolver.current = resolve;
    void fireAutomation(event, options, proceed => { gateResolver.current = null; resolve(proceed); });
  }), [fireAutomation]);

  /** Wraps a history mutation with a pre-gate and a post-hook. */
  const performGated = useCallback(async (pre, post, run, success) => {
    if (pre && !(await runAutomation(pre, {}))) return null;
    const result = await perform(run, success);
    if (post && result?.ok !== false) void window.twig.runAutomation(repository.id, post, {}).then(() => setAutomationRefresh(value => value + 1)).catch(() => {});
    return result;
  }, [runAutomation, perform, repository.id]);

  const resolveGate = useCallback((proceed, bypass = false) => {
    const resolve = gateResolver.current;
    gateResolver.current = null;
    const current = execution;
    setExecution(null);
    if (bypass && current?.event) void window.twig.runAutomation(repository.id, current.event, { ...current.options, bypass: true }).then(() => setAutomationRefresh(value => value + 1)).catch(() => {});
    resolve?.(proceed || bypass);
  }, [execution, repository.id]);

  const rerunGate = useCallback(() => {
    if (!execution) return;
    void fireAutomation(execution.event, execution.options, proceed => {
      const resolve = gateResolver.current;
      gateResolver.current = null;
      resolve?.(proceed);
    });
  }, [execution, fireAutomation]);

  // Local commit marks never run Git and never touch history, so they update
  // their own state without a reload.
  const applyMark = useCallback(async (oid, color, noteText) => {
    try { setMarks(await window.twig.setMark(repository.id, oid, color, noteText)); }
    catch { setNote('Could not save the mark.'); onConsole(); }
  }, [repository.id, onConsole]);
  const removeMark = useCallback(async (oid) => {
    try { setMarks(await window.twig.clearMark(repository.id, oid)); }
    catch { setNote('Could not remove the mark.'); onConsole(); }
  }, [repository.id, onConsole]);

  const headBranch = repository.status?.branch?.name || null;
  const headOid = repository.status?.branch?.oid || null;
  const dirty = (repository.status?.entries || []).some(entry => entry.kind === 'ordinary' || entry.kind === 'renamed');

  function openMenu(oid, x, y) {
    const commit = dataRef.current.commits.find(item => item.oid === oid) || search?.commits.find(item => item.oid === oid);
    if (!commit) return;
    // Right-clicking a commit that is part of a multi-selection keeps that
    // selection and offers the actions that act on all of it; right-clicking
    // anything else falls back to selecting just that commit.
    if (selectionSet.has(oid) && selection.length >= 2) {
      const commits = dataRef.current.commits.filter(item => selectionSet.has(item.oid));
      setMenu({ commit, x, y, multi: commits, onBranch: commits.every(item => headAncestors.has(item.oid)),
        someOnBranch: commits.some(item => headAncestors.has(item.oid)) });
    } else {
      choose(oid);
      setMenu({ commit, x, y, multi: null });
    }
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
        run: () => performGated(null, 'post-checkout', () => window.twig.checkoutRef(repository.id, name, false), `Checked out ${name}.`)
      }),
      checkoutCommit: () => confirmIfDirty({
        title: `Check out ${short}`, command: ['checkout', '--detach', commit.oid, '--'],
        consequence: 'HEAD will be detached: new commits will belong to no branch until you create one.',
        confirmLabel: 'Check out',
        run: () => performGated(null, 'post-checkout', () => window.twig.checkoutRef(repository.id, commit.oid, true), `Checked out ${short} with a detached HEAD.`)
      }),
      merge: (name, noFf) => performGated('pre-merge-commit', 'post-merge', () => window.twig.mergeRevision(repository.id, name, noFf), `Merged ${name} into ${target}.`),
      cherryPick: () => perform(() => window.twig.cherryPick(repository.id, commit.oid), `Cherry-picked ${short}.`),
      revert: () => perform(() => window.twig.revertCommit(repository.id, commit.oid, commit.parents.length > 1 ? 1 : null), `Reverted ${short}.`),
      rebase: () => performGated('pre-rebase', 'post-rewrite', () => window.twig.rebaseOnto(repository.id, commit.oid, null), `Rebased ${target} onto ${short}.`),
      interactiveRebase: () => void openRebase(commit.oid),
      reword: () => void openReword(commit),
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
      mark: () => { choose(commit.oid); setDetail(true); },
      removeMark: () => void removeMark(commit.oid),
      copy: (text, what) => {
        void window.twig.copyText(text).then(() => setNote(`${what} copied.`)).catch(() => setNote('Could not copy that.'));
      },
      exportPatch: () => void exportPatches([commit.oid]),
      // Ref actions, mirroring the "Branches and tags" screen. Deletion has no
      // inverse, so every mutating one opens the §6.5 dialog first.
      renameBranch: name => setDialog({
        type: 'name', title: `Rename ${name}`, label: 'New branch name', placeholder: name, initialValue: name, confirmLabel: 'Rename branch',
        onConfirm: ({ name: next }) => perform(() => window.twig.renameBranch(repository.id, name, next), `Branch ${name} renamed to ${next}.`)
      }),
      setUpstream: ref => setDialog({
        type: 'upstream', branch: ref.name, current: ref.upstream || null,
        candidates: data.refs.filter(item => item.type === 'remote').map(item => item.name),
        onConfirm: value => perform(() => window.twig.setUpstream(repository.id, ref.name, value),
          value ? `${ref.name} now tracks ${value}.` : `${ref.name} no longer tracks anything.`)
      }),
      publishBranch: (name, remote) => setDialog({
        type: 'confirm', title: `Publish ${name} to ${remote}`, command: pushRefCommand({ remote, ref: `refs/heads/${name}` }),
        consequence: `${name} is pushed to ${remote} and becomes visible to everyone who fetches it. Nothing is force-pushed: if ${remote} has moved on, the push is refused.`,
        confirmLabel: `Push to ${remote}`,
        onConfirm: () => perform(() => window.twig.pushRef(repository.id, remote, `refs/heads/${name}`, false), `${name} pushed to ${remote}.`)
      }),
      deleteBranch: async name => {
        const result = await perform(() => window.twig.deleteBranch(repository.id, name, false), `Branch ${name} deleted.`);
        if (result && result.ok === false) setDialog({
          type: 'confirm', title: `Delete ${name} without checking`, command: ['branch', '-D', '--', name],
          consequence: `Git refused to delete ${name} because it holds commits that are on no other branch. Deleting it anyway leaves those commits reachable only through the reflog, which expires.`,
          confirmLabel: 'Delete the branch anyway',
          onConfirm: () => perform(() => window.twig.deleteBranch(repository.id, name, true), `Branch ${name} force-deleted.`)
        });
      },
      checkoutRemote: ref => setDialog({
        type: 'name', title: `Check out ${ref.name}`, label: 'Local branch name',
        placeholder: ref.name.slice(ref.name.indexOf('/') + 1), confirmLabel: 'Create and check out',
        onConfirm: ({ name }) => performGated(null, 'post-checkout', () => window.twig.createBranch(repository.id, name, ref.target, true), `Checked out ${name}.`)
      }),
      deleteRemoteBranch: ref => {
        const split = splitRemoteRef(ref.fullName, remotes.map(item => item.name));
        if (!split) { setNote('The remote of this branch is no longer configured. Reload the remotes first.'); onConsole(); return; }
        setDialog({
          type: 'confirm', title: `Delete ${split.branch} on ${split.remote}`,
          command: pushRefCommand({ remote: split.remote, ref: split.ref, remove: true }),
          consequence: `The branch is removed on ${split.remote} for everyone. Your local branches are untouched, and anyone who already fetched it keeps their copy until they prune.`,
          confirmLabel: `Delete on ${split.remote}`,
          onConfirm: () => perform(() => window.twig.pushRef(repository.id, split.remote, split.ref, true), `${ref.name} deleted on ${split.remote}.`)
        });
      },
      deleteTag: ref => setDialog({
        type: 'confirm', title: `Delete tag ${ref.name}`, command: ['tag', '-d', '--', ref.name],
        consequence: 'The tag is removed locally. If it was already pushed, it stays on the remote until it is deleted there too.',
        confirmLabel: 'Delete tag',
        onConfirm: () => perform(() => window.twig.deleteTag(repository.id, ref.name), `Tag ${ref.name} deleted.`)
      }),
      publishTag: (ref, remote) => setDialog({
        type: 'confirm', title: `Publish ${ref.name} to ${remote}`, command: pushRefCommand({ remote, ref: `refs/tags/${ref.name}` }),
        consequence: `The tag becomes visible to everyone who fetches ${remote}. A published tag is not meant to be moved afterwards.`,
        confirmLabel: `Push to ${remote}`,
        onConfirm: () => perform(() => window.twig.pushRef(repository.id, remote, `refs/tags/${ref.name}`, false), `${ref.name} pushed to ${remote}.`)
      }),
      deleteTagOnRemote: (ref, remote) => setDialog({
        type: 'confirm', title: `Delete ${ref.name} on ${remote}`, command: pushRefCommand({ remote, ref: `refs/tags/${ref.name}`, remove: true }),
        consequence: `The tag disappears from ${remote} for everyone. Clones that already fetched it keep their copy until they prune.`,
        confirmLabel: `Delete on ${remote}`,
        onConfirm: () => perform(() => window.twig.pushRef(repository.id, remote, `refs/tags/${ref.name}`, true), `${ref.name} deleted on ${remote}.`)
      })
    };
  }

  function confirmIfDirty({ title, command, consequence, confirmLabel, run }) {
    if (!dirty) { run(); return; }
    setDialog({ type: 'confirm', title, command, consequence, confirmLabel, onConfirm: run });
  }

  function copyText(text, what) {
    void window.twig.copyText(text).then(() => setNote(`${what} copied.`)).catch(() => setNote('Could not copy that.'));
  }

  /**
   * A sidebar ref's menu: the commit handlers aimed at the commit the ref
   * points to, plus what only makes sense for a ref — rebasing onto it,
   * comparing it with HEAD, branching or tagging from it by name.
   */
  function refHandlers(ref) {
    const base = commitHandlers({ oid: ref?.target || headOid || '', parents: [], subject: '', body: '' });
    const target = headBranch || 'HEAD';
    return {
      ...base,
      show: item => void jump(item.target),
      openWorktree: name => openWorktreeDialog(name),
      checkoutDetached: item => confirmIfDirty({
        title: `Check out ${item.name}`, command: ['checkout', '--detach', item.target, '--'],
        consequence: 'HEAD will be detached: new commits will belong to no branch until you create one.',
        confirmLabel: 'Check out',
        run: () => performGated(null, 'post-checkout', () => window.twig.checkoutRef(repository.id, item.target, true), `Checked out ${item.name} with a detached HEAD.`)
      }),
      rebaseOnto: item => performGated('pre-rebase', 'post-rewrite', () => window.twig.rebaseOnto(repository.id, item.target, null), `Rebased ${target} onto ${item.name}.`),
      // The same compare a drag-and-drop offers: the ref against HEAD, read-only.
      compare: item => {
        selectionAnchor.current = item.target; jumpRequest.current++;
        setSelected(item.target); setSelection([]); setRange({ base: headOid, oid: item.target });
        setDetail(true); setDiff(null); setFileHistory(null); diffRequest.current++;
      },
      createBranchFrom: item => setDialog({
        type: 'name', title: `Create a branch from ${item.name}`, label: 'Branch name', placeholder: 'feature/short-description',
        confirmLabel: 'Create branch', extra: 'Check it out straight away',
        onConfirm: ({ name, checked }) => perform(() => window.twig.createBranch(repository.id, name, item.target, checked), `Branch ${name} created.`)
      }),
      createTagAt: () => base.createTag(),
      createBranchAtHead: () => commitHandlers({ oid: headOid, parents: [] }).createBranch(),
      createTagAtHead: () => commitHandlers({ oid: headOid, parents: [] }).createTag(),
      fetch: () => void perform(() => window.twig.runSync(repository.id, 'fetch-prune', null), 'Fetched.'),
      manage: () => choose('branches'),
      copy: copyText
    };
  }

  /**
   * A file row's menu. Opening and revealing go through main, which resolves
   * the path inside this repository's working tree and picks the editor from
   * its own setting; a refusal (the file is gone, it would run as a program,
   * the editor is not installed) is a note, and only a launch that actually
   * failed points at the console, where it is journaled.
   */
  const fileHandlers = {
    openInEditor: async path => {
      try {
        const result = await window.twig.openInEditor(repository.id, path);
        setNote(result.ok ? `Opened ${path} in ${result.editor}.` : result.message);
        if (!result.ok && result.reason === 'failed') onConsole();
      } catch { setNote('Could not open that file.'); }
    },
    reveal: async path => {
      try {
        const result = await window.twig.revealFile(repository.id, path);
        if (result.missing) setNote(`${path} is not in the working tree; showing ${result.shown === '.' ? 'the repository folder' : result.shown} instead.`);
      } catch { setNote('Could not show that file.'); }
    },
    copyPath: path => copyText(path, 'Path'),
    copyFullPath: path => copyText(absolutePath(repository.path, path), 'Full path'),
    fileHistory: path => void openFileHistory(path),
    blame: (path, oid) => openBlame(path, oid)
  };

  /**
   * Rewording the tip is `commit --amend`, which touches nothing but HEAD, so
   * it is offered straight away. An older commit is rewritten the way Git
   * rewrites history — by replaying the range — so the commits Git would
   * replay are read first: the dialog can then say how many of them change
   * their object id, and a commit that is not on the current branch is refused
   * before the user writes a message for nothing.
   */
  async function openReword(commit) {
    const short = commit.oid.slice(0, 7);
    const initial = [commit.subject, commit.body].filter(Boolean).join('\n\n');
    const dialogFor = (command, consequence, confirmLabel, onConfirm) => setDialog({
      type: 'message', title: `Reword ${short}`, label: 'Commit message',
      initial, command, consequence, confirmLabel, onConfirm
    });
    if (headOid === commit.oid) {
      dialogFor(['commit', '--amend', '--only', '--file=-'],
        `${short} gets a new object id. Its changes stay exactly as they are, and whatever is staged is left out of it. If the commit is already pushed, the remote will only accept it after a force push.`,
        'Rewrite the message',
        text => performGated(null, 'post-rewrite', () => window.twig.rewordCommit(repository.id, commit.oid, text), 'Message rewritten.'));
      return;
    }
    setWorking(true); setNote('');
    try {
      const parent = commit.parents[0];
      const commits = await window.twig.getRebaseCandidates(repository.id, parent);
      if (!commits.some(item => item.oid === commit.oid)) {
        throw new Error(`${short} is not on ${headBranch || 'the current HEAD'}. Check out the branch that contains it first.`);
      }
      const replayed = commits.length - 1;
      dialogFor(['rebase', '--interactive', parent],
        `${short} and ${replayed === 1 ? 'the one commit' : `the ${replayed} commits`} after it get new object ids; their changes are replayed unchanged. If any of them is already pushed, the remote will only accept them after a force push.`,
        'Rewrite and replay',
        text => performGated('pre-rebase', 'post-rewrite', () => window.twig.rebaseOnto(repository.id, parent, buildRewordPlan(commits, commit.oid, text)), 'Message rewritten.'));
    } catch (failure) {
      setNote(failure.message || 'Could not read the commits to replay.');
      onConsole();
    } finally { setWorking(false); }
  }

  /**
   * Squashing a run of adjacent commits is an interactive rebase: the range
   * Git would replay is read first so the dialog can name the exact base, and
   * a selection that turns out not to be on the current branch is refused
   * before the user writes a message for nothing — the same shape as rewording
   * an older commit.
   */
  async function openSquash(selectedCommits) {
    const ordered = [...selectedCommits].reverse(); // oldest first, the order Git replays
    const base = ordered[0].parents[0];
    const count = selectedCommits.length;
    const combined = ordered.map(commit => [commit.subject, commit.body].filter(Boolean).join('\n\n')).filter(Boolean).join('\n\n');
    setWorking(true); setNote('');
    try {
      const commits = await window.twig.getRebaseCandidates(repository.id, base);
      const oids = ordered.map(commit => commit.oid);
      if (!oids.every(oid => commits.some(item => item.oid === oid))) {
        throw new Error(`These commits are not all on ${headBranch || 'the current HEAD'}. Check out the branch that contains them first.`);
      }
      const after = commits.length - count;
      setDialog({
        type: 'message', title: `Squash ${count} commits into one`, label: 'Message for the squashed commit',
        initial: combined, allowUnchanged: true,
        command: ['rebase', '--interactive', base.slice(0, 7)],
        consequence: `The ${count} selected commits melt into one new commit with a new object id`
          + `${after > 0 ? `; the ${after === 1 ? 'commit' : `${after} commits`} after them are replayed unchanged` : ''}. `
          + 'If any of them is already pushed, the remote will only accept the result after a force push.',
        confirmLabel: 'Squash and replay',
        onConfirm: text => performGated('pre-rebase', 'post-rewrite',
          () => window.twig.rebaseOnto(repository.id, base, buildSquashPlan(commits, oids, text)),
          `Squashed ${count} commits into one.`)
      });
    } catch (failure) {
      setNote(failure.message || 'Could not read the commits to squash.');
      onConsole();
    } finally { setWorking(false); }
  }

  // Worktrees and submodules open as tabs of their own; App switches to them.
  const [toolsRefresh, setToolsRefresh] = useState(0);
  function openWorktreeDialog(branch = null) { setDialog({ type: 'worktree', branch }); }
  async function openTab(open) {
    setNote('');
    try { onOpenWorkspace?.(await open()); }
    catch (failure) { setNote(failure.message || 'Could not open it as a tab.'); }
  }
  async function createWorktree(request) {
    setWorking(true); setNote('');
    try {
      const result = await window.twig.addWorktree(repository.id, request);
      if (!result.ok) { setNote(result.message); onConsole(); return; }
      setNote(`Worktree for ${request.branch} created in ${result.path}.`);
      setToolsRefresh(value => value + 1);
      if (request.create) void reload();
      onOpenWorkspace?.(result.workspace);
    } catch (failure) { setNote(failure.message || 'Could not add the worktree.'); onConsole(); }
    finally { setWorking(false); }
  }

  /** `git format-patch` of the given commits (oldest first) into one file the save dialog names. */
  async function exportPatches(oids) {
    setNote('');
    try {
      const result = await window.twig.exportPatches(repository.id, oids);
      if (result.cancelled) return;
      if (result.ok) setNote(`${result.count === 1 ? 'Patch' : `${result.count} patches`} saved to ${result.path}.`);
      else { setNote(result.message); onConsole(); }
    } catch (failure) { setNote(failure.message || 'Could not export the patch.'); onConsole(); }
  }

  /** Pick a patch file in the native dialog; main says what it holds before anything runs. */
  async function openPatch() {
    setNote('');
    try {
      const patch = await window.twig.choosePatch(repository.id);
      if (!patch) return;
      if (patch.invalid) { setNote(`${patch.name}: ${patch.reason}`); return; }
      setDialog({ type: 'patch', patch });
    } catch (failure) { setNote(failure.message || 'Could not read that file.'); }
  }

  /**
   * Cherry-pick or revert of a multi-selection, one sequencer run. The graph
   * lists commits newest first; a pick replays them oldest first, the order
   * they were made in, and a revert undoes them newest first.
   */
  function openPickMany(kind, commits) {
    const oids = commits.map(commit => commit.oid);
    const ordered = kind === 'cherry-pick' ? [...oids].reverse() : oids;
    const count = commits.length;
    const target = headBranch || 'HEAD';
    setDialog({
      type: 'confirm', danger: false,
      title: kind === 'cherry-pick' ? `Cherry-pick ${count} commits` : `Revert ${count} commits`,
      command: kind === 'cherry-pick' ? ['cherry-pick', ...ordered] : ['revert', '--no-edit', ...ordered],
      consequence: kind === 'cherry-pick'
        ? `${count} new commits are made on ${target}, oldest first, with the same changes and messages. If one conflicts, Git stops there and the banner offers Continue, Skip and Abort.`
        : `${count} new commits are made on ${target}, each undoing one selected commit, newest first. Nothing is removed from history. If one conflicts, Git stops there and the banner offers Continue, Skip and Abort.`,
      confirmLabel: kind === 'cherry-pick' ? `Cherry-pick ${count} commits` : `Revert ${count} commits`,
      onConfirm: () => void perform(() => (kind === 'cherry-pick' ? window.twig.cherryPickMany : window.twig.revertMany)(repository.id, ordered),
        kind === 'cherry-pick' ? `Cherry-picked ${count} commits.` : `Reverted ${count} commits.`)
    });
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
    if (!isCommitSelection(selected)) { setCommitState({ commit: null, loading: false, error: '' }); return; }
    setCommitState({ commit: null, loading: true, error: '' });
    const timer = setTimeout(() => {
      Promise.all([window.twig.getCommit(repository.id, selected), range ? window.twig.compareCommits(repository.id, range.base, range.oid) : Promise.resolve(null)])
        .then(([commit, files]) => { if (alive) setCommitState({ commit: files ? { ...commit, files } : commit, loading: false, error: '' }); })
        .catch(() => { if (alive) setCommitState({ commit: null, loading: false, error: 'Could not read this commit.' }); });
    }, 100);
    return () => { alive = false; clearTimeout(timer); };
  }, [selected, repository.id, range]);

  const choose = useCallback((oid, mods = {}) => {
    const { shift = false, toggle = false } = typeof mods === 'boolean' ? { shift: mods } : mods;
    jumpRequest.current++;
    const commits = dataRef.current.commits;
    const known = new Map(commits.map((commit, index) => [commit.oid, index]));
    const isCommit = isCommitSelection(oid) && known.has(oid);

    if (isCommit && toggle) {
      // Cmd/Ctrl-click adds or removes one commit from the selection.
      const base = selection.length ? selection : (known.has(selected) ? [selected] : []);
      const next = new Set(base);
      if (next.has(oid)) next.delete(oid); else next.add(oid);
      const ordered = commits.filter(commit => next.has(commit.oid)).map(commit => commit.oid);
      setSelection(ordered.length > 1 ? ordered : []);
      setRange(null);
      selectionAnchor.current = oid;
      setSelected(oid);
    } else if (isCommit && shift) {
      // Shift-click sweeps a contiguous run from the anchor.
      const anchorOid = known.has(selectionAnchor.current) ? selectionAnchor.current : (known.has(selected) ? selected : oid);
      const a = known.get(anchorOid);
      const b = known.get(oid);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const ordered = commits.slice(lo, hi + 1).map(commit => commit.oid);
      setSelection(ordered.length > 1 ? ordered : []);
      // Exactly two commits keep the side-by-side compare the panel has always shown.
      setRange(ordered.length === 2 ? { base: anchorOid, oid } : null);
      setSelected(oid);
    } else {
      setSelection([]);
      setRange(null);
      selectionAnchor.current = isCommit ? oid : null;
      setSelected(oid);
    }
    setDetail(true); setDiff(null); setFileHistory(null); diffRequest.current++;
  }, [selected, selection]);

  async function jump(oid) {
    const request = ++jumpRequest.current;
    setError('');
    if (reloading.current) await reloading.current.catch(() => {});
    if (jumpRequest.current !== request) return;
    while (!dataRef.current.commits.some(commit => commit.oid === oid) && dataRef.current.nextSkip !== null) {
      if (!await loadMore() || jumpRequest.current !== request) return;
    }
    if (jumpRequest.current !== request) return;
    if (dataRef.current.commits.some(commit => commit.oid === oid)) choose(oid);
    else setError('This commit is not in the loaded repository history. Refresh to update it.');
  }
  async function openFile(file) {
    const request = ++diffRequest.current;
    setFileHistory(null);
    setDiff({ file, loading: true });
    try {
      const result = await window.twig.getFileDiff(repository.id, selected, file, range?.base || null);
      if (request === diffRequest.current) setDiff({ file, ...result, loading: false });
    } catch { if (request === diffRequest.current) setDiff({ file, error: 'Could not read the diff. Show output in the console.', loading: false }); }
  }
  /**
   * The read-only diff of an uncommitted file, opened from its row in the
   * panel. An untracked file has no diff until Git tracks it, and tracking is a
   * mutation, so this says so instead of running `git add -N` unasked — the
   * staging screen is where that choice is made.
   */
  async function openWorktreeFile(file, section) {
    const request = ++diffRequest.current;
    setFileHistory(null);
    if (section === 'untracked') {
      setDiff({ file: file.path, section, loading: false,
        note: 'Untracked — Git has no diff for this file until it is added. Open staging to add it.' });
      return;
    }
    setDiff({ file: file.path, section, loading: true });
    try {
      const result = await window.twig.getWorktreeDiff(repository.id, file.path, section === 'staged');
      if (request === diffRequest.current) setDiff({ file: file.path, section, patch: result.text, binary: result.binary, loading: false });
    } catch { if (request === diffRequest.current) setDiff({ file: file.path, section, error: 'Could not read the diff. Show output in the console.', loading: false }); }
  }
  async function openFileHistory(path) {
    const request = ++diffRequest.current;
    setDiff(null);
    setFileHistory({ path, loading: true });
    try {
      const { commits } = await window.twig.getFileHistory(repository.id, path);
      if (request === diffRequest.current) setFileHistory({ path, commits, loading: false });
    } catch { if (request === diffRequest.current) setFileHistory({ path, error: 'Could not read this file’s history. Show output in the console.', loading: false }); }
  }
  /**
   * Opens blame for a committed version of a file. `oid` is always a real
   * commit id (the one the panel or the file-history row was showing), so the
   * blamed content is that commit's, never the working tree's.
   */
  function openBlame(path, oid) {
    if (!path || typeof oid !== 'string' || !/^[0-9a-f]{7,64}$/i.test(oid)) return;
    diffRequest.current++;
    setDiff(null); setFileHistory(null); setDetail(true);
    setBlameSel(null);
    setBlame({ path, oid, line: 1 });
  }
  function closeBlame() { setBlame(null); setBlameSel(null); }
  async function openHistoryDiff(commit) {
    const request = ++diffRequest.current;
    const file = commit.path || fileHistory.path;
    const oid = commit.oid;
    setDetail(true);
    setDiff({ file, oid, loading: true });
    try {
      const result = await window.twig.getFileDiff(repository.id, oid, file, null);
      if (request === diffRequest.current) setDiff({ file, oid, ...result, loading: false });
    } catch { if (request === diffRequest.current) setDiff({ file, oid, error: 'Could not read the diff. Show output in the console.', loading: false }); }
  }
  // What is staged, changed and untracked, split from the status the workspace
  // already holds: the row in the graph and its details panel both read this,
  // and neither of them runs Git to get it.
  const statusEntries = repository.status?.entries;
  const summary = useMemo(() => summarizeStatus(statusEntries), [statusEntries]);
  // Committing or stashing empties the working tree, and with it the row this
  // panel describes; the selection follows the row off the graph instead of
  // leaving an empty panel behind.
  useEffect(() => {
    if (summary.paths === 0) setSelected(current => (current === UNCOMMITTED ? dataRef.current.commits[0]?.oid || null : current));
  }, [summary.paths]);

  /**
   * Staging straight from the uncommitted panel. It runs the very channels the
   * staging screen runs — no new IPC, no new Git path — and then re-reads the
   * status the panel is drawn from. History is deliberately left alone: moving
   * a file in or out of the index moves no commit and no ref, so a `reload()`
   * would only throw away whatever is open for nothing. The diff on screen is
   * re-read instead, because staging is exactly what moves a file between the
   * two sides it can be read from.
   */
  async function runStaging(action, describe) {
    if (staging) return;
    setStaging(true); setStagingError('');
    try {
      const outcome = await action();
      await onRepositoryChanged?.();
      const open = diffRef.current;
      if (open?.section) await openWorktreeFile({ path: open.file }, open.section);
      setNote(describe(outcome));
    } catch (failure) {
      setStagingError(failure.message || 'Git refused this operation.');
    } finally { setStaging(false); }
  }
  const conflicts = conflictCount(summary);
  const stageReason = toolbarBusyReason || (staging ? 'Git is working' : undefined)
    || (working ? 'Git is working' : undefined);
  /**
   * A bulk action is refused where the per-file buttons still work, exactly as
   * on the staging screen: `git add` on a conflicted file would mark it
   * resolved unseen, and unstaging everything is a mixed reset, which deletes
   * the marker of a merge, rebase, cherry-pick or revert and so cancels it.
   * Main refuses both too; the disabled button says why before the click.
   */
  const stageAllReason = stageReason
    || (conflicts ? `Resolve the ${conflicts === 1 ? 'conflict' : 'conflicts'} first` : undefined);
  const unstageAllReason = stageAllReason
    || (operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined);
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const stagingActions = {
    busy: staging,
    reasons: { stage: stageReason, unstage: stageReason, stageAll: stageAllReason, unstageAll: unstageAllReason,
      discardAll: stageAllReason,
      // Main refuses these too; the disabled button says why before the click.
      discard: (file, section) => stageReason
        || (file.status === 'U' ? 'Resolve the conflict first' : undefined)
        || (section === 'unstaged' && file.status === 'A' ? 'Only marked for tracking (git add -N): unstage it first' : undefined) },
    // Discarding always asks first (§6.5), then runs like staging does: the
    // status is re-read and the open diff refreshed, history is left alone.
    discard: (file, section) => setDialog({ type: 'confirm',
      ...discardDialog({ kind: section === 'untracked' ? 'untracked' : 'file', path: file.path }),
      onConfirm: () => void runStaging(() => window.twig.discardFile(repository.id, file.path, section),
        () => `${section === 'untracked' ? `Deleted ${file.path}` : `Discarded changes to ${file.path}`}. Undo brings ${section === 'untracked' ? 'it' : 'them'} back.`) }),
    discardAll: scope => setDialog({ type: 'confirm',
      ...discardDialog({ kind: scope === 'untracked' ? 'untracked-all' : 'tracked', paths: (scope === 'untracked' ? summary.untracked : summary.unstaged).map(file => file.path) }),
      onConfirm: () => void runStaging(() => window.twig.discardAll(repository.id, scope),
        outcome => `${scope === 'untracked' ? `Deleted ${plural(outcome.count, 'untracked file')}` : `Discarded changes to ${plural(outcome.count, 'file')}`}. Undo brings them back.`) }),
    stage: file => void runStaging(() => window.twig.stageFile(repository.id, file.path), () => `Staged ${file.path}.`),
    unstage: file => void runStaging(
      () => window.twig.unstageFile(repository.id, file.path, Boolean(repository.status?.branch?.unborn)),
      () => `Unstaged ${file.path}.`),
    stageAll: scope => void runStaging(() => window.twig.stageAll(repository.id, scope),
      count => `Staged ${plural(count, scope === 'untracked' ? 'new path' : 'file')}.`),
    unstageAll: () => void runStaging(() => window.twig.unstageAll(repository.id),
      count => `Unstaged ${plural(count, 'file')}.`)
  };
  const dropReason = toolbarBusyReason || (working ? 'Git is working' : undefined)
    || (!operationReady ? 'Repository state is not verified yet. Refresh first.' : undefined)
    || (operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined)
    || (bisect.active ? 'Finish BugHunter first' : undefined)
    || (summary.paths ? 'Commit or stash your changes first' : undefined);
  async function selectDropAction(action, source, target) {
    if (action.key === 'compare') {
      selectionAnchor.current = source.oid; jumpRequest.current++;
      setSelected(source.oid); setRange({ base: target.oid, oid: source.oid });
      setDetail(true); setDiff(null); setFileHistory(null); diffRequest.current++;
      return;
    }
    if (dropReason) return;
    setWorking(true);
    try {
      const commit = ['cherry-pick', 'revert'].includes(action.key) ? await window.twig.getCommit(repository.id, source.oid) : null;
      setDropDialog({ title: action.text, parents: commit?.parents || [],
        request: { action: action.key, source, target, head: { oid: headOid, branch: headBranch || null }, mainline: null } });
    } catch { setNote('Could not read the dragged commit. Refresh and try again.'); }
    finally { setWorking(false); }
  }
  const screen = SCREENS.includes(selected) ? selected : null;
  const uncommitted = selected === UNCOMMITTED;
  const hunterCommit = !screen && !range ? data.commits[indexMap.get(selected)] : null;
  const hunterReason = toolbarBusyReason || (working ? 'Git is working' : undefined)
    || (!operationReady ? 'Repository state is not verified yet. Refresh to check it.' : undefined)
    || (bisect.active ? 'BugHunter is already running. Use the panel below.' : undefined)
    || (operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined)
    || (dirty || operation.conflicts.length > 0 ? 'Commit or stash your changes first' : undefined)
    || (loading ? 'History is loading' : undefined)
    || (!data.commits.length ? 'This repository has no commits to search' : undefined)
    || (!hunterCommit ? 'Select a commit with the bug in the history first' : undefined);
  // The sidebar filters refs by name only when the search is about names and
  // messages; an author or a code fragment says nothing about branch names.
  const visibleRefs = searchMode === 'message' ? data.refs.filter(ref => ref.name.toLowerCase().includes(filter.toLowerCase())) : data.refs;
  const headRef = headBranch ? data.refs.find(ref => ref.type === 'local' && ref.name === headBranch) || null : null;
  const headInfo = { branch: headBranch, oid: headOid, detached: Boolean(repository.status?.branch?.detached) };
  const showDetail = detail && !conflict && !screen;
  return <div className={`workspace real-workspace ${collapsed ? 'sidebar-small' : ''} ${showDetail ? '' : 'no-detail'}`} style={{ '--detail-width': `${fileHistory || blame ? fileHistoryWidth : width}px`, '--sidebar-width': `${sidebarWidth}px` }}>
    {active && toolbarSlot && createPortal(
      <Button className="tool bughunter-tool" icon={Bug} reason={hunterReason}
        title={hunterCommit ? `🌱 BugHunter (git bisect): start from ${hunterCommit.oid.slice(0, 7)}, a commit where the bug is present` : '🌱 BugHunter (git bisect)'}
        onClick={() => { if (!hunterReason) void performBisect('start', hunterCommit.oid); }}>BugHunter</Button>, toolbarSlot)}
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Repository navigation">
      {collapsed ? <Button icon={PanelLeftOpen} aria-label="Expand repository sidebar" onClick={() => setCollapsed(false)} /> : <>
        <div className="sidebar-filter"><Search /><input ref={filterRef} aria-label="Search commits and references" placeholder="Search" value={filter} onChange={event => setFilter(event.target.value)} />
          {!filter && <kbd className="sidebar-filter-key" aria-hidden="true">{mod}+F</kbd>}
          {filter && <button className="sidebar-filter-clear" aria-label="Clear search" onClick={() => setFilter('')}><X /></button>}</div>
        <nav className="sidebar-nav" aria-label="Repository screens">
          <button className={`real-branch ${screen === 'branches' ? 'selected' : ''}`} onClick={() => choose('branches')}>
            <GitBranch /><span>Branches and tags</span><small>{data.refs.length}</small></button>
          <button className={`real-branch ${screen === 'stashes' ? 'selected' : ''}`} onClick={() => choose('stashes')}>
            <Archive /><span>Stashes</span><small>{stashes.length}</small></button>
          <button className={`real-branch ${screen === 'reflog' ? 'selected' : ''}`} onClick={() => choose('reflog')} title="Where HEAD and each branch have been — recover lost work">
            <History /><span>Reflog</span></button>
          <button className={`real-branch ${screen === 'worktrees' ? 'selected' : ''}`} onClick={() => choose('worktrees')} title="Other checkouts of this repository, each in its own folder">
            <FolderGit2 /><span>Worktrees</span></button>
          <button className={`real-branch ${screen === 'submodules' ? 'selected' : ''}`} onClick={() => choose('submodules')} title="Repositories pinned inside this one">
            <Boxes /><span>Submodules</span></button>
          <button className={`real-branch ${screen === 'automations' ? 'selected' : ''}`} onClick={() => choose('automations')}>
            <Workflow /><span>Automations</span></button>
        </nav>
        <div className="sidebar-sections">{[['LOCAL', 'local'], ['REMOTE', 'remote'], ['TAGS', 'tag']].map(([label, type]) => <details key={type} open><summary {...contextMenuProps((x, y) => { setMenu(null); setFileMenu(null); setRefMenu({ section: type, label, x, y }); })}>{label}<span>{data.refs.filter(ref => ref.type === type).length}</span></summary>
          <BranchTree refs={visibleRefs.filter(ref => ref.type === type).map(ref => ({ ...ref, label: ref.name }))} onSelect={jump} drag={drag} headBranch={headBranch}
            onMenu={(ref, x, y) => { setMenu(null); setFileMenu(null); setRefMenu({ ref, x, y }); }}
            onRename={ref => { if (operation.kind === 'none' && !working) refHandlers(ref).renameBranch(ref.name); }} />
          {!visibleRefs.some(ref => ref.type === type) && <p className="section-empty">No matching {label.toLowerCase()} refs</p>}
        </details>)}</div><div className="sidebar-footer"><span {...(headRef ? { tabIndex: 0, title: `${headRef.name} · Right-click or Shift+F10 for actions`,
          ...contextMenuProps((x, y) => { setMenu(null); setFileMenu(null); setRefMenu({ ref: headRef, x, y }); }) } : {})}><strong>{repository.status?.branch?.name || 'Detached HEAD'}</strong>
          {headRef && <small className="sidebar-upstream">{headRef.upstream
            ? <>→ {headRef.upstream}{headRef.ahead || headRef.behind ? ` · ${[headRef.ahead && `${headRef.ahead} to push`, headRef.behind && `${headRef.behind} to pull`].filter(Boolean).join(', ')}` : ' · in sync'}</>
            : 'Not published'}</small>}</span><Button icon={PanelLeftClose} aria-label="Collapse repository sidebar" onClick={() => setCollapsed(true)} /></div>
      </>}
    </aside>
    {!collapsed && <Splitter side="left" width={sidebarWidth} onWidth={setSidebarWidth} label="Repository sidebar width" />}
    <main className="graph-panel" aria-label="Repository history">
      <header className="graph-heading"><div><GitBranch /><strong>History</strong><span className="count">{data.commits.length} loaded</span></div><div>{!detail && <Button icon={PanelRightOpen} aria-label="Show commit details" onClick={() => setDetail(true)} />}<Button icon={FileInput}
        reason={working ? 'Wait for the current action' : operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined}
        title="Apply a .patch or .mbox file: commits through git am, a plain diff through git apply" onClick={() => void openPatch()}>Apply patch…</Button><Button icon={RefreshCw} reason={loading ? 'History is loading' : undefined}
        onClick={() => { void reload(); void refreshOperation(); onRepositoryChanged?.(); }}>Refresh</Button></div></header>
      {error && <div className="history-error" role="alert">{error}<button onClick={onConsole}>Show output</button></div>}
      {drag.state && <div className="git-drag-status" role="status">
        <span>Source <strong>{endpointLabel(drag.state.source)}</strong> → Target <strong>{drag.state.target ? endpointLabel(drag.state.target) : 'Choose a branch or commit'}</strong></span>
        <small>{sameEndpoint(drag.state.source, drag.state.target) ? 'Choose a different target' : drag.state.phase === 'menu' ? 'Choose an action below' : 'Drop for actions · Alt+D to pick up · Alt+Enter to drop · Esc to cancel'}</small>
        <Button onClick={drag.cancel}>Cancel</Button>
      </div>}
      {dropRunning && <div className="git-drag-status" role="status">Running Git action… <Button onClick={() => void window.twig.cancelSync(repository.id)}>Cancel operation</Button></div>}
      {note && <div className="operation-note" role="status"><span>{note}</span><button onClick={() => setNote('')} aria-label="Dismiss">×</button></div>}
      <OperationBanner state={operation} busy={working} onOpenConflict={setConflict}
        onStep={step => perform(() => window.twig.runSequencer(repository.id, operation.kind, step), `${operation.kind} ${step === 'abort' ? 'aborted' : step === 'skip' ? 'skipped a commit' : 'finished'}.`)} />
      <BisectBanner state={bisect} busy={working}
        blockedReason={operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : dirty ? 'Commit or stash your changes before the next test' : undefined}
        selectedCommit={!screen && !range ? data.commits[indexMap.get(selected)] : null}
        onStep={(step, oid = null) => void performBisect(step, oid)} onOpenCommit={jump} />
      {lfs?.used && (lfs.installed === false || lfs.missing > 0 || lfsPulling) && <div className="lfs-banner" role="status">
        <HardDrive aria-hidden="true" />
        {lfs.installed === false
          ? <span>This repository keeps large files in <strong>Git LFS</strong>, but git-lfs is not installed. Those files are small pointers until you install it and run <code>git lfs install</code>.</span>
          : <span title={lfs.missingPaths.join('\n')}><strong>{lfs.missing} of {lfs.files}</strong> Git LFS {lfs.files === 1 ? 'file is' : 'files are'} still {lfs.missing === 1 ? 'a pointer' : 'pointers'} here{lfs.missingPaths[0] ? `, like ${lfs.missingPaths[0]}` : ''}.</span>}
        {lfs.installed && <Button icon={HardDrive} reason={lfsPulling ? 'Downloading…' : working ? 'Wait for the current action' : undefined} onClick={() => void pullLfs()}
          title="Runs git lfs pull: downloads the content of these files and puts it in place of their pointers">Download (git lfs pull)</Button>}
        {lfsPulling && <Button onClick={() => void window.twig.cancelRepositoryTool(repository.id)}>Cancel</Button>}
      </div>}
      <div hidden={Boolean(diff) || Boolean(fileHistory) || Boolean(blame) || Boolean(conflict) || Boolean(screen)} className="history-slot">
        {search ? <div className="search-results">
          <div className="search-results-heading" role="status">
            <span>{searchSummary({ ...search, count: search.commits.length })}</span>
            <label className="search-mode"><span>Search in</span>
              <select aria-label="Search in" value={searchMode} onChange={event => setSearchMode(event.target.value)}>
                {SEARCH_MODE_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select></label>
            <Button onClick={() => setFilter('')}>Clear search results</Button>
          </div>
          {search.loading ? <div className="loading-shell" aria-label="Searching history">{Array.from({ length: 6 }, (_, i) => <div className="skeleton" key={i} />)}</div>
            : search.error ? <p className="empty-inline">{search.error} <button onClick={onConsole}>Show output</button></p>
            : search.commits.length ? <CommitGraph commits={search.commits} lanes={search.lanes} laneCount={1} refMap={refMap} indexMap={searchIndexMap} selected={selected} head={repository.status?.branch?.oid}
                onSelect={oid => choose(oid)} onMenu={openMenu} loadMore={NOOP} hasMore={false} loading={false} summary={null} stashes={[]} marks={marks}
                onUncommitted={NOOP} onStashes={NOOP} active={active} commitColors={commitColors} drag={drag} headBranch={headBranch} />
              : <p className="empty-inline">{search.invalid || searchEmpty(search.query, search.mode)}</p>}
        </div>
        : loading && !data.commits.length ? <div className="loading-shell" aria-label="Loading history">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>
          : <CommitGraph commits={data.commits} lanes={data.lanes} laneCount={data.width} refMap={refMap} indexMap={indexMap} selected={selected} selection={selectionSet} head={repository.status?.branch?.oid}
            onSelect={choose} onMenu={openMenu} loadMore={loadMore} hasMore={data.nextSkip !== null} loading={loading} summary={summary} stashes={stashes} marks={marks}
            onUncommitted={() => choose(UNCOMMITTED)} onStashes={() => choose('stashes')} active={active} commitColors={commitColors} drag={drag} headBranch={headBranch} />}
      </div>
      {conflict && <ConflictEditor repositoryId={repository.id} file={conflict} onConsole={onConsole} onClose={() => setConflict(null)}
        onResolved={state => { setConflict(null); setOperation(state); setNote(`${conflict} marked resolved.`); void reload(); onRepositoryChanged?.(); }} />}
      {!conflict && screen === 'branches' && <RefsScreen repository={repository} refs={data.refs} headBranch={headBranch} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'stashes' && <StashScreen repository={repository} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'reflog' && <ReflogScreen repository={repository} refs={data.refs} headBranch={headBranch} operation={operation} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} onJump={oid => void jump(oid)} />}
      {!conflict && screen === 'worktree' && <WorktreeScreen repository={repository} operation={operation} onConsole={onConsole} onChanged={() => { void reload(); void refreshOperation(); onRepositoryChanged?.(); }}
        runAutomation={runAutomation} onBack={() => choose(data.commits[0]?.oid || null)} />}
      {!conflict && screen === 'worktrees' && <WorktreesScreen repository={repository} busy={working} refreshKey={toolsRefresh}
        onBack={() => choose(data.commits[0]?.oid || null)} onNew={branch => openWorktreeDialog(branch)} onOpen={folder => openTab(() => window.twig.openWorktree(repository.id, folder))}
        onDialog={setDialog} onWorkspace={next => onWorkspace?.(next)} onConsole={onConsole} />}
      {!conflict && screen === 'submodules' && <SubmodulesScreen repository={repository} busy={working} refreshKey={toolsRefresh}
        onBack={() => choose(data.commits[0]?.oid || null)} onOpen={folder => openTab(() => window.twig.openSubmodule(repository.id, folder))}
        onDialog={setDialog} onChanged={() => onRepositoryChanged?.()} onConsole={onConsole} />}
      {!conflict && screen === 'automations' && <AutomationsScreen repository={repository} refreshKey={automationRefresh} busy={working || Boolean(execution)}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onChanged={() => setAutomationRefresh(value => value + 1)}
        onRunEvent={(event, options) => void runAutomation(event, options)} />}
      {!conflict && blame && <BlameView repository={repository} seed={blame} onConsole={onConsole}
        onClose={closeBlame} onJump={oid => { closeBlame(); void jump(oid); }} onSelect={setBlameSel} />}
      {!conflict && !blame && diff && !fileHistory && <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }}
        onBlame={diff.file && (diff.oid || indexMap.has(selected)) ? () => openBlame(diff.file, diff.oid || selected) : undefined} />}
      {!conflict && !blame && fileHistory && <FileHistory data={fileHistory} selected={diff?.oid} onConsole={onConsole}
        onSelect={openHistoryDiff} onClose={() => { diffRequest.current++; setFileHistory(null); setDiff(null); }} />}
    </main>
    {showDetail && (fileHistory || blame
      ? <Splitter width={fileHistoryWidth} onWidth={setFileHistoryWidth} size={FILE_HISTORY_PANEL_SIZE} label={blame ? 'Blame details width' : 'File history changes width'} />
      : <Splitter width={width} onWidth={setWidth} />)}
    {showDetail && blame && <BlameDetail repositoryId={repository.id} sel={blameSel}
      onJump={oid => { closeBlame(); void jump(oid); }} onConsole={onConsole} />}
    {showDetail && !blame && fileHistory && <aside className="file-history-detail" aria-label="File history changes">
      {diff ? <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }} onCommit={() => void jump(diff.oid)}
        onBlame={() => openBlame(diff.file, diff.oid)} />
        : <p className="empty-inline">Select a commit to view this file’s changes.</p>}
    </aside>}
    {showDetail && !fileHistory && !blame && uncommitted && <WorktreePanel summary={summary} branch={headBranch} open={diff}
      onFileMenu={(file, section, x, y) => { setMenu(null); setRefMenu(null); setFileMenu({ path: file.path, section, status: file.status, x, y }); }}
      actions={stagingActions} error={stagingError} onConsole={onConsole} onDismissError={() => setStagingError('')}
      onFile={openWorktreeFile} onStaging={() => choose('worktree')} onClose={() => setDetail(false)} />}
    {showDetail && !fileHistory && !blame && !uncommitted && <CommitPanel repositoryId={repository.id} {...commitState} onClose={() => setDetail(false)} onParent={jump} onFile={openFile}
      onFileMenu={(path, x, y) => setFileMenu({ path, x, y })} onConsole={onConsole} range={range} commitColors={commitColors} remotes={remotes}
      mark={commitState.commit ? marks[commitState.commit.oid] || null : null} onSetMark={applyMark} onClearMark={removeMark} />}
    {fileMenu && <Menu x={fileMenu.x} y={fileMenu.y} label={`Actions for ${fileMenu.path}`} onClose={() => setFileMenu(null)}
      items={buildFileMenu({
        path: fileMenu.path, platform, editor,
        // A commit's file is blamed at that commit; an uncommitted one at HEAD,
        // unless it is new and HEAD has no version of it to blame.
        blameOid: fileMenu.section
          ? (fileMenu.status === 'A' ? null : headOid)
          : [commitState.commit?.oid, selected].find(oid => /^[0-9a-f]{7,64}$/i.test(oid || '')) || null,
        tracked: fileMenu.section !== 'untracked',
        move: fileMenu.section ? (fileMenu.section === 'staged' ? 'unstage' : 'stage') : null,
        discard: fileMenu.section === 'unstaged' ? 'changes' : fileMenu.section === 'untracked' ? 'untracked' : null,
        handlers: { ...fileHandlers,
          discard: () => stagingActions.discard({ path: fileMenu.path, status: fileMenu.status }, fileMenu.section),
          discardReason: fileMenu.section && fileMenu.section !== 'staged' ? stagingActions.reasons.discard({ status: fileMenu.status }, fileMenu.section) : undefined,
          move: () => (fileMenu.section === 'staged' ? stagingActions.unstage : stagingActions.stage)({ path: fileMenu.path }),
          moveReason: fileMenu.section === 'staged' ? stagingActions.reasons.unstage : stagingActions.reasons.stage }
      })} />}
    {refMenu && <Menu x={refMenu.x} y={refMenu.y} onClose={() => setRefMenu(null)}
      label={refMenu.ref ? `Actions for ${refMenu.ref.name}` : `Actions for ${refMenu.label}`}
      items={refMenu.ref
        ? buildRefMenu({ ref: refMenu.ref, head: headInfo, remotes: remotes.map(remote => remote.name), operation, handlers: refHandlers(refMenu.ref) })
        : buildSectionMenu({ type: refMenu.section, head: headInfo, remotes: remotes.map(remote => remote.name), operation, handlers: refHandlers(null) })} />}
    {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
      label={menu.multi ? `Actions for ${menu.multi.length} selected commits` : `Actions for commit ${menu.commit.oid.slice(0, 7)}`}
      items={menu.multi
        ? buildMultiCommitMenu({
          commits: menu.multi, operation, dirty, onCurrentBranch: menu.onBranch, someOnCurrentBranch: menu.someOnBranch,
          head: { branch: headBranch },
          handlers: {
            squash: () => void openSquash(menu.multi),
            cherryPick: () => openPickMany('cherry-pick', menu.multi),
            exportPatch: () => void exportPatches(exportOrder(menu.multi)),
            revert: () => openPickMany('revert', menu.multi),
            copyShas: () => void window.twig.copyText(menu.multi.map(commit => commit.oid).join('\n'))
              .then(() => setNote(`${menu.multi.length} SHAs copied.`)).catch(() => setNote('Could not copy that.'))
          }
        })
        : buildCommitMenu({
          commit: menu.commit, refs: refMap.get(menu.commit.oid) || [], remotes: remotes.map(remote => remote.name), operation, bisect, dirty,
          mark: marks[menu.commit.oid] || null,
          head: { branch: headBranch, oid: headOid, detached: Boolean(repository.status?.branch?.detached) },
          handlers: commitHandlers(menu.commit)
        })} />}
    {dropMenu && <Menu x={dropMenu.x} y={dropMenu.y} label="Drag and drop actions" className="drop-action-menu" onClose={() => { setDropMenu(null); drag.cancel(); }}
      items={dropActions(dropMenu.source, dropMenu.target, remotes.map(remote => remote.name)).map(action => ({ ...action,
        reason: action.key === 'compare' ? undefined : dropReason,
        hint: action.key !== 'compare' && dropReason ? dropReason : action.hint,
        run: () => void selectDropAction(action, dropMenu.source, dropMenu.target) }))} />}
    {dropDialog && <DropDialog {...dropDialog} remoteNames={remotes.map(remote => remote.name)} onClose={() => setDropDialog(null)}
      onRun={request => { setDropDialog(null); setDropRunning(true);
        void perform(() => window.twig.runDrop(repository.id, request), 'Drag and drop action finished.').finally(() => setDropRunning(false)); }} />}
    {dialog?.type === 'confirm' && <ConfirmDialog {...dialog} onClose={() => setDialog(null)} />}
    {dialog?.type === 'name' && <NameDialog {...dialog} onClose={() => setDialog(null)} />}
    {dialog?.type === 'message' && <MessageDialog {...dialog} onClose={() => setDialog(null)} />}
    {dialog?.type === 'upstream' && <UpstreamDialog branch={dialog.branch} current={dialog.current} candidates={dialog.candidates}
      onClose={() => setDialog(null)} onConfirm={dialog.onConfirm} />}
    {dialog?.type === 'worktree' && <WorktreeDialog repository={repository} refs={data.refs} headOid={headOid} headBranch={headBranch}
      initialBranch={dialog.branch} onClose={() => setDialog(null)} onCreate={request => void createWorktree(request)} />}
    {dialog?.type === 'patch' && <PatchDialog patch={dialog.patch} branch={headBranch} onClose={() => setDialog(null)}
      onApply={index => void (dialog.patch.kind === 'mbox'
        ? perform(() => window.twig.applyPatchCommits(repository.id, dialog.patch.token), `${dialog.patch.commits.length === 1 ? 'Patch' : `${dialog.patch.commits.length} patches`} applied as commits.`)
        : perform(() => window.twig.applyPatchFiles(repository.id, dialog.patch.token, index), `Patch applied to the files${index ? ' and staged' : ''}.`))} />}
    {dialog?.type === 'rebase' && <RebaseDialog commits={dialog.commits} onClose={() => setDialog(null)}
      onRun={entries => performGated('pre-rebase', 'post-rewrite', () => window.twig.rebaseOnto(repository.id, dialog.oid, entries), 'Rebase finished.')} />}
    {execution && <ExecutionPanel event={execution.event} label={execution.label} phase={execution.phase}
      steps={execution.steps} result={execution.result} blocked={execution.blocked} bypassed={execution.bypassed}
      onClose={() => resolveGate(false)} onRetry={() => resolveGate(false)} onBypass={() => resolveGate(false, true)}
      onRunAgain={rerunGate} />}
  </div>;
}
