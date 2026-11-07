import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import Button from './Button.jsx';
import { t } from '../i18n/i18n.js';

/**
 * `wide` is opt-in: a dialog is 480px unless its content genuinely needs a table.
 *
 * Focus goes to the element marked `data-autofocus`. Nothing marked is the close
 * button, which is what showModal() picks by itself: Enter there only closes, so
 * a dialog with a field to type in marks the field.
 *
 * Esc and the close button both call `onClose`. The dialog closes when its parent
 * stops rendering it, not before: a parent can answer `onClose` with a question.
 */
export default function Dialog({ title, onClose, wide = false, closeReason, children }) {
  const ref = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    dialog.querySelector('[data-autofocus]')?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  // Settings opens its sections inside the same dialog: the button that was pressed is gone.
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog.contains(document.activeElement)) (dialog.querySelector('[data-autofocus]') || dialog.querySelector('button'))?.focus();
  }, [title]);
  const requestClose = event => {
    event.preventDefault();
    if (!closeReason) onClose();
  };
  // Esc is taken at the key: Chromium lets a page refuse a `cancel` only once per
  // user activation, and a second Esc would close the dialog under its parent.
  return <dialog ref={ref} className={wide ? 'wide' : undefined} aria-labelledby={titleId} onCancel={requestClose}
    onKeyDown={event => { if (event.key === 'Escape' && !event.defaultPrevented) requestClose(event); }}>
    <header className="panel-heading"><h2 id={titleId}>{title}</h2>
      <Button icon={X} aria-label={t('Close dialog')} title={t('Close')} reason={closeReason} onClick={onClose} /></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
