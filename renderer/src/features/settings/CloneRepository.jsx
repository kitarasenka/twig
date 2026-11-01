import { useEffect, useState } from 'react';
import { ArrowDown, FolderOpen } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, t } from '../../i18n/i18n.js';

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
    catch (failure) { setError(failureText(failure, t('Could not choose the destination.'))); }
    finally { setBusy(false); }
  }
  async function clone(event) {
    event.preventDefault(); setBusy(true); setCloning(true); setError(''); setNotice('');
    try {
      const result = await window.twig.cloneRepository(destination.token, name, url);
      if (result.ok) onWorkspace(result.workspace, true);
      else setNotice(result.path
        ? t`Clone cancelled. No repository was added. Any remaining files are kept at ${result.path}.`
        : t('Clone cancelled. No repository was added. Any remaining files are kept at the destination.'));
    } catch (failure) { setError(failureText(failure, t('Clone failed. Show output in the console.'))); }
    finally { setBusy(false); setCloning(false); }
  }
  async function cancel() {
    try { await window.twig.cancelClone(); setNotice(t('Cancellation requested. Waiting for Git to exit…')); }
    catch (failure) { setError(failureText(failure, t('Could not cancel the clone.'))); }
  }
  const command = cloning ? entries.findLast(entry => entry.operation === 'Clone repository') : null;
  return <form className="repository-manager" onSubmit={clone} aria-busy={busy}>
    <p className="muted">{t('Clone into a new folder. Existing folders are never overwritten.')}</p>
    <label className="manager-field">{t('Repository URL')}<input required value={url} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => setUrl(event.target.value)} placeholder={t('https://host/team/repository.git or git@host:team/repository.git')} /></label>
    <label className="manager-field">{t('New folder name')}<input required value={name} disabled={busy} maxLength={180} autoComplete="off" onChange={event => setName(event.target.value)} placeholder="my-repository" /></label>
    <div className="manager-field"><span>{t('Parent folder')}</span><code className="manager-path">{destination?.path || t('Choose where to create the new folder.')}</code><Button icon={FolderOpen} type="button" reason={busy ? t('Wait for the current action') : undefined} onClick={choose}>{t('Choose parent folder')}</Button></div>
    <div className="manager-actions"><Button icon={ArrowDown} className="primary" type="submit" reason={busy ? t('Clone in progress') : !destination || !url || !name ? t('Enter an address, folder name and destination') : undefined}>{cloning ? t('Cloning…') : t('Clone and open')}</Button>{cloning && <Button type="button" onClick={cancel}>{t('Cancel clone')}</Button>}<Button type="button" onClick={onConsole}>{t('Show output')}</Button></div>
    {cloning && <><progress aria-label={t('Clone progress')} /><p className="muted">{t('Git output appears live below. Cancel the clone before closing this dialog.')}</p><pre className="manager-output" tabIndex={0} aria-label={t('Live clone output')}>{command?.stderr.slice(-6000) || t('Starting Git…')}</pre></>}
    <p role="status">{notice}</p>
    {error && <p role="alert" className="profile-error">{error}</p>}
  </form>;
}
