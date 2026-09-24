import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Clipboard, CornerDownLeft, Search, Terminal } from 'lucide-react';
import Button from '../ui/Button.jsx';
import { isUserCommand } from './command-source.js';
import { checkReadOnly, tokenize } from '../../../main/git/read-only-command.js';

function commandText(entry) { return `$ ${entry.executable || 'git'} ${entry.argv.join(' ')}`; }
function elapsed(entry) { return entry.ms === null ? 'running' : `${entry.ms}ms`; }
function startedText(entry) { return entry.startedAt.replace('T', ' ').replace(/\.\d+/, '').replace('Z', ''); }

export function Console({ expanded, onToggle, mod, entries, repositoryId = null, focus = null }) {
  const [query, setQuery] = useState('');
  // "My" is the default view: the journal is mostly the app reading state for
  // itself, and the question a person opens the console with is "what did I do".
  const [mode, setMode] = useState('mine');
  const [expandedId, setExpandedId] = useState(null);
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [focusedId, setFocusedId] = useState(null);
  const entryNodes = useRef(new Map());

  // Expand the output of the last command the user typed, so it is readable
  // the moment it finishes rather than after a manual click.
  const lastTypedId = entries.filter(entry => entry.operation === 'Console command').at(-1)?.id;
  useEffect(() => { if (lastTypedId) setExpandedId(lastTypedId); }, [lastTypedId]);
  useEffect(() => { setError(''); }, [repositoryId]);

  // "Show output" next to an error hands us the entry that failed: reveal it
  // instead of dropping the reader at the top of a 2000-line journal. The
  // filter is cleared first, otherwise the entry could be filtered out of view.
  useEffect(() => {
    if (!focus) return undefined;
    setMode('all'); setQuery(''); setExpandedId(focus.id); setFocusedId(focus.id);
    const frame = requestAnimationFrame(() => {
      const node = entryNodes.current.get(focus.id);
      if (!node) return;
      node.scrollIntoView({ block: 'nearest' });
      node.querySelector('.console-entry-summary')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  async function runCommand(event) {
    event.preventDefault();
    const value = command.trim();
    if (!value || !repositoryId || running) return;
    let argv;
    try { argv = tokenize(value); } catch (failure) { setError(failure.message); return; }
    const verdict = checkReadOnly(argv);
    if (!verdict.ok) { setError(verdict.reason); return; }
    setRunning(true); setError('');
    try {
      await window.twig.runConsoleCommand(repositoryId, value);
      setHistory(entriesSoFar => (entriesSoFar.at(-1) === value ? entriesSoFar : [...entriesSoFar, value]));
      setHistoryIndex(-1);
      setCommand('');
    } catch (failure) {
      setError(String(failure?.message || failure).replace(/^Error:\s*/, ''));
    } finally {
      setRunning(false);
    }
  }

  function recallHistory(event) {
    if (event.key === 'ArrowUp') {
      if (history.length === 0) return;
      event.preventDefault();
      const index = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(index); setCommand(history[index]);
    } else if (event.key === 'ArrowDown') {
      if (historyIndex === -1) return;
      event.preventDefault();
      const index = historyIndex + 1;
      if (index >= history.length) { setHistoryIndex(-1); setCommand(''); }
      else { setHistoryIndex(index); setCommand(history[index]); }
    }
  }

  const visible = entries.filter(entry => {
    const source = `${entry.operation} ${entry.argv.join(' ')} ${entry.cwd}`.toLowerCase();
    return (mode === 'all' || isUserCommand(entry.operation)) && source.includes(query.toLowerCase());
  }).slice().reverse();
  const latest = entries.at(-1);
  // The status bar speaks for the person, like the "My" filter: the last thing
  // they asked for, by name. The app's own reads (and their long argv) stay in
  // Full History; the exact command is one hover or one click away.
  const mine = entries.findLast(entry => isUserCommand(entry.operation));
  const outcome = entry => (entry.code === null ? 'running' : entry.code === 0 ? `done · ${elapsed(entry)}` : `failed with exit code ${entry.code} · ${elapsed(entry)}`);
  async function copy(value) { try { await navigator.clipboard.writeText(value); } catch { /* Clipboard access may be unavailable in a locked-down desktop session. */ } }
  return <section className={`console ${expanded ? 'expanded' : ''}`} aria-label="Command console">
    <button className="console-status" onClick={onToggle} aria-expanded={expanded} title={`Terminal · ${mod}+J`}>
      <Terminal /><strong>CONSOLE</strong><ChevronDown className={expanded ? '' : 'rotate'} />
      <span className={`console-last ${mine && mine.code !== null && mine.code !== 0 ? 'failed' : ''}`} title={mine ? commandText(mine) : undefined}>
        {mine ? <>{mine.operation || commandText(mine)} <small>{outcome(mine)}</small></> : 'Nothing you ran yet'}</span>
      <span className="console-tail">{latest?.state === 'running' ? `Running: ${latest.operation || 'git'}` : '🌱 Twig'}</span>
    </button>
    {expanded && <div className="console-body">
      <div className="console-tools"><div className="segmented" aria-label="Command filter"><button aria-pressed={mode === 'all'} onClick={() => setMode('all')} title="Every git command, including the ones 🌱 Twig runs on its own">Full History</button><button aria-pressed={mode === 'mine'} onClick={() => setMode('mine')} title="Only the commands you asked for">My</button></div><label className="console-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands" aria-label="Search command log" /></label><kbd>{mod}+J</kbd></div>
      {visible.length === 0 && <div className="console-empty"><Terminal /><div><strong>Your commands, in plain sight.</strong><p>{entries.length === 0 ? 'Git checks, repository status and future actions appear here.'
        : query ? 'No commands match this search.'
          : mode === 'mine' ? 'Nothing you ran yet. Full History also shows what 🌱 Twig runs on its own.'
            : 'No commands match this filter.'}</p></div></div>}
      {visible.map(entry => <article key={entry.id} ref={node => { if (node) entryNodes.current.set(entry.id, node); else entryNodes.current.delete(entry.id); }}
        className={`console-entry ${entry.code !== null && entry.code !== 0 ? 'failed' : ''} ${focusedId === entry.id ? 'focused' : ''}`}>
        <button className="console-entry-summary" onClick={() => { setFocusedId(null); setExpandedId(value => value === entry.id ? null : entry.id); }} aria-expanded={expandedId === entry.id}><ChevronRight className={expandedId === entry.id ? 'expanded-arrow' : ''} /><code>{commandText(entry)}</code><span>(cwd: {entry.cwd})</span><small>{startedText(entry)} · {entry.code ?? '…'} · {elapsed(entry)}</small></button>
        {expandedId === entry.id && <div className="console-output"><div className="console-copy"><Button icon={Clipboard} onClick={() => copy(`${commandText(entry)}\n(cwd: ${entry.cwd})\n${entry.stdout}${entry.stderr}`)}>Copy entry</Button></div>{entry.stdout && <pre>{entry.stdout}</pre>}{entry.stderr && <pre className="stderr">{entry.stderr}</pre>}{!entry.stdout && !entry.stderr && <p className="muted">Waiting for output…</p>}</div>}
      </article>)}
      <div className="console-dock">
        {error && <p className="console-input-error" role="alert">{error}</p>}
        <form className="console-input" onSubmit={runCommand}>
          <span className="console-prompt" aria-hidden="true">$ git</span>
          <input className="console-command" value={command} spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(event) => { setCommand(event.target.value); setError(''); }} onKeyDown={recallHistory}
            disabled={!repositoryId || running} aria-label="Run a read-only git command"
            placeholder={repositoryId ? 'log --oneline -10   ·   read-only commands only' : 'Open a repository to run git commands'} />
          <Button icon={CornerDownLeft} type="submit"
            reason={!repositoryId ? 'Open a repository first' : running ? 'A command is running…' : !command.trim() ? 'Type a git command' : undefined}>Run</Button>
        </form>
      </div>
    </div>}
  </section>;
}
