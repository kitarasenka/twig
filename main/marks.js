/**
 * Local commit marks: a colour and an optional note kept only in userData,
 * never written to the repository and never run through Git. No imports on
 * purpose so the Node check can load it without the Electron or Git layer.
 */
export const MARK_COLORS = Object.freeze(['red', 'amber', 'green', 'blue', 'violet', 'slate']);
export const NOTE_LIMIT = 2000;

const OID = /^(?:[a-f\d]{40}|[a-f\d]{64})$/i;

/** Lowercased oid or TypeError, so an invalid IPC call is rejected rather than answered. */
export function validateOid(oid) {
  if (typeof oid !== 'string' || !OID.test(oid)) throw new TypeError('Invalid commit identifier');
  return oid.toLowerCase();
}

/** Normalises a full mark or throws TypeError. */
export function validateMark(oid, color, note) {
  if (!MARK_COLORS.includes(color)) throw new TypeError('Unknown mark colour');
  if (typeof note !== 'string' || note.length > NOTE_LIMIT || note.includes('\0')) throw new TypeError('Invalid mark note');
  return { oid: validateOid(oid), color, note };
}
