import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Bot, Bug, ChevronDown, Download, FolderOpen, GitBranch, Layers, LoaderCircle, Plus, Redo2, RefreshCw, RotateCw, Settings, Undo2, Upload, UserRound, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import { Console } from './Console.jsx';
import { pickFailedEntry } from './console-focus.js';
import { CONSOLE_FLUSH_MS, applyConsoleUpdates } from './console-entries.js';
import { keepUnchangedRepositories } from './workspace-identity.js';
import { readClosedTabs, startRepositoryId, writeClosedTabs } from './closed-tabs.js';
import { fetchExplanation, fetchStatusLine, intervalLabel, pullTitle } from './background-fetch-view.js';
import { autoCheckExplanation, installVerb, percent, toolbarUpdate, updateStatusLine } from './update-view.js';
import HistoryWorkspace from '../features/graph/HistoryWorkspace.jsx';
import { mcpSummary, mcpToolTitle } from '../features/settings/mcp-view.js';
import useDiffPrefs from '../features/diff/useDiffPrefs.js';
import ExecutionPanel from '../features/automations/ExecutionPanel.jsx';
import { outcomeNote } from '../features/proposal/proposal-view.js';
import { AGE_STOPS, ageTextClass } from '../features/graph/age-color.js';
import lazyScreen from '../ui/lazy-screen.jsx';

// Opened rarely: loaded the first time they are shown, not with the window.
const GitProfile = lazyScreen(() => import('../features/settings/GitProfile.jsx'));
const Repositories = lazyScreen(() => import('../features/settings/Repositories.jsx'));
const CloneRepository = lazyScreen(() => import('../features/settings/CloneRepository.jsx'));
const Remotes = lazyScreen(() => import('../features/settings/Remotes.jsx'));
const SshSettings = lazyScreen(() => import('../features/settings/SshSettings.jsx'));
const McpSettings = lazyScreen(() => import('../features/settings/McpSettings.jsx'));
const CommitProposalDialog = lazyScreen(() => import('../features/proposal/CommitProposalDialog.jsx'));

const unavailable = 'Connect a repository to use this action';
function initialTheme() {
  try { const value = localStorage.getItem('twig:theme'); return ['dark', 'light'].includes(value) ? value : 'system'; }
  catch { return 'system'; }
}

/** Age colours are the default: the ramp says how old the history is, lanes only say which branch. */
function initialCommitColors() {
  try { return localStorage.getItem('twig:commit-colors') === 'lanes' ? 'lanes' : 'age'; }
  catch { return 'age'; }
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [commitColors, setCommitColors] = useState(initialCommitColors);
  const [active, setActive] = useState('');
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  // The in-app update lives in main (it downloads and installs); this is the
  // state it broadcasts, for the top-bar button and Settings → Updates.
  const [update, setUpdate] = useState(null);
  const [updateError, setUpdateError] = useState('');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [bugHunterSlot, setBugHunterSlot] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [info, setInfo] = useState(null);
  // The external editor lives in main (it names a program to run); this is
  // only its description, for the Settings row and the file menus.
  const [editor, setEditor] = useState(null);
  const [editorError, setEditorError] = useState('');
  // Background fetch: the consent lives in main, which runs the fetch; the
  // renderer only shows it and how the open repository's schedule stands.
  const [fetchSettings, setFetchSettings] = useState(null);
  // Settings → AI agents (MCP), for the toolbar button and the Settings summary.
  const [mcpSettings, setMcpSettings] = useState(null);
  // A commit an agent proposed through MCP: main owns it and runs it; this is
  // the dialog's view, its progress and a failure to show before closing.
  const [proposal, setProposal] = useState(null);
  const [proposalRun, setProposalRun] = useState({ running: false, step: null, failure: '' });
  const [fetchStatus, setFetchStatus] = useState(null);
  const [fetchError, setFetchError] = useState('');
  const [diffPrefs, setDiffPrefs] = useDiffPrefs();
  const [workspace, setWorkspaceState] = useState(null);
  // A repository that did not change keeps its object, so its tab (a memoized
  // HistoryWorkspace) does not re-render because another one was refreshed.
  const setWorkspace = useCallback(next => setWorkspaceState(previous => keepUnchangedRepositories(previous, next)), []);
  const [entries, setEntries] = useState([]);
  const [consoleFocus, setConsoleFocus] = useState(null);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;
  // Journal events gather for a moment and reach the screen together: one
  // refresh is dozens of git processes, three or more events each, and every
  // event used to re-render the whole window.
  const pendingConsole = useRef([]);
  const consoleTimer = useRef(0);
  const flushConsole = useCallback(() => {
    clearTimeout(consoleTimer.current);
    consoleTimer.current = 0;
    const batch = pendingConsole.current;
    if (!batch.length) return;
    pendingConsole.current = [];
    entriesRef.current = applyConsoleUpdates(entriesRef.current, batch);
    setEntries(entriesRef.current);
  }, []);
  // Opening the console is not enough when something failed: point at the entry
  // that actually failed, so the reader does not hunt for it in the journal.
  // Events still gathering are applied first: the failure may be among them.
  const showConsole = useCallback(() => {
    flushConsole();
    setConsoleOpen(true);
    const failed = pickFailedEntry(entriesRef.current);
    setConsoleFocus(failed ? { id: failed.id } : null);
  }, [flushConsole]);
  const [startupError, setStartupError] = useState('');
  const [divergence, setDivergence] = useState({ ahead: 0, behind: 0, upstream: null });
  const [stashCount, setStashCount] = useState(null);
  const [syncing, setSyncing] = useState(null);
  const [syncNote, setSyncNote] = useState('');
  const [pushGate, setPushGate] = useState(null);
  const pushGateResolve = useRef(null);
  const [worktreeVersion, setWorktreeVersion] = useState(0);
  const [remoteRevisions, setRemoteRevisions] = useState({});
  const [closedTabs, setClosedTabs] = useState(() => { try { return readClosedTabs(localStorage); } catch { return new Set(); } });
  const [undoState, setUndoState] = useState({ undo: false, redo: false, undoReason: 'No application actions to undo.', redoReason: 'No next action.' });
  const [undoMoving, setUndoMoving] = useState(false);
  const repositoryFilters = useRef(new Map());
  // Tabs that have been open on screen. A tab's history loads when it is first
  // shown, not at launch: every connected repository used to read its whole
  // first page, refs, remotes and selected commit at startup (91 git processes
  // for 8 repositories), closed tabs included.
  const [visited, setVisited] = useState(() => new Set());
  useEffect(() => {
    if (!active.startsWith('repository:')) return;
    const id = active.slice(11);
    setVisited(current => (current.has(id) ? current : new Set(current).add(id)));
  }, [active]);
  // One ref callback per repository for the life of the window: a new arrow on
  // every render would detach and re-attach the search box each time and
  // defeat the memoized tab.
  const filterRefs = useRef(new Map());
  const filterRefFor = id => {
    let ref = filterRefs.current.get(id);
    if (!ref) {
      ref = node => { if (node) repositoryFilters.current.set(id, node); else repositoryFilters.current.delete(id); };
      filterRefs.current.set(id, ref);
    }
    return ref;
  };
  const tabsRef = useRef(null);
  const selectionRequest = useRef(0);
  const divergenceRequest = useRef(0);
  const stashRequest = useRef(0);
  const mod = info?.platform === 'darwin' || (!info && /Mac/.test(navigator.platform)) ? 'Cmd' : 'Ctrl';
  const ready = (info !== null && workspace !== null) || Boolean(startupError);
  const repository = workspace?.repositories.find(item => active === `repository:${item.id}`)
    || workspace?.repositories.find(item => item.id === workspace.activeId) || null;
  const sandboxId = workspace?.repositories.find(item => item.sandbox)?.id || null;
  const repositoryActive = active.startsWith('repository:');

  useEffect(() => {
    let alive = true;
    if (!window.twig) { setStartupError('Browser preview. Launch the desktop app with npm run dev.'); return; }
    Promise.all([window.twig.getAppInfo(), window.twig.getWorkspace(), window.twig.getConsoleEntries()])
      .then(([appInfo, initialWorkspace, initialEntries]) => {
        if (!alive) return;
        setInfo(appInfo); setWorkspace(initialWorkspace);
        entriesRef.current = applyConsoleUpdates(initialEntries, pendingConsole.current.splice(0));
        setEntries(entriesRef.current);
        // A tab closed last time stays closed: start on the remembered one only
        // while its tab is open.
        let closed = new Set();
        try { closed = readClosedTabs(localStorage); } catch { /* Nothing remembered. */ }
        const startId = startRepositoryId(initialWorkspace.repositories, initialWorkspace.activeId, closed);
        // Nothing to show — no connected repository and a closed demo — is a
        // real state now, and it starts on the New repository tab, not on a
        // blank window.
        if (startId) setActive(`repository:${startId}`);
        else { setEmptyOpen(true); setActive('new'); }
      })
      .catch(() => { if (alive) setStartupError('Desktop connection unavailable. Restart 🌱 Twig.'); });
    window.twig.getEditor().then(value => { if (alive) setEditor(value); }).catch(() => {});
    window.twig.getBackgroundFetch().then(value => { if (alive) setFetchSettings(value); }).catch(() => {});
    window.twig.getUpdateState().then(value => { if (alive) setUpdate(value); }).catch(() => {});
    const unsubscribeUpdate = window.twig.onUpdateState(value => { if (alive) setUpdate(value); });
    const unsubscribe = window.twig.onConsoleUpdate((update) => {
      if (!alive) return;
      pendingConsole.current.push(update);
      if (!consoleTimer.current) consoleTimer.current = setTimeout(flushConsole, CONSOLE_FLUSH_MS);
    });
    return () => { alive = false; unsubscribe(); unsubscribeUpdate(); clearTimeout(consoleTimer.current); };
  }, [flushConsole, setWorkspace]);
  // "Other application…" opens a native picker in main; cancelling it leaves
  // the previous choice in place, which is what comes back.
  const chooseEditor = useCallback(async (preset) => {
    setEditorError('');
    try { setEditor(await window.twig.setEditor(preset)); }
    catch { setEditorError('Could not save the editor choice.'); }
  }, []);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    function apply() { document.documentElement.dataset.theme = theme === 'system' ? (system.matches ? 'dark' : 'light') : theme; }
    apply();
    try { localStorage.setItem('twig:theme', theme); } catch { /* Preference remains session-local if storage is unavailable. */ }
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);
  useEffect(() => {
    try { localStorage.setItem('twig:commit-colors', commitColors); } catch { /* Preference remains session-local if storage is unavailable. */ }
  }, [commitColors]);
  // Closed tabs survive a restart. Only ids still in the list are kept, so a
  // repository removed from 🌱 Twig does not linger in the stored set.
  useEffect(() => {
    if (!workspace) return;
    const known = new Set(workspace.repositories.map(item => item.id));
    try { writeClosedTabs(localStorage, [...closedTabs].filter(id => known.has(id))); } catch { /* Session-local if storage is unavailable. */ }
  }, [closedTabs, workspace]);
  // The tab strip has no visible scrollbar: the active tab scrolls into view,
  // and a plain mouse wheel scrolls the strip sideways.
  useEffect(() => {
    tabsRef.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, closedTabs, emptyOpen]);
  function scrollTabs(event) {
    if (event.deltaX === 0 && event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY;
  }
  // Whatever makes a closed repository active — the REPOSITORY picker, Open
  // repository on the same folder, Connected repositories — brings its tab back.
  useEffect(() => {
    if (!active.startsWith('repository:')) return;
    const id = active.slice(11);
    if (closedTabs.has(id)) setClosedTabs(current => { const copy = new Set(current); copy.delete(id); return copy; });
  }, [active, closedTabs]);
  const branchName = repository?.status?.branch?.name || null;
  const fetchRequest = useRef(0);
  const readFetchStatus = useCallback(() => {
    const request = ++fetchRequest.current;
    if (!repositoryActive || !repository?.available) { setFetchStatus(null); return; }
    window.twig.getBackgroundFetchStatus(repository.id)
      .then(next => { if (request === fetchRequest.current) setFetchStatus(next); })
      .catch(() => { if (request === fetchRequest.current) setFetchStatus(null); });
  }, [repositoryActive, repository?.id, repository?.available]);
  useEffect(() => { readFetchStatus(); }, [readFetchStatus, fetchSettings?.interval]);
  // Read at start and again whenever a dialog opens or closes: the toolbar's
  // MCP button shows whether the server is on, and Settings summarises it.
  useEffect(() => {
    if (!window.twig?.getMcpSettings) return undefined;
    let alive = true;
    window.twig.getMcpSettings().then(value => { if (alive) setMcpSettings(value); }).catch(() => {});
    return () => { alive = false; };
  }, [dialog]);
  // A finished background fetch may have moved remote-tracking refs: the
  // badges are re-read (the watcher reloads the graph on its own).
  useEffect(() => window.twig?.onBackgroundFetch?.(update => {
    if (update.cwd !== repository?.path) return;
    readFetchStatus();
    setWorktreeVersion(value => value + 1);
  }), [repository?.path, readFetchStatus]);
  const chooseFetchInterval = useCallback(async (interval) => {
    setFetchError('');
    try { setFetchSettings(await window.twig.setBackgroundFetch(interval)); }
    catch { setFetchError('Could not save the background fetch choice.'); }
  }, []);
  useEffect(() => {
    const request = ++divergenceRequest.current;
    if (!repositoryActive || !repository?.available) { setDivergence({ ahead: 0, behind: 0, upstream: null }); return; }
    window.twig.getDivergence(repository.id, branchName)
      .then(next => { if (request === divergenceRequest.current) setDivergence(next); })
      .catch(() => { if (request === divergenceRequest.current) setDivergence({ ahead: 0, behind: 0, upstream: null }); });
  }, [repositoryActive, repository?.id, repository?.available, branchName, worktreeVersion]);
  /** Pop restores the newest stash, so the button is only useful while the repository has one. */
  useEffect(() => {
    const request = ++stashRequest.current;
    if (!repositoryActive || !repository?.available) { setStashCount(null); return; }
    window.twig.stashList(repository.id)
      .then(list => { if (request === stashRequest.current) setStashCount(list.length); })
      .catch(() => { if (request === stashRequest.current) setStashCount(null); });
  }, [repositoryActive, repository?.id, repository?.available, worktreeVersion]);

  function runPushGate() {
    return new Promise(resolve => {
      pushGateResolve.current = resolve;
      setPushGate({ steps: [], result: null, blocked: false });
      window.twig.runAutomation(repository.id, 'pre-push', { remote: divergence.upstream ? divergence.upstream.split('/')[0] : 'origin' })
        .then(result => {
          if (result.ran === false) { setPushGate(null); pushGateResolve.current = null; resolve(true); return; }
          setPushGate({ steps: result.steps, result: result.blocked ? 'blocked' : result.ok ? 'passed' : 'failed', blocked: result.blocked });
          if (!result.blocked) setTimeout(() => { setPushGate(null); pushGateResolve.current = null; resolve(true); }, result.ok ? 900 : 1600);
        })
        .catch(() => { setPushGate(null); pushGateResolve.current = null; showConsole(); resolve(true); });
    });
  }
  function closePushGate(proceed, bypass = false) {
    const resolve = pushGateResolve.current;
    pushGateResolve.current = null;
    if (bypass) void window.twig.runAutomation(repository.id, 'pre-push', { bypass: true }).catch(() => {});
    setPushGate(null);
    resolve?.(proceed || bypass);
  }

  async function runSync(mode) {
    if (!repository) return;
    if ((mode === 'push' || mode === 'push-upstream') && !await runPushGate()) return;
    setSyncing(mode); setSyncNote('');
    try {
      const result = await window.twig.runSync(repository.id, mode, branchName);
      setSyncNote(result.ok ? `${mode} finished.` : result.message);
      if (!result.ok) showConsole();
      const next = await window.twig.selectRepository(repository.id);
      setWorkspace(next);
      setWorktreeVersion(value => value + 1);
    } catch (error) {
      setSyncNote(error.message || 'The operation failed.');
      showConsole();
    } finally { setSyncing(null); }
  }
  async function runStash(action) {
    if (!repository) return;
    setSyncing(action); setSyncNote('');
    try {
      if (action === 'stash') await window.twig.stashPush(repository.id, true, '');
      else await window.twig.stashPop(repository.id);
      setSyncNote(action === 'stash' ? 'Changes stashed.' : 'Stash popped.');
      const next = await window.twig.selectRepository(repository.id);
      setWorkspace(next);
      setWorktreeVersion(value => value + 1);
    } catch (error) {
      setSyncNote(error.message || 'The operation failed.');
      showConsole();
    } finally { setSyncing(null); }
  }

  /** Every update step is one press; main answers with its state and keeps broadcasting it. */
  async function runUpdate(step) {
    setUpdateError('');
    try {
      const next = step === 'check' ? await window.twig.checkForUpdate()
        : step === 'download' ? await window.twig.downloadUpdate()
          : step === 'cancel' ? await window.twig.cancelUpdate()
            : await window.twig.installUpdate();
      setUpdate(next);
    } catch { setUpdateError('The update could not run. Restart 🌱 Twig and try again.'); }
  }
  async function chooseAutoUpdate(value) {
    setUpdateError('');
    try { setUpdate(await window.twig.setAutoUpdateCheck(value)); }
    catch { setUpdateError('Could not save the update setting.'); }
  }

  async function resetDemo() {
    setResetting(true); setSyncNote('');
    try {
      const next = await window.twig.resetDemoWorkspace();
      ++selectionRequest.current;
      setWorkspace(next);
      setWorktreeVersion(value => value + 1);
      const demo = next.repositories.find(item => item.sandbox);
      if (demo) {
        setActive(`repository:${demo.id}`);
        setRemoteRevisions(current => ({ ...current, [demo.id]: (current[demo.id] || 0) + 1 }));
      }
      setDialog(null);
      setSyncNote('Demo workspace reset to its sample history.');
    } catch (error) {
      setSyncNote(error.message || 'Could not reset the demo workspace.');
      showConsole();
    } finally { setResetting(false); }
  }

  /**
   * Closing the demo tab is remembered across restarts — a closed demo costs
   * nothing on startup — and it deletes nothing: showing it again reopens the
   * same sandbox with its history intact.
   */
  const demoVisibleRef = useRef(null);
  async function setDemoVisible(visible) {
    try {
      const next = await window.twig.setDemoWorkspaceVisible(visible);
      ++selectionRequest.current;
      setWorkspace(next);
      const demo = next.repositories.find(item => item.sandbox);
      if (visible && demo) {
        setActive(`repository:${demo.id}`);
        setDialog(null);
        setSyncNote('');
      } else if (!visible) {
        const open = next.repositories.filter(item => !closedTabs.has(item.id));
        if (open[0]) setActive(`repository:${open[0].id}`); else openEmpty();
        setSyncNote('Demo workspace closed. Settings brings it back.');
      }
    } catch (error) {
      setSyncNote(error.message || 'Could not change the demo workspace.');
      showConsole();
    }
  }

  // Cmd+W fires from a subscription that must not be torn down on every render,
  // so it reaches this handler through a ref rather than the dependency list.
  demoVisibleRef.current = setDemoVisible;

  const syncReason = !repositoryActive || !repository?.available ? unavailable
    : syncing ? `${syncing} is running` : undefined;

  /** A commit or a staging change moves the divergence badges, so the toolbar has to hear about it. */
  const repositoryId = repository?.id;
  const refreshRepository = useCallback(async () => {
    if (!repositoryId) return;
    try { setWorkspace(await window.twig.selectRepository(repositoryId)); } catch { /* the previous status stays on screen */ }
    setWorktreeVersion(value => value + 1);
  }, [repositoryId, setWorkspace]);
  useEffect(() => {
    let alive = true;
    const show = view => {
      if (!alive) return;
      // null is main closing it (answered elsewhere, superseded). While this window is
      // committing it, or showing why that failed, the dialog stays: decideProposal closes it.
      const held = proposalRunRef.current.running || Boolean(proposalRunRef.current.failure);
      if (view === null && held) return;
      setProposalRun({ running: false, step: null, failure: '' });
      setProposal(view);
    };
    window.twig.getCommitProposal().then(show).catch(() => {});
    const offProposal = window.twig.onCommitProposal(show);
    const offStep = window.twig.onCommitProposalStep(step => { if (alive) setProposalRun(current => (current.running ? { ...current, step } : current)); });
    return () => { alive = false; offProposal(); offStep(); };
  }, []);
  const proposalRunRef = useRef(proposalRun);
  proposalRunRef.current = proposalRun;
  async function decideProposal(decision) {
    if (!proposal) return;
    if (decision.action !== 'cancel') setProposalRun({ running: true, step: null, failure: '' });
    try {
      const answer = await window.twig.decideCommitProposal(proposal.id, decision);
      if (answer.stale) { setProposal(answer.stale); setProposalRun({ running: false, step: null, failure: '' }); return; }
      // A tag that cannot be made (it exists, a bad name): the dialog stays open to fix it.
      if (answer.invalid) { setProposalRun({ running: false, step: null, failure: '', invalid: answer.invalid }); return; }
      if (decision.action === 'cancel') { setProposal(null); setProposalRun({ running: false, step: null, failure: '' }); return; }
      if (answer.ok) {
        setProposal(null);
        setProposalRun({ running: false, step: null, failure: '' });
        setSyncNote(outcomeNote(answer.outcome));
      } else {
        setProposalRun({ running: false, step: null, failure: answer.outcome });
      }
    } catch (error) {
      setProposalRun({ running: false, step: null, failure: error.message || 'The proposal could not be answered.' });
    }
    if (decision.action !== 'cancel') void refreshRepository();
  }
  useEffect(() => {
    if (!repositoryActive || !repositoryId) return;
    let alive = true; let generation = 0;
    const refresh = () => {
      const current = ++generation;
      window.twig.getUndoState(repositoryId).then(state => { if (alive && current === generation) setUndoState(state); })
        .catch(() => { if (alive && current === generation) setUndoState({ undo: false, redo: false, undoReason: 'Could not verify the repository.', redoReason: 'Could not verify the repository.' }); });
    };
    refresh();
    const unsubscribe = window.twig.onUndoUpdate(update => { if (update.cwd === repositoryId) refresh(); });
    window.addEventListener('focus', refresh);
    return () => { alive = false; unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [repositoryId, repositoryActive, worktreeVersion]);
  // Watch whichever repository is on screen for changes made outside 🌱 Twig.
  // One watcher in main follows the active tab; the workspace screen reloads on
  // the event it sends.
  useEffect(() => {
    if (!window.twig?.watchRepository) return undefined;
    const id = repositoryActive && repository?.available ? repository.id : null;
    window.twig.watchRepository(id).catch(() => { /* watch is best-effort */ });
    return () => { window.twig.watchRepository(null).catch(() => {}); };
  }, [repositoryActive, repository?.id, repository?.available]);

  const moveUndo = useCallback(async direction => {
    if (!repositoryActive || !repositoryId || undoMoving) return;
    setUndoMoving(true); setSyncNote('');
    try {
      const result = await window.twig.moveUndo(repositoryId, direction);
      // The graph starts reading right away, alongside the status below.
      setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      await refreshRepository();
      setSyncNote(`${direction === 'undo' ? 'Undo' : 'Redo'} ${result.cancelled ? 'cancelled' : 'completed'}.`);
    }
    catch (failure) {
      setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      setSyncNote(failure.message || 'The action could not be reversed.'); showConsole();
    }
    finally { setUndoMoving(false); }
  }, [repositoryActive, repositoryId, refreshRepository, showConsole, undoMoving]);
  useEffect(() => {
    const keydown = event => {
      if (dialog || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z'
        || event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault(); const direction = event.shiftKey ? 'redo' : 'undo';
      if (undoState[direction]) void moveUndo(direction);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, moveUndo, undoState]);

  function openEmpty() { setEmptyOpen(true); setActive('new'); }
  async function openRepository() {
    try {
      const next = await window.twig.openRepository();
      setWorkspace(next);
      if (next.activeId) { setActive(`repository:${next.activeId}`); setConsoleOpen(true); }
    } catch (error) { setStartupError(error.message || 'Could not open this repository.'); showConsole(); }
  }
  async function selectRepository(id) {
    const request = ++selectionRequest.current;
    // The tab switches at once; main's answer brings its fresh status after.
    // Waiting for it first held every tab click behind a round of git reads.
    if (workspace?.repositories.some(item => item.id === id)) {
      setActive(`repository:${id}`);
      setClosedTabs(current => { if (!current.has(id)) return current; const copy = new Set(current); copy.delete(id); return copy; });
    }
    try {
      const next = await window.twig.selectRepository(id);
      if (request === selectionRequest.current) {
        setWorkspace(next); setActive(`repository:${id}`);
        setClosedTabs(current => { if (!current.has(id)) return current; const copy = new Set(current); copy.delete(id); return copy; });
      }
    } catch (error) { setStartupError(error.message || 'Could not select this repository.'); }
  }
  function closeRepositoryTab(id) {
    setClosedTabs(current => new Set(current).add(id));
    if (active !== `repository:${id}`) return;
    const openRepositories = (workspace?.repositories || []).filter(item => item.id !== id && !closedTabs.has(item.id));
    if (openRepositories.length > 0) setActive(`repository:${openRepositories[0].id}`);
    else if (sandboxId) setActive(`repository:${sandboxId}`);
    else openEmpty();
  }
  function acceptWorkspace(next, open = false) {
    ++selectionRequest.current;
    setWorkspace(next);
    if (open || !next.repositories.some(item => active === `repository:${item.id}`)) {
      const fallbackId = next.activeId || next.repositories.find(item => item.sandbox)?.id;
      if (fallbackId) setActive(`repository:${fallbackId}`);
      else openEmpty();
    }
    if (open) setDialog(null);
  }
  /** A worktree or submodule opened from a repository screen: its tab comes up at once. */
  const openWorkspaceTab = useCallback(next => {
    if (!next) return;
    ++selectionRequest.current;
    setWorkspace(next);
    if (next.activeId) {
      setActive(`repository:${next.activeId}`);
      setClosedTabs(current => { if (!current.has(next.activeId)) return current; const copy = new Set(current); copy.delete(next.activeId); return copy; });
    }
  }, [setWorkspace]);
  const acceptWorkspaceRef = useRef(null);
  acceptWorkspaceRef.current = acceptWorkspace;
  const updateWorkspace = useCallback(next => { if (next) acceptWorkspaceRef.current(next); }, []);
  function showManagerOutput() {
    showConsole();
    if (!dialogBusy) setDialog(null);
  }
  const focusSearch = useCallback(() => {
    requestAnimationFrame(() => {
      if (active.startsWith('repository:')) repositoryFilters.current.get(active.slice(11))?.focus();
    });
  }, [active]);
  useEffect(() => {
    function keydown(event) {
      if (dialog || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); setConsoleOpen(value => !value); }
      if (key === ',') { event.preventDefault(); setDialog('Settings'); }
      if (key === 't') { event.preventDefault(); openEmpty(); }
      if (key === 'f' && active.startsWith('repository:')) { event.preventDefault(); focusSearch(); }
      if (key === 'w') {
        event.preventDefault();
        if (active === 'new') { setEmptyOpen(false); if (sandboxId) setActive(`repository:${sandboxId}`); }
        else if (repositoryActive && active.slice(11) === sandboxId) void demoVisibleRef.current(false);
        else if (repositoryActive) {
          const id = active.slice(11);
          setClosedTabs(current => new Set(current).add(id));
          const remaining = (workspace?.repositories || []).filter(item => item.id !== id && !closedTabs.has(item.id));
          setActive(remaining[0] ? `repository:${remaining[0].id}` : sandboxId ? `repository:${sandboxId}` : 'new');
          if (!remaining[0] && !sandboxId) setEmptyOpen(true);
        }
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, active, repositoryActive, sandboxId, workspace, closedTabs, focusSearch]);

  // Restarting ends whatever Git runs: wait for the running action first.
  const updateBusy = syncing ? `Wait for ${syncing} to finish` : undoMoving ? 'Wait for Undo to finish' : dialogBusy || resetting ? 'Wait for the action to finish' : undefined;
  const updateAction = toolbarUpdate(update);
  const UpdateIcon = updateAction?.icon === 'restart' ? RotateCw : updateAction?.icon === 'progress' ? LoaderCircle : Download;
  const updateButton = updateAction && <Button className={`update-button ${updateAction.action === 'settings' || !updateAction.action ? '' : 'primary'} ${updateAction.icon === 'progress' ? 'working' : ''}`}
    icon={UpdateIcon} title={updateAction.title}
    reason={!updateAction.action ? updateAction.title : updateAction.action === 'install' ? updateBusy : undefined}
    onClick={() => { if (updateAction.action === 'settings') setDialog('Settings'); else void runUpdate(updateAction.action); }}>{updateAction.label}</Button>;
  const updateRunning = ['downloading', 'preparing'].includes(update?.status);

  return <div className="app-shell">
    <header className="tab-bar"><div className="brand"><img className="brand-logo" src="./twig-logo.png" alt="" width="36" height="36" /><strong>🌱 Twig</strong></div>
      <nav className="tabs" aria-label="Repository tabs" ref={tabsRef} onWheel={scrollTabs}>
        {workspace?.repositories.filter(item => !closedTabs.has(item.id)).map(item => <div key={item.id} className={`tab ${active === `repository:${item.id}` ? 'active' : ''}`}><button aria-current={active === `repository:${item.id}` ? 'page' : undefined} onClick={() => selectRepository(item.id)}><GitBranch /><span>{item.name}</span>{item.sandbox ? <small>DEMO</small> : !item.available && <small>OFFLINE</small>}</button><Button icon={X} aria-label={`Close ${item.name} tab`} title={item.sandbox ? `Close the demo workspace · ${mod}+W` : `${mod}+W`} onClick={() => { if (item.sandbox) void setDemoVisible(false); else closeRepositoryTab(item.id); }} /></div>)}
        {emptyOpen && <div className={`tab ${active === 'new' ? 'active' : ''}`}><button aria-current={active === 'new' ? 'page' : undefined} onClick={() => setActive('new')}><FolderOpen />New repository</button><Button icon={X} aria-label="Close new tab" onClick={() => { setEmptyOpen(false); if (sandboxId) setActive(`repository:${sandboxId}`); }} /></div>}
        <Button icon={Plus} aria-label="New repository tab" title={`${mod}+T`} onClick={openEmpty} />
      </nav>
      <div className="account-actions">{updateButton}<Button icon={Settings} aria-label="Settings" title={`Settings · ${mod}+,`} onClick={() => setDialog('Settings')} /><Button icon={UserRound} aria-label="Git profile" title="Git profile" onClick={() => setDialog('Git profile')} /></div>
    </header>
    <section className="toolbar" aria-label="Git actions">
      <div className="repo-select"><label htmlFor="repository-select">REPOSITORY</label><select id="repository-select" value={active} onChange={(e) => { const { value } = e.target; if (value === 'new') openEmpty(); else void selectRepository(value.slice(11)); }}>{workspace?.repositories.map(item => <option key={item.id} value={`repository:${item.id}`}>{item.name}</option>)}<option value="new">Open repository…</option></select></div>
      <div className="branch-select"><span>CURRENT BRANCH</span><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : unavailable} onClick={focusSearch}>{repositoryActive ? repository?.status?.branch?.name || (repository?.status?.branch?.detached ? 'Detached HEAD' : 'Unavailable') : 'main'}<ChevronDown /></Button></div>
      <div className="tool-group"><Button className="tool" icon={Undo2} title={`${undoState.undoReason} · ${mod}+Z`} reason={undoMoving ? 'Reversing the action…' : !repositoryActive ? unavailable : !undoState.undo ? undoState.undoReason : undefined} onClick={() => moveUndo('undo')}>Undo</Button><Button className="tool" icon={Redo2} title={`${undoState.redoReason} · ${mod}+Shift+Z`} reason={undoMoving ? 'Reversing the action…' : !repositoryActive ? unavailable : !undoState.redo ? undoState.redoReason : undefined} onClick={() => moveUndo('redo')}>Redo</Button></div>
      <div className="tool-group">
        <Button className="tool" icon={ArrowDown} onClick={() => runSync('pull')} title={repositoryActive ? pullTitle(fetchStatus) : undefined}
          reason={syncReason || (divergence.upstream ? undefined : 'Pull: this branch has no upstream')}>
          Pull{divergence.behind > 0 && <span className="badge">{divergence.behind}</span>}</Button>
        <Button className="tool" icon={ArrowUp} onClick={() => runSync(divergence.upstream ? 'push' : 'push-upstream')}
          reason={syncReason || (!divergence.upstream && !branchName ? 'Push: no branch to publish' : undefined)}>
          {divergence.upstream ? 'Push' : 'Publish'}{divergence.ahead > 0 && <span className="badge">{divergence.ahead}</span>}</Button>
        {syncing && <Button className="tool" onClick={() => window.twig.cancelSync(repository.id)}>Cancel</Button>}
      </div>
      <div className="tool-group"><Button className="tool" icon={GitBranch} reason={unavailable}>Branch</Button>
        <Button className="tool" icon={Layers} onClick={() => runStash('stash')} reason={syncReason}>Stash</Button>
        <Button className="tool" icon={Upload} onClick={() => runStash('pop')}
          reason={syncReason || (stashCount === 0 ? 'Pop: there are no stashes to restore' : undefined)}>Pop</Button></div>
      {/* The console lives at the bottom of the window and opens from its own
          status bar (or {mod}+J); a second switch in the toolbar only took room. */}
      <div className="tool-group">
        <span className="bughunter-tool-slot" ref={setBugHunterSlot}>
          {!workspace?.repositories.some(item => item.available && active === `repository:${item.id}`) &&
            <Button className="tool bughunter-tool" icon={Bug} reason={unavailable}>BugHunter</Button>}
        </span>
        <Button className={`tool mcp-tool ${mcpSettings?.enabled ? 'mcp-on' : ''}`} icon={Bot} title={mcpToolTitle(mcpSettings)} aria-label={mcpToolTitle(mcpSettings)}
          onClick={() => setDialog('AI agents (MCP)')}>MCP{mcpSettings?.enabled && <span className="tool-dot" aria-hidden="true" />}</Button>
      </div>
    </section>
    {startupError && <div className="startup-error" role="status">{startupError}</div>}
    {syncNote && <div className="sync-note" role="status"><span>{syncNote}</span><button onClick={() => setSyncNote('')} aria-label="Dismiss">×</button></div>}
    {!ready && <div className="loading-shell" aria-label="Loading workspace" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>}
    {ready && <div className="workspace-container">
      {workspace?.repositories.map(item => <div className="workspace-tab" key={item.id} hidden={active !== `repository:${item.id}`}>
        {/* A real repository tab mounts the first time it is shown and then
            stays mounted, so switching back keeps its DOM; a closed tab is not
            mounted at all. The always-present demo tab mounts only while active,
            so its graph never collides with another tab's. */}
        {(item.sandbox ? active === `repository:${item.id}` : !closedTabs.has(item.id) && (visited.has(item.id) || active === `repository:${item.id}`)) && (item.available
          ? <HistoryWorkspace repository={item} active={active === `repository:${item.id}`} mod={mod} referencesRevision={remoteRevisions[item.id] || 0} commitColors={commitColors} platform={info?.platform} editor={editor?.label} toolbarSlot={bugHunterSlot} toolbarBusyReason={syncing ? `${syncing} is running` : undoMoving ? 'Reversing the action…' : undefined}
            filterRef={filterRefFor(item.id)}
            onConsole={showConsole} onRepositoryChanged={refreshRepository} onOpenWorkspace={openWorkspaceTab} onWorkspace={updateWorkspace} />
          : <RepositoryReady repository={item} onOpen={openRepository} />)}
      </div>)}
      {active === 'new' && <main className="welcome"><div className="welcome-mark"><img src="./twig-logo.png" alt="" width="96" height="96" /></div><span className="eyebrow">YOUR NEXT WORKSPACE</span><h1>A clear view of your code.</h1><p>Open a folder, clone a repository, or choose one you have connected.</p><div className="welcome-actions"><Button icon={FolderOpen} className="primary" onClick={openRepository}>Open repository</Button><Button icon={ArrowDown} onClick={() => setDialog('Clone repository')}>Clone repository</Button><Button icon={GitBranch} onClick={() => setDialog('Repositories')}>Connected repositories</Button></div><div className="welcome-demo"><span className="demo-pill">DEMO</span><p>The <strong>workspace-demo</strong> tab is a real sandbox repository — every command runs against it.</p>{sandboxId
        ? <Button icon={GitBranch} className="primary" onClick={() => setActive(`repository:${sandboxId}`)}>Open workspace-demo</Button>
        : <Button icon={GitBranch} className="primary" onClick={() => setDemoVisible(true)}>Show workspace-demo</Button>}</div></main>}
    </div>}
    <Console expanded={consoleOpen} onToggle={() => setConsoleOpen(!consoleOpen)} mod={mod} entries={entries} focus={consoleFocus}
      repositoryId={workspace?.repositories.find(item => item.available && active === `repository:${item.id}`)?.id || null} />
    {dialog && <Dialog title={dialog} wide={['Git profile', 'Repositories', 'Clone repository', 'Remotes', 'SSH', 'AI agents (MCP)'].includes(dialog)} closeReason={dialogBusy || resetting ? 'Wait for the action to finish or cancel it first' : undefined} onClose={() => setDialog(null)}>
      {dialog === 'Settings' && <><p className="muted">Make this workspace feel like yours.</p>
        <label className="setting-row" htmlFor="theme"><span><strong>Appearance</strong><small>System follows your device setting.</small></span><select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <label className="setting-row" htmlFor="commit-colors"><span><strong>Commit colors</strong><small>Age shades the graph and the dates from brown roots to green new work.</small></span><select id="commit-colors" value={commitColors} onChange={(e) => setCommitColors(e.target.value)}><option value="age">Commit age</option><option value="lanes">Branch lanes</option></select></label>
        {commitColors === 'age' && <ul className="age-legend" aria-label="Commit age colors">{AGE_STOPS.map((stop, index) => <li key={stop.key} className={ageTextClass(index)}>{stop.label}</li>)}</ul>}
        <label className="setting-row" htmlFor="syntax"><span><strong>Syntax highlighting</strong><small>Colours code by file type in diffs, staging and blame. Lines / Words is switched above each diff.</small></span>
          <select id="syntax" value={diffPrefs.syntax ? 'on' : 'off'} onChange={(e) => setDiffPrefs({ syntax: e.target.value === 'on' })}><option value="on">On</option><option value="off">Off</option></select></label>
        {editor && <div className="setting-row"><label htmlFor="editor"><strong>Open files with</strong><small className="editor-path">{
          editor.preset === 'custom' ? editor.customPath
            : editor.preset === 'system' ? (info?.platform === 'darwin' ? 'Your default text editor. Used by “Open in editor” in file menus.'
              : 'The app your system opens that file type with. Program files are refused.')
              : 'Used by “Open in editor” in file menus.'}</small></label>
          <span className="setting-controls"><select id="editor" value={editor.preset} onChange={(e) => void chooseEditor(e.target.value)}>
            {editor.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.id === 'custom' && editor.preset === 'custom' ? editor.label : preset.label}</option>)}
          </select>{editor.preset === 'custom' && <Button onClick={() => void chooseEditor('custom')}>Choose…</Button>}</span></div>}
        {editorError && <p className="update-note" role="alert">{editorError}</p>}
        {fetchSettings && <label className="setting-row" htmlFor="background-fetch"><span><strong>Background fetch</strong>
          <small>{fetchExplanation(fetchSettings.interval)}</small>
          {fetchSettings.interval > 0 && repositoryActive && fetchStatus && <small className="fetch-status" role="status">{repository?.name}: {fetchStatusLine(fetchStatus)}</small>}</span>
          <select id="background-fetch" value={fetchSettings.interval} onChange={(e) => void chooseFetchInterval(Number(e.target.value))}>
            {fetchSettings.intervals.map(minutes => <option key={minutes} value={minutes}>{intervalLabel(minutes)}</option>)}
          </select></label>}
        {fetchError && <p className="update-note" role="alert">{fetchError}</p>}
        <div className="setting-row"><span><strong>Updates</strong><small>🌱 Twig {info?.version || '…'}. A new version downloads from GitHub, is checked against the release checksum and replaces this one when you restart.</small></span>
          <Button icon={RefreshCw} reason={update?.status === 'checking' ? 'Checking…' : updateRunning || update?.status === 'installing' ? 'An update is already in progress' : undefined} onClick={() => void runUpdate('check')}>Check for updates</Button></div>
        {update && <label className="setting-row" htmlFor="update-auto"><span><strong>Check automatically</strong><small>{autoCheckExplanation(update.auto)}</small></span>
          <select id="update-auto" value={update.auto ? 'on' : 'off'} onChange={(e) => void chooseAutoUpdate(e.target.value === 'on')}><option value="off">Only when I ask</option><option value="on">At launch and daily</option></select></label>}
        {update && updateStatusLine(update) && <div className="update-panel" role="status">
          <p className="update-note">{updateStatusLine(update)}{update.url && <> <a className="text-link" href={update.url} rel="noreferrer">Release on GitHub</a></>}</p>
          {update.status === 'downloading' && <progress className="update-progress" max="100" value={percent(update.progress)} aria-label={`Downloading ${update.latest}`} />}
          <div className="update-actions">
            {update.status === 'available' && update.installable && !update.installReason && <Button className="primary" icon={Download} onClick={() => void runUpdate('download')}>{update.error ? 'Try again' : `Download and install ${update.latest}`}</Button>}
            {update.status === 'downloading' && <Button onClick={() => void runUpdate('cancel')}>Cancel download</Button>}
            {update.status === 'ready' && <Button className="primary" icon={RotateCw} reason={updateBusy} onClick={() => void runUpdate('install')}>{installVerb(update)}</Button>}
          </div>
          {update.notes && ['available', 'downloading', 'preparing', 'ready'].includes(update.status) && <details className="update-notes"><summary>What’s new in {update.latest}</summary><pre>{update.notes}</pre></details>}
        </div>}
        {updateError && <p className="update-note" role="alert">{updateError}</p>}
        <div className="settings-note">🌱 Twig {info?.version || '…'}<br />Local fonts. No telemetry. Updates install only when you press the button.</div></>}
      {dialog === 'Settings' && <div className="manager-actions"><Button icon={FolderOpen} onClick={() => setDialog('Repositories')}>Manage repositories</Button><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : 'Open a repository first'} onClick={() => setDialog('Remotes')}>Manage remotes</Button></div>}
      {dialog === 'Settings' && <Button onClick={() => setDialog('SSH')}>SSH keys and config</Button>}
      {dialog === 'Settings' && <div className="setting-row"><span><strong>AI agents (MCP)</strong><small>{mcpSummary(mcpSettings)}</small></span><Button icon={Bot} onClick={() => setDialog('AI agents (MCP)')}>Set up AI agents</Button></div>}
      {dialog === 'Settings' && (sandboxId
        ? <div className="setting-row"><span><strong>Demo workspace</strong><small>Restore the <strong>workspace-demo</strong> sandbox to its sample history.</small></span><Button icon={RefreshCw} onClick={() => setDialog('Reset demo workspace')}>Reset demo workspace</Button></div>
        : <div className="setting-row"><span><strong>Demo workspace</strong><small>The <strong>workspace-demo</strong> tab is closed. Its sandbox is still on disk — showing it again opens the same repository.</small></span><Button icon={GitBranch} onClick={() => setDemoVisible(true)}>Show demo workspace</Button></div>)}
      {dialog === 'Reset demo workspace' && <div className="confirm-dialog">
        <p className="confirm-consequence"><AlertTriangle aria-hidden="true" /><span>Deletes the <strong>workspace-demo</strong> sandbox and its local demo remote, then recreates them with the sample history.</span></p>
        <ul>
          <li>Any commits, branches, stashes or edits you made in the demo are discarded.</li>
          <li>The demo’s Undo history ends and its commit marks are cleared.</li>
          <li>Your own connected repositories and automation pipelines are not touched.</li>
        </ul>
        <div className="dialog-actions"><Button onClick={() => setDialog('Settings')} reason={resetting ? 'Resetting…' : undefined}>Cancel</Button><Button className="danger" icon={RefreshCw} onClick={resetDemo} reason={resetting ? 'Resetting the demo workspace…' : undefined}>Reset demo workspace</Button></div>
      </div>}
      {dialog === 'AI agents (MCP)' && <McpSettings onBusyChange={setDialogBusy} onChange={setMcpSettings} />}
      {dialog === 'SSH' && <SshSettings entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} />}
      {dialog === 'Git profile' && <GitProfile repository={repositoryActive ? repository : null} onConsole={() => { setDialog(null); showConsole(); }} />}
      {dialog === 'Repositories' && <Repositories workspace={workspace} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onOpen={async () => { await openRepository(); setDialog(null); }} onClone={() => setDialog('Clone repository')} />}
      {dialog === 'Clone repository' && <CloneRepository entries={entries} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} />}
      {dialog === 'Remotes' && repository && <Remotes repository={repository} entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onChanged={async () => {
        await refreshRepository();
        setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      }} />}
    </Dialog>}
    {proposal && <CommitProposalDialog key={proposal.id} view={proposal} running={proposalRun.running} step={proposalRun.step} failure={proposalRun.failure} invalid={proposalRun.invalid}
      onDecide={decision => void decideProposal(decision)} onClose={() => { setProposal(null); setProposalRun({ running: false, step: null, failure: '' }); }} />}
    {pushGate && <ExecutionPanel event="pre-push" label="Before Push" phase="pre" steps={pushGate.steps} result={pushGate.result}
      blocked={pushGate.blocked} onClose={() => closePushGate(false)} onRetry={() => closePushGate(false)}
      onRunAgain={() => runPushGate()} onBypass={() => closePushGate(false, true)} />}
  </div>;
}

function RepositoryReady({ repository, onOpen }) {
  if (!repository) return null;
  const status = repository.status;
  return <main className="repository-ready"><GitBranch /><span className="eyebrow">CONNECTED REPOSITORY</span><h1>{repository.name}</h1><p className="repository-path">{repository.path}</p>
    {!repository.available && <><strong>Repository is unavailable.</strong><p>It may have moved or been removed. Choose its current location to reconnect it.</p><Button icon={FolderOpen} className="primary" onClick={onOpen}>Open repository</Button></>}
    {repository.available && status?.error && <><strong>{status.error}</strong><p>Open the console to see the exact Git command and output.</p></>}
    {repository.available && status?.branch && <><strong>{status.branch.detached ? 'Detached HEAD' : status.branch.name || 'Unborn branch'}</strong><p>{status.entries.length} changed file{status.entries.length === 1 ? '' : 's'}</p></>}
  </main>;
}
