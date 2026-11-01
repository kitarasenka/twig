/**
 * Local commit mark colours. Kept in sync with the allow-list in `main/marks.js`
 * (the Node check asserts the two match). Only the i18n module is imported: Vite
 * loads this module and so does the check, the same arrangement as `age-color.js`.
 */
import { mark } from '../../i18n/i18n.js';

export const MARK_COLORS = ['red', 'amber', 'green', 'blue', 'violet', 'slate'];
export const MARK_LABELS = {
  red: mark('Red'), amber: mark('Amber'), green: mark('Green'), blue: mark('Blue'), violet: mark('Violet'), slate: mark('Slate')
};

/** CSS class that carries the mark colour into `--mark-color`, or '' for an unknown colour. */
export function markClass(color) { return MARK_COLORS.includes(color) ? `mark-${color}` : ''; }
