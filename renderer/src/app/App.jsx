import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, ChevronDown, FolderOpen, GitBranch, Layers, Plus, Redo2, Search, Settings, SquareTerminal, Undo2, Upload, UserRound, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import Workspace from './Workspace.jsx';
import { Console } from './Panels.jsx';
import HistoryWorkspace from '../features/graph/HistoryWorkspace.jsx';

const unavailable = 'Connect a repository to use this action';
function initialTheme() {
  try { const value = localStorage.getItem('twig:theme'); return ['dark', 'light'].includes(value) ? value : 'system'; }
  catch { return 'system'; }
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
  const [active, setActive] = useState('demo');
  const [demoOpen, setDemoOpen] = useState(true);
  const [emptyOpen, setEmptyOpen] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [sidebar, setSidebar] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [info, setInfo] = useState(null);
  const [workspace, setWorkspace] = useState(null);
  const [entries, setEntries] = useState([]);
  const [startupError, setStartupError] = useState('');
  const filterRef = useRef(null);
  const repositoryFilters = useRef(new Map());
  const selectionRequest = useRef(0);
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
      .catch(() => { if (alive) setStartupError('Desktop connection unavailable. Restart 🌱Twig.'); });
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
      if (request === selectionRequest.current) { setWorkspace(next); setActive(`repository:${id}`); }
    } catch (error) { setStartupError(error.message || 'Could not select this repository.'); }
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
    <header className="tab-bar"><div className="brand"><img className="brand-logo" src="./twig-logo.png" alt="" width="36" height="36" /><strong>🌱Twig</strong></div>
      <nav className="tabs" aria-label="Repository tabs">
        {demoOpen && <div className={`tab ${active === 'demo' ? 'active' : ''}`}><button aria-current={active === 'demo' ? 'page' : undefined} onClick={() => setActive('demo')}><GitBranch /><span>workspace-demo</span><small>DEMO</small></button><Button icon={X} aria-label="Close demo tab" title={`${mod}+W`} onClick={() => { setDemoOpen(false); openEmpty(); }} /></div>}
        {workspace?.repositories.map(item => <div key={item.id} className={`tab ${active === `repository:${item.id}` ? 'active' : ''}`}><button aria-current={active === `repository:${item.id}` ? 'page' : undefined} onClick={() => selectRepository(item.id)}><GitBranch /><span>{item.name}</span>{!item.available && <small>OFFLINE</small>}</button></div>)}
        {emptyOpen && <div className={`tab ${active === 'new' ? 'active' : ''}`}><button aria-current={active === 'new' ? 'page' : undefined} onClick={() => setActive('new')}><FolderOpen />New repository</button>{demoOpen && <Button icon={X} aria-label="Close new tab" onClick={() => { setEmptyOpen(false); setActive('demo'); }} />}</div>}
        <Button icon={Plus} aria-label="New repository tab" title={`${mod}+T`} onClick={openEmpty} />
      </nav>
      <div className="account-actions"><Button icon={Bell} aria-label="Notifications" title="Notifications" onClick={() => setDialog('Notifications')} /><Button icon={Settings} aria-label="Settings" title={`Settings · ${mod}+,`} onClick={() => setDialog('Settings')} /><Button icon={UserRound} aria-label="Git profile" title="Git profile" onClick={() => setDialog('Git profile')} /></div>
    </header>
    <section className="toolbar" aria-label="Git actions">
      <div className="repo-select"><label htmlFor="repository-select">REPOSITORY</label><select id="repository-select" value={active} onChange={(e) => { const { value } = e.target; if (value === 'demo') openDemo(); else if (value === 'new') openEmpty(); else void selectRepository(value.slice(11)); }}><option value="demo">workspace-demo</option>{workspace?.repositories.map(item => <option key={item.id} value={`repository:${item.id}`}>{item.name}</option>)}<option value="new">Open repository…</option></select></div>
      <div className="branch-select"><span>CURRENT BRANCH</span><Button icon={GitBranch} reason={repositoryActive && repository?.available ? undefined : unavailable} onClick={focusSearch}>{repositoryActive ? repository?.status?.branch?.name || (repository?.status?.branch?.detached ? 'Detached HEAD' : 'Unavailable') : 'main'}<ChevronDown /></Button></div>
      <div className="tool-group"><Button className="tool" icon={Undo2} reason="Undo: no actions to undo">Undo</Button><Button className="tool" icon={Redo2} reason="Redo: no next action">Redo</Button></div>
      <div className="tool-group"><Button className="tool" icon={ArrowDown} reason={unavailable}>Pull<ChevronDown className="dropdown-icon" /></Button><Button className="tool" icon={ArrowUp} reason={unavailable}>Push<ChevronDown className="dropdown-icon" /></Button></div>
      <div className="tool-group"><Button className="tool" icon={GitBranch} reason={unavailable}>Branch</Button><Button className="tool" icon={Layers} reason={unavailable}>Stash</Button><Button className="tool" icon={Upload} reason="Pop: stash is empty">Pop</Button></div>
      <div className="tool-group"><Button className={`tool ${consoleOpen ? 'pressed' : ''}`} icon={SquareTerminal} title={`${mod}+J`} aria-pressed={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>Terminal</Button></div>
      <div className="toolbar-end"><Button reason={unavailable}>Actions<ChevronDown /></Button><Button icon={Search} title={`${mod}+F`} reason={active === 'demo' || repositoryActive ? undefined : 'Open a repository to search'} onClick={focusSearch}>Search</Button></div>
    </section>
    {startupError && <div className="startup-error" role="status">{startupError}</div>}
    {!ready && <div className="loading-shell" aria-label="Loading workspace" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>}
    {ready && <div className="workspace-container">
      {demoOpen && <div className="workspace-tab" hidden={active !== 'demo'}><Workspace filterRef={filterRef} mod={mod} sidebar={sidebar} onSidebar={() => setSidebar(!sidebar)} searchSignal={focusSearch} /></div>}
      {workspace?.repositories.map(item => <div className="workspace-tab" key={item.id} hidden={active !== `repository:${item.id}`}>
        {item.available ? <HistoryWorkspace repository={item} active={active === `repository:${item.id}`} mod={mod}
          filterRef={node => { if (node) repositoryFilters.current.set(item.id, node); else repositoryFilters.current.delete(item.id); }} onConsole={() => setConsoleOpen(true)} />
          : <RepositoryReady repository={item} onOpen={openRepository} />}
      </div>)}
      {active === 'new' && <main className="welcome"><div className="welcome-mark"><img src="./twig-logo.png" alt="" width="96" height="96" /></div><span className="eyebrow">YOUR NEXT WORKSPACE</span><h1>A clear view of your code.</h1><p>Open a local repository to start exploring its history.</p><div className="welcome-actions"><Button icon={FolderOpen} className="primary" onClick={openRepository}>Open repository</Button><Button icon={ArrowDown} reason="Cloning repositories arrives after the Git executor">Clone repository</Button></div><div className="welcome-demo"><span className="demo-pill">M1</span><p>Git availability, repository selection and command history are ready. The visual commit graph arrives in M2.</p><Button icon={GitBranch} className="primary" onClick={openDemo}>Explore demo workspace</Button></div></main>}
    </div>}
    <Console expanded={consoleOpen} onToggle={() => setConsoleOpen(!consoleOpen)} mod={mod} entries={entries} />
    {dialog && <Dialog title={dialog} onClose={() => setDialog(null)}>
      {dialog === 'Settings' && <><p className="muted">Make this workspace feel like yours.</p><label className="setting-row" htmlFor="theme"><span><strong>Appearance</strong><small>System follows your device setting.</small></span><select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><div className="settings-note">🌱Twig {info?.version || '0.1.0'} · M1<br />Local fonts. No telemetry. No automatic updates.</div></>}
      {dialog === 'Notifications' && <div className="dialog-empty"><Bell /><h3>You’re all caught up.</h3><p>Git checks and repository activity appear in the command console.</p></div>}
      {dialog === 'Git profile' && <div className="dialog-empty"><UserRound /><h3>Your Git identity</h3><p>Git name, email and SSH settings arrive in M5. This preview does not read or change your Git configuration.</p></div>}
    </Dialog>}
  </div>;
}

function RepositoryReady({ repository, onOpen }) {
  if (!repository) return null;
  const status = repository.status;
  return <main className="repository-ready"><GitBranch /><span className="eyebrow">CONNECTED REPOSITORY</span><h1>{repository.name}</h1><p className="repository-path">{repository.path}</p>
    {!repository.available && <><strong>Repository is unavailable.</strong><p>It may have moved or been removed. Choose its current location to reconnect it.</p><Button icon={FolderOpen} className="primary" onClick={onOpen}>Open repository</Button></>}
    {repository.available && status?.error && <><strong>{status.error}</strong><p>Open the console to see the exact Git command and output.</p></>}
    {repository.available && status?.branch && <><strong>{status.branch.detached ? 'Detached HEAD' : status.branch.name || 'Unborn branch'}</strong><p>{status.entries.length} changed file{status.entries.length === 1 ? '' : 's'} · Commit graph and file diffs arrive in M2.</p></>}
  </main>;
}
