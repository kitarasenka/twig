import { Fragment, useEffect, useState } from 'react';
import { RefreshCw, Save, RotateCcw } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, mark, t } from '../../i18n/i18n.js';
import { tx } from '../../i18n/rich.js';

const FIELDS = [
  ['user.name', mark('Name'), mark('Your name on new commits.')],
  ['user.email', mark('Email'), mark('Your email on new commits.')],
  ['core.editor', mark('Editor command'), mark('Git runs this command when it needs an external editor.')],
  ['pull.rebase', mark('Pull strategy'), mark('Default strategy for Git commands that do not specify one.')],
  ['init.defaultBranch', mark('Initial branch'), mark('Used when you create a new repository.')],
  ['commit.gpgSign', mark('Sign new commits'), mark('Every commit, amend, cherry-pick, revert and rebase is signed with the key below. Many teams require it.')],
  ['gpg.format', mark('Signature format'), mark('GPG uses your gpg keyring; SSH signs with an SSH key; X.509 uses gpgsm.')],
  ['user.signingKey', mark('Signing key'), mark('GPG: a key ID or fingerprint. SSH: the path to a public key (~/.ssh/id_ed25519.pub) or “key::” and the key itself.')],
  ['tag.gpgSign', mark('Sign annotated tags'), mark('Tags created with a message are signed too.')],
  ['gpg.ssh.allowedSignersFile', mark('Allowed signers file'), mark('Needed to verify SSH signatures: lines of “email key”. Without it every SSH-signed commit shows as not verified.')]
];

/** Settings that take one of a few words, shown as a choice instead of a text field. */
const CHOICES = {
  'pull.rebase': [['false', mark('Merge')], ['true', mark('Rebase')], ['merges', mark('Rebase with merges')], ['interactive', mark('Interactive rebase')]],
  'commit.gpgSign': [['true', mark('On')], ['false', mark('Off')]],
  'tag.gpgSign': [['true', mark('On')], ['false', mark('Off')]],
  'gpg.format': [['openpgp', 'GPG (openpgp)'], ['ssh', 'SSH'], ['x509', 'X.509 (gpgsm)']]
};
const SIGNING = 'commit.gpgSign';

function ProfileField({ field, value, effective, busy, scope, onSave }) {
  const [key, englishLabel, description] = field;
  const label = t(englishLabel);
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const reason = busy ? t('Wait for the current request') : draft === (value ?? '') ? t('No changes to save') : !draft.trim() ? t('Enter a value or remove this setting') : undefined;
  const id = `profile-${key}`;
  const source = value === null ? t('Inherited / default') : scope === 'local' ? t('Set for this repository') : t('Set globally');
  return <form className="profile-field" onSubmit={event => { event.preventDefault(); if (!reason) onSave(key, draft, value); }}>
    <label htmlFor={id}>{label}<code>{key}</code></label>
    <p className="muted" id={`${id}-help`}>{t(description)}</p>
    <div className="profile-controls">
      {CHOICES[key] ? <select id={id} aria-describedby={`${id}-help`} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}>
        <option value="">{t('Not set here')}</option>{CHOICES[key].map(([choice, text]) => <option key={choice} value={choice}>{t(text)}</option>)}
        {draft && !CHOICES[key].some(([choice]) => choice === draft) && <option value={draft}>{t`${draft} (existing value)`}</option>}
      </select> : <input id={id} value={draft} maxLength={4096} aria-describedby={`${id}-help`} disabled={busy} spellCheck={false} autoComplete="off" onChange={event => setDraft(event.target.value)} />}
      <Button icon={Save} type="submit" reason={reason} aria-label={t`Save ${label}`} title={scope === 'local' ? t`Save ${label} · local` : t`Save ${label} · global`}>{t('Save')}</Button>
      <Button icon={RotateCcw} type="button" aria-label={t`Remove ${label} setting`} reason={busy ? t('Wait for the current request') : value === null ? t('This setting is not stored in this scope') : undefined} title={scope === 'local' ? t('Remove local setting and use inherited configuration') : t('Remove global setting and use inherited configuration')} onClick={() => onSave(key, null, value)}>{t('Remove')}</Button>
    </div>
    <small className="profile-effective">{tx('{source} · Effective: {value}', { source, value: <code>{effective ?? t('Git default (not configured)')}</code> })}</small>
  </form>;
}

function ProfileForm({ repositoryId, scope, onConsole }) {
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    setBusy(true); setError(''); setSnapshot(null); setNotice('');
    window.twig.getGitProfile(repositoryId, scope)
      .then(result => { if (alive) setSnapshot(result); })
      .catch(failure => { if (alive) setError(failureText(failure, t('Could not read the profile.'))); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [repositoryId, scope, reload]);
  async function save(key, value, expected) {
    setBusy(true); setError(''); setNotice('');
    try {
      setSnapshot(await window.twig.saveGitProfileValue(repositoryId, scope, key, value, expected));
      const global = scope === 'global';
      setNotice(value === null
        ? (global ? t`${key} removed globally.` : t`${key} removed for this repository.`)
        : (global ? t`${key} saved globally.` : t`${key} saved for this repository.`));
    } catch (failure) { setError(failureText(failure, t('Could not save the setting.'))); }
    finally { setBusy(false); }
  }
  return <div className="profile-form" aria-busy={busy}>
    <div className="profile-feedback" aria-live="polite">{busy ? t('Loading or saving Git profile…') : notice}</div>
    {error && <div role="alert" className="profile-error"><p>{error}</p><Button type="button" onClick={onConsole}>{t('Show output')}</Button></div>}
    {!snapshot && busy && <div aria-label={t('Loading Git profile')} className="loading-shell">{FIELDS.map(([key]) => <div key={key} className="skeleton" />)}</div>}
    {snapshot && FIELDS.map(field => <Fragment key={field[0]}>
      {field[0] === SIGNING && <h3 className="profile-heading">{t('Commit signing')}</h3>}
      <ProfileField field={field} scope={scope} value={snapshot.values[field[0]]} effective={snapshot.effective[field[0]]} busy={busy} onSave={save} />
    </Fragment>)}
    <Button icon={RefreshCw} reason={busy ? t('Wait for the current request') : undefined} onClick={() => setReload(value => value + 1)} title={t('Discard unsaved edits and reread Git configuration')}>{t('Reload profile')}</Button>
  </div>;
}

export default function GitProfile({ repository, onConsole }) {
  const [scope, setScope] = useState(repository?.available ? 'local' : 'global');
  const repositoryId = repository?.available ? repository.id : null;
  return <section className="git-profile" aria-label={t('Git configuration')}>
    <label className="setting-row" htmlFor="profile-scope"><span><strong>{t('Save settings for')}</strong><small>{scope === 'global' ? t('All repositories for your OS account. Local settings take priority.') : repository?.path}</small></span>
      <select id="profile-scope" value={scope} onChange={event => setScope(event.target.value)}><option value="local" disabled={!repositoryId}>{t('This repository')}</option><option value="global">{t('All repositories')}</option></select>
    </label>
    <ProfileForm key={`${repositoryId}:${scope}`} repositoryId={repositoryId} scope={scope} onConsole={onConsole} />
  </section>;
}
