/**
 * Machine-readable failures of a tool call. A tool throws `McpError`; the
 * session turns it into `{ error: { code, message, hint? } }` with `isError`.
 * Anything else a tool throws — Git exited non-zero, its output did not parse —
 * becomes GIT_OPERATION_FAILED, and the console holds the exact command.
 */
export const ERROR_CODES = Object.freeze([
  'NO_REPOSITORY_OPEN',
  'REPOSITORY_NOT_FOUND',
  'FILE_NOT_FOUND',
  'COMMIT_NOT_FOUND',
  'REF_NOT_FOUND',
  'INVALID_HUNK',
  'INVALID_ARGUMENT',
  'OUTPUT_TOO_LARGE',
  'GIT_OPERATION_FAILED',
  // Only the stdio bridge answers with this one, when 🌱 Twig is not listening.
  'TWIG_UNAVAILABLE'
]);

export class McpError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message
   * @param {{ hint?: string }} [extra]
   */
  constructor(code, message, extra = {}) {
    if (!ERROR_CODES.includes(code)) throw new TypeError(`Unknown MCP error code: ${code}`);
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.extra = extra;
  }
}

/** Runs a validator from the Git layer and reports its TypeError as a bad argument. */
export function checked(validate, value, field) {
  try { return validate(value); }
  catch (error) {
    if (error instanceof TypeError) throw new McpError('INVALID_ARGUMENT', `${field}: ${error.message}`);
    throw error;
  }
}
