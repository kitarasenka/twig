import { useEffect, useState } from 'react';
import { ArrowDown, FolderOpen, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';

export default function Repositories({ workspace, onWorkspace, onOpen, onClone, onBusyChange, onConsole }) {
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState(null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  async function act(action, id) {
    setBusy(true); setError('');
    try {
      const next = await (action === 'remove' ? window.twig.removeRepository(id) : window.twig.selectRepository(id));
      setRemoving(null); onWorkspace(next, action === 'select');
    } catch (failure) { setError(failure.message || 'Could not update the repository list.'); }
    finally { setBusy(false); }
  }
  const items = (workspace?.repositories || []).filter(item => `${item.name} ${item.path}`.toLowerCase().includes(filter.toLowerCase()));
  return <section className="repository-manager" aria-label="Connected repositories" aria-busy={busy}>
    <p className="muted">Your connected repositories. Removing an entry keeps every file on disk.</p>
    <div className="manager-actions"><Button icon={FolderOpen} onClick={onOpen} reason={busy ? 'Wait for the current action' : undefined}>Open folder</Button><Button icon={ArrowDown} onClick={onClone} reason={busy ? 'Wait for the current action' : undefined}>Clone repository</Button></div>
    <label className="manager-field">Filter repositories<input value={filter} onChange={event => setFilter(event.target.value)} placeholder="Name or path" /></label>
    {error && <div role="alert" className="profile-error"><p>{error}</p><Button onClick={onConsole}>Show output</Button></div>}
    <ul className="manager-list">{items.map(item => <li key={item.id}>
      <div className="manager-item-heading"><strong>{item.name}</strong><small>{item.available ? 'Available' : 'Unavailable'}{workspace.activeId === item.id ? ' · Current' : ''}</small></div>
      <code className="manager-path">{item.path}</code>
      <div className="manager-actions"><Button icon={FolderOpen} reason={busy ? 'Wait for the current action' : undefined} onClick={() => act('select', item.id)}>Open {item.name}</Button><Button icon={Trash2} reason={busy ? 'Wait for the current action' : undefined} onClick={() => setRemoving(item.id)}>Remove from list</Button></div>
      {removing === item.id && <div className="manager-confirm"><p>Remove {item.name} from Twig? Its folder and files will stay on disk.</p><Button reason={busy ? 'Removing…' : undefined} onClick={() => act('remove', item.id)}>Confirm removal</Button><Button reason={busy ? 'Removing…' : undefined} onClick={() => setRemoving(null)}>Keep repository</Button></div>}
    </li>)}</ul>
    {!items.length && <p className="empty-inline">{workspace?.repositories.length ? 'No repositories match this filter.' : 'No connected repositories. Open a folder or clone a repository to begin.'}</p>}
  </section>;
}
