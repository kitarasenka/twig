import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Archive, GitBranch, History, PanelLeftClose, PanelLeftOpen, PanelRightOpen, RefreshCw, Search, X, Globe, Tag, Workflow } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Menu from '../../ui/Menu.jsx';
import CommitPanel from '../commit/CommitPanel.jsx';
import Splitter from '../../ui/Splitter.jsx';
import { PANEL_DEFAULT, SIDEBAR_SIZE, FILE_HISTORY_PANEL_SIZE } from '../../ui/panel-width.js';
import CommitGraph from './CommitGraph.jsx';
import WorktreeScreen from '../worktree/WorktreeScreen.jsx';
import ConflictEditor from '../conflicts/ConflictEditor.jsx';
import OperationBanner from '../ops/OperationBanner.jsx';
import BisectBanner from '../ops/BisectBanner.jsx';
import RefsScreen from '../refs/RefsScreen.jsx';
import StashScreen from '../stash/StashScreen.jsx';
import AutomationsScreen from '../automations/AutomationsScreen.jsx';
import ExecutionPanel from '../automations/ExecutionPanel.jsx';
import { eventLabel, eventPhase } from '../automations/event-labels.js';
import RebaseDialog from '../rebase/RebaseDialog.jsx';
import { ConfirmDialog, MessageDialog, NameDialog } from '../ops/dialogs.jsx';
import { buildCommitMenu, buildMultiCommitMenu } from '../ops/commit-menu.js';
import { buildRewordPlan } from '../ops/reword-plan.js';
import { buildSquashPlan } from '../ops/squash-plan.js';
import { createLaneLayout } from './layout.js';
import useGitDrag, { refEndpoint } from './useGitDrag.js';
import DropDialog from './DropDialog.jsx';
import { dropActions, endpointLabel, sameEndpoint } from '../../../../main/git/drop-plan.js';

const IDLE = { kind: 'none', step: null, total: null, branch: null, conflicts: [], resolved: false };
const NO_BISECT = { active: false, terms: { bad: 'bad', good: 'good' }, start: null, bad: null, goods: [],
  skipped: [], expected: null, remaining: null, steps: null, done: false, firstBad: null };
/** The three centre-pane screens that replace the graph instead of selecting a commit. */
const SCREENS = ['worktree', 'branches', 'stashes', 'automations'];

function BranchTree({ refs, onSelect, drag, headBranch }) {
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
  return <>{[...folders].map(([name, children]) => <details className="branch-folder" key={name} open><summary>{name}</summary><BranchTree refs={children} onSelect={onSelect} drag={drag} headBranch={headBranch} /></details>)}
    {leaves.map(ref => <button {...drag.bind(refEndpoint(ref))} className={`real-branch ${ref.type === 'local' && ref.name === headBranch ? 'current-branch' : ''} ${drag.className(refEndpoint(ref))}`} key={ref.fullName}
      title={`${ref.fullName} · Drag or Alt+D, then Alt+Enter on a target`} onClick={() => onSelect(ref.target)}>
      {ref.type === 'remote' ? <Globe /> : ref.type === 'tag' ? <Tag /> : <GitBranch />}<span>{ref.label}</span>{(ref.ahead > 0 || ref.behind > 0) && <small>↑{ref.ahead} ↓{ref.behind}</small>}</button>)}</>;
}

function Diff({ diff, onClose, onCommit }) {
  return <section className="diff-view" aria-label="File diff"><header className="panel-heading"><code>{diff.file}</code><Button icon={X} aria-label="Close diff" onClick={onClose} /></header>
    {onCommit && <div className="file-history-diff-heading"><code>{diff.oid.slice(0, 8)}</code><Button icon={GitBranch} onClick={onCommit}>Go to commit</Button></div>}
    {diff.loading ? <div className="loading-shell" aria-label="Loading diff"><div className="skeleton" /></div> : diff.error ? <p role="alert" className="empty-inline">{diff.error}</p> : diff.binary ? <p className="empty-inline">Binary file changed. A text diff is unavailable.</p> : <div className="diff-lines" tabIndex={0} aria-label="Diff lines">
      {diff.patch ? diff.patch.split('\n').map((line, index) => <div key={index} className={line.startsWith('+') ? 'diff-added' : line.startsWith('-') ? 'diff-deleted' : line.startsWith('@@') ? 'diff-hunk' : ''}><span>{line || ' '}</span></div>) : <p className="empty-inline">No changes for this file in this comparison.</p>}
    </div>}
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

export default function HistoryWorkspace({ repository, active, mod, filterRef, onConsole, onRepositoryChanged, referencesRevision = 0, commitColors = 'lanes', toolbarSlot, toolbarBusyReason }) {
  const [data, setData] = useState({ commits: [], lanes: [], refs: [], nextSkip: 0, width: 1 });
  const dataRef = useRef(data);
  const layout = useRef(createLaneLayout());
  const generation = useRef(0);
  const busy = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [selection, setSelection] = useState([]);
  const [range, setRange] = useState(null);
  const [commitState, setCommitState] = useState({ commit: null, loading: false, error: '' });
  const [detail, setDetail] = useState(true);
  const [width, setWidth] = useState(PANEL_DEFAULT);
  const [fileHistoryWidth, setFileHistoryWidth] = useState(PANEL_DEFAULT);
  const [sidebarWidth, setSidebarWidth] = useState(SIDEBAR_SIZE.defaultWidth);
  const [collapsed, setCollapsed] = useState(false);
  const [filter, setFilter] = useState('');
  const [diff, setDiff] = useState(null);
  const [fileHistory, setFileHistory] = useState(null);
  const [fileMenu, setFileMenu] = useState(null);
  const [operation, setOperation] = useState(IDLE);
  const [bisect, setBisect] = useState(NO_BISECT);
  const [operationReady, setOperationReady] = useState(false);
  const [stashes, setStashes] = useState([]);
  const [remotes, setRemotes] = useState([]);
  const [marks, setMarks] = useState({});
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
      setMenu(null); setFileMenu(null); setSelection([]);
      if (!conflict) {
        setDiff(null); setFileHistory(null); diffRequest.current++;
        setSelected(value => SCREENS.includes(value) ? data.commits[0]?.oid || null : value);
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

  const reload = useCallback(async () => {
    const epoch = ++generation.current;
    // Reloading history must not throw the user out of the working tree
    // screen: staging refreshes history, and the screen lives in `selected`.
    busy.current = true; setLoading(true); setError('');
    setSelected(current => (SCREENS.includes(current) ? current : null));
    setSelection([]); setRange(null); setDiff(null); setFileHistory(null); diffRequest.current++;
    try {
      const [refs, stashList, remoteList, markMap] = await Promise.all([
        window.twig.getRefs(repository.id),
        window.twig.stashList(repository.id).catch(() => []),
        window.twig.getRemotes(repository.id).catch(() => []),
        window.twig.listMarks(repository.id).catch(() => ({}))
      ]);
      if (generation.current !== epoch) return;
      setStashes(stashList);
      setRemotes(remoteList);
      setMarks(markMap);
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
    const commit = dataRef.current.commits.find(item => item.oid === oid);
    if (!commit) return;
    // Right-clicking a commit that is part of a multi-selection keeps that
    // selection and offers the actions that act on all of it; right-clicking
    // anything else falls back to selecting just that commit.
    if (selectionSet.has(oid) && selection.length >= 2) {
      const commits = dataRef.current.commits.filter(item => selectionSet.has(item.oid));
      setMenu({ commit, x, y, multi: commits, onBranch: commits.every(item => headAncestors.has(item.oid)) });
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
      }
    };
  }

  function confirmIfDirty({ title, command, consequence, confirmLabel, run }) {
    if (!dirty) { run(); return; }
    setDialog({ type: 'confirm', title, command, consequence, confirmLabel, onConfirm: run });
  }

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

  const choose = useCallback((oid, mods = {}) => {
    const { shift = false, toggle = false } = typeof mods === 'boolean' ? { shift: mods } : mods;
    jumpRequest.current++;
    const commits = dataRef.current.commits;
    const known = new Map(commits.map((commit, index) => [commit.oid, index]));
    const isCommit = Boolean(oid) && !SCREENS.includes(oid) && known.has(oid);

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
  async function openFileHistory(path) {
    const request = ++diffRequest.current;
    setDiff(null);
    setFileHistory({ path, loading: true });
    try {
      const { commits } = await window.twig.getFileHistory(repository.id, path);
      if (request === diffRequest.current) setFileHistory({ path, commits, loading: false });
    } catch { if (request === diffRequest.current) setFileHistory({ path, error: 'Could not read this file’s history. Show output in the console.', loading: false }); }
  }
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
  const changes = repository.status?.entries || [];
  const dropReason = toolbarBusyReason || (working ? 'Git is working' : undefined)
    || (!operationReady ? 'Repository state is not verified yet. Refresh first.' : undefined)
    || (operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined)
    || (bisect.active ? 'Finish BugHunter first' : undefined)
    || (changes.length ? 'Commit or stash your changes first' : undefined);
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
  const hunterCommit = !screen && !range ? data.commits[indexMap.get(selected)] : null;
  const hunterReason = toolbarBusyReason || (working ? 'Git is working' : undefined)
    || (!operationReady ? 'Repository state is not verified yet. Refresh to check it.' : undefined)
    || (bisect.active ? 'BugHunter is already running. Use the panel below.' : undefined)
    || (operation.kind !== 'none' ? `Finish or abort the ${operation.kind} first` : undefined)
    || (dirty || operation.conflicts.length > 0 ? 'Commit or stash your changes first' : undefined)
    || (loading ? 'History is loading' : undefined)
    || (!data.commits.length ? 'This repository has no commits to search' : undefined)
    || (!hunterCommit ? 'Select a commit with the bug in the history first' : undefined);
  const visibleRefs = data.refs.filter(ref => ref.name.toLowerCase().includes(filter.toLowerCase()));
  const showDetail = detail && !conflict && !screen;
  return <div className={`workspace real-workspace ${collapsed ? 'sidebar-small' : ''} ${showDetail ? '' : 'no-detail'}`} style={{ '--detail-width': `${fileHistory ? fileHistoryWidth : width}px`, '--sidebar-width': `${sidebarWidth}px` }}>
    {active && toolbarSlot && createPortal(
      <Button className="tool bughunter-tool" reason={hunterReason}
        title={hunterCommit ? `Start from ${hunterCommit.oid.slice(0, 7)}: choose a commit where the bug is present` : undefined}
        onClick={() => { if (!hunterReason) void performBisect('start', hunterCommit.oid); }}>🌱 BugHunter (bisect)</Button>, toolbarSlot)}
    <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`} aria-label="Repository navigation">
      {collapsed ? <Button icon={PanelLeftOpen} aria-label="Expand repository sidebar" onClick={() => setCollapsed(false)} /> : <>
        <div className="sidebar-filter"><Search /><input ref={filterRef} aria-label="Filter repository references" placeholder={`Filter refs · ${mod}+F`} value={filter} onChange={event => setFilter(event.target.value)} /></div>
        <nav className="sidebar-nav" aria-label="Repository screens">
          <button className={`real-branch ${screen === 'branches' ? 'selected' : ''}`} onClick={() => choose('branches')}>
            <GitBranch /><span>Branches and tags</span><small>{data.refs.length}</small></button>
          <button className={`real-branch ${screen === 'stashes' ? 'selected' : ''}`} onClick={() => choose('stashes')}>
            <Archive /><span>Stashes</span><small>{stashes.length}</small></button>
          <button className={`real-branch ${screen === 'automations' ? 'selected' : ''}`} onClick={() => choose('automations')}>
            <Workflow /><span>Automations</span></button>
        </nav>
        <div className="sidebar-sections">{[['LOCAL', 'local'], ['REMOTE', 'remote'], ['TAGS', 'tag']].map(([label, type]) => <details key={type} open><summary>{label}<span>{data.refs.filter(ref => ref.type === type).length}</span></summary>
          <BranchTree refs={visibleRefs.filter(ref => ref.type === type).map(ref => ({ ...ref, label: ref.name }))} onSelect={jump} drag={drag} headBranch={headBranch} />
          {!visibleRefs.some(ref => ref.type === type) && <p className="section-empty">No matching {label.toLowerCase()} refs</p>}
        </details>)}</div><div className="sidebar-footer"><span>{repository.status?.branch?.name || 'Detached HEAD'}</span><Button icon={PanelLeftClose} aria-label="Collapse repository sidebar" onClick={() => setCollapsed(true)} /></div>
      </>}
    </aside>
    {!collapsed && <Splitter side="left" width={sidebarWidth} onWidth={setSidebarWidth} label="Repository sidebar width" />}
    <main className="graph-panel" aria-label="Repository history">
      <header className="graph-heading"><div><GitBranch /><strong>History</strong><span className="count">{data.commits.length} loaded</span></div><div>{!detail && <Button icon={PanelRightOpen} aria-label="Show commit details" onClick={() => setDetail(true)} />}<Button icon={RefreshCw} reason={loading ? 'History is loading' : undefined}
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
      <div hidden={Boolean(diff) || Boolean(fileHistory) || Boolean(conflict) || Boolean(screen)} className="history-slot">
        {loading && !data.commits.length ? <div className="loading-shell" aria-label="Loading history">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>
          : <CommitGraph commits={data.commits} lanes={data.lanes} laneCount={data.width} refMap={refMap} indexMap={indexMap} selected={selected} selection={selectionSet} head={repository.status?.branch?.oid}
            onSelect={choose} onMenu={openMenu} loadMore={loadMore} hasMore={data.nextSkip !== null} loading={loading} changes={changes.length} stashes={stashes} marks={marks}
            onWorktree={() => choose('worktree')} onStashes={() => choose('stashes')} active={active} commitColors={commitColors} drag={drag} headBranch={headBranch} />}
      </div>
      {conflict && <ConflictEditor repositoryId={repository.id} file={conflict} onConsole={onConsole} onClose={() => setConflict(null)}
        onResolved={state => { setConflict(null); setOperation(state); setNote(`${conflict} marked resolved.`); void reload(); onRepositoryChanged?.(); }} />}
      {!conflict && screen === 'branches' && <RefsScreen repository={repository} refs={data.refs} headBranch={headBranch} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'stashes' && <StashScreen repository={repository} busy={working}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onPerform={perform} onDialog={setDialog} />}
      {!conflict && screen === 'worktree' && <WorktreeScreen repository={repository} operation={operation} onConsole={onConsole} onChanged={() => { void reload(); void refreshOperation(); onRepositoryChanged?.(); }}
        runAutomation={runAutomation} onBack={() => choose(data.commits[0]?.oid || null)} />}
      {!conflict && screen === 'automations' && <AutomationsScreen repository={repository} refreshKey={automationRefresh} busy={working || Boolean(execution)}
        onConsole={onConsole} onBack={() => choose(data.commits[0]?.oid || null)} onChanged={() => setAutomationRefresh(value => value + 1)}
        onRunEvent={(event, options) => void runAutomation(event, options)} />}
      {!conflict && diff && !fileHistory && <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }} />}
      {!conflict && fileHistory && <FileHistory data={fileHistory} selected={diff?.oid} onConsole={onConsole}
        onSelect={openHistoryDiff} onClose={() => { diffRequest.current++; setFileHistory(null); setDiff(null); }} />}
    </main>
    {showDetail && (fileHistory
      ? <Splitter width={fileHistoryWidth} onWidth={setFileHistoryWidth} size={FILE_HISTORY_PANEL_SIZE} label="File history changes width" />
      : <Splitter width={width} onWidth={setWidth} />)}
    {showDetail && fileHistory && <aside className="file-history-detail" aria-label="File history changes">
      {diff ? <Diff diff={diff} onClose={() => { diffRequest.current++; setDiff(null); }} onCommit={() => void jump(diff.oid)} />
        : <p className="empty-inline">Select a commit to view this file’s changes.</p>}
    </aside>}
    {showDetail && !fileHistory && <CommitPanel repositoryId={repository.id} {...commitState} onClose={() => setDetail(false)} onParent={jump} onFile={openFile}
      onFileMenu={(path, x, y) => setFileMenu({ path, x, y })} onConsole={onConsole} range={range} commitColors={commitColors} remotes={remotes}
      mark={commitState.commit ? marks[commitState.commit.oid] || null : null} onSetMark={applyMark} onClearMark={removeMark} />}
    {fileMenu && <Menu x={fileMenu.x} y={fileMenu.y} label={`Actions for ${fileMenu.path}`} onClose={() => setFileMenu(null)}
      items={[{ key: 'file-history', text: 'File history', hint: 'Every commit that changed this file', icon: History, run: () => void openFileHistory(fileMenu.path) }]} />}
    {menu && <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
      label={menu.multi ? `Actions for ${menu.multi.length} selected commits` : `Actions for commit ${menu.commit.oid.slice(0, 7)}`}
      items={menu.multi
        ? buildMultiCommitMenu({
          commits: menu.multi, operation, dirty, onCurrentBranch: menu.onBranch,
          handlers: {
            squash: () => void openSquash(menu.multi),
            copyShas: () => void window.twig.copyText(menu.multi.map(commit => commit.oid).join('\n'))
              .then(() => setNote(`${menu.multi.length} SHAs copied.`)).catch(() => setNote('Could not copy that.'))
          }
        })
        : buildCommitMenu({
          commit: menu.commit, refs: refMap.get(menu.commit.oid) || [], operation, bisect, dirty,
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
    {dialog?.type === 'rebase' && <RebaseDialog commits={dialog.commits} onClose={() => setDialog(null)}
      onRun={entries => performGated('pre-rebase', 'post-rewrite', () => window.twig.rebaseOnto(repository.id, dialog.oid, entries), 'Rebase finished.')} />}
    {execution && <ExecutionPanel event={execution.event} label={execution.label} phase={execution.phase}
      steps={execution.steps} result={execution.result} blocked={execution.blocked} bypassed={execution.bypassed}
      onClose={() => resolveGate(false)} onRetry={() => resolveGate(false)} onBypass={() => resolveGate(false, true)}
      onRunAgain={rerunGate} />}
  </div>;
}
