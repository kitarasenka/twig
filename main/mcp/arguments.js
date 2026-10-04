import { McpError } from './errors.js';

const TYPES = {
  string: value => typeof value === 'string',
  integer: value => Number.isInteger(value),
  boolean: value => typeof value === 'boolean',
  null: value => value === null
};

/**
 * Checks tool arguments against the subset of JSON Schema the catalog uses —
 * `type` (one or several), `minimum`/`maximum`, `required` and no extra keys —
 * and fills in declared defaults. Strings are capped so no argument can make a
 * tool hold an unbounded value. A mismatch is INVALID_ARGUMENT, not a crash.
 * @param {{ properties: object, required: string[] }} schema
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
export function validateArguments(schema, input) {
  const args = input === undefined || input === null ? {} : input;
  if (typeof args !== 'object' || Array.isArray(args)) throw new McpError('INVALID_ARGUMENT', 'arguments must be an object');
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(schema.properties, key)) throw new McpError('INVALID_ARGUMENT', `Unknown argument: ${key}`);
  }
  for (const key of schema.required) {
    if (args[key] === undefined) throw new McpError('INVALID_ARGUMENT', `Missing argument: ${key}`);
  }
  const result = {};
  for (const [key, spec] of Object.entries(schema.properties)) {
    const value = args[key] === undefined ? spec.default : args[key];
    if (value === undefined) continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    if (!types.some(type => TYPES[type](value))) throw new McpError('INVALID_ARGUMENT', `${key} must be ${types.join(' or ')}`);
    if (typeof value === 'string' && (value.length > 4096 || value.includes('\0'))) throw new McpError('INVALID_ARGUMENT', `${key} is too long or contains NUL`);
    if (typeof value === 'number' && ((spec.minimum !== undefined && value < spec.minimum) || (spec.maximum !== undefined && value > spec.maximum))) {
      throw new McpError('INVALID_ARGUMENT', `${key} must be between ${spec.minimum} and ${spec.maximum}`);
    }
    result[key] = value;
  }
  return result;
}

/** Pages are plain offsets: `nextCursor` is the index of the first item of the next page. */
export function readCursor(cursor) {
  if (cursor === undefined) return 0;
  if (!/^\d{1,9}$/.test(cursor)) throw new McpError('INVALID_ARGUMENT', 'cursor must be a nextCursor value from an earlier page');
  return Number(cursor);
}
