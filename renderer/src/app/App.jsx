import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bell, ChevronDown, FolderOpen, GitBranch, Layers, Plus, Redo2, Search, Settings, SquareTerminal, Undo2, Upload, UserRound, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Dialog from '../ui/Dialog.jsx';
import Workspace from './Workspace.jsx';
import { Console } from './Panels.jsx';

const unavailable = 'Connect a repository in M1; this is a layout preview';
function initialTheme() {
  try { const value = localStorage.getItem('git-desk:theme'); return ['dark', 'light'].includes(value) ? value : 'system'; }
  catch { return 'system'; }
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
  const [startupError, setStartupError] = useState('');
  const filterRef = useRef(null);
  const mod = info?.platform === 'darwin' || (!info && /Mac/.test(navigator.platform)) ? 'Cmd' : 'Ctrl';
  const ready = info !== null || Boolean(startupError);

  useEffect(() => {
    let alive = true;
    if (!window.gitDesk) { setStartupError('Browser preview. Launch the desktop app with npm run dev.'); return; }
    window.gitDesk.getAppInfo().then(value => { if (alive) setInfo(value); })
      .catch(() => { if (alive) setStartupError('Desktop connection unavailable. Restart Git Desk.'); });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)');
    function apply() { document.documentElement.dataset.theme = theme === 'system' ? (system.matches ? 'dark' : 'light') : theme; }
    apply();
    try { localStorage.setItem('git-desk:theme', theme); } catch { /* Preference remains session-local if storage is unavailable. */ }
    system.addEventListener('change', apply);
    return () => system.removeEventListener('change', apply);
  }, [theme]);
  function openEmpty() { setEmptyOpen(true); setActive('new'); }
  function openDemo() { setDemoOpen(true); setActive('demo'); }
  function focusSearch() { setSidebar(false); requestAnimationFrame(() => filterRef.current?.focus()); }
  useEffect(() => {
    function keydown(event) {
      if (dialog || !(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'j') { event.preventDefault(); setConsoleOpen(value => !value); }
      if (key === ',') { event.preventDefault(); setDialog('Settings'); }
      if (key === 't') { event.preventDefault(); openEmpty(); }
      if (key === 'b') { event.preventDefault(); setSidebar(value => !value); }
      if (key === 'f' && active === 'demo') { event.preventDefault(); focusSearch(); }
      if (key === 'w') {
        event.preventDefault();
        if (active === 'demo') { setDemoOpen(false); openEmpty(); }
        else if (demoOpen) { setEmptyOpen(false); setActive('demo'); }
      }
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [dialog, active, demoOpen]);

  return <div className="app-shell">
    <header className="tab-bar"><div className="brand"><span className="brand-mark"><GitBranch /></span><strong>git desk<span className="brand-dot">.</span></strong></div>
      <nav className="tabs" aria-label="Repository tabs">
        {demoOpen && <div className={`tab ${active === 'demo' ? 'active' : ''}`}><button aria-current={active === 'demo' ? 'page' : undefined} onClick={() => setActive('demo')}><GitBranch /><span>workspace-demo</span><small>DEMO</small></button><Button icon={X} aria-label="Close demo tab" title={`${mod}+W`} onClick={() => { setDemoOpen(false); openEmpty(); }} /></div>}
        {emptyOpen && <div className={`tab ${active === 'new' ? 'active' : ''}`}><button aria-current={active === 'new' ? 'page' : undefined} onClick={() => setActive('new')}><FolderOpen />New repository</button>{demoOpen && <Button icon={X} aria-label="Close new tab" onClick={() => { setEmptyOpen(false); setActive('demo'); }} />}</div>}
        <Button icon={Plus} aria-label="New repository tab" title={`${mod}+T`} onClick={openEmpty} />
      </nav>
      <div className="account-actions"><Button icon={Bell} aria-label="Notifications" title="Notifications" onClick={() => setDialog('Notifications')} /><Button icon={Settings} aria-label="Settings" title={`Settings · ${mod}+,`} onClick={() => setDialog('Settings')} /><Button icon={UserRound} aria-label="Git profile" title="Git profile" onClick={() => setDialog('Git profile')} /></div>
    </header>
    <section className="toolbar" aria-label="Git actions">
      <div className="repo-select"><label htmlFor="repository-select">REPOSITORY</label><select id="repository-select" value={active} onChange={(e) => e.target.value === 'demo' ? openDemo() : openEmpty()}><option value="demo">workspace-demo</option><option value="new">New repository…</option></select></div>
      <div className="branch-select"><span>CURRENT BRANCH</span><Button icon={GitBranch} reason={unavailable}>{active === 'demo' ? 'main' : 'No branch'}<ChevronDown /></Button></div>
      <div className="tool-group"><Button className="tool" icon={Undo2} reason="Undo: no actions to undo">Undo</Button><Button className="tool" icon={Redo2} reason="Redo: no next action">Redo</Button></div>
      <div className="tool-group"><Button className="tool" icon={ArrowDown} reason={unavailable}>Pull<ChevronDown className="dropdown-icon" /></Button><Button className="tool" icon={ArrowUp} reason={unavailable}>Push<ChevronDown className="dropdown-icon" /></Button></div>
      <div className="tool-group"><Button className="tool" icon={GitBranch} reason={unavailable}>Branch</Button><Button className="tool" icon={Layers} reason={unavailable}>Stash</Button><Button className="tool" icon={Upload} reason="Pop: stash is empty">Pop</Button></div>
      <div className="tool-group"><Button className={`tool ${consoleOpen ? 'pressed' : ''}`} icon={SquareTerminal} title={`${mod}+J`} aria-pressed={consoleOpen} onClick={() => setConsoleOpen(!consoleOpen)}>Terminal</Button></div>
      <div className="toolbar-end"><Button reason={unavailable}>Actions<ChevronDown /></Button><Button icon={Search} title={`${mod}+F`} reason={active === 'demo' ? undefined : 'Open the demo to search its history'} onClick={focusSearch}>Search</Button></div>
    </section>
    {startupError && <div className="startup-error" role="status">{startupError}</div>}
    {!ready && <div className="loading-shell" aria-label="Loading workspace" aria-busy="true">{Array.from({ length: 12 }, (_, i) => <div className="skeleton" key={i} />)}</div>}
    {ready && <div className="workspace-container">
      {demoOpen && <div className="workspace-tab" hidden={active !== 'demo'}><Workspace filterRef={filterRef} mod={mod} sidebar={sidebar} onSidebar={() => setSidebar(!sidebar)} searchSignal={focusSearch} /></div>}
      {active === 'new' && <main className="welcome"><div className="welcome-mark"><GitBranch /></div><span className="eyebrow">YOUR NEXT WORKSPACE</span><h1>A clear view of your code.</h1><p>Open a repository or clone one to start exploring its history.</p><div className="welcome-actions"><Button icon={FolderOpen} reason="Opening local repositories arrives in M1">Open repository</Button><Button icon={ArrowDown} reason="Cloning repositories arrives after the Git executor">Clone repository</Button></div><div className="welcome-demo"><span className="demo-pill">M0 PREVIEW</span><p>The desktop shell is ready. Explore a sample workspace while Git integration is being built.</p><Button icon={GitBranch} className="primary" onClick={openDemo}>Explore demo workspace</Button></div></main>}
    </div>}
    <Console expanded={consoleOpen} onToggle={() => setConsoleOpen(!consoleOpen)} mod={mod} />
    {dialog && <Dialog title={dialog} onClose={() => setDialog(null)}>
      {dialog === 'Settings' && <><p className="muted">Make this workspace feel like yours.</p><label className="setting-row" htmlFor="theme"><span><strong>Appearance</strong><small>System follows your device setting.</small></span><select id="theme" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select></label><div className="settings-note">Git Desk {info?.version || '0.1.0'} · M0 preview<br />Local fonts. No telemetry. No automatic updates.</div></>}
      {dialog === 'Notifications' && <div className="dialog-empty"><Bell /><h3>You’re all caught up.</h3><p>No operations have run. Fetch results and errors will appear here after Git integration.</p></div>}
      {dialog === 'Git profile' && <div className="dialog-empty"><UserRound /><h3>Your Git identity</h3><p>Git name, email and SSH settings arrive in M5. This preview does not read or change your Git configuration.</p></div>}
    </Dialog>}
  </div>;
}
