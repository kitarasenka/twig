import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Clipboard, CornerDownLeft, Search, Terminal } from 'lucide-react';
import Button from '../ui/Button.jsx';
import ConsoleSplitter from './ConsoleSplitter.jsx';
import { readConsoleHeight } from '../ui/panel-width.js';
import { isUserCommand } from './command-source.js';
import { plainText } from './console-entries.js';
import { commandLine, commandWords, readCommandView, readPathView, writeCommandView, writePathView } from './short-command.js';
import { checkReadOnly, tokenize } from '../../../main/git/read-only-command.js';
import { failureText, t, tr } from '../i18n/i18n.js';

// The exact command: what the status bar's hover names and what Copy takes.
function commandText(entry) { return commandLine(entry, false); }
function elapsed(entry) { return entry.ms === null ? t('running') : t`${entry.ms}ms`; }
function startedText(entry) { return entry.startedAt.replace('T', ' ').replace(/\.\d+/, '').replace('Z', ''); }

const failed = entry => entry.code !== null && entry.code !== 0 && !entry.cancelled;
async function copy(value) { try { await navigator.clipboard.writeText(value); } catch { /* Clipboard access may be unavailable in a locked-down desktop session. */ } }

// Newest entries drawn at first: the rest of a 2000-entry journal is 30 000
// nodes to lay out on every open of Full History.
const CONSOLE_PAGE = 300;

/** One journal entry. Entries keep their identity until they change, so a batch of events draws only the new ones. */
const ConsoleEntry = memo(function ConsoleEntry({ entry, open, focused, short, showPath, output, onToggle, register }) {
  const mine = isUserCommand(entry.operation);
  const stdout = open ? plainText((entry.lazy ? output : entry)?.stdout || '') : '';
  const stderr = open ? plainText((entry.lazy ? output : entry)?.stderr || '') : '';
  return <article ref={node => register(entry.id, node)} className={`console-entry ${failed(entry) ? 'failed' : ''} ${focused ? 'focused' : ''}`}>
    <button className="console-entry-summary" onClick={() => onToggle(entry.id)} aria-expanded={open}><ChevronRight className={open ? 'expanded-arrow' : ''} />{entry.operation?.startsWith('MCP:') && <b className="console-tag" title={t`${entry.operation} — asked by an AI agent through the MCP server`}>MCP</b>}<code title={short || !showPath ? `${commandText(entry)}\n(cwd: ${entry.cwd})` : undefined}><span className={`console-prompt-mark ${mine ? '' : 'twig'}`} title={mine ? t('You ran this') : t('🌱 Twig ran this on its own')}>{isUserCommand(entry.operation) ? '$' : '🌱 :'}</span> {commandWords(entry, short)}</code>{showPath && <span>(cwd: {entry.cwd})</span>}<small>{startedText(entry)} · {entry.cancelled ? t('stopped') : entry.code ?? '…'} · {elapsed(entry)}</small></button>
    {open && <div className="console-output"><div className="console-copy"><Button icon={Clipboard} onClick={() => copy(`${commandText(entry)}\n(cwd: ${entry.cwd})\n${stdout}${stderr}`)}>{t('Copy entry')}</Button></div>{stdout && <pre>{stdout}</pre>}{stderr && <pre className="stderr">{stderr}</pre>}{!stdout && !stderr && <p className="muted">{entry.lazy && !output ? t('Loading output…') : t('Waiting for output…')}</p>}</div>}
  </article>;
});

export function Console({ expanded, onToggle, entries, repositoryId = null, focus = null }) {
  const [query, setQuery] = useState('');
  // "My" is the default view: the journal is mostly the app reading state for
  // itself, and the question a person opens the console with is "what did I do".
  const [mode, setMode] = useState('mine');
  // Short hides the flags 🌱 Twig adds to every git call (`--no-pager -c …`,
  // `-z`, `:(literal)`): the list reads like commands a person types. Full is
  // the exact argv; the hover of a short line and Copy entry always give it.
  const [commandView, setCommandView] = useState(() => readCommandView(globalThis.localStorage));
  const short = commandView === 'short';
  const toggleShort = value => { const next = value ? 'short' : 'full'; setCommandView(next); writeCommandView(globalThis.localStorage, next); };
  // The folder each command ran in: the same for every line of one tab, so it
  // is hidden by default. The hover and Copy entry keep it.
  const [showPath, setShowPath] = useState(() => readPathView(globalThis.localStorage));
  const togglePath = value => { setShowPath(value); writePathView(globalThis.localStorage, value); };
  const [expandedId, setExpandedId] = useState(null);
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [focusedId, setFocusedId] = useState(null);
  const [height, setHeight] = useState(() => readConsoleHeight(globalThis.localStorage));
  const [limit, setLimit] = useState(CONSOLE_PAGE);
  const entryNodes = useRef(new Map());
  const register = useCallback((id, node) => { if (node) entryNodes.current.set(id, node); else entryNodes.current.delete(id); }, []);
  const toggleEntry = useCallback(id => { setFocusedId(null); setExpandedId(value => (value === id ? null : id)); }, []);
  // The output of the app's own reads is not sent with the journal: it arrives
  // when its entry is opened (again once a running one finishes).
  const [outputs, setOutputs] = useState(() => new Map());
  const opened = entries.find(entry => entry.id === expandedId);
  const lazyId = opened?.lazy ? opened.id : null;
  const lazyState = opened?.state;
  useEffect(() => {
    if (!lazyId || !window.twig?.getConsoleOutput) return undefined;
    let alive = true;
    window.twig.getConsoleOutput(lazyId)
      .then(output => { if (alive && output) setOutputs(current => new Map(current).set(lazyId, output)); })
      .catch(() => {});
    return () => { alive = false; };
  }, [lazyId, lazyState]);

  // Expand the output of the last command the user typed, so it is readable
  // the moment it finishes rather than after a manual click.
  const lastTypedId = entries.filter(entry => entry.operation === 'Console command').at(-1)?.id;
  useEffect(() => { if (lastTypedId) setExpandedId(lastTypedId); }, [lastTypedId]);
  useEffect(() => { setError(''); }, [repositoryId]);
  useEffect(() => { if (!expanded) setLimit(CONSOLE_PAGE); }, [expanded]);

  // "Show output" next to an error hands us the entry that failed: reveal it
  // instead of dropping the reader at the top of a 2000-line journal. The
  // filter is cleared first, otherwise the entry could be filtered out of view.
  useEffect(() => {
    if (!focus) return undefined;
    setMode('all'); setQuery(''); setExpandedId(focus.id); setFocusedId(focus.id); setLimit(Infinity);
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
    try { argv = tokenize(value); } catch (failure) { setError(tr(failure.message)); return; }
    const verdict = checkReadOnly(argv);
    if (!verdict.ok) { setError(tr(verdict.reason)); return; }
    setRunning(true); setError('');
    try {
      await window.twig.runConsoleCommand(repositoryId, value);
      setHistory(entriesSoFar => (entriesSoFar.at(-1) === value ? entriesSoFar : [...entriesSoFar, value]));
      setHistoryIndex(-1);
      setCommand('');
    } catch (failure) {
      setError(failureText(failure, String(failure)));
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

  const visible = useMemo(() => entries.filter(entry => {
    const source = `${entry.operation} ${entry.argv.join(' ')} ${entry.cwd}`.toLowerCase();
    return (mode === 'all' || isUserCommand(entry.operation)) && source.includes(query.toLowerCase());
  }).reverse(), [entries, mode, query]);
  const latest = entries.at(-1);
  // The status bar speaks for the person, like the "My" filter: the last thing
  // they asked for, by name. The app's own reads (and their long argv) stay in
  // Full History; the exact command is one hover or one click away.
  const mine = entries.findLast(entry => isUserCommand(entry.operation));
  const outcome = entry => (entry.code === null ? t('running') : entry.code === 0 ? t`done · ${elapsed(entry)}`
    : entry.cancelled ? t`stopped by 🌱 Twig · ${elapsed(entry)}` : t`failed with exit code ${entry.code} · ${elapsed(entry)}`);
  return <section className={`console ${expanded ? 'expanded' : ''}`} aria-label={t('Command console')} style={height === null ? undefined : { '--console-height': `${height}px` }}>
    {expanded && <ConsoleSplitter height={height} onHeight={setHeight} />}
    <button className="console-status" onClick={onToggle} aria-expanded={expanded} title={t('Show or hide the console')}>
      <Terminal /><strong>{t('CONSOLE')}</strong><ChevronDown className={expanded ? '' : 'rotate'} />
      <span className={`console-last ${mine && failed(mine) ? 'failed' : ''}`} title={mine ? commandText(mine) : undefined}>
        {mine ? <>{mine.operation || commandText(mine)} <small>{outcome(mine)}</small></> : t('Nothing you ran yet')}</span>
      {latest?.state === 'running' && <span className="console-tail">{t`Running: ${latest.operation || 'git'}`}</span>}
    </button>
    {expanded && <div className="console-body">
      <div className="console-tools"><div className="segmented" aria-label={t('Command filter')}><button aria-pressed={mode === 'all'} onClick={() => setMode('all')} title={t('Every git command, including the ones 🌱 Twig runs on its own')}>{t('Full History')}</button><button aria-pressed={mode === 'mine'} onClick={() => setMode('mine')} title={t('Only the commands you asked for')}>{t('My')}</button></div><label className="console-search"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search commands')} aria-label={t('Search command log')} /></label><label className="switch console-short" title={t('Short: commands as you would type them. Off: the exact command, with the flags 🌱 Twig adds to every git call')}><input type="checkbox" checked={short} onChange={event => toggleShort(event.target.checked)} /><span className="track" />{t('Short')}</label><label className="switch console-path" title={t('Show the folder each command ran in')}><input type="checkbox" checked={showPath} onChange={event => togglePath(event.target.checked)} /><span className="track" />{t('Path')}</label></div>
      {visible.length === 0 && <div className="console-empty"><Terminal /><div><strong>{t('Your commands, in plain sight.')}</strong><p>{entries.length === 0 ? t('Git checks, repository status and future actions appear here.')
        : query ? t('No commands match this search.')
          : mode === 'mine' ? t('Nothing you ran yet. Full History also shows what 🌱 Twig runs on its own.')
            : t('No commands match this filter.')}</p></div></div>}
      {visible.slice(0, limit).map(entry => <ConsoleEntry key={entry.id} entry={entry} open={expandedId === entry.id} focused={focusedId === entry.id}
        short={short} showPath={showPath} output={outputs.get(entry.id)} onToggle={toggleEntry} register={register} />)}
      {visible.length > limit && <button type="button" className="text-button list-show-all" onClick={() => setLimit(value => value + CONSOLE_PAGE * 2)}>{t('Show older commands')}</button>}
      <div className="console-dock">
        {error && <p className="console-input-error" role="alert">{error}</p>}
        <form className="console-input" onSubmit={runCommand}>
          <span className="console-prompt" aria-hidden="true">$ git</span>
          <input className="console-command" value={command} spellCheck={false} autoCorrect="off" autoCapitalize="off"
            onChange={(event) => { setCommand(event.target.value); setError(''); }} onKeyDown={recallHistory}
            disabled={!repositoryId || running} aria-label={t('Run a read-only git command')}
            placeholder={repositoryId ? t('log --oneline -10   ·   read-only commands only') : t('Open a repository to run git commands')} />
          <Button icon={CornerDownLeft} type="submit"
            reason={!repositoryId ? t('Open a repository first') : running ? t('A command is running…') : !command.trim() ? t('Type a git command') : undefined}>{t('Run')}</Button>
        </form>
      </div>
    </div>}
  </section>;
}
