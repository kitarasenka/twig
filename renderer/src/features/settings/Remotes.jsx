import { useEffect, useState } from 'react';
import { ArrowDown, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';

function RemoteRow({ remote, busy, onAction }) {
  const [url, setUrl] = useState(remote.urls[0] || '');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setUrl(remote.urls[0] || ''); setConfirm(false); }, [remote]);
  return <li><form onSubmit={event => { event.preventDefault(); onAction('set-url', remote, url); }}>
    <strong>{remote.name}</strong>
    <label className="manager-field">Primary fetch URL<input value={url} required disabled={busy} spellCheck={false} autoComplete="off" onChange={event => setUrl(event.target.value)} /></label>
    {remote.urls.slice(1).map((address, index) => <p className="manager-path" key={index}>Additional fetch URL: <code>{address}</code></p>)}
    <p className="manager-path">Push: <code>{remote.pushUrls.length ? remote.pushUrls.join(', ') : 'Uses fetch URL'}</code></p>
    <div className="manager-actions"><Button icon={Save} type="submit" reason={busy ? 'Wait for the current action' : url === remote.urls[0] ? 'No URL changes' : undefined}>Save URL</Button><Button icon={ArrowDown} type="button" reason={busy ? 'Wait for the current action' : undefined} onClick={() => onAction('fetch', remote)}>Fetch and prune</Button><Button icon={Trash2} type="button" reason={busy ? 'Wait for the current action' : undefined} onClick={() => setConfirm(true)}>Remove remote</Button></div>
    {confirm && <div className="manager-confirm"><p>Remove {remote.name}? Git will remove its connection settings and remote-tracking branches. Local branches and files stay on disk.</p><Button type="button" reason={busy ? 'Removing…' : undefined} onClick={() => onAction('remove', remote)}>Confirm remote removal</Button><Button type="button" reason={busy ? 'Removing…' : undefined} onClick={() => setConfirm(false)}>Keep remote</Button></div>}
  </form></li>;
}

export default function Remotes({ repository, entries, onBusyChange, onConsole, onChanged }) {
  const [remotes, setRemotes] = useState([]);
  const [busy, setBusy] = useState(true);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let alive = true; setBusy(true); setError('');
    window.twig.getRemotes(repository.id).then(result => { if (alive) setRemotes(result); })
      .catch(failure => { if (alive) setError(failure.message || 'Could not read remotes.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [repository.id, revision]);
  async function act(action, remote, address = null) {
    setBusy(true); setFetching(action === 'fetch'); setError(''); setNotice('');
    try {
      const result = await window.twig.changeRemote(repository.id, action, remote.name, address, action === 'add' ? null : JSON.stringify(remote));
      setNotice(result.cancelled ? 'Fetch cancelled. Git may have already updated some references.' : `${remote.name}: ${action} finished.`);
      if (result.ok && action === 'add') { setName(''); setUrl(''); }
      await onChanged(); setRevision(value => value + 1);
    } catch (failure) { setError(failure.message || 'Could not finish the remote action.'); }
    finally { setBusy(false); setFetching(false); }
  }
  async function cancel() {
    try { await window.twig.cancelRemote(repository.id); setNotice('Cancellation requested. Waiting for Git to exit…'); }
    catch (failure) { setError(failure.message || 'Could not cancel fetch.'); }
  }
  return <section className="repository-manager" aria-label={`Remotes for ${repository.name}`} aria-busy={busy}>
    <p className="muted">Connections for {repository.name}. Fetch runs only when you request it.</p>
    <div className="manager-actions"><Button icon={RefreshCw} reason={busy ? 'Wait for the current action' : undefined} onClick={() => setRevision(value => value + 1)}>Reload remotes</Button><Button onClick={onConsole}>Show output</Button>{fetching && <Button onClick={cancel}>Cancel fetch</Button>}</div>
    <p role="status">{fetching ? 'Fetching… Cancel or wait before closing.' : notice}</p>
    {fetching && <pre className="manager-output" tabIndex={0} aria-label="Live fetch output">{entries.findLast(entry => entry.operation.startsWith('Fetch and prune:'))?.stderr.slice(-6000) || 'Starting Git…'}</pre>}
    {error && <p role="alert" className="profile-error">{error}</p>}
    {busy && !remotes.length && !fetching && <div className="loading-shell" aria-label="Loading remotes"><div className="skeleton" /></div>}
    {!busy && !remotes.length && <p>No remotes connected. Add an address below.</p>}
    <ul className="manager-list">{remotes.map(remote => <RemoteRow key={remote.name} remote={remote} busy={busy} onAction={act} />)}</ul>
    <form className="manager-add" onSubmit={event => { event.preventDefault(); act('add', { name }, url); }}>
      <h3>Add remote</h3><label className="manager-field">Remote name<input required disabled={busy} value={name} maxLength={255} onChange={event => setName(event.target.value)} placeholder="origin" /></label>
      <label className="manager-field">Remote URL<input required disabled={busy} value={url} spellCheck={false} autoComplete="off" onChange={event => setUrl(event.target.value)} placeholder="https://host/team/repository.git" /></label>
      <Button icon={Plus} type="submit" reason={busy ? 'Wait for the current action' : !name || !url ? 'Enter a remote name and address' : undefined}>Add remote</Button>
    </form>
  </section>;
}
