/**
 * @typedef {Object} StatusSubmodule
 * @property {boolean} commitChanged
 * @property {boolean} trackedChanges
 * @property {boolean} untrackedChanges
 */

/**
 * @typedef {Object} StatusScore
 * @property {'rename'|'copy'} kind
 * @property {number} value 0..100
 */

/**
 * @typedef {Object} StatusEntry
 * @property {'ordinary'|'renamed'|'unmerged'|'untracked'|'ignored'} kind
 * @property {string} path
 * @property {?string} originalPath
 * @property {string} indexStatus
 * @property {string} worktreeStatus
 * @property {?StatusSubmodule} submodule
 * @property {?StatusScore} score
 */

/**
 * @typedef {Object} StatusBranch
 * @property {?string} oid
 * @property {?string} name
 * @property {boolean} detached
 * @property {boolean} unborn
 * @property {?string} upstream
 * @property {number} ahead
 * @property {number} behind
 */

/**
 * @typedef {Object} ParsedStatus
 * @property {StatusBranch} branch
 * @property {StatusEntry[]} entries
 */

export class StatusParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StatusParseError';
  }
}

const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const MODE_PATTERN = /^[0-7]+$/;
const RENAME_SCORE_PATTERN = /^([RC])(\d{1,3})$/;
const AB_PATTERN = /^\+(\d+) -(\d+)$/;
const ORDINARY_XY_CHARS = new Set(['.', 'M', 'T', 'A', 'D', 'R', 'C', 'U']);
const UNMERGED_XY_CHARS = new Set(['D', 'U', 'A']);

function fail(message) {
  throw new StatusParseError(message);
}

/**
 * Splits `fieldCount` leading space-separated fields off the front of `line`,
 * returning the rest verbatim (paths may contain spaces, so this cannot use
 * a plain split).
 * @param {string} line
 * @param {number} fieldCount
 * @returns {{ fields: string[], rest: string }}
 */
function splitFields(line, fieldCount) {
  const fields = [];
  let rest = line;
  for (let i = 0; i < fieldCount; i++) {
    const idx = rest.indexOf(' ');
    if (idx === -1) fail('malformed status record');
    fields.push(rest.slice(0, idx));
    rest = rest.slice(idx + 1);
  }
  return { fields, rest };
}

function validateXY(xy, allowed) {
  if (xy.length !== 2 || !allowed.has(xy[0]) || !allowed.has(xy[1])) fail('invalid status code');
}

function validateMode(mode) {
  if (!MODE_PATTERN.test(mode)) fail('invalid file mode');
}

function validateHash(hash) {
  if (!OID_PATTERN.test(hash)) fail('invalid object hash');
}

/**
 * @param {string} sub raw 4-char submodule field
 * @returns {?StatusSubmodule}
 */
function parseSubmodule(sub) {
  if (sub.length !== 4) fail('invalid submodule field');
  if (sub === 'N...') return null;
  if (sub[0] === 'S' && (sub[1] === 'C' || sub[1] === '.') && (sub[2] === 'M' || sub[2] === '.')
    && (sub[3] === 'U' || sub[3] === '.')) {
    return { commitChanged: sub[1] === 'C', trackedChanges: sub[2] === 'M', untrackedChanges: sub[3] === 'U' };
  }
  fail('invalid submodule field');
}

function parseOrdinary(line) {
  const { fields, rest } = splitFields(line, 8);
  const [, xy, sub, mH, mI, mW, hH, hI] = fields;
  validateXY(xy, ORDINARY_XY_CHARS);
  const submodule = parseSubmodule(sub);
  validateMode(mH); validateMode(mI); validateMode(mW);
  validateHash(hH); validateHash(hI);
  if (rest.length === 0) fail('missing path');
  return {
    kind: 'ordinary',
    path: rest,
    originalPath: null,
    indexStatus: xy[0],
    worktreeStatus: xy[1],
    submodule,
    score: null
  };
}

function parseRenamed(line, originalPath) {
  const { fields, rest } = splitFields(line, 9);
  const [, xy, sub, mH, mI, mW, hH, hI, xscore] = fields;
  validateXY(xy, ORDINARY_XY_CHARS);
  const submodule = parseSubmodule(sub);
  validateMode(mH); validateMode(mI); validateMode(mW);
  validateHash(hH); validateHash(hI);
  const scoreMatch = RENAME_SCORE_PATTERN.exec(xscore);
  if (!scoreMatch) fail('invalid rename score');
  const value = Number(scoreMatch[2]);
  if (value > 100) fail('invalid rename score');
  if (rest.length === 0) fail('missing path');
  if (originalPath === undefined) fail('missing rename original path');
  return {
    kind: 'renamed',
    path: rest,
    originalPath,
    indexStatus: xy[0],
    worktreeStatus: xy[1],
    submodule,
    score: { kind: scoreMatch[1] === 'R' ? 'rename' : 'copy', value }
  };
}

function parseUnmerged(line) {
  const { fields, rest } = splitFields(line, 10);
  const [, xy, sub, m1, m2, m3, mW, h1, h2, h3] = fields;
  validateXY(xy, UNMERGED_XY_CHARS);
  const submodule = parseSubmodule(sub);
  validateMode(m1); validateMode(m2); validateMode(m3); validateMode(mW);
  validateHash(h1); validateHash(h2); validateHash(h3);
  if (rest.length === 0) fail('missing path');
  return {
    kind: 'unmerged',
    path: rest,
    originalPath: null,
    indexStatus: xy[0],
    worktreeStatus: xy[1],
    submodule,
    score: null
  };
}

function parseOther(line, kind) {
  const { rest } = splitFields(line, 1);
  if (rest.length === 0) fail('missing path');
  return { kind, path: rest, originalPath: null, indexStatus: '.', worktreeStatus: '.', submodule: null, score: null };
}

/**
 * Parses one `# key value` header line into `branch`. Headers this parser
 * doesn't know about (including `# stash N` and any future addition) are
 * ignored, matching Git's own forward-compatibility contract for this format.
 * @param {string} line
 * @param {StatusBranch} branch
 */
function parseHeader(line, branch) {
  if (line[0] !== '#' || line[1] !== ' ') fail('malformed header');
  const content = line.slice(2);
  const spaceIdx = content.indexOf(' ');
  const key = spaceIdx === -1 ? content : content.slice(0, spaceIdx);
  const value = spaceIdx === -1 ? '' : content.slice(spaceIdx + 1);
  switch (key) {
    case 'branch.oid':
      if (value === '(initial)') { branch.unborn = true; branch.oid = null; }
      else if (OID_PATTERN.test(value)) branch.oid = value;
      else fail('invalid branch.oid header');
      break;
    case 'branch.head':
      if (value === '(detached)') { branch.detached = true; branch.name = null; }
      else if (value.length > 0) branch.name = value;
      else fail('invalid branch.head header');
      break;
    case 'branch.upstream':
      if (value.length === 0) fail('invalid branch.upstream header');
      branch.upstream = value;
      break;
    case 'branch.ab': {
      const match = AB_PATTERN.exec(value);
      if (!match) fail('invalid branch.ab header');
      branch.ahead = Number(match[1]);
      branch.behind = Number(match[2]);
      break;
    }
    default:
      break;
  }
}

/**
 * Parses the NUL-delimited output of `git status --porcelain=v2 --branch -z`.
 * Performs a single linear pass with no Git invocation of its own.
 * @param {string} output raw UTF-8 output, not human-quoted
 * @returns {ParsedStatus}
 */
export function parseStatusV2(output) {
  if (typeof output !== 'string') fail('output must be a string');

  const branch = { oid: null, name: null, detached: false, unborn: false, upstream: null, ahead: 0, behind: 0 };
  const entries = [];

  if (output.length === 0) return { branch, entries };
  if (!output.endsWith('\0')) fail('truncated record');

  const tokens = output.split('\0');
  tokens.pop();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.length === 0) fail('empty record');
    switch (token[0]) {
      case '#':
        parseHeader(token, branch);
        break;
      case '1':
        entries.push(parseOrdinary(token));
        break;
      case '2': {
        i++;
        if (i >= tokens.length) fail('missing rename original path');
        entries.push(parseRenamed(token, tokens[i]));
        break;
      }
      case 'u':
        entries.push(parseUnmerged(token));
        break;
      case '?':
        entries.push(parseOther(token, 'untracked'));
        break;
      case '!':
        entries.push(parseOther(token, 'ignored'));
        break;
      default:
        fail('unknown record type');
    }
  }

  return { branch, entries };
}
