import { useEffect, useRef } from 'react';

/**
 * The name of a screen that stands in for the graph, in that screen's one
 * heading. Focus lands here when the screen opens, so a keyboard moves on from
 * the screen and a screen reader says which one this is. A field being typed in
 * keeps its focus.
 */
export default function ScreenTitle({ icon: Icon, title, children }) {
  const heading = useRef(null);
  useEffect(() => {
    if (!document.activeElement?.matches('input, textarea, select, [contenteditable="true"]')) heading.current?.focus({ preventScroll: true });
  }, []);
  return <h2 className="screen-title" ref={heading} tabIndex={-1}>{Icon && <Icon aria-hidden="true" />}<span>{title}</span>{children}</h2>;
}
