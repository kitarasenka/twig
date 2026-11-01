import { useEffect, useState } from 'react';
import { Bot, Check, Copy, FileDiff, History, ListChecks, MessageSquareText, MousePointerClick, Plug, ShieldCheck } from 'lucide-react';
import { TOOLS } from '../../../../main/mcp/protocol.mjs';
import Button from '../../ui/Button.jsx';
import { mcpStatusLine } from './mcp-view.js';
import { failureText, mark, t } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

// What an agent can ask for, in the order a good agent asks: summary, then one
// file, then history — and what is on screen here.
const GIVES = [
  { icon: ListChecks, title: mark('The state of your work'), text: mark('Branch, ahead/behind, a merge or rebase in progress, and which files are staged, changed, untracked or conflicted — in a few hundred bytes.') },
  { icon: FileDiff, title: mark('Every change in one answer'), text: mark('Each file as one line with its line counts and its hunks below, in plain git shapes. Lock files and huge files arrive as one line, and the agent can still open any file or hunk on its own.') },
  { icon: History, title: mark('History and commits'), text: mark('Compact commit lists for any branch, then one commit’s message and files, then its diff for one file.') },
  { icon: MousePointerClick, title: mark('What you have selected here'), text: mark('The commit, compare range or file open in 🌱 Twig, so “explain this commit” needs no hash pasted.') }
];

const PROMPTS = [
  mark('Look at my current changes and suggest how to split them into commits.'),
  mark('Explain the commit I have selected in Twig.'),
  mark('Review the staged diff before I commit.'),
  mark('Summarise what happened on main in the last 20 commits.')
];

const CLIENTS = [
  { key: 'claude', title: 'Claude Code', where: mark('Run in a terminal once. --scope user makes it available in every project.') },
  { key: 'codex', title: 'Codex', where: mark('Add to ~/.codex/config.toml.') },
  { key: 'json', title: mark('Cursor and other clients'), where: mark('Merge into ~/.cursor/mcp.json, or the mcpServers file your client reads.') }
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
    window.twig.getMcpSettings().then(value => { if (alive) { setSettings(value); onChange(value); } }).catch(failure => { if (alive) setError(failureText(failure)); });
    return () => { alive = false; };
    // Read once per opening; onChange is the parent's state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  async function choose(enabled) {
    setBusy(true); setError('');
    try { const next = await window.twig.setMcpEnabled(enabled); setSettings(next); onChange(next); }
    catch (failure) { setError(failureText(failure, t('Could not change the MCP server.'))); }
    finally { setBusy(false); }
  }
  async function allowCommits(allowed) {
    setBusy(true); setError('');
    try { const next = await window.twig.setMcpCommitsAllowed(allowed); setSettings(next); onChange(next); }
    catch (failure) { setError(failureText(failure, t('Could not change this setting.'))); }
    finally { setBusy(false); }
  }
  async function copy(key) {
    await window.twig.copyText(settings.config[key]);
    setCopied(key);
  }
  if (!settings) return <section className="mcp-settings" aria-busy="true">{error ? <p role="alert" className="profile-error">{error}</p> : <p role="status">{t('Loading…')}</p>}</section>;
  const status = settings.status;
  return <section className="mcp-settings" aria-label={t('AI agents (MCP)')}>
    <p className="muted">{t('Lets coding agents such as Claude Code, Codex and Cursor read your repositories through 🌱 Twig: status, changes, diffs one file or hunk at a time, history, and what is selected here. Agents start a small bridge that connects to 🌱 Twig on this computer only.')}</p>
    <label className="setting-row" htmlFor="mcp-enabled"><span><strong>{t('MCP server')}</strong>
      <small>{settings.enabled ? t('On while 🌱 Twig is running. Agents see repositories you connected here.') : t('Off — nothing listens, and agents get a message that 🌱 Twig is off.')}</small></span>
      <select id="mcp-enabled" value={settings.enabled ? 'on' : 'off'} disabled={busy} onChange={(e) => void choose(e.target.value === 'on')}>
        <option value="off">{t('Off')}</option><option value="on">{t('On')}</option>
      </select></label>
    <label className="setting-row" htmlFor="mcp-commits"><span><strong>{t('Allow agents to propose commits')}</strong>
      <small>{settings.allowCommits
        ? t('An agent can ask to commit all changes with its message. 🌱 Twig shows the files and the message here; nothing is committed until you press Commit.')
        : t('Off — agents can only read. A commit proposal is refused.')}</small></span>
      <select id="mcp-commits" value={settings.allowCommits ? 'on' : 'off'} disabled={busy} onChange={(e) => void allowCommits(e.target.value === 'on')}>
        <option value="off">{t('Off')}</option><option value="on">{t('On')}</option>
      </select></label>
    {mcpStatusLine(status) && <p className={`update-note ${status.error ? 'profile-error' : ''}`} role={status.error ? 'alert' : 'status'}>{mcpStatusLine(status)}</p>}
    {error && <p className="profile-error" role="alert">{error}</p>}
    <p className="visually-hidden" role="status">{copied ? t`${t(CLIENTS.find(client => client.key === copied).title)} configuration copied.` : ''}</p>
    <p className="mcp-guarantee"><ShieldCheck aria-hidden="true" /><span>{settings.allowCommits
      ? tx('{lead} An agent can only propose one; it cannot stage, check out or run commands. Every Git command an agent causes is in the console’s Full History.', { lead: <strong>{t('You confirm every commit.')}</strong> })
      : tx('{lead} There is no tool to commit, stage, check out or run commands. Every Git command an agent causes is in the console’s Full History, tagged MCP.', { lead: <strong>{t('Read-only.')}</strong> })}</span></p>
    <h3 className="mcp-heading"><Bot aria-hidden="true" />{t('What your agent gets')}</h3>
    <ul className="mcp-gives">{GIVES.map(item => <li key={item.title}><item.icon aria-hidden="true" /><span><strong>{t(item.title)}</strong><small>{t(item.text)}</small></span></li>)}</ul>
    <h3 className="mcp-heading"><ListChecks aria-hidden="true" />{t('Available MCP tools')}</h3>
    <p className="muted mcp-tools-note">{t('These names and descriptions are the tools agents receive from Twig. Commit tools can only propose a commit; Twig still asks you to approve it.')}</p>
    <ul className="mcp-tool-list" aria-label={t('MCP tools and descriptions')}>{TOOLS.map(tool => {
      const readOnly = tool.annotations.readOnlyHint;
      const access = readOnly ? t('Read-only') : settings.allowCommits ? t('Commit proposal enabled') : t('Commit proposal disabled');
      return <li key={tool.name}>
        <div className="mcp-tool-title"><span><strong>{tool.title}</strong><code>{tool.name}</code></span>
          <small className={readOnly ? '' : 'mcp-tool-write'}>{access}</small></div>
        <p>{tool.description}</p>
      </li>;
    })}</ul>
    <h3 className="mcp-heading"><Plug aria-hidden="true" />{t('Connect an agent')}</h3>
    <ol className="mcp-steps"><li>{tx('Turn the server {on} above.', { on: <strong>{t('On')}</strong> })}</li><li>{t('Copy the line for your agent below and run or paste it once.')}</li><li>{t('Restart the agent and ask it about your repository.')}</li></ol>
    {CLIENTS.map(client => <div className="mcp-client" key={client.key}>
      <div className="mcp-client-head"><span><strong>{t(client.title)}</strong><small>{t(client.where)}</small></span>
        <Button icon={copied === client.key ? Check : Copy} onClick={() => void copy(client.key)} aria-label={t`Copy ${t(client.title)} configuration`}>{copied === client.key ? t('Copied') : t('Copy')}</Button></div>
      {/* Focusable so the keyboard can scroll it when it is taller than its box. */}
      <pre className="mcp-config" tabIndex={0} aria-label={t`${t(client.title)} configuration`}><code>{settings.config[client.key]}</code></pre>
    </div>)}
    <h3 className="mcp-heading"><MessageSquareText aria-hidden="true" />{t('Try asking')}</h3>
    <ul className="mcp-prompts">{PROMPTS.map(prompt => <li key={prompt}>{t`“${t(prompt)}”`}</li>)}</ul>
    <p className="settings-note">{t('The agent proposes; you decide. It cannot stage or commit — do that here, where every step can be undone. The bridge runs on 🌱 Twig’s own executable, so no separate Node.js is needed; if 🌱 Twig is closed, the agent’s tools answer that 🌱 Twig is off.')}</p>
  </section>;
}
