import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import Button from './Button.jsx';

/** `wide` is opt-in: a dialog is 480px unless its content genuinely needs a table. */
export default function Dialog({ title, onClose, wide = false, closeReason, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    // showModal focuses the header's close button; a dialog can name the button Enter should press.
    dialog.querySelector('[data-autofocus]')?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={wide ? 'wide' : undefined} aria-labelledby="dialog-title" onCancel={event => { if (closeReason) event.preventDefault(); else onClose(); }}>
    <header className="panel-heading"><h2 id="dialog-title">{title}</h2>
      <Button icon={X} aria-label="Close dialog" title="Close" reason={closeReason} onClick={onClose} /></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
