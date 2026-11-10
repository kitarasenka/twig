import { useEffect, useRef, useState } from 'react';
import { ArrowDown, FolderOpen } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, t } from '../../i18n/i18n.js';
import { cloneFolderName } from './clone-name.js';

// The parent folder is held in main by a token that lives 15 minutes; a draft
// older than that asks for the folder again instead of failing on Clone.
const destinationLive = destination => Boolean(destination) && (!destination.expires || destination.expires > Date.now());

/**
 * `draft` lives in App, so Show output (which closes the dialog to reach the
 * console) and a failed clone keep the address, the folder name and the
 * chosen parent folder for the next try.
 */
export default function CloneRepository({ entries, onWorkspace, onBusyChange, onConsole, draft = null, onDraft = () => {} }) {
  const [url, setUrl] = useState(draft?.url || '');
  const [name, setName] = useState(draft?.name || '');
  // The name follows the address until the person types their own.
  const [named, setNamed] = useState(Boolean(draft?.named));
  const [destination, setDestination] = useState(destinationLive(draft?.destination) ? draft.destination : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(draft?.error || '');
  const [notice, setNotice] = useState('');
  const [cloning, setCloning] = useState(false);
  // The journal entry of the last clone: shown live while it runs and kept
  // after a failure, so the reason is readable in the dialog itself.
  const [startedAt, setStartedAt] = useState(draft?.startedAt || null);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  // A finished clone forgets the draft for good; later renders must not write it back.
  const done = useRef(false);
  useEffect(() => { if (!done.current) onDraft({ url, name, named, destination, error, startedAt }); }, [url, name, named, destination, error, startedAt, onDraft]);
  function changeUrl(value) {
    setUrl(value);
    if (!named) setName(cloneFolderName(value));
  }
  function changeName(value) {
    setName(value);
    setNamed(value !== '');
    if (value === '') setName(cloneFolderName(url));
  }
  async function choose() {
    setBusy(true); setError('');
    try { const choice = await window.twig.chooseCloneDestination(); if (choice) setDestination(choice); }
    catch (failure) { setError(failureText(failure, t('Could not choose the destination.'))); }
    finally { setBusy(false); }
  }
  async function clone(event) {
    event.preventDefault();
    if (!destinationLive(destination)) { setDestination(null); setError(t('Choose the parent folder again: the choice expires after 15 minutes.')); return; }
    setBusy(true); setCloning(true); setError(''); setNotice(''); setStartedAt(Date.now());
    try {
      const result = await window.twig.cloneRepository(destination.token, name, url);
      if (result.ok) { done.current = true; onDraft(null); onWorkspace(result.workspace, true); return; }
      setNotice(result.path
        ? t`Clone cancelled. No repository was added. Any remaining files are kept at ${result.path}.`
        : t('Clone cancelled. No repository was added. Any remaining files are kept at the destination.'));
    } catch (failure) {
      const text = failureText(failure, t('Clone failed. Show output in the console.'));
      if (/destination folder again/.test(failure?.message || '')) setDestination(null);
      setError(text);
    }
    finally { setBusy(false); setCloning(false); }
  }
  async function cancel() {
    try { await window.twig.cancelClone(); setNotice(t('Cancellation requested. Waiting for Git to exit…')); }
    catch (failure) { setError(failureText(failure, t('Could not cancel the clone.'))); }
  }
  const command = startedAt ? entries.findLast(entry => entry.operation === 'Clone repository' && Date.parse(entry.startedAt) >= startedAt - 2000) : null;
  const output = command ? (command.stderr || '').trimEnd().split('\n').slice(-12).join('\n').slice(-3000) : '';
  return <form className="repository-manager" onSubmit={clone} aria-busy={busy}>
    <p className="muted">{t('Clone into a new folder. Existing folders are never overwritten.')}</p>
    <label className="manager-field">{t('Repository URL')}<input required autoFocus data-autofocus value={url} disabled={busy} autoComplete="off" spellCheck={false} onChange={event => changeUrl(event.target.value)} placeholder={t('https://host/team/repository.git or git@host:team/repository.git')} /></label>
    <label className="manager-field">{t('New folder name')}<input required value={name} disabled={busy} maxLength={180} autoComplete="off" onChange={event => changeName(event.target.value)} placeholder="my-repository" /></label>
    <div className="manager-field"><span>{t('Parent folder')}</span><code className="manager-path">{destination?.path || t('Choose where to create the new folder.')}</code><Button icon={FolderOpen} type="button" reason={busy ? t('Wait for the current action') : undefined} onClick={choose}>{t('Choose parent folder')}</Button></div>
    <div className="manager-actions"><Button icon={ArrowDown} className="primary" type="submit" reason={busy ? t('Clone in progress') : !destination || !url || !name ? t('Enter an address, folder name and destination') : undefined}>{cloning ? t('Cloning…') : t('Clone and open')}</Button>{cloning && <Button type="button" onClick={cancel}>{t('Cancel clone')}</Button>}<Button type="button" onClick={onConsole}>{t('Show output')}</Button></div>
    {cloning && <><progress aria-label={t('Clone progress')} /><p className="muted">{t('Git output appears live below. Cancel the clone before closing this dialog.')}</p><pre className="manager-output" tabIndex={0} aria-label={t('Live clone output')}>{command?.stderr.slice(-6000) || t('Starting Git…')}</pre></>}
    <p role="status">{notice}</p>
    {error && <p role="alert" className="profile-error">{error}</p>}
    {!cloning && error && output && <pre className="manager-output" tabIndex={0} aria-label={t('What Git said')}>{output}</pre>}
  </form>;
}
