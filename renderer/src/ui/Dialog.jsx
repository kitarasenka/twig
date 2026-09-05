import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import Button from './Button.jsx';

export default function Dialog({ title, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} aria-labelledby="dialog-title" onCancel={onClose}>
    <header className="panel-heading"><h2 id="dialog-title">{title}</h2>
      <Button icon={X} aria-label="Close dialog" title="Close · Esc" onClick={onClose} /></header>
    <div className="dialog-content">{children}</div>
  </dialog>;
}
