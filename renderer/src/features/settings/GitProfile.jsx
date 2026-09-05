import { useEffect, useState } from 'react';
import { RefreshCw, Save, RotateCcw } from 'lucide-react';
import Button from '../../ui/Button.jsx';

const FIELDS = [
  ['user.name', 'Name', 'Your name on new commits.'],
  ['user.email', 'Email', 'Your email on new commits.'],
  ['core.editor', 'Editor command', 'Git runs this command when it needs an external editor.'],
  ['pull.rebase', 'Pull strategy', 'Default strategy for Git commands that do not specify one.'],
  ['init.defaultBranch', 'Initial branch', 'Used when you create a new repository.']
];

function ProfileField({ field, value, effective, busy, scope, onSave }) {
  const [key, label, description] = field;
  const [draft, setDraft] = useState(value ?? '');
  useEffect(() => { setDraft(value ?? ''); }, [value]);
  const reason = busy ? 'Wait for the current request' : draft === (value ?? '') ? 'No changes to save' : !draft.trim() ? 'Enter a value or remove this setting' : undefined;
  const id = `profile-${key}`;
  return <form className="profile-field" onSubmit={event => { event.preventDefault(); if (!reason) onSave(key, draft, value); }}>
    <label htmlFor={id}>{label}<code>{key}</code></label>
    <p className="muted" id={`${id}-help`}>{description}</p>
    <div className="profile-controls">
      {key === 'pull.rebase' ? <select id={id} aria-describedby={`${id}-help`} value={draft} disabled={busy} onChange={event => setDraft(event.target.value)}>
        <option value="">Not set here</option><option value="false">Merge</option><option value="true">Rebase</option><option value="merges">Rebase with merges</option><option value="interactive">Interactive rebase</option>
        {draft && !['false', 'true', 'merges', 'interactive'].includes(draft) && <option value={draft}>{draft} (existing value)</option>}
      </select> : <input id={id} value={draft} maxLength={4096} aria-describedby={`${id}-help`} disabled={busy} spellCheck={false} autoComplete="off" onChange={event => setDraft(event.target.value)} />}
      <Button icon={Save} type="submit" reason={reason} aria-label={`Save ${label}`} title={`Save ${label} · ${scope}`}>Save</Button>
      <Button icon={RotateCcw} type="button" aria-label={`Remove ${label} setting`} reason={busy ? 'Wait for the current request' : value === null ? 'This setting is not stored in this scope' : undefined} title={`Remove ${scope} setting and use inherited configuration`} onClick={() => onSave(key, null, value)}>Remove</Button>
    </div>
    <small className="profile-effective">{value === null ? 'Inherited / default' : `Set ${scope === 'local' ? 'for this repository' : 'globally'}`} · Effective: <code>{effective ?? 'Git default (not configured)'}</code></small>
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
      .catch(failure => { if (alive) setError(failure.message || 'Could not read the profile.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [repositoryId, scope, reload]);
  async function save(key, value, expected) {
    setBusy(true); setError(''); setNotice('');
    try {
      setSnapshot(await window.twig.saveGitProfileValue(repositoryId, scope, key, value, expected));
      setNotice(`${key} ${value === null ? 'removed' : 'saved'} ${scope === 'global' ? 'globally' : 'for this repository'}.`);
    } catch (failure) { setError(failure.message || 'Could not save the setting.'); }
    finally { setBusy(false); }
  }
  return <div className="profile-form" aria-busy={busy}>
    <div className="profile-feedback" aria-live="polite">{busy ? 'Loading or saving Git profile…' : notice}</div>
    {error && <div role="alert" className="profile-error"><p>{error}</p><Button type="button" onClick={onConsole}>Show output</Button></div>}
    {!snapshot && busy && <div aria-label="Loading Git profile" className="loading-shell">{FIELDS.map(([key]) => <div key={key} className="skeleton" />)}</div>}
    {snapshot && FIELDS.map(field => <ProfileField key={field[0]} field={field} scope={scope} value={snapshot.values[field[0]]} effective={snapshot.effective[field[0]]} busy={busy} onSave={save} />)}
    <Button icon={RefreshCw} reason={busy ? 'Wait for the current request' : undefined} onClick={() => setReload(value => value + 1)} title="Discard unsaved edits and reread Git configuration">Reload profile</Button>
  </div>;
}

export default function GitProfile({ repository, onConsole }) {
  const [scope, setScope] = useState(repository?.available ? 'local' : 'global');
  const repositoryId = repository?.available ? repository.id : null;
  return <section className="git-profile" aria-label="Git configuration">
    <label className="setting-row" htmlFor="profile-scope"><span><strong>Save settings for</strong><small>{scope === 'global' ? 'All repositories for your OS account. Local settings take priority.' : repository?.path}</small></span>
      <select id="profile-scope" value={scope} onChange={event => setScope(event.target.value)}><option value="local" disabled={!repositoryId}>This repository</option><option value="global">All repositories</option></select>
    </label>
    <ProfileForm key={`${repositoryId}:${scope}`} repositoryId={repositoryId} scope={scope} onConsole={onConsole} />
  </section>;
}
