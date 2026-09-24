import { runGit } from './exec.js';

/**
 * @typedef {Object} Ref
 * @property {string} name display name, without the `refs/heads/` or `refs/remotes/` prefix
 * @property {string} fullName e.g. `refs/heads/main`
 * @property {string} target 40 or 64 hex chars; the commit a tag points at, not the tag object
 * @property {'local'|'remote'|'tag'} type
 * @property {?string} upstream e.g. `origin/main`, or `null`
 * @property {number} ahead
 * @property {number} behind
 */

export class RefsParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RefsParseError';
  }
}

function fail(message) {
  throw new RefsParseError(message);
}

const FIELD_COUNT = 8;
const OID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const OBJECT_TYPES = new Set(['blob', 'tree', 'commit', 'tag']);
const TRACK_PATTERN = /^\[(?:ahead (\d+))?(?:, )?(?:behind (\d+))?\]$/;
const TYPE_ORDER = { local: 0, remote: 1, tag: 2 };
const NAMESPACES = [
  ['refs/heads/', 'local'],
  ['refs/remotes/', 'remote'],
  ['refs/tags/', 'tag']
];

function validateOid(value) {
  if (!OID_PATTERN.test(value)) fail('invalid object id');
}

function classify(fullName) {
  for (const [prefix, type] of NAMESPACES) {
    if (fullName.startsWith(prefix)) {
      const name = fullName.slice(prefix.length);
      if (name.length === 0) fail('empty ref name');
      return { type, name };
    }
  }
  fail('unknown ref namespace');
}

/**
 * Reads `%(upstream)`, `%(upstream:short)` and `%(upstream:track)`. Per
 * git-for-each-ref(1): an empty `%(upstream)` means no upstream is
 * configured; a configured but deleted/unreachable upstream reports
 * `%(upstream:track)` as the literal `[gone]`, in which case we still
 * surface the configured name but cannot compute divergence.
 */
function parseUpstream(upstreamFull, upstreamShort, track) {
  if (upstreamFull.length === 0) return { upstream: null, ahead: 0, behind: 0 };
  if (upstreamShort.length === 0) fail('invalid upstream field');
  if (track.length === 0 || track === '[gone]') return { upstream: upstreamShort, ahead: 0, behind: 0 };
  const match = TRACK_PATTERN.exec(track);
  if (!match || (match[1] === undefined && match[2] === undefined)) fail('invalid upstream track field');
  return { upstream: upstreamShort, ahead: Number(match[1] ?? 0), behind: Number(match[2] ?? 0) };
}

/**
 * Parses the NUL-delimited output of `git for-each-ref` run with this
 * module's own `%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)
 * %00%(upstream)%00%(upstream:short)%00%(upstream:track)%00%(symref)` format.
 * `for-each-ref` has no `-z`/null-termination flag: each record is still
 * newline-terminated by Git itself, so records are split on `\n` first and
 * only the 8 fields within a record are NUL-delimited. None of the chosen
 * atoms (ref names, hex ids, the fixed `objecttype` enum, short tracking
 * strings) can legally contain a newline, so this split is unambiguous.
 * @param {string} output
 * @returns {Ref[]}
 */
export function parseRefsV1(output) {
  if (typeof output !== 'string') fail('output must be a string');
  if (output.length === 0) return [];
  if (!output.endsWith('\n')) fail('truncated ref record');

  const lines = output.split('\n');
  lines.pop();
  if (lines.length === 0) return [];

  const refs = [];
  for (const line of lines) {
    if (line.length === 0) fail('empty ref record');
    const fields = line.split('\0');
    if (fields.length !== FIELD_COUNT) fail('wrong field count');
    const [fullName, objectName, derefObjectName, objectType, upstreamFull, upstreamShort, upstreamTrack, symref] = fields;

    // A symbolic ref (e.g. refs/remotes/origin/HEAD) is a pointer to another
    // ref, not a branch of its own: it must not surface as one.
    if (symref.length > 0) continue;

    if (!OBJECT_TYPES.has(objectType)) fail('invalid object type');
    validateOid(objectName);
    if (derefObjectName.length > 0) validateOid(derefObjectName);
    // An annotated tag's own object id is the tag object, not a commit;
    // %(*objectname) dereferences it. A lightweight tag or branch has no
    // dereferenced value, so its direct object id is already the commit.
    const target = derefObjectName.length > 0 ? derefObjectName : objectName;

    const { type, name } = classify(fullName);
    const { upstream, ahead, behind } = parseUpstream(upstreamFull, upstreamShort, upstreamTrack);
    refs.push({ name, fullName, target, type, upstream, ahead, behind });
  }

  refs.sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || a.name.localeCompare(b.name, 'en'));
  return refs;
}

const FORMAT = '%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)'
  + '%00%(upstream)%00%(upstream:short)%00%(upstream:track)%00%(symref)';

/**
 * Builds the argv for `git for-each-ref` in this module's parser format.
 * Exported separately (beyond the `loadRefs` in the M2-HISTORY contract) so
 * the self-check can assert on the exact argv without spawning Git.
 * @returns {string[]}
 */
export function buildRefsArgv() {
  return ['for-each-ref', `--format=${FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags'];
}

/**
 * @param {{ cwd: string, log: import('../command-log.js').CommandLog }} options
 * @returns {Promise<Ref[]>}
 */
export async function loadRefs({ cwd, log }) {
  const result = await runGit({ argv: buildRefsArgv(), cwd, log, operation: 'Read branches and tags' });
  if (result.code !== 0) throw new Error('Git could not read branches and tags.');
  return parseRefsV1(result.stdout);
}

/**
 * What the tag list on the "Branches and tags" screen shows beyond the name:
 * whether a tag is annotated, who tagged it and when, and its message. One
 * `for-each-ref` over `refs/tags`, read only while that screen is open — the
 * graph and the sidebar keep using the lean `loadRefs` above.
 *
 * A message spans lines, so records cannot be split on `\n` the way
 * `parseRefsV1` does. Every field, the last one included, ends in NUL instead;
 * Git then appends its own `\n` to each record, which therefore sits at the
 * start of the next record's first field (a ref name, which cannot contain a
 * newline) and alone after the last one.
 */
const TAG_FIELDS = ['%(refname)', '%(objecttype)', '%(objectname)', '%(*objectname)', '%(taggername)', '%(taggeremail)',
  '%(creatordate:unix)', '%(contents:subject)', '%(contents:body)', '%(contents:signature)'];
const TAG_MESSAGE_LIMIT = 8000;

export function buildTagDetailsArgv() {
  return ['for-each-ref', `--format=${TAG_FIELDS.map(field => `${field}%00`).join('')}`, 'refs/tags'];
}

/**
 * @param {string} output
 * @returns {{ name: string, fullName: string, target: string, annotated: boolean, tagger: ?{ name: string, email: string },
 *   date: ?number, subject: string, body: string, signed: boolean }[]}
 */
export function parseTagDetails(output) {
  if (typeof output !== 'string') fail('output must be a string');
  if (output.length === 0) return [];
  const tokens = output.split('\0');
  if (tokens.pop() !== '\n' || tokens.length % TAG_FIELDS.length !== 0) fail('truncated tag record');
  const tags = [];
  for (let at = 0; at < tokens.length; at += TAG_FIELDS.length) {
    const record = tokens.slice(at, at + TAG_FIELDS.length);
    if (at > 0) {
      if (!record[0].startsWith('\n')) fail('unexpected tag record separator');
      record[0] = record[0].slice(1);
    }
    const [fullName, objectType, objectName, deref, taggerName, taggerEmail, date, subject, body, signature] = record;
    const { type, name } = classify(fullName);
    if (type !== 'tag') fail('not a tag');
    if (!OBJECT_TYPES.has(objectType)) fail('invalid object type');
    validateOid(objectName);
    if (deref) validateOid(deref);
    // A lightweight tag points straight at a commit, so its "contents" are
    // that commit's message — not something the tag says. Only a tag object
    // has a tagger and a message of its own.
    const annotated = objectType === 'tag';
    const seconds = Number(date);
    tags.push({
      name, fullName, target: deref || objectName, annotated,
      tagger: annotated && taggerName ? { name: taggerName, email: taggerEmail.replace(/^<|>$/g, '') } : null,
      date: date && Number.isSafeInteger(seconds) ? seconds * 1000 : null,
      subject: annotated ? subject : '',
      body: annotated ? body.replace(/\s+$/, '').slice(0, TAG_MESSAGE_LIMIT) : '',
      signed: annotated && signature.length > 0
    });
  }
  return tags;
}

/** @param {{ cwd: string, log: import('../command-log.js').CommandLog }} options */
export async function loadTagDetails({ cwd, log }) {
  const result = await runGit({ argv: buildTagDetailsArgv(), cwd, log, operation: 'Read tag messages' });
  if (result.code !== 0) throw new Error('Git could not read the tags.');
  return parseTagDetails(result.stdout);
}
