import { useEffect, useState } from 'react';
import { Copy, KeyRound, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, t, tr } from '../../i18n/i18n.js';

export default function SshSettings({ entries, onBusyChange, onConsole }) {
  const [keys, setKeys] = useState([]); const [config, setConfig] = useState(null);
  const [content, setContent] = useState(''); const [mode, setMode] = useState('text');
  const [busy, setBusy] = useState(true); const [testing, setTesting] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [output, setOutput] = useState('');
  const [name, setName] = useState('id_twig'); const [comment, setComment] = useState('');
  const [passphrase, setPassphrase] = useState(''); const [repeat, setRepeat] = useState('');
  const [target, setTarget] = useState('git@github.com'); const [reload, setReload] = useState(0);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let alive = true; setBusy(true); setError('');
    Promise.all([window.twig.getSshKeys(), window.twig.getSshConfig()]).then(([nextKeys, nextConfig]) => {
      if (alive) { setKeys(nextKeys); setConfig(nextConfig); setContent(nextConfig.content); }
    }).catch(failure => { if (alive) setError(failureText(failure)); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [reload]);
  async function run(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); } catch (failure) { setError(failureText(failure, t('SSH action failed. Show output in the console.'))); }
    finally { setBusy(false); }
  }
  const waiting = busy ? t('Wait for the SSH action to finish') : undefined;
  const lines = content.split('\n');
  return <section className="repository-manager" aria-label={t('SSH settings')} aria-busy={busy}>
    <div className="manager-actions"><Button icon={RefreshCw} reason={waiting} onClick={() => setReload(value => value + 1)}>{t('Reload SSH settings')}</Button><Button onClick={onConsole}>{t('Show output')}</Button></div>
    <p role="status">{busy ? t('Working…') : notice}</p>{error && <p role="alert" className="profile-error">{error}</p>}
    <h3>{t('SSH keys')}</h3>
    {busy && !config && <div className="skeleton" aria-label={t('Loading SSH settings')} />}
    {!busy && !keys.length && <p className="muted">{t('No public keys found in ~/.ssh. Generate an encrypted key below.')}</p>}
    <ul className="manager-list">{keys.map(key => <li key={key.name}><strong>{key.name}</strong>{key.error ? <p>{tr(key.error)}</p> : <><p className="manager-path">{key.type} · {key.hasPrivateKey ? t('Key pair') : t('Public key only')}</p><code className="manager-path">{key.fingerprint}</code>{!key.securePermissions && <><p>{t('Private key permissions allow access by other users.')}</p><Button reason={waiting} onClick={() => run(async () => { setKeys(await window.twig.secureSshKey(key.name)); setNotice(t('Private key permissions set to 600.')); })}>{t('Secure key permissions')}</Button></>}<Button icon={Copy} reason={waiting} onClick={() => run(async () => { await window.twig.copyText(key.publicKey); setNotice(t('Public key copied.')); })}>{t('Copy public key')}</Button></>}</li>)}</ul>
    <form className="manager-add" onSubmit={event => { event.preventDefault(); void run(async () => {
      const secret = passphrase; setPassphrase(''); setRepeat('');
      setKeys(await window.twig.generateSshKey(name, comment, secret)); setNotice(t('Encrypted Ed25519 key pair created. Copy the public key to your Git host.'));
    }); }}>
      <h3>{t('Generate Ed25519 key')}</h3>
      <label className="manager-field">{t('Key filename')}<input required value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label className="manager-field">{t('Key comment')}<input value={comment} disabled={busy} onChange={event => setComment(event.target.value)} placeholder="you@example.com" /></label>
      <label className="manager-field">{t('Passphrase')}<input type="password" required autoComplete="new-password" value={passphrase} disabled={busy} onChange={event => setPassphrase(event.target.value)} /></label>
      <label className="manager-field">{t('Repeat passphrase')}<input type="password" required autoComplete="new-password" value={repeat} disabled={busy} onChange={event => setRepeat(event.target.value)} /></label>
      <Button icon={KeyRound} type="submit" reason={waiting || (!passphrase || passphrase !== repeat ? t('Enter matching passphrases') : undefined)}>{t('Generate key')}</Button>
    </form>
    <section className="manager-add" aria-label={t('SSH configuration editor')}><h3>{t('SSH config')}</h3><code className="manager-path">{config?.path || '~/.ssh/config'}</code>
      <p className="muted">{t('A backup is created before saving. Include files are not expanded and Match exec commands are not run during validation.')}</p>
      <div className="manager-actions"><Button aria-pressed={mode === 'text'} onClick={() => setMode('text')}>{t('Text')}</Button><Button aria-pressed={mode === 'lines'} onClick={() => setMode('lines')}>{t('Lines')}</Button></div>
      {mode === 'text' ? <label className="manager-field">{t('Configuration text')}<textarea className="ssh-config" rows={12} disabled={busy} spellCheck={false} value={content} onChange={event => setContent(event.target.value)} /></label>
        : <div className="ssh-lines">{lines.map((line, index) => <div key={index}><label>{index + 1}<input aria-label={t`Config line ${index + 1}`} disabled={busy} value={line} onChange={event => setContent(lines.map((value, at) => at === index ? event.target.value : value).join('\n'))} /></label><Button icon={Trash2} title={t('Remove this line')} aria-label={t`Remove config line ${index + 1}`} reason={waiting} onClick={() => setContent(lines.filter((_, at) => at !== index).join('\n'))} /></div>)}<Button icon={Plus} reason={waiting} onClick={() => setContent(`${content}\n`)}>{t('Add line')}</Button></div>}
      <Button icon={Save} reason={waiting || (!config || content === config.content ? t('No configuration changes') : undefined)} onClick={() => run(async () => {
        const saved = await window.twig.saveSshConfig(content, config.digest); setConfig(saved); setContent(saved.content); setNotice(saved.backup ? t`Saved. Backup: ${saved.backup}` : t('SSH config created.'));
      })}>{t('Validate and save config')}</Button>
    </section>
    <form className="manager-add" onSubmit={event => { event.preventDefault(); setTesting(true); void run(async () => {
      try { const result = await window.twig.testSshConnection(target); setOutput(`${result.stdout}${result.stderr}`); setNotice(result.cancelled ? t('SSH check cancelled or timed out.') : t`SSH exited with code ${result.code}. Git hosts may return 1 even after successful authentication; see their message below.`); }
      finally { setTesting(false); }
    }); }}>
      <h3>{t('Test connection')}</h3><p className="muted">{t('Uses your SSH agent and known host keys. No password prompts or automatic host-key acceptance.')}</p>
      <label className="manager-field">{t('SSH host')}<input required disabled={busy} value={target} onChange={event => setTarget(event.target.value)} /></label>
      <Button type="submit" reason={waiting}>{t('Test SSH connection')}</Button>{testing && <Button type="button" onClick={() => window.twig.cancelSshConnection().catch(failure => setError(failureText(failure)))}>{t('Cancel SSH check')}</Button>}
      {testing && <pre className="manager-output" tabIndex={0} aria-label={t('Live SSH output')}>{entries.findLast(entry => entry.executable === 'ssh' && entry.argv[0] === '-T')?.stderr || t('Connecting…')}</pre>}
      {output && <pre className="manager-output" tabIndex={0} aria-label={t('SSH connection output')}>{output}</pre>}
    </form>
  </section>;
}
