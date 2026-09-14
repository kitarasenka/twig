import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';

/**
 * A context menu that works without a mouse. Pointer users get it on
 * right-click; keyboard users get the same menu from the Menu key or
 * Shift+F10 on the focused row, then arrows, Home/End, Enter and Escape.
 *
 * Focus moves into the menu on open and returns to whatever opened it on
 * close, so a keyboard user is never dropped back at the top of the document.
 */
export default function Menu({ x, y, label, items, onClose, className = '' }) {
  const list = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  // Same convention as Button: an item that carries a reason is disabled, and
  // the reason is what the tooltip and the accessible name explain.
  const enabled = items.filter(item => !item.separator && !item.reason);

  useLayoutEffect(() => {
    const box = list.current.getBoundingClientRect();
    // Flip rather than clip: a menu opened near the bottom edge would
    // otherwise lose its last items with no way to reach them.
    setPosition({
      left: Math.max(4, Math.min(x, innerWidth - box.width - 4)),
      top: y + box.height > innerHeight - 4 ? Math.max(4, y - box.height) : y,
      ready: true
    });
  }, [x, y]);

  // Focus has to wait for `ready`: the menu is measured while hidden, and a
  // `visibility: hidden` element silently refuses focus.
  useLayoutEffect(() => {
    if (position.ready) list.current.querySelector('[role="menuitem"]:not([disabled])')?.focus();
  }, [position.ready]);

  useEffect(() => {
    // Whatever had focus when the menu opened gets it back when it closes, so
    // a keyboard user lands on the same commit row rather than on the body.
    const opener = document.activeElement;
    return () => { if (opener instanceof HTMLElement && document.body.contains(opener)) opener.focus(); };
  }, []);

  useEffect(() => {
    const dismiss = event => { if (!list.current?.contains(event.target)) onClose(); };
    // `capture` so the click that dismisses the menu cannot also activate
    // whatever sits underneath it.
    document.addEventListener('pointerdown', dismiss, true);
    addEventListener('resize', onClose);
    addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('pointerdown', dismiss, true);
      removeEventListener('resize', onClose);
      removeEventListener('blur', onClose);
    };
  }, [onClose]);

  function keydown(event) {
    const nodes = [...list.current.querySelectorAll('[role="menuitem"]:not([disabled])')];
    const index = nodes.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    let next = null;
    if (event.key === 'ArrowDown') next = (index + 1) % nodes.length;
    else if (event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = nodes.length - 1;
    else return;
    event.preventDefault();
    nodes[next]?.focus();
  }

  return <div className="menu-layer" style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}>
    <div className={`menu ${className}`} role="menu" aria-label={label} ref={list} onKeyDown={keydown}>
      {items.map((item, index) => item.separator
        ? <hr key={`separator-${index}`} role="separator" />
        : <button key={item.key} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} type="button"
          disabled={Boolean(item.reason)} className={item.danger ? 'destructive' : undefined}
          aria-checked={item.checked === undefined ? undefined : item.checked}
          title={item.reason || undefined} aria-label={item.reason ? `${item.text}: ${item.reason}` : undefined}
          onClick={() => { if (!item.stayOpen) onClose(); item.run(); }}>
          {item.checked !== undefined && <Check aria-hidden="true" className={item.checked ? '' : 'menu-check-empty'} />}
          {item.icon && <item.icon aria-hidden="true" />}<span>{item.text}</span>
          {item.hint && <small>{item.hint}</small>}
        </button>)}
      {enabled.length === 0 && <p className="menu-empty">Nothing can be done here right now.</p>}
    </div>
  </div>;
}
