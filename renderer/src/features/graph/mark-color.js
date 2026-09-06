/**
 * Local commit mark colours. Kept in sync with the allow-list in `main/marks.js`
 * (the Node check asserts the two match). No imports on purpose: Vite loads this
 * module and so does the check, the same arrangement as `age-color.js`.
 */
export const MARK_COLORS = ['red', 'amber', 'green', 'blue', 'violet', 'slate'];
export const MARK_LABELS = {
  red: 'Red', amber: 'Amber', green: 'Green', blue: 'Blue', violet: 'Violet', slate: 'Slate'
};

/** CSS class that carries the mark colour into `--mark-color`, or '' for an unknown colour. */
export function markClass(color) { return MARK_COLORS.includes(color) ? `mark-${color}` : ''; }
