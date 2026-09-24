/**
 * Where either panel's edge may sit.
 *
 * Dragging left widens the right panel; the sidebar uses the opposite direction.
 * The graph keeps a floor of its
 * own, because the grid column would otherwise collapse to nothing on a narrow
 * window and the divider would have no way back.
 *
 * No imports: Vite loads this for the workspace and Node loads it in the
 * self-check, and both read the same file.
 */
export const PANEL_MIN = 240;
export const PANEL_MAX = 560;
export const PANEL_DEFAULT = 306;
export const SIDEBAR_SIZE = { min: 160, max: 400, defaultWidth: 212 };
const PANEL_SIZE = { min: PANEL_MIN, max: PANEL_MAX, defaultWidth: PANEL_DEFAULT };
/**
 * The file-history diff panel may grow to twice the normal maximum: it shows a
 * full file diff on its own, with no graph row to read alongside it, so the
 * extra width is useful there and nowhere else. It also starts wide: at the
 * normal 306 px a diff line was cut off while the commit list beside it — a
 * handful of short rows — sat half empty. The graph floor in
 * `panelWidthLimits` still stops it before the graph collapses.
 */
export const FILE_HISTORY_PANEL_SIZE = { min: PANEL_MIN, max: PANEL_MAX * 2, defaultWidth: PANEL_MAX };
const GRAPH_MIN = 240;

/** `available` is the combined width of the graph and the panel being resized. */
export function panelWidthLimits(available, size = PANEL_SIZE) {
  const room = Number.isFinite(available) ? available - GRAPH_MIN : size.max;
  return { min: size.min, max: Math.max(size.min, Math.min(size.max, room)) };
}

export function clampPanelWidth(width, available, size = PANEL_SIZE) {
  if (!Number.isFinite(width)) width = size.defaultWidth;
  const { min, max } = panelWidthLimits(available, size);
  return Math.round(Math.min(max, Math.max(min, width)));
}

export function dragPanelWidth(startWidth, deltaX, available, side = 'right', size = PANEL_SIZE) {
  return clampPanelWidth(startWidth + (side === 'left' ? deltaX : -deltaX), available, size);
}
