import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import { failureText, formatDateTime, t, tn } from '../../i18n/i18n.js';
import { discardedLine, discardedTitle, relativeTime, restoreDiscardDialog } from './reflog-view.js';

/**
 * What was discarded here, from the backups 🌱 Twig keeps first. Undo reaches
 * only the last actions; this list stays, so changes thrown away by mistake
 * come back however much happened since. Restore asks by the backup's id, and
 * what it replaces is backed up too, so Undo takes it back.
 */
export default function DiscardedChanges({ repository, busy, refreshKey, onPerform, onDialog, onConsole }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const request = useRef(0);
  const load = useCallback(async () => {
    const epoch = ++request.current;
    try {
      const next = await window.twig.getDiscards(repository.id);
      if (epoch === request.current) { setItems(next); setError(''); }
    } catch (failure) { if (epoch === request.current) setError(failureText(failure, t('Could not read the discarded changes.'))); }
  }, [repository.id]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  function restore(item) {
    onDialog({ type: 'confirm', ...restoreDiscardDialog(item), onConfirm: async () => {
      await onPerform(() => window.twig.restoreDiscard(repository.id, item.id),
        tn(item.count, 'Restored {n} file. Undo takes it back.', 'Restored {n} files. Undo takes them back.'));
      await load();
    } });
  }

  return <div className="discard-view">
    <p className="reflog-intro muted">{t('Everything you discarded or deleted in 🌱 Twig, newest first, as it was just before. Restore works however much happened since; Git may drop the oldest backups.')}</p>
    {error && <p className="history-error" role="alert">{error}<button onClick={onConsole}>{t('Show output')}</button></p>}
    {items === null && !error && <div className="loading-shell" aria-label={t('Reading the discarded changes')}><div className="skeleton" /></div>}
    {items?.length === 0 && <p className="empty-inline">{t('Nothing has been discarded here yet.')}</p>}
    {items?.length > 0 && <ul className="discard-list" aria-label={t('Discarded changes')}>
      {items.map(item => <li key={item.id}>
        <div>
          <strong title={item.files.join('\n')}>{discardedTitle(item)}</strong>
          <small><time title={formatDateTime(item.at * 1000)}>{relativeTime(item.at)}</time>{discardedLine(item) && <> · {discardedLine(item)}</>}</small>
        </div>
        <Button icon={RotateCcw} reason={busy ? t('Git is working') : undefined} onClick={() => restore(item)}>{t('Restore…')}</Button>
      </li>)}
    </ul>}
  </div>;
}
