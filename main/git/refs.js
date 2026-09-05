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
