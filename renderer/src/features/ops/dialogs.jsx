import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import Dialog from '../../ui/Dialog.jsx';

/**
 * Confirmation for a destructive operation. §6.5 of the brief asks for two
 * things by name — the exact command that will run and what it destroys — so
 * both are required arguments rather than optional decoration, and the command
 * is shown in the same monospace form the console will log.
 */
export function ConfirmDialog({ title, command, consequence, confirmLabel, onConfirm, onClose }) {
  return <Dialog title={title} onClose={onClose}>
    <div className="confirm-dialog">
      <p className="confirm-consequence"><AlertTriangle aria-hidden="true" />{consequence}</p>
      <p className="muted">This command will run:</p>
      <code className="confirm-command">$ git {command.join(' ')}</code>
      <div className="dialog-actions">
        <Button onClick={onClose}>Cancel</Button>
        <Button className="danger" onClick={() => { onClose(); onConfirm(); }}>{confirmLabel}</Button>
      </div>
    </div>
  </Dialog>;
}

/**
 * Asks for a ref name, and for a tag also for an optional message. The name is
 * checked here only for the mistakes worth catching before a process starts;
 * Git remains the authority and its refusal is shown as-is.
 */
export function NameDialog({ title, label, placeholder, confirmLabel, extra, withMessage, onConfirm, onClose }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [checked, setChecked] = useState(false);
  const invalid = name.length > 0 && /[\s~^:?*[\\]|\.\.|^[-/.]|\.lock$|\/$/.test(name);
  return <Dialog title={title} onClose={onClose}>
    <form className="name-dialog" onSubmit={event => { event.preventDefault(); onClose(); onConfirm({ name: name.trim(), message, checked }); }}>
      <label htmlFor="ref-name">{label}</label>
      {/* showModal() focuses the first control by itself, so this field is where the caret lands. */}
      <input id="ref-name" value={name} placeholder={placeholder} autoComplete="off" spellCheck={false}
        aria-describedby={invalid ? 'ref-name-error' : undefined} onChange={event => setName(event.target.value)} />
      {invalid && <p id="ref-name-error" role="alert" className="warn">A Git ref name cannot contain spaces, <code>..</code>, <code>~^:?*[\</code>, or end with <code>/</code> or <code>.lock</code>.</p>}
      {withMessage && <>
        <label htmlFor="tag-message">Message (optional — a message makes it an annotated tag)</label>
        <textarea id="tag-message" rows={3} value={message} onChange={event => setMessage(event.target.value)} />
      </>}
      {extra && <label className="checkbox-row"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />{extra}</label>}
      <div className="dialog-actions">
        <Button type="button" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="primary" reason={name.trim().length === 0 ? 'Enter a name first' : invalid ? 'This name is not valid' : undefined}>{confirmLabel}</Button>
      </div>
    </form>
  </Dialog>;
}
