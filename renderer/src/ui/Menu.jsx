import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronRight } from 'lucide-react';
import { t } from '../i18n/i18n.js';

const SUBMENU_DELAY_MS = 120;
const ITEMS = '[role^="menuitem"]:not([disabled])';

/**
 * One column of items. An item with `submenu` (a list of items) opens it beside
 * itself: on hover, on click, with the right arrow or Enter. Its items are the
 * same kind, and the left arrow or Escape comes back to the item that opened them.
 */
function MenuColumn({ items, label, className = '', columnRef, onKeyDown, onItemClick, onItemHover, openKey, onLeave }) {
  const enabled = items.filter(item => !item.separator && !item.reason);
  return <div className={`menu ${className}`} role="menu" aria-label={label} ref={columnRef} onKeyDown={onKeyDown} onPointerLeave={onLeave}>
    {items.map((item, index) => {
      if (item.separator) return <hr key={`separator-${index}`} role="separator" />;
      return <button key={item.key} role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'} type="button"
        disabled={Boolean(item.reason)} className={item.danger ? 'destructive' : undefined} data-menu-key={item.key}
        aria-checked={item.checked === undefined ? undefined : item.checked}
        aria-haspopup={item.submenu ? 'menu' : undefined} aria-expanded={item.submenu ? openKey === item.key : undefined}
        title={item.reason || item.title || item.text} aria-label={item.reason ? `${item.text}: ${item.reason}` : undefined}
        onPointerEnter={event => onItemHover(item, event.currentTarget)} onClick={event => onItemClick(item, event.currentTarget)}>
        {item.checked !== undefined && <Check aria-hidden="true" className={item.checked ? '' : 'menu-check-empty'} />}
        {item.icon && <item.icon aria-hidden="true" />}<span>{item.text}</span>
        {item.hint && <small>{item.hint}</small>}
        {item.submenu && <ChevronRight className="menu-chevron" aria-hidden="true" />}
      </button>;
    })}
    {enabled.length === 0 && <p className="menu-empty">{t('Nothing can be done here right now.')}</p>}
  </div>;
}

/** Up/Down/Home/End within one column; Tab leaves the whole menu. */
function moveFocus(event, column) {
  const nodes = [...column.querySelectorAll(ITEMS)];
  const index = nodes.indexOf(document.activeElement);
  let next = null;
  if (event.key === 'ArrowDown') next = (index + 1) % nodes.length;
  else if (event.key === 'ArrowUp') next = (index - 1 + nodes.length) % nodes.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = nodes.length - 1;
  else return false;
  event.preventDefault();
  nodes[next]?.focus();
  return true;
}

/**
 * A context menu that works without a mouse. Pointer users get it on
 * right-click; keyboard users get the same menu from the Menu key or
 * Shift+F10 on the focused row, then arrows, Home/End, Enter and Escape.
 *
 * Focus moves into the menu on open and returns to whatever opened it on
 * close, so a keyboard user is never dropped back at the top of the document.
 */
export default function Menu({ x, y, label, items, onClose, className = '' }) {
  const layer = useRef(null);
  const list = useRef(null);
  const subList = useRef(null);
  const hoverTimer = useRef(0);
  const [position, setPosition] = useState({ left: x, top: y, ready: false });
  // { item, anchor (its button), focus: move into it once placed, left, top, ready }
  const [sub, setSub] = useState(null);

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
    if (position.ready) list.current.querySelector(ITEMS)?.focus();
  }, [position.ready]);

  useEffect(() => {
    // Whatever had focus when the menu opened gets it back when it closes, so
    // a keyboard user lands on the same commit row rather than on the body.
    const opener = document.activeElement;
    return () => { if (opener instanceof HTMLElement && document.body.contains(opener)) opener.focus(); };
  }, []);

  useEffect(() => {
    const dismiss = event => { if (!layer.current?.contains(event.target)) onClose(); };
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
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  // Beside the item, on the side with room, and never below the window.
  useLayoutEffect(() => {
    if (!sub || sub.ready) return;
    const box = subList.current.getBoundingClientRect();
    const anchor = sub.anchor.getBoundingClientRect();
    const fits = anchor.right + box.width <= innerWidth - 4;
    setSub(current => current && ({ ...current, ready: true,
      left: fits ? anchor.right - 2 : Math.max(4, anchor.left - box.width + 2),
      top: Math.max(4, Math.min(anchor.top - 5, innerHeight - box.height - 4)) }));
  }, [sub]);
  useLayoutEffect(() => {
    if (sub?.ready && sub.focus) subList.current.querySelector(ITEMS)?.focus();
  }, [sub?.ready, sub?.focus, sub?.item]);

  function openSub(item, anchor, focus) {
    clearTimeout(hoverTimer.current);
    setSub(current => (current?.item.key === item.key ? { ...current, focus: current.focus || focus } : { item, anchor, focus, left: 0, top: 0, ready: false }));
  }
  function closeSub(refocus) {
    clearTimeout(hoverTimer.current);
    if (refocus) sub?.anchor.focus();
    setSub(null);
  }
  function activate(item, node) {
    if (item.submenu) { openSub(item, node, true); return; }
    if (!item.stayOpen) onClose();
    item.run();
  }
  function hover(item, node) {
    clearTimeout(hoverTimer.current);
    if (item.reason) return;
    hoverTimer.current = setTimeout(() => {
      if (item.submenu) openSub(item, node, false);
      else setSub(null);
    }, SUBMENU_DELAY_MS);
  }

  function keydown(event) {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    const key = document.activeElement?.dataset?.menuKey;
    if (event.key === 'ArrowRight') {
      const item = items.find(entry => entry.key === key);
      if (item?.submenu) { event.preventDefault(); openSub(item, document.activeElement, true); }
      return;
    }
    moveFocus(event, list.current);
  }
  function subKeydown(event) {
    if (event.key === 'Escape' || event.key === 'ArrowLeft') { event.preventDefault(); closeSub(true); return; }
    if (event.key === 'Tab') { event.preventDefault(); onClose(); return; }
    moveFocus(event, subList.current);
  }

  return <div className="menu-layer" ref={layer} style={{ left: position.left, top: position.top, visibility: position.ready ? 'visible' : 'hidden' }}>
    <MenuColumn items={items} label={label} className={className} columnRef={list} onKeyDown={keydown} openKey={sub?.item.key}
      onItemClick={activate} onItemHover={hover} onLeave={() => clearTimeout(hoverTimer.current)} />
    {sub && <div className="submenu-layer" style={{ left: sub.left, top: sub.top, visibility: sub.ready ? 'visible' : 'hidden' }}>
      <MenuColumn items={sub.item.submenu} label={sub.item.text} columnRef={subList} onKeyDown={subKeydown}
        onItemClick={activate} onItemHover={() => clearTimeout(hoverTimer.current)} />
    </div>}
  </div>;
}
