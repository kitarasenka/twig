import { useEffect, useState } from 'react';
import { Bot, Check, Copy, FileDiff, History, ListChecks, MessageSquareText, MousePointerClick, Plug, ShieldCheck } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { mcpStatusLine } from './mcp-view.js';

// What an agent can ask for, in the order a good agent asks: summary, then one
// file, then history — and what is on screen here.
const GIVES = [
  { icon: ListChecks, title: 'The state of your work', text: 'Branch, ahead/behind, a merge or rebase in progress, and which files are staged, changed, untracked or conflicted — in a few hundred bytes.' },
  { icon: FileDiff, title: 'Every change in one answer', text: 'Each file as one line with its line counts and its hunks below, in plain git shapes. Lock files and huge files arrive as one line, and the agent can still open any file or hunk on its own.' },
  { icon: History, title: 'History and commits', text: 'Compact commit lists for any branch, then one commit’s message and files, then its diff for one file.' },
  { icon: MousePointerClick, title: 'What you have selected here', text: 'The commit, compare range or file open in 🌱 Twig, so “explain this commit” needs no hash pasted.' }
];

const PROMPTS = [
  'Look at my current changes and suggest how to split them into commits.',
  'Explain the commit I have selected in Twig.',
  'Review the staged diff before I commit.',
  'Summarise what happened on main in the last 20 commits.'
];

const CLIENTS = [
  { key: 'claude', title: 'Claude Code', where: 'Run in a terminal once. --scope user makes it available in every project.' },
  { key: 'codex', title: 'Codex', where: 'Add to ~/.codex/config.toml.' },
  { key: 'json', title: 'Cursor and other clients', where: 'Merge into ~/.cursor/mcp.json, or the mcpServers file your client reads.' }
];

/**
 * Settings → AI agents (MCP). The switch lives in main, which owns the socket;
 * the configuration shown is what main computed for this installation, so the
 * paths are the real ones and nothing here is typed by hand.
 */
export default function McpSettings({ onBusyChange, onChange = () => {} }) {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let alive = true;
    window.twig.getMcpSettings().then(value => { if (alive) { setSettings(value); onChange(value); } }).catch(failure => { if (alive) setError(failure.message); });
    return () => { alive = false; };
    // Read once per opening; onChange is the parent's state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function choose(enabled) {
    setBusy(true); setError('');
    try { const next = await window.twig.setMcpEnabled(enabled); setSettings(next); onChange(next); }
    catch (failure) { setError(failure.message || 'Could not change the MCP server.'); }
    finally { setBusy(false); }
  }
  async function copy(key) {
    await window.twig.copyText(settings.config[key]);
    setCopied(key);
  }
  if (!settings) return <section className="mcp-settings" aria-busy="true">{error ? <p role="alert" className="profile-error">{error}</p> : <p role="status">Loading…</p>}</section>;
  const status = settings.status;
  return <section className="mcp-settings" aria-label="AI agents (MCP)">
    <p className="muted">Lets coding agents such as Claude Code, Codex and Cursor read your repositories through 🌱 Twig: status, changes, diffs one file or hunk at a time, history, and what is selected here. Agents start a small bridge that connects to 🌱 Twig on this computer only.</p>
    <label className="setting-row" htmlFor="mcp-enabled"><span><strong>MCP server</strong>
      <small>{settings.enabled ? 'On while 🌱 Twig is running. Agents see repositories you connected here.' : 'Off — nothing listens, and agents get a message that 🌱 Twig is off.'}</small></span>
      <select id="mcp-enabled" value={settings.enabled ? 'on' : 'off'} disabled={busy} onChange={(e) => void choose(e.target.value === 'on')}>
        <option value="off">Off</option><option value="on">On</option>
      </select></label>
    {mcpStatusLine(status) && <p className={`update-note ${status.error ? 'profile-error' : ''}`} role={status.error ? 'alert' : 'status'}>{mcpStatusLine(status)}</p>}
    {error && <p className="profile-error" role="alert">{error}</p>}
    <p className="visually-hidden" role="status">{copied ? `${CLIENTS.find(client => client.key === copied).title} configuration copied.` : ''}</p>
    <p className="mcp-guarantee"><ShieldCheck aria-hidden="true" /><span><strong>Read-only.</strong> There is no tool to commit, stage, check out or run commands. Every Git command an agent causes is in the console’s Full History, tagged MCP.</span></p>
    <h3 className="mcp-heading"><Bot aria-hidden="true" />What your agent gets</h3>
    <ul className="mcp-gives">{GIVES.map(item => <li key={item.title}><item.icon aria-hidden="true" /><span><strong>{item.title}</strong><small>{item.text}</small></span></li>)}</ul>
    <h3 className="mcp-heading"><Plug aria-hidden="true" />Connect an agent</h3>
    <ol className="mcp-steps"><li>Turn the server <strong>On</strong> above.</li><li>Copy the line for your agent below and run or paste it once.</li><li>Restart the agent and ask it about your repository.</li></ol>
    {CLIENTS.map(client => <div className="mcp-client" key={client.key}>
      <div className="mcp-client-head"><span><strong>{client.title}</strong><small>{client.where}</small></span>
        <Button icon={copied === client.key ? Check : Copy} onClick={() => void copy(client.key)} aria-label={`Copy ${client.title} configuration`}>{copied === client.key ? 'Copied' : 'Copy'}</Button></div>
      {/* Focusable so the keyboard can scroll it when it is taller than its box. */}
      <pre className="mcp-config" tabIndex={0} aria-label={`${client.title} configuration`}><code>{settings.config[client.key]}</code></pre>
    </div>)}
    <h3 className="mcp-heading"><MessageSquareText aria-hidden="true" />Try asking</h3>
    <ul className="mcp-prompts">{PROMPTS.map(prompt => <li key={prompt}>“{prompt}”</li>)}</ul>
    <p className="settings-note">The agent proposes; you decide. It cannot stage or commit — do that here, where every step can be undone. The bridge runs on 🌱 Twig’s own executable, so no separate Node.js is needed; if 🌱 Twig is closed, the agent’s tools answer that 🌱 Twig is off.</p>
  </section>;
}
