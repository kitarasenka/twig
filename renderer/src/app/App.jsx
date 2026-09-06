import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, ChevronDown, FolderOpen, GitBranch, Layers, Plus, Redo2, Settings, SquareTerminal, Undo2, Upload, UserRound, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import Workspace from './Workspace.jsx';
import { Console } from './Panels.jsx';
import HistoryWorkspace from '../features/graph/HistoryWorkspace.jsx';
import GitProfile from '../features/settings/GitProfile.jsx';
import Repositories from '../features/settings/Repositories.jsx';
import CloneRepository from '../features/settings/CloneRepository.jsx';
import Remotes from '../features/settings/Remotes.jsx';
import SshSettings from '../features/settings/SshSettings.jsx';
import { AGE_STOPS, ageTextClass } from '../features/graph/age-color.js';

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

function applyConsoleUpdate(entries, update) {
  if (update.type === 'start') return [...entries, { ...update.entry, stdout: '', stderr: '', state: 'running', code: null, ms: null }].slice(-2000);
  if (update.type === 'output') return entries.map(entry => entry.id === update.id
    ? { ...entry, [update.stream]: entry[update.stream] + update.chunk }
    : entry);
  if (update.type === 'finish') return entries.map(entry => entry.id === update.id
    ? { ...entry, ...update.result, state: 'finished' }
    : entry);
  return entries;
}

export default function App() {
  const [theme, setTheme] = useState(initialTheme);
  const [commitColors, setCommitColors] = useState(initialCommitColors);
  const [active, setActive] = useState('demo');
  const [demoOpen, setDemoOpen] = useState(true);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [bugHunterSlot, setBugHunterSlot] = useState(null);
  const [sidebar, setSidebar] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [info, setInfo] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [startupError, setStartupError] = useState('');
  const [divergence, setDivergence] = useState({ ahead: 0, behind: 0, upstream: null });
  const [syncing, setSyncing] = useState(null);
  const [syncNote, setSyncNote] = useState('');
  const [worktreeVersion, setWorktreeVersion] = useState(0);
  const [remoteRevisions, setRemoteRevisions] = useState({});
  const [closedTabs, setClosedTabs] = useState(() => new Set());
  const [undoState, setUndoState] = useState({ undo: false, redo: false, undoReason: 'No application actions to undo.', redoReason: 'No next action.' });
  const [undoMoving, setUndoMoving] = useState(false);
  const filterRef = useRef(null);
  const repositoryFilters = useRef(new Map());
  const selectionRequest = useRef(0);
  const divergenceRequest = useRef(0);
  const mod = info?.platform === 'darwin' || (!info && /Mac/.test(navigator.platform)) ? 'Cmd' : 'Ctrl';
  const ready = (info !== null && workspace !== null) || Boolean(startupError);
  const repository = workspace?.repositories.find(item => item.id === workspace.activeId) || null;
  const repositoryActive = active.startsWith('repository:');

  useEffect(() => {
    let alive = true;
    if (!window.twig) { setStartupError('Browser preview. Launch the desktop app with npm run dev.'); return; }
    Promise.all([window.twig.getAppInfo(), window.twig.getWorkspace(), window.twig.getConsoleEntries()])
      .then(([appInfo, initialWorkspace, initialEntries]) => {
        if (!alive) return;
        setInfo(appInfo); setWorkspace(initialWorkspace); setEntries(initialEntries);
        if (initialWorkspace.activeId) setActive(`repository:${initialWorkspace.activeId}`);
      })
      .catch(() => { if (alive) setStartupError('Desktop connection unavailable. Restart 🌱 Twig.'); });
    const unsubscribe = window.twig.onConsoleUpdate((update) => { if (alive) setEntries(current => applyConsoleUpdate(current, update)); });
    return () => { alive = false; unsubscribe(); };
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
  const branchName = repository?.status?.branch?.name || null;
  useEffect(() => {
    const request = ++divergenceRequest.current;
    if (!repositoryActive || !repository?.available) { setDivergence({ ahead: 0, behind: 0, upstream: null }); return; }
    window.twig.getDivergence(repository.id, branchName)
      .then(next => { if (request === divergenceRequest.current) setDivergence(next); })
      .catch(() => { if (request === divergenceRequest.current) setDivergence({ ahead: 0, behind: 0, upstream: null }); });
  }, [repositoryActive, repository?.id, repository?.available, branchName, worktreeVersion]);

  async function runSync(mode) {
    if (!repository) return;
    setSyncing(mode); setSyncNote('');
    try {
      const result = await window.twig.runSync(repository.id, mode, branchName);
      setSyncNote(result.ok ? `${mode} finished.` : result.message);
      if (!result.ok) setConsoleOpen(true);
      const next = await window.twig.selectRepository(repository.id);
      setWorkspace(next);
      setWorktreeVersion(value => value + 1);
    } catch (error) {
      setSyncNote(error.message || 'The operation failed.');
      setConsoleOpen(true);
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
      setConsoleOpen(true);
    } finally { setSyncing(null); }
  }

  const syncReason = !repositoryActive || !repository?.available ? unavailable
    : syncing ? `${syncing} is running` : undefined;

  /** A commit or a staging change moves the divergence badges, so the toolbar has to hear about it. */
  const repositoryId = repository?.id;
  const refreshRepository = useCallback(async () => {
    if (!repositoryId) return;
    try { setWorkspace(await window.twig.selectRepository(repositoryId)); } catch { /* the previous status stays on screen */ }
    setWorktreeVersion(value => value + 1);
  }, [repositoryId]);
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
  const moveUndo = useCallback(async direction => {
    if (!repositoryActive || !repositoryId || undoMoving) return;
    setUndoMoving(true); setSyncNote('');
    try {
      const result = await window.twig.moveUndo(repositoryId, direction);
      await refreshRepository();
      setSyncNote(`${direction === 'undo' ? 'Undo' : 'Redo'} ${result.cancelled ? 'cancelled' : 'completed'}.`);
    }
    catch (failure) { setSyncNote(failure.message || 'The action could not be reversed.'); setConsoleOpen(true); }
    finally { setUndoMoving(false); }
    setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
  }, [repositoryActive, repositoryId, refreshRepository, undoMoving]);
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
  function openDemo() { setDemoOpen(true); setActive('demo'); }
  async function openRepository() {
    try {
      const next = await window.twig.openRepository();
      setWorkspace(next);
      if (next.activeId) { setActive(`repository:${next.activeId}`); setConsoleOpen(true); }
    } catch (error) { setStartupError(error.message || 'Could not open this repository.'); setConsoleOpen(true); }
  }
  async function selectRepository(id) {
    const request = ++selectionRequest.current;
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
    else if (demoOpen) setActive('demo');
    else openEmpty();
  }
  function acceptWorkspace(next, open = false) {
    ++selectionRequest.current;
    setWorkspace(next);
    if (open || !next.repositories.some(item => active === `repository:${item.id}`)) {
      if (next.activeId) setActive(`repository:${next.activeId}`);
      else openEmpty();
    }
    if (open) setDialog(null);
  }
  function showManagerOutput() {
    setConsoleOpen(true);
    if (!dialogBusy) setDialog(null);
  }
  const focusSearch = useCallback(() => {
    setSidebar(false);
    requestAnimationFrame(() => {
      if (active.startsWith('repository:')) repositoryFilters.current.get(active.slice(11))?.focus();
      else filterRef.current?.focus();
    });
  }, [active]);
  useEffect(() => {
    function keydown(event) {
      if (dialog || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); setConsoleOpen(value => !value); }
      if (key === ',') { event.preventDefault(); setDialog('Settings'); }
      if (key === 't') { event.preventDefault(); openEmpty(); }
      if (key === 'b') { event.preventDefault(); setSidebar(value => !value); }
      if (key === 'f' && (active === 'demo' || active.startsWith('repository:'))) { event.preventDefault(); focusSearch(); }
      if (key === 'w') {
        event.preventDefault();
        if (active === 'demo') { setDemoOpen(false); openEmpty(); }
        else if (demoOpen) { setEmptyOpen(false); setActive('demo'); }
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, active, demoOpen, focusSearch]);

  return <div className="app-shell">
    <header className="tab-bar"><div className="brand"><img className="brand-logo" src="./twig-logo.png" alt="" width="36" height="36" /><strong>🌱 Twig</strong></div>
      <nav className="tabs" aria-label="Repository tabs">
        {demoOpen && <div className={`tab ${active === 'demo' ? 'active' : ''}`}><button aria-current={active === 'demo' ? 'page' : undefined} onClick={() => setActive('demo')}><GitBranch /><span>workspace-demo</span><small>DEMO</small></button><Button icon={X} aria-label="Close demo tab" title={`${mod}+W`} onClick={() => { setDemoOpen(false); openEmpty(); }} /></div>}
        {workspace?.repositories.filter(item => !closedTabs.has(item.id)).map(item => <div key={item.id} className={`tab ${active === `repository:${item.id}` ? 'active' : ''}`}><button aria-current={active === `repository:${item.id}` ? 'page' : undefined} onClick={() => selectRepository(item.id)}><GitBranch /><span>{item.name}</span>{!item.available && <small>OFFLINE</small>}</button><Button icon={X} aria-label={`Close ${item.name} tab`} onClick={() => closeRepositoryTab(item.id)} /></div>)}
        {emptyOpen && <div className={`tab ${active === 'new' ? 'active' : ''}`}><button aria-current={active === 'new' ? 'page' : undefined} onClick={() => setActive('new')}><FolderOpen />New repository</button>{demoOpen && <Button icon={X} aria-label="Close new tab" onClick={() => { setEmptyOpen(false); setActive('demo'); }} />}</div>}
        <Button icon={Plus} aria-label="New repository tab" title={`${mod}+T`} onClick={openEmpty} />
      </nav>
      <div className="account-actions"><Button icon={Bell} aria-label="Notifications" title="Notifications" onClick={() => setDialog('Notifications')} /><Button icon={Settings} aria-label="Settings" title={`Settings · ${mod}+,`} onClick={() => setDialog('Settings')} /><Button icon={UserRound} aria-label="Git profile" title="Git profile" onClick={() => setDialog('Git profile')} /></div>
    </header>
    <section className="toolbar" aria-label="Git actions">
      <div className="repo-select"><label htmlFor="repository-select">REPOSITORY</label><select id="repository-select" value={active} onChange={(e) => { const { value } = e.target; if (value === 'demo') openDemo(); else if (value === 'new') openEmpty(); else void selectRepository(value.slice(11)); }}><option value="demo">workspace-demo</option>{workspace?.repositories.map(item => <option key={item.id} value={`repository:${item.id}`}>{item.name}</option>)}<option value="new">Open repository…</option></select></div>
      <div className="branch-select"><span>CURRENT BRANCH</span><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : unavailable} onClick={focusSearch}>{repositoryActive ? repository?.status?.branch?.name || (repository?.status?.branch?.detached ? 'Detached HEAD' : 'Unavailable') : 'main'}<ChevronDown /></Button></div>
      <div className="tool-group"><Button className="tool" icon={Undo2} title={`${undoState.undoReason} · ${mod}+Z`} reason={undoMoving ? 'Reversing the action…' : !repositoryActive ? unavailable : !undoState.undo ? undoState.undoReason : undefined} onClick={() => moveUndo('undo')}>Undo</Button><Button className="tool" icon={Redo2} title={`${undoState.redoReason} · ${mod}+Shift+Z`} reason={undoMoving ? 'Reversing the action…' : !repositoryActive ? unavailable : !undoState.redo ? undoState.redoReason : undefined} onClick={() => moveUndo('redo')}>Redo</Button></div>
      <div className="tool-group">
        <Button className="tool" icon={ArrowDown} onClick={() => runSync('pull')}
          reason={syncReason || (divergence.upstream ? undefined : 'Pull: this branch has no upstream')}>
          Pull{divergence.behind > 0 && <span className="badge">{divergence.behind}</span>}</Button>
        <Button className="tool" icon={ArrowUp} onClick={() => runSync(divergence.upstream ? 'push' : 'push-upstream')}
          reason={syncReason || (!divergence.upstream && !branchName ? 'Push: no branch to publish' : undefined)}>
          {divergence.upstream ? 'Push' : 'Publish'}{divergence.ahead > 0 && <span className="badge">{divergence.ahead}</span>}</Button>
        {syncing && <Button className="tool" onClick={() => window.twig.cancelSync(repository.id)}>Cancel</Button>}
      </div>
      <div className="tool-group"><Button className="tool" icon={GitBranch} reason={unavailable}>Branch</Button>
        <Button className="tool" icon={Layers} onClick={() => runStash('stash')} reason={syncReason}>Stash</Button>
        <Button className="tool" icon={Upload} onClick={() => runStash('pop')} reason={syncReason}>Pop</Button></div>
      <div className="tool-group"><Button className={`tool ${consoleOpen ? 'pressed' : ''}`} icon={SquareTerminal} title={`${mod}+J`} aria-pressed={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>Terminal</Button>
        <span className="bughunter-tool-slot" ref={setBugHunterSlot}>
          {!workspace?.repositories.some(item => item.available && active === `repository:${item.id}`) &&
            <Button className="tool bughunter-tool" reason={unavailable}>🌱 BugHunter (bisect)</Button>}
        </span>
      </div>
    </section>
    {startupError && <div className="startup-error" role="status">{startupError}</div>}
    {syncNote && <div className="sync-note" role="status"><span>{syncNote}</span><button onClick={() => setSyncNote('')} aria-label="Dismiss">×</button></div>}
    {!ready && <div className="loading-shell" aria-label="Loading workspace" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>}
    {ready && <div className="workspace-container">
      {demoOpen && <div className="workspace-tab" hidden={active !== 'demo'}><Workspace filterRef={filterRef} mod={mod} sidebar={sidebar} onSidebar={() => setSidebar(!sidebar)} searchSignal={focusSearch} /></div>}
      {workspace?.repositories.map(item => <div className="workspace-tab" key={item.id} hidden={active !== `repository:${item.id}`}>
        {item.available ? <HistoryWorkspace repository={item} active={active === `repository:${item.id}`} mod={mod} referencesRevision={remoteRevisions[item.id] || 0} commitColors={commitColors} toolbarSlot={bugHunterSlot} toolbarBusyReason={syncing ? `${syncing} is running` : undoMoving ? 'Reversing the action…' : undefined}
          filterRef={node => { if (node) repositoryFilters.current.set(item.id, node); else repositoryFilters.current.delete(item.id); }}
          onConsole={() => setConsoleOpen(true)} onRepositoryChanged={refreshRepository} />
          : <RepositoryReady repository={item} onOpen={openRepository} />}
      </div>)}
      {active === 'new' && <main className="welcome"><div className="welcome-mark"><img src="./twig-logo.png" alt="" width="96" height="96" /></div><span className="eyebrow">YOUR NEXT WORKSPACE</span><h1>A clear view of your code.</h1><p>Open a folder, clone a repository, or choose one you have connected.</p><div className="welcome-actions"><Button icon={FolderOpen} className="primary" onClick={openRepository}>Open repository</Button><Button icon={ArrowDown} onClick={() => setDialog('Clone repository')}>Clone repository</Button><Button icon={GitBranch} onClick={() => setDialog('Repositories')}>Connected repositories</Button></div><div className="welcome-demo"><span className="demo-pill">PREVIEW</span><p>Explore the workspace with a sample history.</p><Button icon={GitBranch} className="primary" onClick={openDemo}>Explore demo workspace</Button></div></main>}
    </div>}
    <Console expanded={consoleOpen} onToggle={() => setConsoleOpen(!consoleOpen)} mod={mod} entries={entries} />
    {dialog && <Dialog title={dialog} wide={['Git profile', 'Repositories', 'Clone repository', 'Remotes', 'SSH'].includes(dialog)} closeReason={dialogBusy ? 'Wait for the action to finish or cancel it first' : undefined} onClose={() => setDialog(null)}>
      {dialog === 'Settings' && <><p className="muted">Make this workspace feel like yours.</p>
        <label className="setting-row" htmlFor="theme"><span><strong>Appearance</strong><small>System follows your device setting.</small></span><select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
        <label className="setting-row" htmlFor="commit-colors"><span><strong>Commit colors</strong><small>Age shades the graph and the dates from brown roots to green new work.</small></span><select id="commit-colors" value={commitColors} onChange={(e) => setCommitColors(e.target.value)}><option value="age">Commit age</option><option value="lanes">Branch lanes</option></select></label>
        {commitColors === 'age' && <ul className="age-legend" aria-label="Commit age colors">{AGE_STOPS.map((stop, index) => <li key={stop.key} className={ageTextClass(index)}>{stop.label}</li>)}</ul>}
        <div className="settings-note">🌱 Twig {info?.version || '0.2.0'}<br />Local fonts. No telemetry. No automatic updates.</div></>}
      {dialog === 'Settings' && <div className="manager-actions"><Button icon={FolderOpen} onClick={() => setDialog('Repositories')}>Manage repositories</Button><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : 'Open a repository first'} onClick={() => setDialog('Remotes')}>Manage remotes</Button></div>}
      {dialog === 'Settings' && <Button onClick={() => setDialog('SSH')}>SSH keys and config</Button>}
      {dialog === 'SSH' && <SshSettings entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} />}
      {dialog === 'Notifications' && <div className="dialog-empty"><Bell /><h3>You’re all caught up.</h3><p>Git checks and repository activity appear in the command console.</p></div>}
      {dialog === 'Git profile' && <GitProfile repository={repositoryActive ? repository : null} onConsole={() => { setDialog(null); setConsoleOpen(true); }} />}
      {dialog === 'Repositories' && <Repositories workspace={workspace} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onOpen={async () => { await openRepository(); setDialog(null); }} onClone={() => setDialog('Clone repository')} />}
      {dialog === 'Clone repository' && <CloneRepository entries={entries} onWorkspace={acceptWorkspace} onBusyChange={setDialogBusy} onConsole={showManagerOutput} />}
      {dialog === 'Remotes' && repository && <Remotes repository={repository} entries={entries} onBusyChange={setDialogBusy} onConsole={showManagerOutput} onChanged={async () => {
        await refreshRepository();
        setRemoteRevisions(current => ({ ...current, [repositoryId]: (current[repositoryId] || 0) + 1 }));
      }} />}
    </Dialog>}
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
