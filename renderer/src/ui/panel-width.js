/**
 * Where the commit panel's edge may sit.
 *
 * The panel is the right-hand column, so dragging the divider left widens it:
 * a negative pointer delta grows the panel. The graph keeps a floor of its
 * own, because the grid column would otherwise collapse to nothing on a narrow
 * window and the divider would have no way back.
 *
 * No imports: Vite loads this for the workspace and Node loads it in the
 * self-check, and both read the same file.
 */
export const PANEL_MIN = 240;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 306;
const GRAPH_MIN = 240;

/** `available` is the width the graph and the panel share, sidebar excluded. */
export function panelWidthLimits(available) {
  const room = Number.isFinite(available) ? available - GRAPH_MIN : PANEL_MAX;
  return { min: PANEL_MIN, max: Math.max(PANEL_MIN, Math.min(PANEL_MAX, room)) };
}

export function clampPanelWidth(width, available) {
  if (!Number.isFinite(width)) return PANEL_DEFAULT;
  const { min, max } = panelWidthLimits(available);
  return Math.round(Math.min(max, Math.max(min, width)));
}

export function dragPanelWidth(startWidth, deltaX, available) {
  return clampPanelWidth(startWidth - deltaX, available);
}
