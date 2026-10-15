import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import Button from '../../ui/Button.jsx';
import {
  SHORTCUTS, bindings, comboFromEvent, formatCombo, isMac, resetAllShortcuts, resetShortcut, setShortcut, subscribeShortcuts,
} from '../../app/shortcuts.js';

/**
 * Settings → Keyboard shortcuts: the one place 🌱 Twig's keys are listed.
 * Click a key, press the new one; Esc stops listening. A key another action
 * already uses, or one that types, copies or moves through lists, is refused
 * with the reason, and nothing changes.
 */
export default function ShortcutsSettings({ platform }) {
  const mac = platform ? platform === 'darwin' : isMac();
  const [current, setCurrent] = useState(() => bindings());
  const [recording, setRecording] = useState(null);
  const [problem, setProblem] = useState(null);
  useEffect(() => subscribeShortcuts(setCurrent), []);

  function listen(id, event) {
    if (recording !== id) return;
    if (event.key === 'Tab') { setRecording(null); return; }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Escape') { setRecording(null); setProblem(null); return; }
    const combo = comboFromEvent(event, mac);
    if (!combo) return; // a lone modifier: wait for the key
    const result = setShortcut(id, combo, globalThis.localStorage, mac);
    if (result.ok) { setRecording(null); setProblem(null); }
    else setProblem({ id, reason: result.reason });
  }
  function reset(id) {
    const result = resetShortcut(id, globalThis.localStorage, mac);
    setProblem(result.ok ? null : { id, reason: result.reason });
  }

  const groups = [...new Set(SHORTCUTS.map(item => item.group))];
  return <div className="shortcuts-settings">
    <p className="muted">Click a shortcut, then press the keys you want. Esc stops without changing it.</p>
    {groups.map(group => <section key={group} aria-label={group}>
      <h3 className="shortcuts-group">{group}</h3>
      <ul className="shortcuts-list">
        {SHORTCUTS.filter(item => item.group === group).map(item => {
          const listening = recording === item.id;
          const changed = current[item.id] !== item.default;
          return <li key={item.id} className="shortcut-row">
            <span className="shortcut-label">{item.label}</span>
            <span className="shortcut-controls">
              <button type="button" className={`shortcut-key ${listening ? 'listening' : ''} ${changed ? 'changed' : ''}`}
                aria-label={`${item.label}: ${listening ? 'press the new keys' : formatCombo(current[item.id], mac)}`}
                onClick={() => { setProblem(null); setRecording(listening ? null : item.id); }}
                onKeyDown={event => listen(item.id, event)} onBlur={() => { if (listening) setRecording(null); }}>
                {listening ? 'Press keys…' : formatCombo(current[item.id], mac)}
              </button>
              <Button icon={RotateCcw} aria-label={`Reset ${item.label} to ${formatCombo(item.default, mac)}`}
                reason={changed ? undefined : 'Already the default'} onClick={() => reset(item.id)} />
            </span>
            {problem?.id === item.id && <p className="shortcut-problem" role="alert">{problem.reason}</p>}
          </li>;
        })}
      </ul>
    </section>)}
    <div className="dialog-actions">
      <Button icon={RotateCcw} reason={Object.keys(current).every(id => current[id] === SHORTCUTS.find(item => item.id === id).default) ? 'Every shortcut is the default' : undefined}
        onClick={() => { resetAllShortcuts(globalThis.localStorage); setProblem(null); setRecording(null); }}>Reset all shortcuts</Button>
    </div>
  </div>;
}
