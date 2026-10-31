import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, SquareTerminal, X } from 'lucide-react';

/**
 * Where notes go: the stack above the console that App renders. A hidden
 * repository tab provides null, so its notes wait until it is shown again.
 */
export const NoteRegion = createContext(null);

/** A note that is not a failure leaves by itself after this long, unless the pointer or focus is on it. */
export const NOTE_MS = 6000;

// The note after an action rises from the bottom of the window, above the console,
// instead of pushing the screen down. A failure reads as one at a glance: red tint,
// a warning icon and the word in the text, plus a real button to the failed
// command's output; it stays until it is dismissed.
export default function OperationNote({ note, onConsole, onDismiss }) {
  const region = useContext(NoteRegion);
  const [held, setHeld] = useState(false);
  // The parent passes a new arrow every render; the timer must not restart with it.
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const failed = typeof note === 'object' && note?.failed;
  // A note removed under the pointer never hears it leave: the next one starts free.
  useEffect(() => { if (!note || !region) setHeld(false); }, [note, region]);
  useEffect(() => {
    if (!note || failed || held || !region) return undefined;
    const timer = setTimeout(() => dismiss.current(), NOTE_MS);
    return () => clearTimeout(timer);
  }, [note, failed, held, region]);
  if (!note || !region) return null;
  return createPortal(<div className={`operation-note${failed ? ' failed' : ''}`} role={failed ? 'alert' : 'status'}
    onMouseEnter={() => setHeld(true)} onMouseLeave={() => setHeld(false)}
    onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false); }}>
    {failed && <AlertTriangle className="note-icon" aria-hidden="true" />}
    <span className="note-text">{typeof note === 'string' ? note : note.text}</span>
    {failed && <button className="note-output" onClick={onConsole}><SquareTerminal aria-hidden="true" />Show output</button>}
    <button className="note-dismiss" onClick={onDismiss} aria-label="Dismiss" title="Dismiss"><X aria-hidden="true" /></button>
  </div>, region);
}
