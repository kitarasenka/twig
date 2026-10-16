import { AlertTriangle, SquareTerminal } from 'lucide-react';

// The note above a screen after an action. A failure reads as one at a glance: red tint,
// a warning icon and the word in the text, plus a real button to the failed command's output.
export default function OperationNote({ note, onConsole, onDismiss }) {
  if (!note) return null;
  const failed = typeof note === 'object' && note.failed;
  return <div className={`operation-note${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'}>
    {failed && <AlertTriangle className="note-icon" aria-hidden="true" />}
    <span>{typeof note === 'string' ? note : note.text}</span>
    {failed && <button className="note-output" onClick={onConsole}><SquareTerminal aria-hidden="true" />Show output</button>}
    <button className="note-dismiss" onClick={onDismiss} aria-label="Dismiss">×</button>
  </div>;
}
