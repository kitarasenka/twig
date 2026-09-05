import { useEffect, useState } from 'react';
import { ArrowDown, FolderOpen } from 'lucide-react';
import Button from '../../ui/Button.jsx';

export default function CloneRepository({ entries, onWorkspace, onBusyChange, onConsole }) {
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [destination, setDestination] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [cloning, setCloning] = useState(false);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  async function choose() {
    setBusy(true); setError('');
    try { const choice = await window.twig.chooseCloneDestination(); if (choice) setDestination(choice); }
    catch (failure) { setError(failure.message || 'Could not choose the destination.'); }
    finally { setBusy(false); }
  }
  async function clone(event) {
    event.preventDefault(); setBusy(true); setCloning(true); setError(''); setNotice('');
    try {
      const result = await window.twig.cloneRepository(destination.token, name, url);
      if (result.ok) onWorkspace(result.workspace, true);
      else setNotice(`Clone cancelled. No repository was added. Any remaining files are kept${result.path ? ` at ${result.path}` : ' at the destination'}.`);
    } catch (failure) { setError(failure.message || 'Clone failed. Show output in the console.'); }
    finally { setBusy(false); setCloning(false); }
  }
  async function cancel() {
    try { await window.twig.cancelClone(); setNotice('Cancellation requested. Waiting for Git to exit…'); }
    catch (failure) { setError(failure.message || 'Could not cancel the clone.'); }
  }
  const command = cloning ? entries.findLast(entry => entry.operation === 'Clone repository') : null;
  return <form className="repository-manager" onSubmit={clone} aria-busy={busy}>
    <p className="muted">Clone into a new folder. Existing folders are never overwritten.</p>
    <label className="manager-field">Repository URL<input required value={url} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setUrl(event.target.value)} placeholder="https://host/team/repository.git or git@host:team/repository.git" /></label>
    <label className="manager-field">New folder name<input required value={name} disabled={busy} maxLength={180} autoComplete="off" onChange={event => setName(event.target.value)} placeholder="my-repository" /></label>
    <div className="manager-field"><span>Parent folder</span><code className="manager-path">{destination?.path || 'Choose where to create the new folder.'}</code><Button icon={FolderOpen} type="button" reason={busy ? 'Wait for the current action' : undefined} onClick={choose}>Choose parent folder</Button></div>
    <div className="manager-actions"><Button icon={ArrowDown} className="primary" type="submit" reason={busy ? 'Clone in progress' : !destination || !url || !name ? 'Enter an address, folder name and destination' : undefined}>{cloning ? 'Cloning…' : 'Clone and open'}</Button>{cloning && <Button type="button" onClick={cancel}>Cancel clone</Button>}<Button type="button" onClick={onConsole}>Show output</Button></div>
    {cloning && <><progress aria-label="Clone progress" /><p className="muted">Git output appears live below. Cancel the clone before closing this dialog.</p><pre className="manager-output" tabIndex={0} aria-label="Live clone output">{command?.stderr.slice(-6000) || 'Starting Git…'}</pre></>}
    <p role="status">{notice}</p>
    {error && <p role="alert" className="profile-error">{error}</p>}
  </form>;
}
