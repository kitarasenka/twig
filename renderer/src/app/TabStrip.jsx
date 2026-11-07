import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, FolderOpen, GitBranch, Plus, X } from 'lucide-react';
import Button from '../ui/Button.jsx';
import Menu from '../ui/Menu.jsx';
import { t } from '../i18n/i18n.js';

/**
 * The repository tabs. A tab has a width limit and its close button sits outside
 * what gets cut, so a long name or an OFFLINE label cannot push it off the strip.
 * More tabs than fit: the strip scrolls, its edges fade on the side where tabs
 * are hidden, and a button lists them all.
 */
export default function TabStrip({ repositories, closedTabs, active, emptyOpen, onSelect, onShowNew, onClose, onCloseNew, onNew }) {
  const strip = useRef(null);
  const listButton = useRef(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [list, setList] = useState(null);
  const open = repositories.filter(item => !closedTabs.has(item.id));
  const measure = useCallback(() => {
    const node = strip.current;
    if (!node) return;
    const left = node.scrollLeft > 1;
    const right = node.scrollLeft + node.clientWidth < node.scrollWidth - 1;
    setEdges(current => (current.left === left && current.right === right ? current : { left, right }));
  }, []);
  useEffect(() => {
    const observer = new ResizeObserver(measure);
    observer.observe(strip.current);
    return () => observer.disconnect();
  }, [measure]);
  useLayoutEffect(measure, [measure, repositories, closedTabs, emptyOpen]);
  // The strip has no visible scrollbar: the active tab scrolls into view,
  // and a plain mouse wheel scrolls the strip sideways.
  useEffect(() => {
    strip.current?.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active, closedTabs, emptyOpen]);
  function scrollTabs(event) {
    if (event.deltaX === 0 && event.deltaY !== 0) event.currentTarget.scrollLeft += event.deltaY;
  }
  function openList() {
    const box = listButton.current.getBoundingClientRect();
    setList({ x: box.left, y: box.bottom + 2 });
  }
  const label = item => (item.sandbox ? t('DEMO') : item.blocked ? t('STOPPED') : item.available === false ? t('MISSING') : null);
  return <div className="tab-strip">
    <nav className={`tabs ${edges.left ? 'tabs-more-left' : ''} ${edges.right ? 'tabs-more-right' : ''}`} aria-label={t('Repository tabs')} ref={strip} onWheel={scrollTabs} onScroll={measure}>
      {open.map(item => <div key={item.id} className={`tab ${active === `repository:${item.id}` ? 'active' : ''}`}>
        <button aria-current={active === `repository:${item.id}` ? 'page' : undefined} title={item.path || item.name} onClick={() => onSelect(item.id)}><GitBranch /><span>{item.name}</span>{label(item) && <small title={item.blocked ? t('Its Git settings changed. Open repository asks again.') : undefined}>{label(item)}</small>}</button>
        <Button icon={X} aria-label={t`Close ${item.name} tab`} title={item.sandbox ? t('Close the demo workspace') : t`Close ${item.name}`} onClick={() => onClose(item)} /></div>)}
      {emptyOpen && <div className={`tab ${active === 'new' ? 'active' : ''}`}><button aria-current={active === 'new' ? 'page' : undefined} onClick={onShowNew}><FolderOpen /><span>{t('New repository')}</span></button><Button icon={X} aria-label={t('Close new tab')} onClick={onCloseNew} /></div>}
    </nav>
    {(edges.left || edges.right) && <span ref={listButton} className="tab-list-button"><Button icon={ChevronDown} aria-label={t('All tabs')} aria-haspopup="menu" title={t('All tabs')} onClick={openList} /></span>}
    <Button icon={Plus} aria-label={t('New repository tab')} title={t('New repository tab')} onClick={onNew} />
    {list && <Menu x={list.x} y={list.y} label={t('All tabs')} onClose={() => setList(null)}
      items={[...open.map(item => ({ key: item.id, text: item.name, hint: label(item) || undefined, checked: active === `repository:${item.id}`, run: () => onSelect(item.id) })),
        ...(emptyOpen ? [{ key: 'new', text: t('New repository'), checked: active === 'new', run: onShowNew }] : [])]} />}
  </div>;
}
