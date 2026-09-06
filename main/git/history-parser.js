/**
 * @typedef {Object} CommitAuthor
 * @property {string} name
 * @property {string} email
 * @property {string} date ISO-8601
 */

/**
 * @typedef {Object} Commit
 * @property {string} oid 40 or 64 hex chars
 * @property {string[]} parents
 * @property {CommitAuthor} author
 * @property {string} committedAt ISO-8601
 * @property {string} subject
 * @property {string} body
 */

export class HistoryParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HistoryParseError';
  }
}

function fail(message) {
  throw new HistoryParseError(message);
}

const FIELD_COUNT = 8;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateOid(value) {
  if (!OID_PATTERN.test(value)) fail('invalid commit oid');
}

function parseParents(field) {
  if (field.length === 0) return [];
  const parents = field.split(' ');
  for (const parent of parents) validateOid(parent);
  return parents;
}

/**
 * Parses the output of `git log` run with `-z` and this module's own
 * `%H%x00%P%x00%an%x00%ae%x00%aI%x00%cI%x00%s%x00%b` format: `-z` makes
 * every record NUL-terminated (instead of the default trailing newline),
 * so together with the 7 in-format `%x00` separators each commit occupies
 * exactly 8 NUL-delimited tokens with no separator of its own between commits.
 * @param {string} output
 * @returns {Commit[]}
 */
export function parseHistoryV1(output) {
  if (typeof output !== 'string') fail('output must be a string');
  if (output.length === 0) return [];
  if (!output.endsWith('\0')) fail('truncated history record');

  const tokens = output.split('\0');
  tokens.pop();
  if (tokens.length === 0) return [];
  if (tokens.length % FIELD_COUNT !== 0) fail('wrong field count');

  const commits = [];
  for (let i = 0; i < tokens.length; i += FIELD_COUNT) {
    const [oid, parentsField, authorName, authorEmail, authorDate, committerDate, subject, body] = tokens.slice(i, i + FIELD_COUNT);
    validateOid(oid);
    const parents = parseParents(parentsField);
    if (!ISO_DATE_PATTERN.test(authorDate)) fail('invalid author date');
    if (!ISO_DATE_PATTERN.test(committerDate)) fail('invalid committer date');
    commits.push({
      oid,
      parents,
      author: { name: authorName, email: authorEmail, date: authorDate },
      committedAt: committerDate,
      subject,
      body
    });
  }
  return commits;
}

/** Read NUL-delimited name-status records after each eight-field commit header. */
export function parseFileHistory(output, file) {
  if (typeof output !== 'string') fail('output must be a string');
  if (!output) return [];
  if (!output.endsWith('\0')) fail('truncated file history');
  const tokens = output.split('\0');
  tokens.pop();
  const commits = [];
  let trackedPath = file;
  let i = 0;
  while (i < tokens.length) {
    const [commit] = parseHistoryV1(tokens.slice(i, i + FIELD_COUNT).join('\0') + '\0');
    i += FIELD_COUNT;
    const changes = [];
    while (i < tokens.length && !OID_PATTERN.test(tokens[i])) {
      const status = tokens[i++].replace(/^\n/, '');
      if (!/^(?:[AMDTUXB]|[RC]\d{1,3})$/.test(status)) fail('invalid file history status');
      const oldPath = tokens[i++];
      const path = /^[RC]/.test(status) ? tokens[i++] : oldPath;
      if (!oldPath || !path) fail('invalid file history path');
      changes.push({ status, oldPath, path });
    }
    const change = changes.find(item => item.path === trackedPath) || (changes.length === 1 ? changes[0] : null);
    if (changes.length && !change) fail('ambiguous file history path');
    commits.push({ ...commit, path: change?.path || trackedPath });
    if (change) trackedPath = /^[RC]/.test(change.status) ? change.oldPath : change.path;
  }
  return commits;
}
