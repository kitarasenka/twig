import assert from 'node:assert/strict';
import { FILE_HISTORY_PANEL_SIZE, PANEL_DEFAULT, PANEL_MAX, PANEL_MIN, clampPanelWidth, dragPanelWidth, panelWidthLimits }
  from '../../renderer/src/ui/panel-width.js';

// The panel sits on the right, so the divider moving left has to widen it.
assert.equal(dragPanelWidth(300, -40, 1200), 340);
assert.equal(dragPanelWidth(300, 40, 1200), 260);
assert.equal(dragPanelWidth(300, 0, 1200), 300);

// A fractional pointer position still yields a whole number of pixels.
assert.equal(dragPanelWidth(300, -10.4, 1200), 310);

// Both ends hold, whatever the drag distance.
assert.equal(dragPanelWidth(300, -5000, 4000), PANEL_MAX);
assert.equal(dragPanelWidth(300, 5000, 4000), PANEL_MIN);

// A narrow window keeps room for the graph: the panel stops before it collapses.
assert.deepEqual(panelWidthLimits(700), { min: PANEL_MIN, max: 460 });
assert.equal(dragPanelWidth(300, -400, 700), 460);
// Narrower than graph plus panel: the minimum still wins over the graph floor,
// because a divider that cannot move back is worse than a squeezed graph.
assert.deepEqual(panelWidthLimits(300), { min: PANEL_MIN, max: PANEL_MIN });
assert.equal(clampPanelWidth(500, 300), PANEL_MIN);

// Unknown room (the element is not laid out yet) falls back to the fixed range.
assert.deepEqual(panelWidthLimits(Infinity), { min: PANEL_MIN, max: PANEL_MAX });
assert.deepEqual(panelWidthLimits(undefined), { min: PANEL_MIN, max: PANEL_MAX });
assert.equal(clampPanelWidth(Number.NaN, 1200), PANEL_DEFAULT);
assert.ok(PANEL_MIN <= PANEL_DEFAULT && PANEL_DEFAULT <= PANEL_MAX);

// The file-history diff panel may grow to twice the normal maximum, but the
// graph floor still applies and the shared clamps carry the wider size through.
assert.equal(FILE_HISTORY_PANEL_SIZE.max, PANEL_MAX * 2);
assert.deepEqual(panelWidthLimits(Infinity, FILE_HISTORY_PANEL_SIZE), { min: PANEL_MIN, max: PANEL_MAX * 2 });
assert.equal(dragPanelWidth(560, -5000, 4000, 'right', FILE_HISTORY_PANEL_SIZE), PANEL_MAX * 2);
assert.equal(clampPanelWidth(PANEL_MAX * 2, 900, FILE_HISTORY_PANEL_SIZE), 660);
assert.ok(PANEL_MIN <= FILE_HISTORY_PANEL_SIZE.defaultWidth && FILE_HISTORY_PANEL_SIZE.defaultWidth <= FILE_HISTORY_PANEL_SIZE.max);

console.log('panel-width check passed');
