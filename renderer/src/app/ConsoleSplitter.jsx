import { useRef, useState } from 'react';
import { CONSOLE_SIZE, clampConsoleHeight, consoleDefaultHeight, writeConsoleHeight } from '../ui/panel-width.js';
import { t } from '../i18n/i18n.js';

const STEP = 16;
const PAGE = 64;

/** The console's top edge: dragging it up gives the console more of the window. Null is the default height. */
export default function ConsoleSplitter({ height, onHeight }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const element = useRef(null);
  const current = () => element.current?.parentElement.querySelector('.console-body')?.getBoundingClientRect().height ?? consoleDefaultHeight(innerHeight);

  function commit(next) {
    onHeight(next);
    writeConsoleHeight(globalThis.localStorage, next);
  }
  function start(event) {
    if (event.button !== 0) return;
    element.current.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height: current() };
    setDragging(true);
    event.preventDefault();
  }
  function move(event) {
    if (drag.current) onHeight(clampConsoleHeight(drag.current.height + drag.current.y - event.clientY, innerHeight));
  }
  function end() {
    if (!drag.current) return;
    drag.current = null;
    setDragging(false);
    commit(clampConsoleHeight(current(), innerHeight));
  }
  function key(event) {
    const step = event.shiftKey ? PAGE : STEP;
    const next = event.key === 'ArrowUp' ? current() + step
      : event.key === 'ArrowDown' ? current() - step
        : event.key === 'Home' ? CONSOLE_SIZE.min
          : event.key === 'End' ? innerHeight
            : event.key === 'Enter' ? null : undefined;
    if (next === undefined) return;
    event.preventDefault();
    commit(next === null ? null : clampConsoleHeight(next, innerHeight));
  }

  return <div ref={element} className={`console-splitter ${dragging ? 'dragging' : ''}`} role="separator" tabIndex={0}
    aria-orientation="horizontal" aria-label={t('Console height')} title={t('Drag to resize · double-click to reset')}
    aria-valuenow={Math.round(height ?? consoleDefaultHeight(innerHeight))} aria-valuemin={CONSOLE_SIZE.min} aria-valuemax={Math.round(innerHeight * CONSOLE_SIZE.maxShare)}
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => commit(null)} onKeyDown={key} />;
}
