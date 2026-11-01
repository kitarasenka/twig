import { useEffect, useState } from 'react';
import { ArrowDown, FolderOpen, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, t } from '../../i18n/i18n.js';

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
    } catch (failure) { setError(failureText(failure, t('Could not update the repository list.'))); }
    finally { setBusy(false); }
  }
  // The demo sandbox is managed from Settings -> Reset demo workspace, not here.
  const connected = (workspace?.repositories || []).filter(item => !item.sandbox);
  const items = connected.filter(item => `${item.name} ${item.path}`.toLowerCase().includes(filter.toLowerCase()));
  const waiting = busy ? t('Wait for the current action') : undefined;
  const removingReason = busy ? t('Removing…') : undefined;
  return <section className="repository-manager" aria-label={t('Connected repositories')} aria-busy={busy}>
    <p className="muted">{t('Your connected repositories. Removing an entry keeps every file on disk.')}</p>
    <div className="manager-actions"><Button icon={FolderOpen} onClick={onOpen} reason={waiting}>{t('Open folder')}</Button><Button icon={ArrowDown} onClick={onClone} reason={waiting}>{t('Clone repository')}</Button></div>
    <label className="manager-field">{t('Filter repositories')}<input value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('Name or path')} /></label>
    {error && <div role="alert" className="profile-error"><p>{error}</p><Button onClick={onConsole}>{t('Show output')}</Button></div>}
    <ul className="manager-list">{items.map(item => <li key={item.id}>
      <div className="manager-item-heading"><strong>{item.name}</strong><small>{item.available ? t('Available') : t('Unavailable')}{workspace.activeId === item.id ? ` · ${t('Current')}` : ''}</small></div>
      <code className="manager-path">{item.path}</code>
      <div className="manager-actions"><Button icon={FolderOpen} reason={waiting} onClick={() => act('select', item.id)}>{t`Open ${item.name}`}</Button><Button icon={Trash2} reason={waiting} onClick={() => setRemoving(item.id)}>{t('Remove from list')}</Button></div>
      {removing === item.id && <div className="manager-confirm"><p>{t`Remove ${item.name} from 🌱 Twig? Its folder and files will stay on disk.`}</p><Button reason={removingReason} onClick={() => act('remove', item.id)}>{t('Confirm removal')}</Button><Button reason={removingReason} onClick={() => setRemoving(null)}>{t('Keep repository')}</Button></div>}
    </li>)}</ul>
    {!items.length && <p className="empty-inline">{connected.length ? t('No repositories match this filter.') : t('No connected repositories. Open a folder or clone a repository to begin.')}</p>}
  </section>;
}
