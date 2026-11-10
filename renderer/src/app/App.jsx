import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, Bot, Bug, Download, FileInput, FolderOpen, FolderSearch, GitBranch, Keyboard, KeyRound, LoaderCircle, Redo2, RefreshCw, RotateCw, Settings, Trash2, Undo2, UserRound, X } from 'lucide-react';
import { StashPop, StashPush } from '../ui/stash-icons.js';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import ErrorBoundary from '../ui/ErrorBoundary.jsx';
import OperationNote, { NoteRegion } from '../ui/OperationNote.jsx';
import { Console } from './Console.jsx';
import TabStrip from './TabStrip.jsx';
import { noteFor, placeNote } from './tab-notes.js';
import { modalOpen } from '../ui/modal-open.js';
import { matchesShortcut } from './shortcuts.js';
import ShortcutsSettings from '../features/settings/ShortcutsSettings.jsx';
import { pickFailedEntry } from './console-focus.js';
import { CONSOLE_FLUSH_MS, applyConsoleUpdates } from './console-entries.js';
import { keepUnchangedRepositories } from './workspace-identity.js';
import { moveClosedTab, readClosedTabs, startRepositoryId, writeClosedTabs } from './closed-tabs.js';
import { PULL_COMMANDS, needsPullChoice, syncOutcome } from './sync-view.js';
import { fetchExplanation, fetchStatusLine, intervalLabel, pullTitle } from './background-fetch-view.js';
import { autoCheckExplanation, installVerb, percent, toolbarUpdate, updateStatusLine } from './update-view.js';
import HistoryWorkspace from '../features/graph/HistoryWorkspace.jsx';
import { mcpSummary, mcpToolTitle } from '../features/settings/mcp-view.js';
import { moveCommitDraft } from '../features/worktree/commit-draft.js';
import { ConfirmDialog } from '../features/ops/dialogs.jsx';
import useDiffPrefs from '../features/diff/useDiffPrefs.js';
import ExecutionPanel from '../features/automations/ExecutionPanel.jsx';
import { outcomeNote } from '../features/proposal/proposal-view.js';
import { AGE_STOPS, ageTextClass } from '../features/graph/age-color.js';
import lazyScreen from '../ui/lazy-screen.jsx';
import { BRAND, LANGUAGES, failureText, mark, t, tn, tr } from '../i18n/i18n.js';
import { tx } from '../i18n/rich.js';
import { changeLanguage, languageChoice, systemLanguage, takeReopenSettings } from '../i18n/load.js';
import { syncRunning, syncWait } from './sync-words.js';

// Opened rarely: loaded the first time they are shown, not with the window.
const GitProfile = lazyScreen(() => import('../features/settings/GitProfile.jsx'));
const Repositories = lazyScreen(() => import('../features/settings/Repositories.jsx'));
const CloneRepository = lazyScreen(() => import('../features/settings/CloneRepository.jsx'));
const Remotes = lazyScreen(() => import('../features/settings/Remotes.jsx'));
const SshSettings = lazyScreen(() => import('../features/settings/SshSettings.jsx'));
const McpSettings = lazyScreen(() => import('../features/settings/McpSettings.jsx'));
const CommitProposalDialog = lazyScreen(() => import('../features/proposal/CommitProposalDialog.jsx'));

const UNAVAILABLE = mark('Connect a repository to use this action');
// What `dialog` holds: an English name compared in code and shown, translated, as the title.
const DIALOG_TITLES = [mark('Settings'), mark('Git profile'), mark('Repositories'), mark('Clone repository'), mark('Remotes'),
  mark('SSH'), mark('AI agents (MCP)'), mark('Keyboard shortcuts'), mark('Reset demo workspace'), mark('Close tab'), mark('Pull'), mark('Publish')];
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
  const [repoToolsSlot, setRepoToolsSlot] = useState(null);
  // A click on the branch under CURRENT BRANCH, for the open repository to show its HEAD.
  const [headRequest, setHeadRequest] = useState({ id: null, seq: 0 });
  // The Branch button, and Refresh from the keyboard, for the open repository to act on.
  const [branchRequest, setBranchRequest] = useState({ id: null, seq: 0 });
  const [refreshRequest, setRefreshRequest] = useState({ id: null, seq: 0 });
  const [refreshSlot, setRefreshSlot] = useState(null);
  const [dialog, setDialog] = useState(() => (takeReopenSettings() ? 'Settings' : null));
  const [language, setLanguage] = useState(languageChoice);
  const [languageError, setLanguageError] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  // The tab the 'Close tab' dialog asks about: { id, name, sandbox }.
  const [closeTarget, setCloseTarget] = useState(null);
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
  const [journalCleared, setJournalCleared] = useState(false);
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
  // Git on this computer, read at launch: without it there is nothing to show but how to get it.
  const [gitState, setGitState] = useState(null);
  const [gitChecking, setGitChecking] = useState(false);
  // A folder with no repository the person may start one in, and the Push with lease to confirm.
  const [initPlan, setInitPlan] = useState(null);
  const [leasePush, setLeasePush] = useState(null);
  // Where a missing repository turned out to be, for the person to confirm.
  const [locatePlan, setLocatePlan] = useState(null);
  // What the Clone dialog was holding: Show output closes it to reach the console.
  const [cloneDraft, setCloneDraft] = useState(null);
  const [publishRemotes, setPublishRemotes] = useState([]);
  const [divergence, setDivergence] = useState({ ahead: 0, behind: 0, upstream: null });
  const [stashCount, setStashCount] = useState(null);
  const [syncing, setSyncing] = useState(null);
  // By repository id: a failed push stays on its own tab. See tab-notes.js.
  const [syncNotes, setSyncNotes] = useState({});
  const setSyncNote = useCallback((note, id = '') => setSyncNotes(current => placeNote(current, id, note)), []);
  // The stack above the console where notes after an action rise from.
  const [noteRegion, setNoteRegion] = useState(null);
  const [pushGate, setPushGate] = useState(null);
  const pushGateResolve = useRef(null);
  const [worktreeVersion, setWorktreeVersion] = useState(0);
  const [remoteRevisions, setRemoteRevisions] = useState({});
  const [closedTabs, setClosedTabs] = useState(() => { try { return readClosedTabs(localStorage); } catch { return new Set(); } });
  const [undoState, setUndoState] = useState({ undo: false, redo: false, undoReason: mark('No application actions to undo.'), redoReason: mark('No next action.') });
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
  const selectionRequest = useRef(0);
  const divergenceRequest = useRef(0);
  const stashRequest = useRef(0);
  const unavailable = t(UNAVAILABLE);
  const ready = (info !== null && workspace !== null) || Boolean(startupError);
  const repository = workspace?.repositories.find(item => active === `repository:${item.id}`)
    || workspace?.repositories.find(item => item.id === workspace.activeId) || null;
  const sandboxId = workspace?.repositories.find(item => item.sandbox)?.id || null;
  const repositoryActive = active.startsWith('repository:');

  useEffect(() => {
    let alive = true;
    if (!window.twig) { setStartupError(t('Browser preview. Launch the desktop app with npm run dev.')); return; }
    // The window opens before every repository is read: the rest arrives here.
    // Whatever came ahead of the first answer is newer than it.
    let newer = null;
    let started = false;
    const unsubscribeWorkspace = window.twig.onWorkspaceUpdate(next => {
      if (!alive) return;
      if (started) setWorkspace(next); else newer = next;
    });
    Promise.all([window.twig.getAppInfo(), window.twig.getWorkspace(), window.twig.getConsoleEntries()])
      .then(([appInfo, { git, ...initialWorkspace }, initialEntries]) => {
        if (!alive) return;
        started = true;
        setInfo(appInfo); setWorkspace(newer || initialWorkspace); setGitState(git);
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
        // The window is up before this answer: a tab opened meanwhile stays.
        if (startId) setActive(current => current || `repository:${startId}`);
        else { setEmptyOpen(true); setActive(current => current || 'new'); }
      })
      .catch(() => { if (alive) setStartupError(t('Desktop connection unavailable. Restart 🌱 Twig.')); });
    window.twig.getEditor().then(value => { if (alive) setEditor(value); }).catch(() => {});
    window.twig.getBackgroundFetch().then(value => { if (alive) setFetchSettings(value); }).catch(() => {});
    window.twig.getUpdateState().then(value => { if (alive) setUpdate(value); }).catch(() => {});
    const unsubscribeUpdate = window.twig.onUpdateState(value => { if (alive) setUpdate(value); });
    const unsubscribe = window.twig.onConsoleUpdate((update) => {
      if (!alive) return;
      pendingConsole.current.push(update);
      if (!consoleTimer.current) consoleTimer.current = setTimeout(flushConsole, CONSOLE_FLUSH_MS);
    });
    return () => { alive = false; unsubscribe(); unsubscribeUpdate(); unsubscribeWorkspace(); clearTimeout(consoleTimer.current); };
  }, [flushConsole, setWorkspace]);
  // "Other application…" opens a native picker in main; cancelling it leaves
  // the previous choice in place, which is what comes back.
  const chooseEditor = useCallback(async (preset) => {
    setEditorError('');
    try { setEditor(await window.twig.setEditor(preset)); }
    catch { setEditorError(t('Could not save the editor choice.')); }
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
    catch { setFetchError(t('Could not save the background fetch choice.')); }
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

  // A run the person cancelled stays cancelled: its answer, when it comes, must
  // not bring the panel back or let the push go ahead.
  const pushGateRun = useRef(0);
  function runPushGate(remote = null) {
    return new Promise(resolve => {
      pushGateResolve.current = resolve;
      const run = ++pushGateRun.current;
      const finish = () => { setPushGate(null); pushGateResolve.current = null; resolve(true); };
      setPushGate({ steps: [], result: null, blocked: false, remote });
      window.twig.runAutomation(repository.id, 'pre-push', { remote, branch: branchName })
        .then(result => {
          if (run !== pushGateRun.current) return;
          if (result.ran === false) { finish(); return; }
          setPushGate({ steps: result.steps, result: result.blocked ? 'blocked' : result.ok ? 'passed' : 'failed', blocked: result.blocked, remote });
          if (!result.blocked) setTimeout(() => { if (run === pushGateRun.current) finish(); }, result.ok ? 900 : 1600);
        })
        .catch(() => { if (run === pushGateRun.current) finish(); });
    });
  }
  function closePushGate(proceed, bypass = false) {
    const resolve = pushGateResolve.current;
    pushGateResolve.current = null;
    pushGateRun.current++;
    if (bypass) void window.twig.runAutomation(repository.id, 'pre-push', { bypass: true }).catch(() => {});
    setPushGate(null);
    resolve?.(proceed || bypass);
  }
  /** Stopping the checks stops the push: nothing runs afterwards, and the note says so. */
  function cancelPushGate() {
    void window.twig.cancelAutomation(repository.id).catch(() => {});
    closePushGate(false);
    setSyncNote(t('The checks were stopped, so the push did not run.'));
  }

  async function runSync(mode, remote = null) {
    if (!repository) return;
    if (['push', 'push-upstream', 'push-force'].includes(mode) && !await runPushGate(remote)) return;
    const { id, name } = repository;
    setSyncing(mode); setSyncNote('', id);
    try {
      const result = await window.twig.runSync(repository.id, mode, branchName, remote);
      setSyncNote(syncNoteFor(result, mode), id);
      const next = await window.twig.selectRepository(repository.id);
      setWorkspace(next);
      setWorktreeVersion(value => value + 1);
    } catch (error) {
      setSyncNote({ text: t`${name}: ${failureText(error, t('The operation failed.'))}`, failed: true }, id);
    } finally { setSyncing(null); }
  }
  useEffect(() => { if (dialog !== 'Settings') setJournalCleared(false); }, [dialog]);
  async function clearJournal() {
    await window.twig.clearConsole();
    setJournalCleared(true);
  }
  /** The words of `syncOutcome` with its modes turned into buttons. */
  function syncNoteFor(result, mode) {
    const outcome = syncOutcome(result, { mode, branch: branchName, upstream: divergence.upstream });
    if (typeof outcome === 'string') return outcome;
    const note = { ...outcome, text: t`${repository.name}: ${outcome.text}` };
    if (!note.actions) return note;
    const labels = { 'pull-rebase': t('Pull with rebase'), 'pull-merge': t('Pull and merge'), 'push-force': t('Push with lease…') };
    return { ...note, actions: note.actions.map(action => ({ label: labels[action],
      run: () => (action === 'push-force' ? setLeasePush({ command: result.refusal.lease }) : void runSync(action)) })) };
  }
  function pull() {
    if (needsPullChoice(divergence)) setDialog('Pull'); else void runSync('pull');
  }
  /** A branch goes to the one remote there is; with several the person says which, with none they add one. */
  async function publish() {
    let remotes;
    try { remotes = (await window.twig.getRemotes(repository.id)).map(item => item.name); }
    catch (error) { setSyncNote({ text: failureText(error, t('Could not read the remotes.')), failed: true }, repository.id); return; }
    if (remotes.length === 1) { void runSync('push-upstream', remotes[0]); return; }
    if (remotes.length === 0) {
      setSyncNote({ text: t('This repository has no remote yet. Add one, then publish.'), actions: [{ label: t('Add remote…'), run: () => setDialog('Remotes') }] }, repository.id);
      return;
    }
    setPublishRemotes(remotes);
    setDialog('Publish');
  }
  async function runStash(action) {
    if (!repository) return;
    const { id, name } = repository;
    setSyncing(action); setSyncNote('', id);
    const reread = async () => {
      setWorkspace(await window.twig.selectRepository(repository.id));
      setWorktreeVersion(value => value + 1);
    };
    try {
      const saved = action === 'stash' ? await window.twig.stashPush(repository.id, true, '') : await window.twig.stashPop(repository.id);
      setSyncNote(action !== 'stash' ? t('Stash popped.') : saved ? t('Changes stashed.') : t('There was nothing to stash.'), id);
      await reread();
    } catch (error) {
      setSyncNote({ text: t`${name}: ${failureText(error, t('The operation failed.'))}`, failed: true }, id);
      // A pop that stopped on a conflict changed the files all the same.
      await reread().catch(() => {});
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
    } catch { setUpdateError(t('The update could not run. Restart 🌱 Twig and try again.')); }
  }
  async function chooseAutoUpdate(value) {
    setUpdateError('');
    try { setUpdate(await window.twig.setAutoUpdateCheck(value)); }
    catch { setUpdateError(t('Could not save the update setting.')); }
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
      setSyncNote(t('Demo workspace reset to its sample history.'));
    } catch (error) {
      setSyncNote({ text: failureText(error, t('Could not reset the demo workspace.')), failed: true });
    } finally { setResetting(false); }
  }

  /**
   * Closing the demo tab is remembered across restarts — a closed demo costs
   * nothing on startup — and it deletes nothing: showing it again reopens the
   * same sandbox with its history intact.
   */
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
        setSyncNote(t('Demo workspace closed. Settings brings it back.'));
      }
    } catch (error) {
      setSyncNote({ text: failureText(error, t('Could not change the demo workspace.')), failed: true });
    }
  }


  const syncReason = !repositoryActive || !repository?.available ? unavailable
    : syncing ? syncRunning(syncing) : undefined;
  const unbornBranch = Boolean(repository?.status?.branch) && !repository.status.branch.oid;
  const statusEntries = repository?.status?.entries || [];
  const stashReason = syncReason
    || (unbornBranch ? t('Stash: make the first commit first') : undefined)
    || (statusEntries.some(entry => entry.kind === 'unmerged') ? t('Stash: resolve the conflicts first') : undefined)
    || (!statusEntries.some(entry => entry.kind !== 'ignored') ? t('Stash: there is nothing to put away') : undefined);

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
      // The proposal on screen again, with a new count of others waiting: only the count changes.
      if (view && proposalRef.current?.id === view.id) {
        setProposal(current => (current?.id === view.id ? { ...current, waiting: view.waiting } : current));
        return;
      }
      // null is main closing it (answered elsewhere, superseded), another is the next in line.
      // While this window is committing it, or showing why that failed, the dialog stays:
      // closing it asks main for whatever comes next.
      const held = proposalRunRef.current.running || Boolean(proposalRunRef.current.failure);
      if (held) return;
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
  const proposalRef = useRef(proposal);
  proposalRef.current = proposal;
  /** Closes the dialog and shows the next proposal in line, from another worktree, if there is one. */
  function closeProposal() {
    setProposal(null);
    setProposalRun({ running: false, step: null, failure: '' });
    window.twig.getCommitProposal().then(next => { if (next) setProposal(next); }).catch(() => {});
  }
  async function decideProposal(decision) {
    if (!proposal) return;
    if (decision.action !== 'cancel') setProposalRun({ running: true, step: null, failure: '' });
    try {
      const answer = await window.twig.decideCommitProposal(proposal.id, decision);
      if (answer.stale) { setProposal(answer.stale); setProposalRun({ running: false, step: null, failure: '' }); return; }
      // A tag that cannot be made (it exists, a bad name): the dialog stays open to fix it.
      if (answer.invalid) { setProposalRun({ running: false, step: null, failure: '', invalid: answer.invalid }); return; }
      if (decision.action === 'cancel') { closeProposal(); return; }
      if (answer.ok) {
        closeProposal();
        setSyncNote(outcomeNote(answer.outcome));
      } else {
        setProposalRun({ running: false, step: null, failure: answer.outcome });
      }
    } catch (error) {
      setProposalRun({ running: false, step: null, failure: failureText(error, t('The proposal could not be answered.')) });
    }
    if (decision.action !== 'cancel') void refreshRepository();
  }
  useEffect(() => {
    // A repository not read yet has nothing to verify: this runs again once it has been.
    if (!repositoryActive || !repositoryId || !repository?.available) return;
    let alive = true; let generation = 0;
    const refresh = () => {
      const current = ++generation;
      window.twig.getUndoState(repositoryId).then(state => { if (alive && current === generation) setUndoState(state); })
        .catch(() => { if (alive && current === generation) setUndoState({ undo: false, redo: false, undoReason: mark('Could not verify the repository.'), redoReason: mark('Could not verify the repository.') }); });
    };
    refresh();
    const unsubscribe = window.twig.onUndoUpdate(update => { if (update.cwd === repositoryId) refresh(); });
    window.addEventListener('focus', refresh);
    return () => { alive = false; unsubscribe(); window.removeEventListener('focus', refresh); };
  }, [repositoryId, repositoryActive, repository?.available, worktreeVersion]);
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
    setUndoMoving(true); setSyncNote('', repositoryId);
    try {
      const result = await window.twig.moveUndo(repositoryId, direction);
      // The graph starts reading right away, alongside the status below.
      setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      await refreshRepository();
      setSyncNote(direction === 'undo' ? (result.cancelled ? t('Undo cancelled.') : t('Undo completed.'))
        : (result.cancelled ? t('Redo cancelled.') : t('Redo completed.')), repositoryId);
    }
    catch (failure) {
      setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      setSyncNote({ text: failureText(failure, t('The action could not be reversed.')), failed: true }, repositoryId);
    }
    finally { setUndoMoving(false); }
  }, [repositoryActive, repositoryId, refreshRepository, undoMoving, setSyncNote]);
  useEffect(() => {
    const keydown = event => {
      const direction = matchesShortcut(event, 'redo') ? 'redo' : matchesShortcut(event, 'undo') ? 'undo' : null;
      if (dialog || !direction || modalOpen() || event.target.closest('input, textarea, [contenteditable="true"]')) return;
      event.preventDefault();
      if (undoState[direction]) void moveUndo(direction);
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, moveUndo, undoState]);

  // Pressing Refresh from the keyboard: main turns the page-reload key into this.
  const activeRef = useRef(null);
  activeRef.current = repositoryActive ? active.slice(11) : null;
  useEffect(() => window.twig?.onRefreshKey?.(() => {
    setRefreshRequest(current => ({ id: activeRef.current, seq: current.seq + 1 }));
  }), []);

  function openEmpty() { setEmptyOpen(true); setActive('new'); }
  async function openRepository() {
    try {
      const { init, ...next } = await window.twig.openRepository();
      setWorkspace(next);
      if (init) { setInitPlan(init); return; }
      setStartupError('');
      if (next.activeId) setActive(`repository:${next.activeId}`);
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not open this repository.')), failed: true }); }
  }
  async function createRepository() {
    const plan = initPlan;
    setInitPlan(null);
    try {
      const next = await window.twig.initRepository(plan.token);
      setWorkspace(next);
      if (next.activeId) setActive(`repository:${next.activeId}`);
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not create the repository.')), failed: true }); }
  }
  /** The repository moved: the new folder is chosen in main and only named here for the person to confirm. */
  async function chooseLocation(item) {
    try {
      const choice = await window.twig.chooseRepositoryLocation(item.id);
      if (choice) setLocatePlan({ ...choice, id: item.id, name: item.name });
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not open this repository.')), failed: true }); }
  }
  async function locateRepository() {
    const plan = locatePlan;
    setLocatePlan(null);
    try {
      const { workspace: next, from, to } = await window.twig.locateRepository(plan.id, plan.token);
      try { moveCommitDraft(localStorage, from, to); } catch { /* Storage is unavailable: nothing to move. */ }
      setClosedTabs(current => moveClosedTab(current, from, to));
      ++selectionRequest.current;
      setWorkspace(next);
      setActive(`repository:${to}`);
      setSyncNote(t`${plan.name} is connected at its new location.`);
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not move this repository.')), failed: true }); }
  }
  async function removeMissing(item) {
    try { acceptWorkspace(await window.twig.removeRepository(item.id)); }
    catch (error) { setSyncNote({ text: failureText(error, t('Could not remove this repository.')), failed: true }); }
  }
  async function checkGit() {
    setGitChecking(true);
    try {
      const { git, ...next } = await window.twig.checkGit();
      setGitState(git);
      if (git.available) { acceptWorkspace(next); }
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not check for Git.')), failed: true }); }
    finally { setGitChecking(false); }
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
    } catch (error) { setSyncNote({ text: failureText(error, t('Could not select this repository.')), failed: true }); }
  }
  function closeRepositoryTab(id) {
    setClosedTabs(current => new Set(current).add(id));
    if (active !== `repository:${id}`) return;
    const openRepositories = (workspace?.repositories || []).filter(item => item.id !== id && !closedTabs.has(item.id));
    if (openRepositories.length > 0) setActive(`repository:${openRepositories[0].id}`);
    else if (sandboxId) setActive(`repository:${sandboxId}`);
    else openEmpty();
  }
  /** Closing a tab is asked first: the tab button and the shortcut both land here. */
  function askCloseTab(item) {
    if (!item) return;
    setCloseTarget({ id: item.id, name: item.name, sandbox: Boolean(item.sandbox) });
    setDialog('Close tab');
  }
  function confirmCloseTab() {
    const target = closeTarget;
    setDialog(null);
    setCloseTarget(null);
    if (!target) return;
    if (target.sandbox) void setDemoVisible(false);
    else closeRepositoryTab(target.id);
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
      // Keys come from Settings → Keyboard shortcuts and are read at the press.
      if (dialog || modalOpen()) return;
      if (matchesShortcut(event, 'console')) { event.preventDefault(); setConsoleOpen(value => !value); }
      if (matchesShortcut(event, 'settings')) { event.preventDefault(); setDialog('Settings'); }
      if (matchesShortcut(event, 'newTab')) { event.preventDefault(); openEmpty(); }
      if (matchesShortcut(event, 'search') && active.startsWith('repository:')) { event.preventDefault(); focusSearch(); }
      if (matchesShortcut(event, 'closeTab')) {
        event.preventDefault();
        if (active === 'new') { setEmptyOpen(false); if (sandboxId) setActive(`repository:${sandboxId}`); }
        else if (repositoryActive) {
          const item = workspace?.repositories.find(entry => entry.id === active.slice(11));
          if (item) { setCloseTarget({ id: item.id, name: item.name, sandbox: Boolean(item.sandbox) }); setDialog('Close tab'); }
        }
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, active, repositoryActive, sandboxId, workspace, focusSearch]);

  // Restarting ends whatever Git runs: wait for the running action first.
  const updateBusy = syncing ? syncWait(syncing) : undoMoving ? t('Wait for Undo to finish') : dialogBusy || resetting ? t('Wait for the action to finish') : undefined;
  const updateAction = toolbarUpdate(update);
  const UpdateIcon = updateAction?.icon === 'restart' ? RotateCw : updateAction?.icon === 'progress' ? LoaderCircle : Download;
  const updateButton = updateAction && <Button className={`update-button ${updateAction.action === 'settings' || !updateAction.action ? '' : 'primary'} ${updateAction.icon === 'progress' ? 'working' : ''}`}
    icon={UpdateIcon} title={updateAction.title}
    reason={!updateAction.action ? updateAction.title : updateAction.action === 'install' ? updateBusy : undefined}
    onClick={() => { if (updateAction.action === 'settings') setDialog('Settings'); else void runUpdate(updateAction.action); }}>{updateAction.label}</Button>;
  const updateRunning = ['downloading', 'preparing'].includes(update?.status);
  const tabNote = noteFor(syncNotes, repositoryActive ? repository?.id : null);

  const noGit = gitState?.available === false;
  return <NoteRegion.Provider value={noteRegion}><div className="app-shell">
    <header className="tab-bar"><div className="brand"><img className="brand-logo" src="./twig-logo.png" alt="🌱 Twig" width="36" height="36" /></div>
      <TabStrip repositories={noGit ? [] : workspace?.repositories || []} closedTabs={closedTabs} active={active} emptyOpen={emptyOpen} onSelect={id => void selectRepository(id)} onShowNew={() => setActive('new')}
        onClose={askCloseTab} onCloseNew={() => { setEmptyOpen(false); if (sandboxId) setActive(`repository:${sandboxId}`); }} onNew={openEmpty} />
      <div className="account-actions">{updateButton}<Button icon={Settings} aria-label={t('Settings')} title={t('Settings')} onClick={() => setDialog('Settings')} /><Button icon={UserRound} aria-label={t('Git profile')} title={t('Git profile')} onClick={() => setDialog('Git profile')} /></div>
    </header>
    <section className="toolbar" aria-label={t('Git actions')}>
      <div className="repo-select"><div className="repo-select-head"><label htmlFor="repository-select">{t('REPOSITORY')}</label>
        {/* Refresh re-reads the open repository: its HistoryWorkspace renders it here through a portal. */}
        <span className="repo-refresh-slot" ref={setRefreshSlot}>
          {!workspace?.repositories.some(item => item.available && active === `repository:${item.id}`) &&
            <Button className="repo-refresh" icon={RefreshCw} aria-label={t('Refresh')} reason={unavailable} />}
        </span></div><select id="repository-select" value={active} title={repositoryActive ? repository?.name : undefined} onChange={(e) => { const { value } = e.target; if (value === 'new') openEmpty(); else void selectRepository(value.slice(11)); }}>{workspace?.repositories.map(item => <option key={item.id} value={`repository:${item.id}`}>{item.name}</option>)}<option value="new">{t('Open repository…')}</option></select></div>
      <div className="branch-select"><span>{t('CURRENT BRANCH')}</span><Button icon={GitBranch} reason={repositoryActive && repository?.available ? (repository?.status?.branch?.oid ? undefined : t('There is no commit yet')) : unavailable}
        title={t('Show it in the history')} onClick={() => setHeadRequest(current => ({ id: active.slice(11), seq: current.seq + 1 }))}>{repositoryActive ? repository?.status?.branch?.name || (repository?.status?.branch?.detached ? t('Detached HEAD') : t('Unavailable')) : 'main'}</Button></div>
      <div className="tool-group"><Button className="tool" icon={Undo2} title={tr(undoState.undoReason)} reason={undoMoving ? t('Reversing the action…') : !repositoryActive ? unavailable : !undoState.undo ? tr(undoState.undoReason) : undefined} onClick={() => moveUndo('undo')}>{t('Undo')}</Button><Button className="tool" icon={Redo2} title={tr(undoState.redoReason)} reason={undoMoving ? t('Reversing the action…') : !repositoryActive ? unavailable : !undoState.redo ? tr(undoState.redoReason) : undefined} onClick={() => moveUndo('redo')}>{t('Redo')}</Button></div>
      <div className="tool-group">
        <Button className="tool" icon={ArrowDown} onClick={pull} title={repositoryActive ? pullTitle(fetchStatus) : undefined}
          reason={syncReason || (divergence.upstream ? undefined : t('Pull: this branch has no upstream'))}>
          {t('Pull')}{divergence.behind > 0 && <span className="badge">{divergence.behind}</span>}</Button>
        <Button className="tool" icon={ArrowUp} title={divergence.upstream ? t('Push') : t('Publish')} onClick={() => (divergence.upstream ? void runSync('push') : void publish())}
          reason={syncReason || (!divergence.upstream && !branchName ? t('Push: no branch to publish') : undefined)
            || (unbornBranch ? t('Publish: make the first commit first') : undefined)}>
          {divergence.upstream ? t('Push') : t('Publish')}{divergence.ahead > 0 && <span className="badge">{divergence.ahead}</span>}</Button>
        {syncing && <Button className="tool" onClick={() => window.twig.cancelSync(repository.id)}>{t('Cancel')}</Button>}
      </div>
      <div className="tool-group"><Button className="tool" icon={GitBranch} title={t('Create a branch at the selected commit, or at HEAD')}
        reason={syncReason || (unbornBranch ? t('Branch: make the first commit first') : undefined)}
        onClick={() => setBranchRequest(current => ({ id: active.slice(11), seq: current.seq + 1 }))}>{t('Branch')}</Button>
        <Button className="tool" icon={StashPush} title={t('Stash every change, untracked files included')} onClick={() => runStash('stash')} reason={stashReason}>{t('Stash')}</Button>
        <Button className="tool" icon={StashPop} title={t('Pop')} onClick={() => runStash('pop')}
          reason={syncReason || (stashCount === 0 ? t('Pop: there are no stashes to restore') : undefined)}>{t('Pop')}</Button></div>
      {/* Patch belongs to the open repository: its HistoryWorkspace renders it
          here through a portal, like BugHunter. */}
      <div className="tool-group" ref={setRepoToolsSlot}>
        {!workspace?.repositories.some(item => item.available && active === `repository:${item.id}`) && <>
          <Button className="tool" icon={FileInput} reason={unavailable}>{t('Patch')}</Button></>}
      </div>
      {/* The console lives at the bottom of the window and opens from its own
          status bar (or its shortcut); a second switch in the toolbar only took room. */}
      <div className="tool-group">
        <span className="bughunter-tool-slot" ref={setBugHunterSlot}>
          {!workspace?.repositories.some(item => item.available && active === `repository:${item.id}`) &&
            <Button className="tool bughunter-tool" icon={Bug} reason={unavailable}>{t('BugHunter')}</Button>}
        </span>
        <Button className={`tool mcp-tool ${mcpSettings?.enabled ? 'mcp-on' : ''}`} icon={Bot} title={mcpToolTitle(mcpSettings)} aria-label={mcpToolTitle(mcpSettings)}
          onClick={() => setDialog('AI agents (MCP)')}>MCP{mcpSettings?.enabled && <span className="tool-dot" aria-hidden="true" />}</Button>
      </div>
    </section>
    {startupError && <div className="startup-error" role="status">{startupError}</div>}
    {!ready && <div className="loading-shell" aria-label={t('Loading workspace')} aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>}
    {ready && noGit && <GitMissing git={gitState} platform={info?.platform} checking={gitChecking} onCheck={() => void checkGit()} />}
    {ready && !noGit && <div className="workspace-container">
      {workspace?.repositories.map(item => <div className="workspace-tab" key={item.id} hidden={active !== `repository:${item.id}`}>
        {/* A real repository tab mounts the first time it is shown and then
            stays mounted, so switching back keeps its DOM; a closed tab is not
            mounted at all. The always-present demo tab mounts only while active,
            so its graph never collides with another tab's. */}
        {(item.sandbox ? active === `repository:${item.id}` : !closedTabs.has(item.id) && (visited.has(item.id) || active === `repository:${item.id}`)) && (item.available === undefined
          ? <div className="loading-shell" aria-label={t('Loading workspace')} aria-busy="true"><div className="skeleton" /></div>
          : item.available
            ? <ErrorBoundary><HistoryWorkspace repository={item} active={active === `repository:${item.id}`} referencesRevision={remoteRevisions[item.id] || 0} commitColors={commitColors} platform={info?.platform} editor={editor?.label} toolbarSlot={bugHunterSlot} toolsSlot={repoToolsSlot} refreshSlot={refreshSlot} revealHead={headRequest.id === item.id ? headRequest.seq : 0} branchRequest={branchRequest.id === item.id ? branchRequest.seq : 0} refreshRequest={refreshRequest.id === item.id ? refreshRequest.seq : 0} toolbarBusyReason={syncing ? syncRunning(syncing) : undoMoving ? t('Reversing the action…') : undefined}
              filterRef={filterRefFor(item.id)}
              onConsole={showConsole} onRepositoryChanged={refreshRepository} onOpenWorkspace={openWorkspaceTab} onWorkspace={updateWorkspace} /></ErrorBoundary>
            : <RepositoryReady repository={item} busy={resetting} onOpen={openRepository} onLocate={() => void chooseLocation(item)} onRemove={() => void removeMissing(item)} onResetDemo={() => void resetDemo()} />)}
      </div>)}
      {active === 'new' && <main className="welcome"><div className="welcome-mark"><img src="./twig-logo.png" alt="" width="96" height="96" /></div><span className="eyebrow">{t('YOUR NEXT WORKSPACE')}</span><h1>{t('A clear view of your code.')}</h1><p>{t('Open a folder, clone a repository, or choose one you have connected.')}</p><div className="welcome-actions"><Button icon={FolderOpen} className="primary" onClick={openRepository}>{t('Open repository')}</Button><Button icon={ArrowDown} onClick={() => setDialog('Clone repository')}>{t('Clone repository')}</Button><Button icon={GitBranch} onClick={() => setDialog('Repositories')}>{t('Connected repositories')}</Button></div><div className="welcome-demo"><span className="demo-pill">{t('DEMO')}</span><p>{tx('The {name} tab is a real sandbox repository — every command runs against it.', { name: <strong>workspace-demo</strong> })}</p>{sandboxId
        ? <Button icon={GitBranch} className="primary" onClick={() => setActive(`repository:${sandboxId}`)}>{t('Open workspace-demo')}</Button>
        : <Button icon={GitBranch} className="primary" onClick={() => setDemoVisible(true)}>{t('Show workspace-demo')}</Button>}</div></main>}
    </div>}
    <OperationNote note={tabNote.note} onConsole={showConsole} onDismiss={() => setSyncNote('', tabNote.key)} />
    {/* Zero height: the notes stack upwards from the top of the console, over the workspace. */}
    <div className="note-dock"><div className="note-stack" ref={setNoteRegion} /></div>
    <Console expanded={consoleOpen} onToggle={() => setConsoleOpen(!consoleOpen)} entries={entries} focus={consoleFocus}
      repositoryId={workspace?.repositories.find(item => item.available && active === `repository:${item.id}`)?.id || null} />
    {dialog && <Dialog title={DIALOG_TITLES.includes(dialog) ? t(dialog) : dialog} wide={['Git profile', 'Repositories', 'Clone repository', 'Remotes', 'SSH', 'AI agents (MCP)', 'Keyboard shortcuts'].includes(dialog)} closeReason={dialogBusy || resetting ? t('Wait for the action to finish or cancel it first') : undefined} onClose={() => setDialog(null)}>
      {dialog === 'Settings' && <div className="settings-sections"><p className="muted">{t('Make this workspace feel like yours.')}</p>
        <h3 className="settings-group">{t('Interface')}</h3>
        <label className="setting-row" htmlFor="language"><span><strong>{t('Language')}</strong><small>{t('Git’s own words — branch, commit, merge, stash — commands and paths stay as they are.')}</small></span>
          <select id="language" value={language} onChange={(e) => { const choice = e.target.value; setLanguage(choice); setLanguageError(''); changeLanguage(choice).catch(() => setLanguageError(t('Could not change the language.'))); }}>
            <option value="system">{t`System (${LANGUAGES.find(item => item.code === systemLanguage())?.name || 'English'})`}</option>
            {LANGUAGES.map(item => <option key={item.code} value={item.code} lang={item.code}>{item.name}</option>)}
          </select></label>
        {languageError && <p className="update-note" role="alert">{languageError}</p>}
        <label className="setting-row" htmlFor="theme"><span><strong>{t('Appearance')}</strong><small>{t('System follows your device setting.')}</small></span><select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">{t('System')}</option><option value="dark">{t('Dark')}</option><option value="light">{t('Light')}</option></select></label>
        <label className="setting-row" htmlFor="commit-colors"><span><strong>{t('Commit colors')}</strong><small>{t('Age shades the graph and the dates from brown roots to green new work.')}</small></span><select id="commit-colors" value={commitColors} onChange={(e) => setCommitColors(e.target.value)}><option value="age">{t('Commit age')}</option><option value="lanes">{t('Branch lanes')}</option></select></label>
        {commitColors === 'age' && <ul className="age-legend" aria-label={t('Commit age colors')}>{AGE_STOPS.map((stop, index) => <li key={stop.key} className={ageTextClass(index)}>{t(stop.label)}</li>)}</ul>}
        <label className="setting-row" htmlFor="syntax"><span><strong>{t('Syntax highlighting')}</strong><small>{t('Colours code by file type in diffs, staging and blame. Lines / Words is switched above each diff.')}</small></span>
          <select id="syntax" value={diffPrefs.syntax ? 'on' : 'off'} onChange={(e) => setDiffPrefs({ syntax: e.target.value === 'on' })}><option value="on">{t('On')}</option><option value="off">{t('Off')}</option></select></label>
        {editor && <div className="setting-row"><label htmlFor="editor"><strong>{t('Open files with')}</strong><small className="editor-path">{
          editor.preset === 'custom' ? editor.customPath
            : editor.preset === 'system' ? (info?.platform === 'darwin' ? t('Your default text editor. Used by “Open in editor” in file menus.')
              : t('The app your system opens that file type with. Program files are refused.'))
              : t('Used by “Open in editor” in file menus.')}</small></label>
          <span className="setting-controls"><select id="editor" value={editor.preset} onChange={(e) => void chooseEditor(e.target.value)}>
            {editor.presets.map(preset => <option key={preset.id} value={preset.id}>{preset.id === 'custom' && editor.preset === 'custom' ? editor.label : tr(preset.label)}</option>)}
          </select>{editor.preset === 'custom' && <Button onClick={() => void chooseEditor('custom')}>{t('Choose…')}</Button>}</span></div>}
        {editorError && <p className="update-note" role="alert">{editorError}</p>}
        <div className="setting-row"><span><strong>{t('Keyboard shortcuts')}</strong><small>{t('Every key 🌱 Twig answers to, and what it does. Change any of them.')}</small></span><Button icon={Keyboard} onClick={() => setDialog('Keyboard shortcuts')}>{t('Keyboard shortcuts')}</Button></div>
        <h3 className="settings-group">{t('Connections')}</h3>
        <div className="setting-row"><span><strong>{t('Repositories')}</strong><small>{t('Connect, clone and remove repositories.')}</small></span><Button icon={FolderOpen} onClick={() => setDialog('Repositories')}>{t('Manage repositories')}</Button></div>
        <div className="setting-row"><span><strong>{t('SSH')}</strong><small>{t('Keys and config for Git over SSH.')}</small></span><Button icon={KeyRound} onClick={() => setDialog('SSH')}>{t('SSH keys and config')}</Button></div>
        <div className="setting-row"><span><strong>{t('AI agents (MCP)')}</strong><small>{mcpSummary(mcpSettings)}</small></span><Button icon={Bot} onClick={() => setDialog('AI agents (MCP)')}>{t('Set up AI agents')}</Button></div>
        {fetchSettings && <label className="setting-row" htmlFor="background-fetch"><span><strong>{t('Background fetch')}</strong>
          <small>{fetchExplanation(fetchSettings.interval)}</small>
          {fetchSettings.interval > 0 && repositoryActive && fetchStatus && <small className="fetch-status" role="status">{repository?.name}: {fetchStatusLine(fetchStatus)}</small>}</span>
          <select id="background-fetch" value={fetchSettings.interval} onChange={(e) => void chooseFetchInterval(Number(e.target.value))}>
            {fetchSettings.intervals.map(minutes => <option key={minutes} value={minutes}>{intervalLabel(minutes)}</option>)}
          </select></label>}
        {fetchError && <p className="update-note" role="alert">{fetchError}</p>}
        <div className="setting-row"><span><strong>{t('Updates')}</strong><small>{t`🌱 Twig ${info?.version || '…'}. A new version downloads from GitHub, is checked against the release checksum and replaces this one when you restart.`}</small></span>
          <Button icon={RefreshCw} reason={update?.status === 'checking' ? t('Checking…') : updateRunning || update?.status === 'installing' ? t('An update is already in progress') : undefined} onClick={() => void runUpdate('check')}>{t('Check for updates')}</Button></div>
        {update && <label className="setting-row" htmlFor="update-auto"><span><strong>{t('Check automatically')}</strong><small>{autoCheckExplanation(update.auto)}</small></span>
          <select id="update-auto" value={update.auto ? 'on' : 'off'} onChange={(e) => void chooseAutoUpdate(e.target.value === 'on')}><option value="off">{t('Only when I ask')}</option><option value="on">{t('At launch and daily')}</option></select></label>}
        {update && updateStatusLine(update) && <div className="update-panel" role="status">
          <p className="update-note">{updateStatusLine(update)}{update.url && <> <a className="text-link" href={update.url} rel="noreferrer">{t('Release on GitHub')}</a></>}</p>
          {update.status === 'downloading' && <progress className="update-progress" max="100" value={percent(update.progress)} aria-label={t`Downloading ${update.latest}`} />}
          <div className="update-actions">
            {update.status === 'available' && update.installable && !update.installReason && <Button className="primary" icon={Download} onClick={() => void runUpdate('download')}>{update.error ? t('Try again') : t`Download and install ${update.latest}`}</Button>}
            {update.status === 'downloading' && <Button onClick={() => void runUpdate('cancel')}>{t('Cancel download')}</Button>}
            {update.status === 'ready' && <Button className="primary" icon={RotateCw} reason={updateBusy} onClick={() => void runUpdate('install')}>{installVerb(update)}</Button>}
          </div>
          {update.notes && ['available', 'downloading', 'preparing', 'ready'].includes(update.status) && <details className="update-notes"><summary>{t`What’s new in ${update.latest}`}</summary><pre>{update.notes}</pre></details>}
        </div>}
        {updateError && <p className="update-note" role="alert">{updateError}</p>}
        <div className="setting-row"><span><strong>{t('Command journal')}</strong><small>{journalCleared ? t('Cleared.') : t('The commands 🌱 Twig ran and what your automations printed, kept in your profile folder for the console. Only your account can read them.')}</small></span><Button icon={Trash2} onClick={() => void clearJournal()}>{t('Clear journal')}</Button></div>
        {sandboxId
        ? <div className="setting-row"><span><strong>{t('Demo workspace')}</strong><small>{tx('Restore the {name} sandbox to its sample history.', { name: <strong>workspace-demo</strong> })}</small></span><Button icon={RefreshCw} onClick={() => setDialog('Reset demo workspace')}>{t('Reset demo workspace')}</Button></div>
        : <div className="setting-row"><span><strong>{t('Demo workspace')}</strong><small>{tx('The {name} tab is closed. Its sandbox is still on disk — showing it again opens the same repository.', { name: <strong>workspace-demo</strong> })}</small></span><Button icon={GitBranch} onClick={() => setDemoVisible(true)}>{t('Show demo workspace')}</Button></div>}
        <h3 className="settings-group">{t('This repository')}</h3>
        <div className="setting-row"><span><strong>{t('Remotes')}</strong><small>{t('Where this repository fetches from and pushes to.')}</small></span><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : t('Open a repository first')} onClick={() => setDialog('Remotes')}>{t('Manage remotes')}</Button></div>
        <div className="setting-row"><span><strong>{t('Git profile')}</strong><small>{t('The name and email on your commits, here or for every repository.')}</small></span><Button icon={UserRound} onClick={() => setDialog('Git profile')}>{t('Open Git profile')}</Button></div>
        <div className="settings-note">{BRAND} {info?.version || '…'}<br />{t('Local fonts. No telemetry. Updates install only when you press the button.')}</div></div>}
      {dialog === 'Reset demo workspace' && <div className="confirm-dialog">
        <p className="confirm-consequence"><AlertTriangle aria-hidden="true" /><span>{tx('Deletes the {name} sandbox and its local demo remote, then recreates them with the sample history.', { name: <strong>workspace-demo</strong> })}</span></p>
        <ul>
          <li>{t('Any commits, branches, stashes or edits you made in the demo are discarded.')}</li>
          <li>{t('The demo’s Undo history ends and its commit marks are cleared.')}</li>
          <li>{t('Your own connected repositories and automation pipelines are not touched.')}</li>
        </ul>
        <div className="dialog-actions"><Button onClick={() => setDialog('Settings')} reason={resetting ? t('Resetting…') : undefined}>{t('Cancel')}</Button><Button className="danger" icon={RefreshCw} onClick={resetDemo} reason={resetting ? t('Resetting the demo workspace…') : undefined}>{t('Reset demo workspace')}</Button></div>
      </div>}
      {dialog === 'Close tab' && closeTarget && <div className="confirm-dialog">
        <p>{tx('Close the {name} tab?', { name: <strong>{closeTarget.name}</strong> })}</p>
        <p className="muted">{closeTarget.sandbox
          ? t('The demo sandbox stays on disk with its history. Settings brings the tab back.')
          : t('Nothing is deleted: the repository stays connected and its files stay on disk. Choose it under REPOSITORY to open the tab again.')}</p>
        <div className="dialog-actions"><Button onClick={() => { setDialog(null); setCloseTarget(null); }}>{t('Cancel')}</Button><Button className="primary" icon={X} data-autofocus onClick={confirmCloseTab}>{t('Yes, close')}</Button></div>
      </div>}
      {dialog === 'Pull' && <div className="confirm-dialog">
        <p>{tx('{branch} and {upstream} have both moved: {ahead} to push, {behind} to pull.', { branch: <strong>{branchName}</strong>, upstream: <strong>{divergence.upstream}</strong>, ahead: divergence.ahead, behind: divergence.behind })}</p>
        <p className="muted">{t('A plain pull only fast-forwards, so it cannot do this. Rebase replays your commits on top of the remote; merge joins the two with a merge commit.')}</p>
        {Object.values(PULL_COMMANDS).map(argv => <code key={argv.join(' ')} className="confirm-command">$ git {argv.join(' ')}</code>)}
        <div className="dialog-actions"><Button onClick={() => setDialog(null)}>{t('Cancel')}</Button>
          <Button className="secondary" onClick={() => { setDialog(null); void runSync('pull-merge'); }}>{t('Pull and merge')}</Button>
          <Button className="primary" data-autofocus onClick={() => { setDialog(null); void runSync('pull-rebase'); }}>{t('Pull with rebase')}</Button></div>
      </div>}
      {dialog === 'Publish' && <div className="confirm-dialog">
        <p>{tx('Which remote should {branch} go to?', { branch: <strong>{branchName}</strong> })}</p>
        {publishRemotes.map(remote => <code key={remote} className="confirm-command">$ git push --set-upstream {remote} {branchName}</code>)}
        <div className="dialog-actions"><Button onClick={() => setDialog(null)}>{t('Cancel')}</Button>
          {publishRemotes.map(remote => <Button key={remote} className="primary" onClick={() => { setDialog(null); void runSync('push-upstream', remote); }}>{t`Publish to ${remote}`}</Button>)}</div>
      </div>}
      {dialog === 'Keyboard shortcuts' && <ShortcutsSettings platform={info?.platform} />}
      {dialog === 'AI agents (MCP)' && <McpSettings onBusyChange={setDialogBusy} onChange={setMcpSettings} />}
      {dialog === 'SSH' && <SshSettings entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} />}
      {dialog === 'Git profile' && <GitProfile repository={repositoryActive ? repository : null} onConsole={() => { setDialog(null); showConsole(); }} />}
      {dialog === 'Repositories' && <Repositories workspace={workspace} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onOpen={async () => { await openRepository(); setDialog(null); }} onClone={() => setDialog('Clone repository')} />}
      {dialog === 'Clone repository' && <CloneRepository entries={entries} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} draft={cloneDraft} onDraft={setCloneDraft} />}
      {dialog === 'Remotes' && repository && <Remotes repository={repository} entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onChanged={async () => {
        await refreshRepository();
        setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      }} />}
    </Dialog>}
    {proposal && <CommitProposalDialog key={proposal.id} view={proposal} running={proposalRun.running} step={proposalRun.step} failure={proposalRun.failure} invalid={proposalRun.invalid}
      onDecide={decision => void decideProposal(decision)} onClose={closeProposal}
      onStopAgents={() => void window.twig.setMcpCommitsAllowed(false).then(setMcpSettings).catch(() => {})} />}
    {pushGate && <ExecutionPanel event="pre-push" label={t('Before Push')} phase="pre" steps={pushGate.steps} result={pushGate.result}
      blocked={pushGate.blocked} onClose={() => (pushGate.result ? closePushGate(false) : cancelPushGate())} onRetry={() => closePushGate(false)}
      onRunAgain={() => { const resolve = pushGateResolve.current; pushGateResolve.current = null; void runPushGate(pushGate.remote).then(resolve); }} onBypass={() => closePushGate(false, true)} />}
    {initPlan && <ConfirmDialog title={t('Create a repository here?')} danger={false} command={initPlan.command} confirmLabel={t('Create repository')}
      consequence={t`${initPlan.path} has no Git repository yet. Git adds a .git folder there; your files are not changed and nothing is committed.`}
      onConfirm={() => void createRepository()} onClose={() => setInitPlan(null)} />}
    {leasePush && <ConfirmDialog title={t('Push with lease')} command={leasePush.command} confirmLabel={t('Push with lease')}
      consequence={t`The remote branch is replaced with ${branchName || 'this branch'}, and the commits only it holds are gone from there. Git refuses if somebody pushed since your last fetch.`}
      onConfirm={() => void runSync('push-force')} onClose={() => setLeasePush(null)} />}
    {locatePlan && <Dialog title={t`Locate ${locatePlan.name}`} onClose={() => setLocatePlan(null)}><div className="confirm-dialog">
      <p>{t('Connect the repository at this folder?')}</p>
      <code className="confirm-command">{locatePlan.path}</code>
      <p className="muted">{t('Its commit marks, automations and what you trusted, its Undo history and its commit message draft move with it.')}</p>
      <div className="dialog-actions"><Button onClick={() => setLocatePlan(null)}>{t('Cancel')}</Button><Button className="primary" data-autofocus onClick={() => void locateRepository()}>{t('Connect here')}</Button></div>
    </div></Dialog>}
  </div></NoteRegion.Provider>;
}

/** Everything in 🌱 Twig goes through the system Git, so without it this is the whole window. */
function GitMissing({ git, platform, checking, onCheck }) {
  return <main className="repository-ready"><AlertTriangle /><span className="eyebrow">{t('GIT NOT FOUND')}</span><h1>{t('Install Git to get started')}</h1>
    <p>{tr(git.instruction)}</p>
    {platform === 'darwin' && <p>{tx('On a Mac, run {command} in Terminal, or install Git from the site below.', { command: <code>xcode-select --install</code> })}</p>}
    <div className="welcome-actions"><Button icon={RefreshCw} className="primary" reason={checking ? t('Checking…') : undefined} onClick={onCheck}>{t('Check again')}</Button></div>
    <a className="text-link" href="https://git-scm.com/downloads" rel="noreferrer">{t('Download Git')}</a>
  </main>;
}

function RepositoryReady({ repository, busy, onOpen, onLocate, onRemove, onResetDemo }) {
  if (!repository) return null;
  const status = repository.status;
  const missing = !repository.available;
  if (repository.blocked) {
    return <main className="repository-ready"><GitBranch /><span className="eyebrow">{t('CONNECTED REPOSITORY')}</span><h1>{repository.name}</h1><p className="repository-path">{repository.path}</p>
      <strong>{t('🌱 Twig stopped reading this repository.')}</strong><p>{t('Its Git settings changed. Open repository asks again.')}</p>
      <Button icon={FolderOpen} className="primary" onClick={onOpen}>{t('Open repository')}</Button></main>;
  }
  if (repository.seedError) {
    return <main className="repository-ready"><AlertTriangle /><span className="eyebrow">{t('DEMO')}</span><h1>{repository.name}</h1>
      <strong>{t('The demo workspace could not be created.')}</strong><p className="repository-path">{repository.seedError}</p>
      <Button icon={RefreshCw} className="primary" reason={busy ? t('Resetting…') : undefined} onClick={onResetDemo}>{t('Try again')}</Button></main>;
  }
  return <main className="repository-ready"><GitBranch /><span className="eyebrow">{missing ? t('MISSING REPOSITORY') : t('CONNECTED REPOSITORY')}</span><h1>{repository.name}</h1><p className="repository-path">{repository.path}</p>
    {missing && <><strong>{t('This folder is not there any more.')}</strong><p>{t('If the repository moved, locate it: its marks, automations and Undo history move with it. Removing it from the list deletes no files.')}</p>
      <div className="welcome-actions"><Button icon={FolderSearch} className="primary" onClick={onLocate}>{t('Locate…')}</Button><Button icon={Trash2} onClick={onRemove}>{t('Remove from list')}</Button></div></>}
    {repository.available && status?.error && <><strong>{tr(status.error)}</strong><p>{t('Open the console to see the exact Git command and output.')}</p></>}
    {repository.available && status?.branch && <><strong>{status.branch.detached ? t('Detached HEAD') : status.branch.name || t('Unborn branch')}</strong><p>{tn(status.entries.length, '{n} changed file', '{n} changed files')}</p></>}
  </main>;
}
