import { useRef, useState } from 'react';
import { PANEL_DEFAULT, SIDEBAR_SIZE, clampPanelWidth, dragPanelWidth, panelWidthLimits } from './panel-width.js';

const STEP = 16;
const PAGE = 64;

export default function Splitter({ width, onWidth, side = 'right', label = 'Commit panel width' }) {
  const size = side === 'left' ? SIDEBAR_SIZE : undefined;
  const defaultWidth = size?.defaultWidth ?? PANEL_DEFAULT;
  const limits = panelWidthLimits(Infinity, size);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const element = useRef(null);

  // Measure only the two adjacent panes, excluding the other sidebar and divider.
  function room() {
    const node = element.current;
    const before = node?.previousElementSibling;
    const after = node?.nextElementSibling;
    if (!before || !after) return Infinity;
    return before.getBoundingClientRect().width + after.getBoundingClientRect().width;
  }

  function currentWidth() {
    const node = side === 'left' ? element.current?.previousElementSibling : element.current?.nextElementSibling;
    return node?.getBoundingClientRect().width ?? width;
  }

  function start(event) {
    if (event.button !== 0) return;
    element.current.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: currentWidth(), available: room() };
    setDragging(true);
    event.preventDefault();
  }
  function move(event) {
    if (!drag.current) return;
    onWidth(dragPanelWidth(drag.current.width, event.clientX - drag.current.x, drag.current.available, side, size));
  }
  function end() { drag.current = null; setDragging(false); }

  function key(event) {
    const available = room();
    const { min, max } = panelWidthLimits(available, size);
    const step = (event.shiftKey ? PAGE : STEP) * (side === 'left' ? -1 : 1);
    const current = currentWidth();
    const next = event.key === 'ArrowLeft' ? current + step
      : event.key === 'ArrowRight' ? current - step
        : event.key === 'Home' ? min
          : event.key === 'End' ? max
            : event.key === 'Enter' ? defaultWidth : null;
    if (next === null) return;
    event.preventDefault();
    onWidth(clampPanelWidth(next, available, size));
  }

  return <div ref={element} className={`detail-splitter ${dragging ? 'dragging' : ''}`} role="separator" tabIndex={0}
    aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={limits.min} aria-valuemax={limits.max}
    title="Drag to resize · double-click to reset"
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => onWidth(clampPanelWidth(defaultWidth, room(), size))} onKeyDown={key} />;
}
