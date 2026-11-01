import { useEffect, useState } from 'react';
import { ArrowDown, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, t } from '../../i18n/i18n.js';

function RemoteRow({ remote, busy, onAction }) {
  const [url, setUrl] = useState(remote.urls[0] || '');
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { setUrl(remote.urls[0] || ''); setConfirm(false); }, [remote]);
  const waiting = busy ? t('Wait for the current action') : undefined;
  const removing = busy ? t('Removing…') : undefined;
  return <li><form onSubmit={event => { event.preventDefault(); onAction('set-url', remote, url); }}>
    <strong>{remote.name}</strong>
    <label className="manager-field">{t('Primary fetch URL')}<input value={url} required disabled={busy} spellCheck={false} autoComplete="off" onChange={event => setUrl(event.target.value)} /></label>
    {remote.urls.slice(1).map((address, index) => <p className="manager-path" key={index}>{t('Additional fetch URL:')} <code>{address}</code></p>)}
    <p className="manager-path">{t('Push:')} <code>{remote.pushUrls.length ? remote.pushUrls.join(', ') : t('Uses fetch URL')}</code></p>
    <div className="manager-actions"><Button icon={Save} type="submit" reason={waiting || (url === remote.urls[0] ? t('No URL changes') : undefined)}>{t('Save URL')}</Button><Button icon={ArrowDown} type="button" reason={waiting} onClick={() => onAction('fetch', remote)}>{t('Fetch and prune')}</Button><Button icon={Trash2} type="button" reason={waiting} onClick={() => setConfirm(true)}>{t('Remove remote')}</Button></div>
    {confirm && <div className="manager-confirm"><p>{t`Remove ${remote.name}? Git will remove its connection settings and remote-tracking branches. Local branches and files stay on disk.`}</p><Button type="button" reason={removing} onClick={() => onAction('remove', remote)}>{t('Confirm remote removal')}</Button><Button type="button" reason={removing} onClick={() => setConfirm(false)}>{t('Keep remote')}</Button></div>}
  </form></li>;
}

function finished(name, action) {
  switch (action) {
    case 'add': return t`${name}: add finished.`;
    case 'set-url': return t`${name}: set-url finished.`;
    case 'fetch': return t`${name}: fetch finished.`;
    case 'remove': return t`${name}: remove finished.`;
    default: return `${name}: ${action}`;
  }
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
      .catch(failure => { if (alive) setError(failureText(failure, t('Could not read remotes.'))); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [repository.id, revision]);
  async function act(action, remote, address = null) {
    setBusy(true); setFetching(action === 'fetch'); setError(''); setNotice('');
    try {
      const result = await window.twig.changeRemote(repository.id, action, remote.name, address, action === 'add' ? null : JSON.stringify(remote));
      setNotice(result.cancelled ? t('Fetch cancelled. Git may have already updated some references.') : finished(remote.name, action));
      if (result.ok && action === 'add') { setName(''); setUrl(''); }
      await onChanged(); setRevision(value => value + 1);
    } catch (failure) { setError(failureText(failure, t('Could not finish the remote action.'))); }
    finally { setBusy(false); setFetching(false); }
  }
  async function cancel() {
    try { await window.twig.cancelRemote(repository.id); setNotice(t('Cancellation requested. Waiting for Git to exit…')); }
    catch (failure) { setError(failureText(failure, t('Could not cancel fetch.'))); }
  }
  const waiting = busy ? t('Wait for the current action') : undefined;
  return <section className="repository-manager" aria-label={t`Remotes for ${repository.name}`} aria-busy={busy}>
    <p className="muted">{t`Connections for ${repository.name}. Fetch runs only when you request it.`}</p>
    <div className="manager-actions"><Button icon={RefreshCw} reason={waiting} onClick={() => setRevision(value => value + 1)}>{t('Reload remotes')}</Button><Button onClick={onConsole}>{t('Show output')}</Button>{fetching && <Button onClick={cancel}>{t('Cancel fetch')}</Button>}</div>
    <p role="status">{fetching ? t('Fetching… Cancel or wait before closing.') : notice}</p>
    {fetching && <pre className="manager-output" tabIndex={0} aria-label={t('Live fetch output')}>{entries.findLast(entry => entry.operation.startsWith('Fetch and prune:'))?.stderr.slice(-6000) || t('Starting Git…')}</pre>}
    {error && <p role="alert" className="profile-error">{error}</p>}
    {busy && !remotes.length && !fetching && <div className="loading-shell" aria-label={t('Loading remotes')}><div className="skeleton" /></div>}
    {!busy && !remotes.length && <p>{t('No remotes connected. Add an address below.')}</p>}
    <ul className="manager-list">{remotes.map(remote => <RemoteRow key={remote.name} remote={remote} busy={busy} onAction={act} />)}</ul>
    <form className="manager-add" onSubmit={event => { event.preventDefault(); act('add', { name }, url); }}>
      <h3>{t('Add remote')}</h3><label className="manager-field">{t('Remote name')}<input required disabled={busy} value={name} maxLength={255} onChange={event => setName(event.target.value)} placeholder="origin" /></label>
      <label className="manager-field">{t('Remote URL')}<input required disabled={busy} value={url} spellCheck={false} autoComplete="off" onChange={event => setUrl(event.target.value)} placeholder="https://host/team/repository.git" /></label>
      <Button icon={Plus} type="submit" reason={waiting || (!name || !url ? t('Enter a remote name and address') : undefined)}>{t('Add remote')}</Button>
    </form>
  </section>;
}
