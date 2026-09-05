import { useRef, useState } from 'react';
import { PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, clampPanelWidth, dragPanelWidth, panelWidthLimits } from './panel-width.js';

const STEP = 16;
const PAGE = 64;

export default function Splitter({ width, onWidth, label = 'Commit panel width' }) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const element = useRef(null);

  // The room the graph and the panel share: from the graph's left edge to the
  // workspace's right edge, measured when it is needed rather than watched.
  function room() {
    const node = element.current;
    const graph = node?.previousElementSibling;
    const parent = node?.parentElement;
    if (!graph || !parent) return Infinity;
    return parent.getBoundingClientRect().right - graph.getBoundingClientRect().left;
  }

  function start(event) {
    if (event.button !== 0) return;
    element.current.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width, available: room() };
    setDragging(true);
    event.preventDefault();
  }
  function move(event) {
    if (!drag.current) return;
    onWidth(dragPanelWidth(drag.current.width, event.clientX - drag.current.x, drag.current.available));
  }
  function end() { drag.current = null; setDragging(false); }

  function key(event) {
    const available = room();
    const { min, max } = panelWidthLimits(available);
    const step = event.shiftKey ? PAGE : STEP;
    const next = event.key === 'ArrowLeft' ? width + step
      : event.key === 'ArrowRight' ? width - step
        : event.key === 'Home' ? min
          : event.key === 'End' ? max
            : event.key === 'Enter' ? PANEL_DEFAULT : null;
    if (next === null) return;
    event.preventDefault();
    onWidth(clampPanelWidth(next, available));
  }

  return <div ref={element} className={`detail-splitter ${dragging ? 'dragging' : ''}`} role="separator" tabIndex={0}
    aria-orientation="vertical" aria-label={label} aria-valuenow={width} aria-valuemin={PANEL_MIN} aria-valuemax={PANEL_MAX}
    title="Drag to resize · double-click to reset"
    onPointerDown={start} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end}
    onDoubleClick={() => onWidth(clampPanelWidth(PANEL_DEFAULT, room()))} onKeyDown={key} />;
}
