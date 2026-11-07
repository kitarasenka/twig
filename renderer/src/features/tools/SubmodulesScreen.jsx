import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Boxes, Download, ExternalLink, RefreshCw } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import ScreenTitle from '../../ui/ScreenTitle.jsx';
import OperationNote from '../../ui/OperationNote.jsx';
import { submoduleAction, submoduleConsequence, submoduleState, submoduleUpdateCommand } from './tools-view.js';
import { failureText, t, tr } from '../../i18n/i18n.js';

/**
 * The submodules of this repository: where each is pinned, what is checked
 * out, and whether its files are here at all. `git submodule update --init`
 * brings one or all of them to the pinned commit; an initialized one opens as
 * a tab of its own, where it is an ordinary repository.
 */
export default function SubmodulesScreen({ repository, busy, refreshKey = 0, onBack, onOpen, onDialog, onChanged, onConsole }) {
  const [submodules, setSubmodules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++generation.current;
    try {
      const list = await window.twig.getSubmodules(repository.id);
      if (epoch === generation.current) { setSubmodules(list); setError(''); }
    } catch (failure) { if (epoch === generation.current) setError(failureText(failure, t('Could not read the submodules.'))); }
    finally { if (epoch === generation.current) setLoading(false); }
  }, [repository.id]);
  useEffect(() => { void refresh(); const token = generation; return () => { token.current++; }; }, [refresh, refreshKey]);

  async function update(entries, all) {
    setRunning(true); setNote('');
    try {
      const result = await window.twig.updateSubmodules(repository.id, all ? null : entries.map(entry => entry.path));
      setNote(result.ok ? (all ? t('Submodules updated to their pinned commits.') : t`${entries[0].path} is at its pinned commit.`) : { text: tr(result.message), failed: !result.cancelled });
    } catch (failure) { setNote({ text: failureText(failure, t('Could not update the submodules.')), failed: true }); }
    finally { setRunning(false); void refresh(); onChanged(); }
  }
  function confirmUpdate(entries, all = false) {
    onDialog({
      type: 'confirm', danger: false, title: all ? t('Update all submodules') : t`Update ${entries[0].path}`,
      command: submoduleUpdateCommand(all ? null : entries.map(entry => entry.path)),
      consequence: submoduleConsequence(entries), confirmLabel: all ? t('Update all') : submoduleAction(entries[0]) || t('Update'),
      onConfirm: () => void update(entries, all)
    });
  }

  const reason = busy || running ? t('Git is working') : undefined;
  return <section className="tool-screen" aria-label={t('Submodules')}>
    <header className="panel-heading">
      <Button icon={ArrowLeft} onClick={onBack}>{t('Back to history')}</Button>
      <ScreenTitle icon={Boxes} title={t('Submodules')}><span className="count">{submodules.length}</span></ScreenTitle>
      <div className="tool-actions">
        {running && <Button onClick={() => void window.twig.cancelRepositoryTool(repository.id)}>{t('Cancel')}</Button>}
        <Button icon={Download} className="primary" reason={reason || (submodules.length === 0 ? t('This repository has no submodules') : undefined)}
          onClick={() => confirmUpdate(submodules, true)}>{t('Update all…')}</Button>
        <Button icon={RefreshCw} reason={reason} onClick={() => void refresh()}>{t('Refresh')}</Button>
      </div>
    </header>
    <p className="tool-intro muted">{t('A submodule is another repository pinned at one commit inside this one. The pin is part of your commits; what is checked out inside it may differ.')}</p>
    <OperationNote note={note} onConsole={onConsole} onDismiss={() => setNote('')} />
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>{t('Show output')}</button></p>}
    {loading && <div className="loading-shell" aria-label={t('Loading submodules')}>{Array.from({ length: 3 }, (_, index) => <div className="skeleton" key={index} />)}</div>}
    {!loading && !error && submodules.length === 0 && <p className="empty-inline">{t('This repository has no submodules.')}</p>}
    <ul className="tool-list" aria-label={t('Submodules')}>
      {submodules.map(entry => <li key={entry.path}>
        <div className="tool-item">
          <strong>{entry.path}{entry.state !== 'pinned' && <span className="tool-badge">{entry.state === 'moved' ? t('Moved') : t('Not initialized')}</span>}</strong>
          <span>{submoduleState(entry)}</span>
          {entry.url && <code className="tool-path" title={entry.url}>{entry.url}{entry.branch ? ` · ${t`tracks ${entry.branch}`}` : ''}</code>}
        </div>
        <div className="tool-actions">
          {submoduleAction(entry) && <Button icon={Download} reason={reason} onClick={() => confirmUpdate([entry])}>{submoduleAction(entry)}…</Button>}
          <Button icon={ExternalLink} reason={entry.state === 'uninitialized' ? t('Initialize it first: its files are not here yet') : undefined}
            onClick={() => void onOpen(entry.path)}>{t('Open as tab')}</Button>
        </div>
      </li>)}
    </ul>
  </section>;
}
